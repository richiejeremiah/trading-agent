'use strict';

/**
 * Walk-forward backtest of sector_mean_reversion.
 *
 * Only this strategy can be tested on history. fda_overreaction cannot, because
 * every historical event carries a large ingest lag by construction — the
 * staleness rule that protects the live signal makes the backfilled version
 * untestable, which is the correct trade rather than a limitation to work
 * around.
 *
 * Three rules this holds to, because a backtest that breaks any of them is
 * worse than no backtest — it produces a confident number that is wrong:
 *
 *   Parameters are frozen. Lookback, underperformance gap, cooldown, caps and
 *   holding period are read from the live configuration and never varied here.
 *   Fitting them on the same history the result is reported from is in-sample
 *   testing with extra steps, and it is how strategies that do not work come to
 *   look like strategies that do.
 *
 *   Nothing sees the future. On each simulated day the screen uses only bars
 *   dated on or before that day. The fill is the NEXT session's open and the
 *   exit is the next session's open after the trigger, exactly as the live path
 *   does it.
 *
 *   Costs apply. The same tiered assumptions the live path uses, at both ends.
 *   A backtest without costs measures a strategy nobody can trade.
 *
 * What it cannot tell you: whether the strategy works now. It tells you whether
 * it worked over this window, on this universe, which is survivors only. The
 * absent delisted names bias every result here upward.
 */

const { getHistoricalPrices } = require('../services/market-data-client');
const { getDb } = require('../database');
const { subSectorOf, MAX_PER_SUB_SECTOR } = require('../services/sub-sectors');

const BENCHMARK = (process.env.PAPER_BENCHMARK || 'XLV').toUpperCase();

// Frozen, read from the live configuration. Not tuned here.
const LOOKBACK_DAYS = Number(process.env.SIGNAL_REVERSION_LOOKBACK || 21);
const GAP = Number(process.env.SIGNAL_REVERSION_GAP || 0.08);
const COOLDOWN_DAYS = Number(process.env.SIGNAL_COOLDOWN_DAYS || 14);
const MAX_PER_RUN = Number(process.env.SIGNAL_MAX_PER_RUN || 3);
const HOLD_DAYS = Number(process.env.TRADE_HOLD_DAYS || 7);
const STOP = Number(process.env.TRADE_STOP_PCT || -0.08);
const TARGET = Number(process.env.TRADE_TARGET_PCT || 0.12);
const COST_BPS = { liquid: 8, normal: 15, thin: 35 };

const round = (n, d = 2) => Number(Number(n).toFixed(d));

function costTier(vol) {
  if (!vol) return 'thin';
  if (vol > 5_000_000) return 'liquid';
  if (vol > 500_000) return 'normal';
  return 'thin';
}

/** Index of the last bar on or before a date. -1 when there is none. */
function indexOnOrBefore(quotes, t) {
  let idx = -1;
  for (let i = 0; i < quotes.length; i++) {
    if (new Date(quotes[i].date).getTime() <= t) idx = i;
    else break;
  }
  return idx;
}

async function loadSeries(tickers, range) {
  const out = new Map();
  for (const t of tickers) {
    const s = await getHistoricalPrices(t, { range, interval: '1d' });
    if (s && s.ok && (s.data.quotes || []).length) {
      out.set(t, s.data.quotes.filter((q) => Number.isFinite(q.close) && Number.isFinite(q.open)));
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return out;
}

async function backtest({ range = '1y', verbose = true } = {}) {
  const db = getDb();

  // Domestic names only — a currency mismatch is refused live, so including
  // them here would test something the live system will not do.
  const universe = db
    .prepare("SELECT ticker FROM agent_watchlist WHERE ticker NOT LIKE '%.%'")
    .all()
    .map((r) => r.ticker);

  if (verbose) console.log('[backtest] loading ' + universe.length + ' tickers plus benchmark…');

  const bench = await getHistoricalPrices(BENCHMARK, { range, interval: '1d' });
  if (!bench || !bench.ok) {
    return { ok: false, error: { code: 'NO_BENCHMARK', message: 'could not load ' + BENCHMARK } };
  }
  const bq = bench.data.quotes.filter((q) => Number.isFinite(q.close));

  const series = await loadSeries(universe, range);
  if (verbose) console.log('[backtest] ' + series.size + ' priced\n');

  // Simulated days are the benchmark's sessions, so every decision happens on a
  // day the market was actually open.
  const days = bq.map((q) => q.date);
  const trades = [];
  const lastCall = new Map();

  // Start far enough in that the lookback has data, and stop early enough that
  // every opened trade can also close inside the window. A trade still open at
  // the end is not a result and is excluded rather than marked to the last bar.
  const start = LOOKBACK_DAYS + 2;
  const end = days.length - Math.ceil(HOLD_DAYS * 1.6) - 2;

  for (let d = start; d < end; d++) {
    const today = days[d];
    const t = new Date(today).getTime();

    const bNow = bq[d].close;
    const bThenIdx = indexOnOrBefore(bq, t - LOOKBACK_DAYS * 86400000);
    if (bThenIdx < 0) continue;
    const bThen = bq[bThenIdx].close;
    const bMove = (bNow - bThen) / bThen;

    const candidates = [];

    for (const [ticker, quotes] of series) {
      const iNow = indexOnOrBefore(quotes, t);
      if (iNow < LOOKBACK_DAYS) continue;

      const iThen = indexOnOrBefore(quotes, t - LOOKBACK_DAYS * 86400000);
      if (iThen < 0) continue;

      const move = (quotes[iNow].close - quotes[iThen].close) / quotes[iThen].close;
      const rel = move - bMove;
      if (rel > -GAP) continue;

      const last = lastCall.get(ticker);
      if (last && (t - last) / 86400000 < COOLDOWN_DAYS) continue;

      candidates.push({ ticker, rel, iNow, quotes });
    }

    candidates.sort((a, b) => a.rel - b.rel);

    // Concentration, applied to what this run would open — the live cap counts
    // held and pending positions, and in a simulation the equivalent is the
    // trades opened on the same day plus those still running.
    const openBySector = new Map();
    for (const tr of trades) {
      if (tr.exit_date === null) {
        const sec = subSectorOf(tr.ticker);
        openBySector.set(sec, (openBySector.get(sec) || 0) + 1);
      }
    }

    let taken = 0;
    for (const c of candidates) {
      if (taken >= MAX_PER_RUN) break;

      const sec = subSectorOf(c.ticker);
      if ((openBySector.get(sec) || 0) >= MAX_PER_SUB_SECTOR) continue;

      // Fill at the NEXT session's open, never at the close that produced the
      // signal.
      const fillIdx = c.iNow + 1;
      if (fillIdx >= c.quotes.length) continue;
      const fillBar = c.quotes[fillIdx];

      const size = 5000;
      const vol =
        c.quotes.slice(Math.max(0, fillIdx - 20), fillIdx).reduce((s, q) => s + (q.volume || 0), 0) / 20;
      const tier = costTier(vol);
      const entryCost = (size * COST_BPS[tier]) / 10_000;
      const qty = size / fillBar.open;

      const bFillIdx = indexOnOrBefore(bq, new Date(fillBar.date).getTime());
      const bFill = bFillIdx >= 0 ? bq[bFillIdx].close : null;
      if (!bFill) continue;

      // Walk forward bar by bar to the exit, checking the same rules the live
      // path checks, in the same order.
      let exitIdx = null;
      let reason = null;
      let mae = 0;
      let mfe = 0;

      for (let k = fillIdx + 1; k < c.quotes.length; k++) {
        const bar = c.quotes[k];
        const bIdx = indexOnOrBefore(bq, new Date(bar.date).getTime());
        if (bIdx < 0) continue;

        const stockPct = (bar.close - fillBar.open) / fillBar.open;
        const benchPct = (bq[bIdx].close - bFill) / bFill;
        const excess = stockPct - benchPct;

        if (excess < mae) mae = excess;
        if (excess > mfe) mfe = excess;

        if (excess <= STOP) reason = 'stop';
        else if (excess >= TARGET) reason = 'target';
        else if (k - fillIdx >= HOLD_DAYS) reason = 'time';

        if (reason) {
          // Exit at the next open, symmetric with the entry.
          exitIdx = k + 1 < c.quotes.length ? k + 1 : null;
          break;
        }
      }

      if (exitIdx === null) continue;

      const exitBar = c.quotes[exitIdx];
      const exitCost = (qty * exitBar.open * COST_BPS[tier]) / 10_000;
      const bExitIdx = indexOnOrBefore(bq, new Date(exitBar.date).getTime());
      if (bExitIdx < 0) continue;

      const gross = qty * exitBar.open;
      const pnl = gross - exitCost - (size + entryCost);
      const stockPct = (exitBar.open - fillBar.open) / fillBar.open;
      const benchPct = (bq[bExitIdx].close - bFill) / bFill;

      trades.push({
        ticker: c.ticker,
        cluster: today,
        sector: sec,
        signal_date: today,
        fill_date: fillBar.date,
        exit_date: exitBar.date,
        reason,
        days_held: exitIdx - fillIdx,
        pnl: round(pnl),
        pct: round(((pnl / (size + entryCost)) * 100), 3),
        excess_pct: round((stockPct - benchPct) * 100, 3),
        mae_pct: round(mae * 100, 3),
        mfe_pct: round(mfe * 100, 3),
        costs: round(entryCost + exitCost),
      });

      lastCall.set(c.ticker, t);
      openBySector.set(sec, (openBySector.get(sec) || 0) + 1);
      taken += 1;
    }
  }

  if (trades.length === 0) {
    return { ok: true, data: { trades: 0, note: 'no trades met the frozen thresholds over this window' } };
  }

  const excess = trades.map((t) => t.excess_pct);
  const wins = excess.filter((x) => x > 0).length;
  const mean = excess.reduce((s, x) => s + x, 0) / excess.length;
  const sorted = [...excess].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const sd = Math.sqrt(excess.reduce((s, x) => s + (x - mean) ** 2, 0) / excess.length);

  // Same-day signals are one bet, not several. Counting them separately is how
  // a sample of forty becomes a claimed sample of a hundred.
  const clusters = new Set(trades.map((t) => t.cluster)).size;

  const byReason = {};
  for (const t of trades) byReason[t.reason] = (byReason[t.reason] || 0) + 1;

  const byStrategyDay = {};
  for (const t of trades) {
    const m = t.fill_date.slice(0, 7);
    if (!byStrategyDay[m]) byStrategyDay[m] = [];
    byStrategyDay[m].push(t.excess_pct);
  }
  const monthly = Object.fromEntries(
    Object.entries(byStrategyDay).map(([m, xs]) => [
      m,
      { n: xs.length, mean: round(xs.reduce((s, x) => s + x, 0) / xs.length, 2) },
    ])
  );

  return {
    ok: true,
    data: {
      window: range,
      trades: trades.length,
      effective_sample: clusters,
      hit_rate_pct: round((wins / trades.length) * 100, 1),
      mean_excess_pct: round(mean, 3),
      median_excess_pct: round(median, 3),
      stdev_excess_pct: round(sd, 3),
      // Mean over standard deviation per trade — not an annualised Sharpe, and
      // labelled so nobody reads it as one.
      mean_over_sd: sd > 0 ? round(mean / sd, 3) : null,
      total_costs: round(trades.reduce((s, t) => s + t.costs, 0)),
      avg_days_held: round(trades.reduce((s, t) => s + t.days_held, 0) / trades.length, 1),
      exits: byReason,
      by_month: monthly,
      worst: sorted[0],
      best: sorted[sorted.length - 1],
      caveats: [
        'Survivors only — delisted names are absent, which biases this upward.',
        clusters + ' independent days across ' + trades.length +
          ' trades; treating them as ' + trades.length + ' independent trials overstates confidence.',
        'Parameters were frozen, not fitted, so this is out-of-sample for the settings — but the universe was chosen with hindsight.',
      ],
      sample: trades.slice(0, 8),
    },
  };
}

if (require.main === module) {
  backtest({ range: process.argv[2] || '1y' })
    .then((r) => {
      if (!r.ok) {
        console.error(r.error.message);
        process.exit(1);
      }
      const d = r.data;
      console.log('\n' + JSON.stringify({ ...d, sample: undefined }, null, 1));
      console.log('\nfirst trades:');
      for (const t of d.sample || []) {
        console.log(
          '  ' + t.fill_date + '  ' + t.ticker.padEnd(6) + t.reason.padEnd(7) +
          String(t.days_held).padStart(2) + 'd  ' + String(t.excess_pct).padStart(7) + '%'
        );
      }
      process.exit(0);
    })
    .catch((e) => {
      console.error('[backtest] failed:', e.message);
      process.exit(1);
    });
}

module.exports = { backtest };
