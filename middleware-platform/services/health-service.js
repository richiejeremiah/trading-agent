'use strict';

/**
 * Is today's experiment sound?
 *
 * Checking that an endpoint returns 200 is not a health check. The failure mode
 * that matters with free data sources is not an error — it is stale data served
 * cheerfully and indefinitely. A price series that stopped updating three days
 * ago looks exactly like a quiet market, and every signal computed from it is
 * quietly wrong.
 *
 * So each check asks a question that a broken source cannot answer correctly:
 * is the newest bar from the session it should be from, does a known ticker
 * still resolve, does the shape of the response still contain the fields the
 * rest of the system reads.
 *
 * A failed check does not stop the cycle. It records that the day's data was
 * compromised, so a strange result weeks later can be traced to a bad day
 * rather than attributed to the strategy.
 */

const { getCurrentPrice, getHistoricalPrices } = require('./market-data-client');
const { getRecentRecalls } = require('./fda-client');
const { getDb } = require('../database');

const BENCHMARK = (process.env.PAPER_BENCHMARK || 'XLV').toUpperCase();

/** How many sessions old the newest bar may be before it is stale. */
const MAX_BAR_AGE_DAYS = Number(process.env.HEALTH_MAX_BAR_AGE || 4);

function daysAgo(iso) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

async function checkPrices() {
  const started = Date.now();
  const quote = await getCurrentPrice(BENCHMARK);

  if (!quote || !quote.ok) {
    return { name: 'quotes', pass: false, detail: quote && quote.error ? quote.error.message : 'no response' };
  }

  // The fields the rest of the system reads. A response that still returns 200
  // with a changed shape is the quietest possible break.
  const missing = ['price', 'currency', 'timestamp'].filter((k) => quote.data[k] === undefined);
  if (missing.length) {
    return { name: 'quotes', pass: false, detail: 'response missing ' + missing.join(', ') };
  }

  return {
    name: 'quotes',
    pass: true,
    detail: BENCHMARK + ' ' + quote.data.price + ' ' + quote.data.currency,
    ms: Date.now() - started,
  };
}

async function checkBars() {
  const started = Date.now();
  const series = await getHistoricalPrices(BENCHMARK, { range: '1mo', interval: '1d' });

  if (!series || !series.ok) {
    return { name: 'bars', pass: false, detail: series && series.error ? series.error.message : 'no response' };
  }

  const quotes = series.data.quotes || [];
  if (quotes.length === 0) {
    return { name: 'bars', pass: false, detail: 'empty series' };
  }

  const newest = quotes[quotes.length - 1];
  const age = daysAgo(newest.date);

  // The check that matters. A source serving last Tuesday's bars forever passes
  // every other test.
  if (age > MAX_BAR_AGE_DAYS) {
    return {
      name: 'bars',
      pass: false,
      detail: 'newest bar is ' + newest.date + ', ' + age + ' days old — data is stale',
      ms: Date.now() - started,
    };
  }

  return {
    name: 'bars',
    pass: true,
    detail: quotes.length + ' bars, newest ' + newest.date,
    ms: Date.now() - started,
  };
}

async function checkUniverse() {
  const started = Date.now();
  const db = getDb();
  const sample = db
    .prepare("SELECT ticker FROM agent_watchlist WHERE ticker NOT LIKE '%.%' ORDER BY RANDOM() LIMIT 5")
    .all()
    .map((r) => r.ticker);

  if (sample.length === 0) {
    return { name: 'universe', pass: false, detail: 'watchlist is empty' };
  }

  const failed = [];
  for (const t of sample) {
    const q = await getCurrentPrice(t);
    if (!q || !q.ok) failed.push(t);
    await new Promise((r) => setTimeout(r, 150));
  }

  return {
    name: 'universe',
    pass: failed.length === 0,
    detail:
      failed.length === 0
        ? sample.length + ' of ' + sample.length + ' sampled tickers resolved'
        : 'could not price ' + failed.join(', '),
    ms: Date.now() - started,
  };
}

async function checkFda() {
  const started = Date.now();
  const recalls = await getRecentRecalls(30);

  if (!recalls || !recalls.ok) {
    return { name: 'fda', pass: false, detail: recalls && recalls.error ? recalls.error.message : 'no response' };
  }

  const items = recalls.data || [];
  if (items.length === 0) {
    // Not necessarily broken — a genuinely quiet month is possible — but worth
    // flagging rather than reading as "no problems".
    return { name: 'fda', pass: true, detail: 'no recalls in 30 days (unusual, worth a look)', ms: Date.now() - started };
  }

  const newest = items.reduce((a, b) => (new Date(b.published_at) > new Date(a.published_at) ? b : a));
  const age = daysAgo(newest.published_at);

  return {
    name: 'fda',
    pass: age <= 14,
    detail: items.length + ' recalls, newest ' + String(newest.published_at).slice(0, 10) + ' (' + age + 'd ago)',
    ms: Date.now() - started,
  };
}

/** The whole picture, in one call. */
async function runHealthChecks({ verbose = true } = {}) {
  const checks = [];
  for (const fn of [checkPrices, checkBars, checkUniverse, checkFda]) {
    try {
      checks.push(await fn());
    } catch (e) {
      checks.push({ name: fn.name.replace('check', '').toLowerCase(), pass: false, detail: e.message });
    }
  }

  const failed = checks.filter((c) => !c.pass);
  const healthy = failed.length === 0;

  if (verbose) {
    console.log('[health] ' + (healthy ? 'all sources ok' : failed.length + ' FAILING'));
    for (const c of checks) {
      console.log('  ' + (c.pass ? 'pass' : 'FAIL') + '  ' + c.name.padEnd(10) + c.detail + (c.ms ? '  (' + c.ms + 'ms)' : ''));
    }
  }

  return {
    ok: true,
    data: {
      healthy,
      checks,
      failed: failed.map((c) => c.name),
      // Recorded on the cycle so a strange result weeks later can be traced to
      // a bad data day rather than blamed on the strategy.
      verdict: healthy
        ? "Today's data is sound."
        : "Today's data is compromised: " + failed.map((c) => c.name).join(', ') + '. Treat anything generated today with suspicion.',
    },
  };
}

if (require.main === module) {
  runHealthChecks().then((r) => process.exit(r.data.healthy ? 0 : 1));
}

module.exports = { runHealthChecks };
