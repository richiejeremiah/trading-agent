'use strict';

/**
 * Fill in the benchmark price at recommendation time.
 *
 * This exists because the scorer's batched UPDATE writes bench_symbol and then
 * silently drops bench_at_rec, and after several attempts I could not see why.
 * Every ingredient is demonstrably present — the history fetch returns 63 bars,
 * the lookup finds the right one, and the same UPDATE run by hand works.
 *
 * Rather than keep guessing, this does the one write on its own. It is simpler
 * than the batched version, it is idempotent, and it is easy to reason about.
 * The scorer's bug is still there and will be much easier to find against a
 * week of real recommendations than against two test rows.
 *
 * Worth saying plainly: routing around a bug you cannot explain is a compromise,
 * not a fix. It is recorded here so the next person does not assume the batched
 * path was ever correct.
 *
 * The benchmark at recommendation time is the close on or BEFORE the call.
 * price_at_rec comes from a live quote, which outside market hours is the last
 * close — so taking the next session instead would compare a Friday price
 * against a Monday one and call the difference performance.
 */

const { getDb } = require('../database');
const { getHistoricalPrices } = require('../services/market-data-client');

const BENCHMARK = (process.env.PAPER_BENCHMARK || 'XLV').toUpperCase();

function closeOnOrBefore(quotes, target) {
  const t = target.getTime();
  let best = null;
  let bestT = -Infinity;
  for (const q of quotes) {
    const d = new Date(q.date).getTime();
    if (d <= t && d > bestT) {
      best = q;
      bestT = d;
    }
  }
  return best ? best.close : null;
}

async function backfill({ verbose = true } = {}) {
  const db = getDb();

  const rows = db
    .prepare(
      'SELECT id, recommended_at FROM agent_recommendation WHERE bench_at_rec IS NULL AND price_at_rec IS NOT NULL'
    )
    .all();

  if (rows.length === 0) {
    if (verbose) console.log('[bench] nothing to backfill');
    return { ok: true, data: { filled: 0, missed: 0 } };
  }

  const oldest = rows.reduce(
    (min, r) => (new Date(r.recommended_at) < new Date(min.recommended_at) ? r : min),
    rows[0]
  );
  const age = Math.floor((Date.now() - new Date(oldest.recommended_at).getTime()) / 86400000);
  const range = age > 300 ? '2y' : age > 150 ? '1y' : age > 60 ? '6mo' : '3mo';

  const series = await getHistoricalPrices(BENCHMARK, { range, interval: '1d' });
  if (!series || !series.ok) {
    console.error('[bench] could not fetch ' + BENCHMARK + ': ' + (series && series.error ? series.error.message : 'unknown'));
    return { ok: false, error: { code: 'NO_BENCHMARK', message: 'benchmark history unavailable' } };
  }

  const quotes = series.data.quotes || [];
  const stmt = db.prepare('UPDATE agent_recommendation SET bench_symbol = ?, bench_at_rec = ? WHERE id = ?');

  let filled = 0;
  let missed = 0;

  for (const r of rows) {
    const close = closeOnOrBefore(quotes, new Date(r.recommended_at));
    if (close === null) {
      missed += 1;
      continue;
    }
    stmt.run(BENCHMARK, close, r.id);
    filled += 1;
  }

  if (verbose) {
    console.log('[bench] ' + filled + ' filled, ' + missed + ' had no bar on or before the call');
  }
  return { ok: true, data: { filled, missed, benchmark: BENCHMARK } };
}

if (require.main === module) {
  backfill()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('[bench] failed:', e.message);
      process.exit(1);
    });
}

module.exports = { backfill };
