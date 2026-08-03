'use strict';

/**
 * Scoring the recommendations — all of them, against a benchmark.
 *
 * Two jobs. Fill in what the price did one, seven and thirty days after each
 * call, for every row regardless of whether it was accepted. And fill in what
 * the benchmark did over the same windows, because a call that made four
 * percent while the sector made six was a bad call, and without the second
 * number it reads as a good one.
 *
 * The skipped recommendations are the control group. If the calls you passed on
 * did as well as the ones you took, the agent is not the thing adding value.
 *
 * Run daily. Idempotent: a window already filled is left alone, and a window
 * that has not elapsed is skipped rather than guessed — a number written early
 * is a number that never gets corrected, because the column is no longer null.
 */

const { getDb } = require('../database');
const { getHistoricalPrices } = require('../services/market-data-client');

const BENCHMARK = (process.env.PAPER_BENCHMARK || 'XLV').toUpperCase();

const WINDOWS = [
  { days: 1, column: 'price_1d', bench: 'bench_1d' },
  { days: 7, column: 'price_7d', bench: 'bench_7d' },
  { days: 30, column: 'price_30d', bench: 'bench_30d' },
];

const RATE_MS = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function daysBetween(a, b) {
  return Math.floor((b.getTime() - a.getTime()) / 86400000);
}

/**
 * The close on or after a date.
 *
 * Markets shut at weekends, so "seven days later" often has no bar. The next
 * available close is the honest reading. Returning null rather than the nearest
 * earlier bar matters — an earlier bar is a price from before the window, which
 * would flatter or damn the call for something that had not happened yet.
 */
function closeOnOrAfter(quotes, target) {
  const t = target.getTime();
  let best = null;
  let bestT = Infinity;
  for (const q of quotes) {
    const d = new Date(q.date).getTime();
    if (d >= t && d < bestT) {
      best = q;
      bestT = d;
    }
  }
  return best ? best.close : null;
}

/**
 * The close on or BEFORE a date — used only for the benchmark at recommendation
 * time.
 *
 * price_at_rec comes from a live quote, which outside market hours is the last
 * close. Taking the benchmark from the next session instead would compare a
 * Friday price against a Monday one and call the difference performance.
 */
function closeOnOrBefore(quotes, target) {
  const t = target.getTime();
  let best = null;
  let bestT = -Infinity;
  for (const q of quotes) {
    const d = new Date(q.date).getTime();
    if (d <= t && d > bestT) { best = q; bestT = d; }
  }
  return best ? best.close : null;
}

function rangeFor(ageDays) {
  return ageDays > 300 ? '2y' : ageDays > 150 ? '1y' : ageDays > 60 ? '6mo' : '3mo';
}

async function scoreAll({ verbose = true } = {}) {
  const db = getDb();
  const today = new Date();

  const rows = db
    .prepare(
      `SELECT id, ticker, recommended_at, price_at_rec,
              price_1d, price_7d, price_30d,
              bench_at_rec, bench_1d, bench_7d, bench_30d
       FROM agent_recommendation
       WHERE price_at_rec IS NOT NULL
         AND (price_1d IS NULL OR price_7d IS NULL OR price_30d IS NULL
              OR bench_at_rec IS NULL OR bench_1d IS NULL OR bench_7d IS NULL OR bench_30d IS NULL)
       ORDER BY id`
    )
    .all();

  if (rows.length === 0) {
    if (verbose) console.log('[score] nothing to score');
    return { ok: true, data: { scanned: 0, updated: 0, skipped: 0, failed: 0 } };
  }

  const oldestAge = rows.reduce(
    (max, r) => Math.max(max, daysBetween(new Date(r.recommended_at), today)),
    0
  );

  // One benchmark fetch for the whole run.
  const benchSeries = await getHistoricalPrices(BENCHMARK, {
    range: rangeFor(oldestAge),
    interval: '1d',
  });
  await sleep(RATE_MS);

  const benchQuotes = benchSeries && benchSeries.ok ? benchSeries.data.quotes || [] : [];
  if (benchQuotes.length === 0 && verbose) {
    console.warn('[score] no benchmark history for ' + BENCHMARK + '; scoring prices only');
  }

  // One fetch per ticker rather than per row.
  const byTicker = new Map();
  for (const r of rows) {
    if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, []);
    byTicker.get(r.ticker).push(r);
  }

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const [ticker, recs] of byTicker) {
    const age = recs.reduce(
      (max, r) => Math.max(max, daysBetween(new Date(r.recommended_at), today)),
      0
    );

    const series = await getHistoricalPrices(ticker, { range: rangeFor(age), interval: '1d' });
    await sleep(RATE_MS);

    if (!series || !series.ok) {
      failed += recs.length;
      if (verbose) {
        console.warn('[score] no history for ' + ticker + ', leaving ' + recs.length + ' unscored');
      }
      continue;
    }

    const quotes = series.data.quotes || [];

    for (const r of recs) {
      const made = new Date(r.recommended_at);
      const elapsed = daysBetween(made, today);
      const sets = [];
      const vals = [];

      // The benchmark on the day of the call, so the comparison starts from the
      // same moment the recommendation did.
      if (r.bench_at_rec === null && benchQuotes.length) {
        const b = closeOnOrBefore(benchQuotes, made);
        if (Number.isFinite(b)) {
          sets.push('bench_symbol = ?', 'bench_at_rec = ?');
          vals.push(BENCHMARK, b);
        }
      }

      for (const w of WINDOWS) {
        if (elapsed < w.days) {
          skipped += 1;
          continue;
        }

        const target = new Date(made.getTime() + w.days * 86400000);

        if (r[w.column] === null || r[w.column] === undefined) {
          const close = closeOnOrAfter(quotes, target);
          if (!Number.isFinite(close)) skipped += 1;
          else {
            sets.push(w.column + ' = ?');
            vals.push(close);
          }
        }

        if ((r[w.bench] === null || r[w.bench] === undefined) && benchQuotes.length) {
          const b = closeOnOrAfter(benchQuotes, target);
          if (Number.isFinite(b)) {
            sets.push(w.bench + ' = ?');
            vals.push(b);
          }
        }
      }

      if (sets.length === 0) continue;

      db.prepare(
        'UPDATE agent_recommendation SET ' + sets.join(', ') + ", scored_at = datetime('now') WHERE id = ?"
      ).run(...vals, r.id);

      updated += 1;
    }
  }

  const summary = { scanned: rows.length, updated, skipped, failed, benchmark: BENCHMARK };
  if (verbose) {
    console.log(
      '[score] ' + updated + ' updated, ' + skipped + ' windows not yet due, ' +
        failed + ' unpriced — benchmark ' + BENCHMARK
    );
  }
  return { ok: true, data: summary };
}

if (require.main === module) {
  scoreAll()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('[score] failed:', e.message);
      process.exit(1);
    });
}

module.exports = { scoreAll, BENCHMARK };
