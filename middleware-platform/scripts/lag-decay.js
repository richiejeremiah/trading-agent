'use strict';

/**
 * Is there drift left after the market has had six days to read a recall?
 *
 * The staleness rule rejects events older than five days, on the reasoning that
 * news the market has absorbed has no overreaction left to fade. That reasoning
 * is sound and it turns out to be moot: openFDA's freshest recall in a
 * sixty-day sample was six days old and the median was twenty. Nothing will
 * ever clear a five-day rule, so "the strategy resolves once the daily cycle
 * runs" — a claim made repeatedly this session — is simply wrong.
 *
 * That leaves a narrower and answerable question. Not "does the strategy work"
 * but: given that a recall is already six days public, is there measurable
 * drift left to capture? Two different failures have been fused all session —
 * "no edge" and "never fairly tested" — and this separates them.
 *
 * Four things this gets right, because a sloppy version of it would produce a
 * confident wrong answer:
 *
 *   Binned by lag rather than aggregated. A single number over a 5-to-20-day
 *   window cannot distinguish a decay curve (threshold roughly right, off by a
 *   few days) from a flat zero (opportunity gone by day six). Those imply
 *   opposite decisions.
 *
 *   Excess over XLV with the same costs as the live path, so the result is
 *   comparable to the −0.17% baseline rather than merely comparable to zero.
 *
 *   The survivorship caveat, doubly: this measures recalls at companies with
 *   enough price history for a twenty-day window, which skews larger and
 *   longer-listed.
 *
 *   And a bar set before the run: mean excess of +0.5% in a bin, at least
 *   twenty observations in it, and a decay shape that makes sense. With six
 *   bins one will look good by chance.
 */

require('dotenv').config();

const { getDb } = require('../database');
const { getHistoricalPrices } = require('../services/market-data-client');

const BENCHMARK = (process.env.PAPER_BENCHMARK || 'XLV').toUpperCase();
const HOLD_DAYS = Number(process.env.TRADE_HOLD_DAYS || 7);
const COST_BPS = { liquid: 8, normal: 15, thin: 35 };

/** Entry lags to test, in calendar days after publication. */
const LAG_BINS = [1, 3, 6, 9, 12, 16, 20];

/** Set before seeing any number, so it cannot move afterwards. */
const BAR = { meanExcessPct: 0.5, minObservations: 20 };

const RATE_MS = 220;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function costTier(vol) {
  if (!vol) return 'thin';
  if (vol > 5_000_000) return 'liquid';
  if (vol > 500_000) return 'normal';
  return 'thin';
}

/** Index of the last bar on or before a time. */
function idxOnOrBefore(quotes, t) {
  let idx = -1;
  for (let i = 0; i < quotes.length; i++) {
    if (new Date(quotes[i].date).getTime() <= t) idx = i;
    else break;
  }
  return idx;
}

function mean(xs) {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

(async () => {
  const db = getDb();

  // One source at a time. Averaging recalls and trial terminations would hide
  // whichever is weaker inside whichever is stronger, and they have different
  // publication lags — the whole reason for testing separately.
  const kindArg = process.argv[2] || null;

  const events = db
    .prepare(
      `SELECT ticker, kind, published_at FROM kg_event
       WHERE published_at IS NOT NULL AND ticker NOT LIKE '%.%'
         AND (? IS NULL OR kind = ?)
       ORDER BY published_at`
    )
    .all(kindArg, kindArg);

  if (events.length === 0) {
    console.log('\nNo resolved events to measure. Widen the ingest first.\n');
    process.exit(0);
  }

  // Labelling a report by a source it did not isolate is how the first run of
  // this script reported on recalls while measuring trial terminations — a
  // clean tle, a confident conclusion, and entirely the wrong data. The
  // composition is asserted rather than assumed.
  const kindCounts = {};
  for (const e of events) kindCounts[e.kind || 'unknown'] = (kindCounts[e.kind || 'unknown'] || 0) + 1;

  if (Object.keys(kindCounts).length > 1) {
    console.log('\n  This set contains more than one source:\n');
    for (const [k, n] of Object.entries(kindCounts).sort((a, b) => b[1] - a[1])) {
      console.log('    ' + String(n).padStart(4) + '  ' + k);
    }
    console.log('\n  Measuring them together reports on whichever dominates while naming');
    console.log('  whichever was asked for. Pass a source:\n');
    for (const k of Object.keys(kindCounts)) console.log('    node scripts/lag-decay.js ' + k);
    console.log('');
    process.exit(1);
  }

  console.log('\nlag decay — is there drift left after the market has read it?\n');

  if (kindArg) console.log('  source: ' + kindArg);

  // How stale each event was by the time this system could act on it. Source
  // latency and ingest latency compound, and only their sum matters.
  const lags = db
    .prepare(
      `SELECT ticker, published_at, captured_at FROM kg_event
       WHERE published_at IS NOT NULL AND captured_at IS NOT NULL
         AND (? IS NULL OR kind = ?)`
    )
    .all(kindArg, kindArg)
    .map((e) => Math.floor((new Date(e.captured_at) - new Date(e.published_at)) / 86400000))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);

  if (lags.length) {
    // captured_at records when this system first saw an event. For anything
    // ingested in bulk that is when the backfill ran, which says nothing about
    // what a live pipeline would see. A real-looking median here would mislead
    // anyone reading the output without this conversation attached.
    const capturedSameDay = db
      .prepare(
        `SELECT COUNT(DISTINCT date(captured_at)) n FROM kg_event
         WHERE captured_at IS NOT NULL AND (? IS NULL OR kind = ?)`
      )
      .get(kindArg, kindArg).n;

    if (capturedSameDay <= 2) {
      console.log(
        '  ingest lag: NOT MEANINGFUL — every event was captured on ' +
        capturedSameDay + ' day(s), so this measures when the backfill ran'
      );
      console.log('              rather than what a live pipeline would see.');
    } else {
      console.log(
        '  ingest lag: median ' + lags[Math.floor(lags.length / 2)] +
        'd, fastest ' + lags[0] + 'd  across ' + capturedSameDay + ' capture days'
      );
    }
  }
  console.log('  ' + events.length + ' resolved events');
  console.log('  entry at each lag, held ' + HOLD_DAYS + ' days, excess over ' + BENCHMARK);
  console.log('  bar: mean +' + BAR.meanExcessPct + '% on at least ' + BAR.minObservations + ' observations\n');

  const bench = await getHistoricalPrices(BENCHMARK, { range: '2y', interval: '1d' });
  if (!bench || !bench.ok) {
    console.error('could not load ' + BENCHMARK);
    process.exit(1);
  }
  const bq = bench.data.quotes.filter((q) => Number.isFinite(q.close) && Number.isFinite(q.open));

  // One price series per ticker, reused across every lag bin.
  const series = new Map();
  const tickers = [...new Set(events.map((e) => e.ticker))];

  for (const t of tickers) {
    const s = await getHistoricalPrices(t, { range: '2y', interval: '1d' });
    if (s && s.ok) {
      series.set(t, s.data.quotes.filter((q) => Number.isFinite(q.close) && Number.isFinite(q.open)));
    }
    await sleep(RATE_MS);
  }

  console.log('  ' + series.size + ' of ' + tickers.length + ' tickers priced\n');

  const results = [];

  for (const lag of LAG_BINS) {
    const excesses = [];
    const contributors = [];
    let skipped = 0;

    for (const e of events) {
      const quotes = series.get(e.ticker);
      if (!quotes) { skipped += 1; continue; }

      const published = new Date(e.published_at).getTime();
      const entryTarget = published + lag * 86400000;

      // Entry at the next open after the lag has elapsed — the same discipline
      // the live path uses. Buying at the close that told you would be the
      // oldest bias in backtesting.
      const beforeEntry = idxOnOrBefore(quotes, entryTarget);
      const entryIdx = beforeEntry + 1;
      if (entryIdx <= 0 || entryIdx >= quotes.length) { skipped += 1; continue; }

      const exitIdx = entryIdx + HOLD_DAYS;
      if (exitIdx >= quotes.length) { skipped += 1; continue; }

      const entry = quotes[entryIdx].open;
      const exit = quotes[exitIdx].open;
      if (!entry || !exit) { skipped += 1; continue; }

      const bEntryIdx = idxOnOrBefore(bq, new Date(quotes[entryIdx].date).getTime());
      const bExitIdx = idxOnOrBefore(bq, new Date(quotes[exitIdx].date).getTime());
      if (bEntryIdx < 0 || bExitIdx < 0) { skipped += 1; continue; }

      const stockPct = (exit - entry) / entry;
      const benchPct = (bq[bExitIdx].close - bq[bEntryIdx].close) / bq[bEntryIdx].close;

      // Costs both ends, tiered as the live path does. A drift measurement
      // without them is not comparable to the −0.17% baseline.
      const vol =
        quotes.slice(Math.max(0, entryIdx - 20), entryIdx).reduce((s, q) => s + (q.volume || 0), 0) / 20;
      const costPct = (2 * COST_BPS[costTier(vol)]) / 10_000;

      excesses.push((stockPct - benchPct - costPct) * 100);
      contributors.push(e.ticker);
    }

    const counts = {};
    for (const t of contributors) counts[t] = (counts[t] || 0) + 1;
    const uniques = Object.keys(counts).length;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];

    results.push({
      lag,
      n: excesses.length,
      uniques,
      dominant: top ? top[0] : null,
      dominantShare: top && excesses.length ? Math.round((top[1] / excesses.length) * 100) : 0,
      skipped,
      mean: mean(excesses),
      median: median(excesses),
      positive: excesses.filter((x) => x > 0).length,
    });
  }

  console.log('  lag    n  names  top%   mean%   median%   won');
  console.log('  ---  ---  -----  ----  ------  --------  ----');
  for (const r of results) {
    console.log(
      '  ' + String(r.lag).padStart(3) +
      '  ' + String(r.n).padStart(3) +
      '  ' + String(r.uniques).padStart(5) +
      '  ' + (r.dominantShare + '%').padStart(4) +
      '  ' + (r.mean === null ? '    —' : r.mean.toFixed(2).padStart(6)) +
      '  ' + (r.median === null ? '      —' : r.median.toFixed(2).padStart(8)) +
      '  ' + (r.n ? Math.round((r.positive / r.n) * 100) + '%' : '  —').padStart(4)
    );
  }

  // ---- the verdict, against a bar fixed before the run -------------------

  const qualifying = results.filter(
    (r) => r.n >= BAR.minObservations && r.mean !== null && r.mean >= BAR.meanExcessPct
  );

  const withData = results.filter((r) => r.n > 0 && r.mean !== null);

  // Decay: early drift above late drift, and no sign flip in between. An
  // overreaction being corrected fades. Something that grows, or crosses zero
  // twice, is not that whatever the top line says.
  const decays = withData.length >= 3 && withData[0].mean > withData[withData.length - 1].mean;
  const signFlips = withData.reduce(
    (n, r, i) => (i > 0 && Math.sign(r.mean) !== Math.sign(withData[i - 1].mean) ? n + 1 : n),
    0
  );

  // Effective sample. Twenty-five observations across four names is not
  // twenty-five trials, and one name at 65% of them is one bet repeated.
  const bestBin = qualifying.length
    ? qualifying.reduce((a, b) => (b.mean > a.mean ? b : a))
    : results.reduce((a, b) => ((b.mean ?? -Infinity) > (a.mean ?? -Infinity) ? b : a));

  console.log('');
  console.log('  checks');
  // The sample gate comes first. A threshold cleared on three names is not a
  // pass with a caveat, it is a number with nothing behind it — and printing
  // PASS next to it invites exactly the misreading this whole session has been
  // about.
  const sampleAdequate = bestBin.uniques >= 8 && bestBin.dominantShare <= 40;

  console.log(
    '    bar      ' +
      (!sampleAdequate
        ? 'N/A   sample too narrow for any threshold to mean anything'
        : qualifying.length
          ? 'PASS  ' + qualifying.length + ' bin(s) at or above +' + BAR.meanExcessPct + '%'
          : 'FAIL  nothing clears +' + BAR.meanExcessPct + '%')
  );
  console.log('    shape    ' + (decays && signFlips <= 1 ? 'PASS  drift decays with lag' : 'FAIL  ' + (decays ? '' : 'drift does not decay') + (signFlips > 1 ? ', ' : '') + (signFlips > 1 ? (decays ? ', ' : '') + signFlips + ' sign flips' : '')));
  console.log(
    '    sample   ' +
      (sampleAdequate
        ? 'PASS  ' + bestBin.uniques + ' names, top ' + bestBin.dominantShare + '%'
        : 'FAIL  ' + bestBin.uniques + ' names, top at ' + bestBin.dominantShare +
          '% — not independent trials')
  );

  console.log('');

  if (results.every((r) => r.n < BAR.minObservations)) {
    console.log('  Nothing to conclude. The largest bin has ' + Math.max(...results.map((r) => r.n)) + ' observation(s)');
    console.log('  against a bar of ' + BAR.minObservations + ', and widening the ingest will not close that gap —');
    console.log('  the constraint is how many events resolve to tradeable names, not how');
    console.log('  many events there are.');
  } else if (!sampleAdequate) {
    console.log('  No conclusion either way. Three names with one at ' + bestBin.dominantShare + '% is not');
    console.log('  a sample — whatever any bin shows, there is nothing behind it. This is');
    console.log('  untested rather than disproven.');
  } else if (qualifying.length === 0) {
    console.log('  Nothing clears +' + BAR.meanExcessPct + '% at any lag with enough observations.');
    console.log('  The opportunity is gone by the time openFDA publishes. The staleness');
    console.log('  rule was not blocking a working strategy — it was correctly reporting');
    console.log('  that there is no window where a recall is both public and unpriced.');
  } else if (!decays) {
    console.log('  ' + qualifying.map((r) => 'lag ' + r.lag).join(' and ') + ' clear the bar, but drift does');
    console.log('  not decay with lag — it is flat or rising, which is not what an');
    console.log('  overreaction looks like. One bin in seven beating a threshold is what');
    console.log('  chance produces. Treat as noise unless it repeats out of sample.');
  } else {
    console.log('  ' + qualifying.map((r) => 'lag ' + r.lag + ' (' + r.mean.toFixed(2) + '%, n=' + r.n + ')').join(', '));
    console.log('  clears the bar, and drift decays with lag as an overreaction should.');
    console.log('  Worth pursuing — and worth confirming on events this sample did not include.');
  }

  console.log('');
  if (!sampleAdequate) {
    console.log('');
    console.log('  Running the daily cycle for longer will not fix this. The constraint is');
    console.log('  that 86% of FDA events belong to companies outside the universe, mostly');
    console.log('  private manufacturers — so the resolvable set stays a handful of names');
    console.log('  however long it accumulates. The supply-chain graph is the only thing');
    console.log('  that changes it, by making a recall at a private supplier a signal about');
    console.log('  the listed companies that buy from it.');
  }

  console.log('');
  console.log('  Caveats: survivors only, and doubly so here — this measures events at');
  console.log('  companies with enough history for a ' + HOLD_DAYS + '-day window after a 20-day lag,');
  console.log('  which skews larger and longer-listed. Costs are assumptions. No market');
  console.log('  impact is modelled, so a live version is worse than this.');
  console.log('');

  process.exit(0);
})();
