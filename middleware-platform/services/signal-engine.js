'use strict';

/**
 * What makes something a buy.
 *
 * Two strategies, kept separate so the scorecard can tell them apart. Running
 * one hypothesis and averaging it with another produces a number that says
 * nothing about either.
 *
 *   fda_overreaction — a company has a recall or a terminated trial, the stock
 *     falls hard, and the fall is larger than the sector's. The bet is that the
 *     market overreacts to individual bad news at large caps where one recall is
 *     a rounding error against revenue. This is the hypothesis worth testing;
 *     it is also the one that will fire rarely, because most recalls move
 *     nothing.
 *
 *   sector_mean_reversion — the worst performers in the universe over a lookback
 *     window, with no news attached. This is a generic factor, not an insight;
 *     it is decades old and well documented. Its job here is volume: without
 *     enough recommendations the scorecard has nothing to measure, and a
 *     strategy that fires twice a year cannot be validated in a lifetime.
 *
 * Both are honest about what they are. Neither is an edge until the scorecard
 * says so, and the scorecard needs a hundred calls across a bad month as well
 * as a good one before it says anything at all.
 *
 * Point-in-time discipline: signals are computed from the price history up to
 * now and events published before now. Nothing here can see the future, which
 * sounds obvious and is the thing most backtests get wrong.
 */

const { getDb } = require('../database');
const { getHistoricalPrices, getCurrentPrice } = require('./market-data-client');
const { recordRecommendation } = require('./wallet-service');
const { concentrationCheck } = require('./sub-sectors');

const BENCHMARK = (process.env.PAPER_BENCHMARK || 'XLV').toUpperCase();

/** How far a stock must fall relative to the sector before it is interesting. */
const OVERREACTION_DROP = Number(process.env.SIGNAL_OVERREACTION_DROP || 0.05);

/** Trading days either side of an event to measure the reaction over. */
const EVENT_WINDOW_DAYS = 10;

/**
 * How stale an event may be before acting on it is dishonest.
 *
 * A trial termination learned about 38 days late is not an event signal. The
 * price moved five weeks ago and the information is fully in it — what remains
 * is simply that the stock is down, which is the mean-reversion strategy under
 * another name. Acting on it would make the two strategies the same thing with
 * different labels, and the comparison between them meaningless.
 *
 * The consequence, stated plainly: backfilled history cannot testhis
 * hypothesis. Every event ingested in bulk carries a large lag. The strategy
 * only becomes testable once the daily cycle is running and lag is a day or
 * two — which means the first honest result is weeks away, not today.
 */
const MAX_EVENT_LAG_DAYS = Number(process.env.SIGNAL_MAX_EVENT_LAG_DAYS || 5);

/** Lookback for relative weakness. */
const REVERSION_LOOKBACK_DAYS = 21;

/** How far a name must trail the sector to qualify. */
const REVERSION_UNDERPERFORMANCE = Number(process.env.SIGNAL_REVERSION_GAP || 0.08);

/** Do not call the same name again within this many days, whatever happened. */
const COOLDOWN_DAYS = Number(process.env.SIGNAL_COOLDOWN_DAYS || 14);

/** Cap per run, so a bad day does not fill the log with forty calls. */
const MAX_PER_RUN = Number(process.env.SIGNAL_MAX_PER_RUN || 3);

const RATE_MS = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function pctChange(from, to) {
  if (!from || !to) return null;
  return (to - from) / from;
}

/** Recently called names, so the log is not twenty rows about one ticker. */
function inCooldown(ticker, identityId) {
  const row = getDb()
    .prepare(
      `SELECT recommended_at FROM agent_recommendation
       WHERE ticker = ? AND identity_id IS ? AND recommended_at > datetime('now', '-' || ? || ' days')
       ORDER BY recommended_at DESC LIMIT 1`
    )
    .get(ticker, identityId ?? null, COOLDOWN_DAYS);
  return !!row;
}

/**
 * Bad news, a hard fall, and a fall larger than the sector's.
 *
 * All three matter. A fall without news is the other strategy. News without a
 * fall means the market did not care, and there is nothing to revert. A fall no
 * worse than the sector's is the sector falling, not this company.
 */
async function fdaOverreaction(identityId, benchQuotes) {
  const db = getDb();

  const events = db
    .prepare(
      `SELECT ticker, kind, headline, published_at, captured_at, raw_company
       FROM kg_event
       WHERE published_at > datetime('now', '-120 days')
       ORDER BY published_at DESC`
    )
    .all();

  const out = [];
  const seen = new Set();

  for (const e of events) {
    if (out.length >= MAX_PER_RUN) break;
    if (seen.has(e.ticker) || inCooldown(e.ticker, identityId)) continue;
    const conc = concentrationCheck(db, identityId, e.ticker);
    if (!conc.allowed) continue;
    seen.add(e.ticker);

    const series = await getHistoricalPrices(e.ticker, { range: '3mo', interval: '1d' });
    await sleep(RATE_MS);
    if (!series || !series.ok) continue;

    const quotes = series.data.quotes || [];
    // Measured from when this could have been acted on, not from when it was
    // published. An event ingested five days late has five days of price
    // movement nobody here could have traded, and counting them makes every
    // signal look better than it was.
    const publishedAt = new Date(e.published_at);
    const seenAt = e.captured_at ? new Date(e.captured_at) : publishedAt;
    const tradeableFrom = seenAt > publishedAt ? seenAt : publishedAt;
    const lagDays = Math.max(0, Math.round((tradeableFrom - publishedAt) / 86400000));
    // Measured from publication, not from when this system first saw it.
    // Using captured_at meant a backfilled year of events all carried today as
    // their capture date, so every window was today-to-today and every move was
    // zero. The lag is kept as a caveat on the recommendation rather than as
    // the start of the measurement.
    const eventDate = publishedAt;

    if (lagDays > MAX_EVENT_LAG_DAYS) continue;

    const before = closeOnOrBefore(quotes, eventDate);
    const latest = quotes.length ? quotes[quotes.length - 1].close : null;
    if (!before || !latest) continue;

    const stockMove = pctChange(before, latest);

    const benchBefore = closeOnOrBefore(benchQuotes, eventDate);
    const benchLatest = benchQuotes.length ? benchQuotes[benchQuotes.length - 1].close : null;
    const benchMove = pctChange(benchBefore, benchLatest);

    if (stockMove === null || benchMove === null) continue;

    const relative = stockMove - benchMove;
    if (relative > -OVERREACTION_DROP) continue;

    const rec = await recordRecommendation({
      identityId,
      ticker: e.ticker,
      side: 'buy',
      conviction: relative < -0.12 ? 'high' : 'medium',
      rationale:
        e.ticker + ' is down ' + (stockMove * 100).toFixed(1) + '% since a ' +
        (e.kind === 'recall' ? 'recall' : 'trial termination') + ' on ' +
        String(e.published_at).slice(0, 10) + ', against ' + (benchMove * 100).toFixed(1) +
        '% for ' + BENCHMARK + '. The bet is that the reaction is larger than the news.',
      evidence: [
        { type: 'fda_event', kind: e.kind, headline: e.headline, published_at: e.published_at, first_seen_at: e.captured_at, lag_days: lagDays, company: e.raw_company },
        { type: 'price', before, latest, move_pct: Number((stockMove * 100).toFixed(2)) },
        { type: 'benchmark', symbol: BENCHMARK, move_pct: Number((benchMove * 100).toFixed(2)) },
      ],
    });

    if (rec.ok) {
      getDb()
        .prepare("UPDATE agent_recommendation SET strategy = 'fda_overreaction' WHERE id = ?")
        .run(rec.data.id);
      out.push({ ...rec.data, strategy: 'fda_overreaction', relative });
    }
  }

  return out;
}

/**
 * The worst relative performers, with no news required.
 *
 * A generic factor. Its value here is that it fires often enough to fill the
 * log, so the machinery gets exercised and there is something to compare the
 * event strategy against. If the event strategy cannot beat this, it is not
 * worth the data pipeline behind it.
 */
async function sectorMeanReversion(identityId, benchQuotes, budget) {
  if (budget <= 0) return [];

  const db = getDb();
  const universe = db
    .prepare("SELECT ticker FROM agent_watchlist WHERE ticker NOT LIKE '%.%'")
    .all()
    .map((r) => r.ticker);

  const since = new Date(Date.now() - REVERSION_LOOKBACK_DAYS * 86400000);
  const benchThen = closeOnOrBefore(benchQuotes, since);
  const benchNow = benchQuotes.length ? benchQuotes[benchQuotes.length - 1].close : null;
  const benchMove = pctChange(benchThen, benchNow);
  if (benchMove === null) return [];

  const scored = [];

  for (const ticker of universe) {
    if (inCooldown(ticker, identityId)) continue;
    if (!concentrationCheck(db, identityId, ticker).allowed) continue;

    const series = await getHistoricalPrices(ticker, { range: '3mo', interval: '1d' });
    await sleep(RATE_MS);
    if (!series || !series.ok) continue;

    const quotes = series.data.quotes || [];
    const then = closeOnOrBefore(quotes, since);
    const nowPrice = quotes.length ? quotes[quotes.length - 1].close : null;
    const move = pctChange(then, nowPrice);
    if (move === null) continue;

    const relative = move - benchMove;
    if (relative <= -REVERSION_UNDERPERFORMANCE) {
      scored.push({ ticker, move, relative });
    }
  }

  // Worst first — the strongest version of the signal.
  scored.sort((a, b) => a.relative - b.relative);

  const out = [];
  for (const s of scored.slice(0, budget)) {
    const rec = await recordRecommendation({
      identityId,
      ticker: s.ticker,
      side: 'buy',
      conviction: s.relative < -0.15 ? 'high' : 'medium',
      rationale:
        s.ticker + ' is down ' + (s.move * 100).toFixed(1) + '% over ' + REVERSION_LOOKBACK_DAYS +
        ' days against ' + (benchMove * 100).toFixed(1) + '% for ' + BENCHMARK +
        ' — ' + (s.relative * 100).toFixed(1) + '% behind its sector, with no company news attached.',
      evidence: [
        { type: 'relative_weakness', lookback_days: REVERSION_LOOKBACK_DAYS, move_pct: Number((s.move * 100).toFixed(2)) },
        { type: 'benchmark', symbol: BENCHMARK, move_pct: Number((benchMove * 100).toFixed(2)) },
      ],
    });

    if (rec.ok) {
      getDb()
        .prepare("UPDATE agent_recommendation SET strategy = 'sector_mean_reversion' WHERE id = ?")
        .run(rec.data.id);
      out.push({ ...rec.data, strategy: 'sector_mean_reversion', relative: s.relative });
    }
  }

  return out;
}

async function runSignals(identityId, { verbose = true } = {}) {
  const bench = await getHistoricalPrices(BENCHMARK, { range: '3mo', interval: '1d' });
  await sleep(RATE_MS);

  if (!bench || !bench.ok) {
    return { ok: false, error: { code: 'NO_BENCHMARK', message: 'Could not price ' + BENCHMARK + '; no signals generated.' } };
  }

  const benchQuotes = bench.data.quotes || [];

  // The event strategy goes first and takes what it needs. It is the hypothesis
  // being tested; the factor is filler.
  const events = await fdaOverreaction(identityId, benchQuotes);
  const reversion = await sectorMeanReversion(identityId, benchQuotes, MAX_PER_RUN - events.length);

  const all = [...events, ...reversion];

  if (verbose) {
    console.log(
      '[signals] ' + events.length + ' from FDA events, ' + reversion.length + ' from relative weakness'
    );
    for (const r of all) console.log('  #' + r.id + '  ' + r.ticker + '  ' + r.strategy);
    if (all.length === 0) console.log('  nothing met the thresholds today');
  }

  return { ok: true, data: { generated: all.length, recommendations: all } };
}

if (require.main === module) {
  const identityId = Number(process.argv[2] || 0);
  if (!identityId) {
    console.error('usage: node scripts/run-signals.js <identityId>');
    process.exit(1);
  }
  runSignals(identityId)
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('[signals] failed:', e.message);
      process.exit(1);
    });
}

module.exports = { runSignals, fdaOverreaction, sectorMeanReversion };
