'use strict';

/**
 * Whether any of this is working.
 *
 * The scorecard this replaces counted a call right if the price went up. That is
 * wrong in a way that flatters: a buy that gained two percent while the sector
 * gained five lost money against the alternative of buying the sector and doing
 * nothing. Every number here is relative to the benchmark, because the absolute
 * one answers a question nobody should be asking.
 *
 * Three things it reports, in order of how much they matter:
 *
 *   Accepted versus skipped. The skipped calls are the control group. If the
 *   ones passed on did as well as the ones taken, the filtering is what is
 *   adding value — or nothing is. This is the comparison most track records
 *   quietly omit, because it is the one that can embarrass them.
 *
 *   Per strategy. Averaging a strategy that works with one that does not
 *   produces a number describing neither.
 *
 *   Portfolio against buy-and-hold. What the wallet did, against having bought
 *   the sector on day one and gone away.
 *
 * And the sample size caveat, said every time, because a hit rate on eleven
 * calls is noise and reads exactly like a result.
 */

const { getDb } = require('../database');
const { getCurrentPrice, getHistoricalPrices } = require('./market-data-client');

const BENCHMARK = (process.env.PAPER_BENCHMARK || 'XLV').toUpperCase();

/** Below this, any figure is noise. Stated rather than implied. */
const MEANINGFUL_SAMPLE = 30;
const CONFIDENT_SAMPLE = 100;

function pct(from, to) {
  if (!from || !to) return null;
  return (to - from) / from;
}

/**
 * Excess return over the benchmark for one recommendation.
 *
 * Sign-adjusted: a sell that fell more than the sector was right, so its excess
 * is the negative of the price move.
 */
function excessReturn(rec, window) {
  const priceCol = 'price_' + window;
  const benchCol = 'bench_' + window;

  const stock = pct(rec.price_at_rec, rec[priceCol]);
  const bench = pct(rec.bench_at_rec, rec[benchCol]);
  if (stock === null || bench === null) return null;

  const excess = stock - bench;
  return rec.side === 'sell' ? -excess : excess;
}

function summarise(rows, window) {
  const scored = rows
    .map((r) => ({ rec: r, excess: excessReturn(r, window) }))
    .filter((x) => x.excess !== null);

  if (scored.length === 0) {
    return { n: 0, hit_rate: null, mean_excess_pct: null, median_excess_pct: null };
  }

  const wins = scored.filter((x) => x.excess > 0).length;
  const values = scored.map((x) => x.excess).sort((a, b) => a - b);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const mid = Math.floor(values.length / 2);
  const median = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;

  return {
    n: scored.length,
    hit_rate: Number(((wins / scored.length) * 100).toFixed(1)),
    mean_excess_pct: Number((mean * 100).toFixed(2)),
    median_excess_pct: Number((median * 100).toFixed(2)),
    best_pct: Number((values[values.length - 1] * 100).toFixed(2)),
    worst_pct: Number((values[0] * 100).toFixed(2)),
  };
}

function caveatFor(n) {
  if (n === 0) return 'Nothing scored yet. A call needs seven days before it can be judged.';
  if (n < MEANINGFUL_SAMPLE) {
    return n + ' scored calls is noise. Around ' + MEANINGFUL_SAMPLE +
      ' before a pattern is worth looking at, and ' + CONFIDENT_SAMPLE +
      ' across a bad month as well as a good one before it is evidence.';
  }
  if (n < CONFIDENT_SAMPLE) {
    return n + ' scored calls is enough to notice a pattern and not enough to trust it. ' +
      CONFIDENT_SAMPLE + ' spanning different market conditions is the bar.';
  }
  return null;
}

/**
 * What the wallet did against having bought the benchmark and done nothing.
 *
 * Fills in the wallet's opening benchmark price on first use — the column was
 * added by migration 007 and nothing populates it at wallet creation, because
 * an HTTP call inside wallet creation would make enrolment fail when the market
 * data provider is down.
 */
async function portfolioVsBenchmark(identityId) {
  const db = getDb();
  const wallet = db.prepare('SELECT * FROM agent_wallet WHERE identity_id = ?').get(identityId);
  if (!wallet) return null;

  let benchAtOpen = wallet.bench_at_open;

  if (benchAtOpen === null || benchAtOpen === undefined) {
    const opened = new Date(wallet.created_at);
    const ageDays = Math.floor((Date.now() - opened.getTime()) / 86400000);
    const range = ageDays > 300 ? '2y' : ageDays > 150 ? '1y' : ageDays > 60 ? '6mo' : '3mo';

    const series = await getHistoricalPrices(BENCHMARK, { range, interval: '1d' });
    if (series && series.ok) {
      const quotes = series.data.quotes || [];
      let best = null;
      let bestT = -Infinity;
      for (const q of quotes) {
        const t = new Date(q.date).getTime();
        if (t <= opened.getTime() && t > bestT) {
          best = q;
          bestT = t;
        }
      }
      if (best) {
        benchAtOpen = best.close;
        db.prepare('UPDATE agent_wallet SET bench_symbol = ?, bench_at_open = ? WHERE identity_id = ?').run(
          BENCHMARK,
          benchAtOpen,
          identityId
        );
      }
    }
  }

  const nowQuote = await getCurrentPrice(BENCHMARK);
  const benchNow = nowQuote && nowQuote.ok ? nowQuote.data.price : null;

  // Portfolio value, counting only positions in the wallet's currency — the
  // same rule getWalletSummary uses, for the same reason.
  const walletCurrency = (wallet.currency || 'USD').toUpperCase();
  const positions = db
    .prepare('SELECT ticker, quantity, avg_cost FROM paper_positions WHERE identity_id IS ? AND quantity > 0')
    .all(identityId);

  let holdings = 0;
  let uncounted = 0;

  for (const p of positions) {
    const q = await getCurrentPrice(p.ticker);
    if (!q || !q.ok || (q.data.currency || '').toUpperCase() !== walletCurrency) {
      uncounted += 1;
      continue;
    }
    holdings += p.quantity * q.data.price;
  }

  const total = uncounted === 0 ? wallet.cash + holdings : null;
  const portfolioReturn = total === null ? null : pct(wallet.starting_balance, total);
  const benchReturn = pct(benchAtOpen, benchNow);

  return {
    opened: wallet.created_at,
    benchmark: BENCHMARK,
    portfolio_value: total === null ? null : Number(total.toFixed(2)),
    portfolio_return_pct: portfolioReturn === null ? null : Number((portfolioReturn * 100).toFixed(2)),
    benchmark_return_pct: benchReturn === null ? null : Number((benchReturn * 100).toFixed(2)),
    excess_pct:
      portfolioReturn === null || benchReturn === null
        ? null
        : Number(((portfolioReturn - benchReturn) * 100).toFixed(2)),
    uncounted_positions: uncounted,
    // Said plainly, because "up 3%" invites the wrong conclusion when the
    // sector was up 4%.
    verdict:
      portfolioReturn === null || benchReturn === null
        ? 'Not comparable yet.'
        : Math.abs(portfolioReturn - benchReturn) < 0.0005
          ? "Level with " + BENCHMARK + " — no difference either way yet."
          : portfolioReturn > benchReturn
          ? 'Ahead of simply owning ' + BENCHMARK + '.'
          : 'Behind simply owning ' + BENCHMARK + ' — the sector would have done better.',
  };
}

async function getMetrics(identityId, { window = '7d' } = {}) {
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT id, ticker, side, status, strategy, price_at_rec, bench_at_rec,
              price_1d, price_7d, price_30d, bench_1d, bench_7d, bench_30d
       FROM agent_recommendation
       WHERE identity_id IS ?`
    )
    .all(identityId ?? null);

  const overall = summarise(rows, window);

  // The comparison that matters most, and the one most track records omit.
  const accepted = summarise(rows.filter((r) => r.status === 'accepted'), window);
  const skipped = summarise(rows.filter((r) => r.status === 'skipped'), window);

  const byStrategy = {};
  for (const s of new Set(rows.map((r) => r.strategy || 'unlabelled'))) {
    byStrategy[s] = summarise(rows.filter((r) => (r.strategy || 'unlabelled') === s), window);
  }

  const portfolio = await portfolioVsBenchmark(identityId);

  let filtering = null;
  if (accepted.n >= 5 && skipped.n >= 5) {
    const gap = accepted.mean_excess_pct - skipped.mean_excess_pct;
    filtering =
      gap > 0
        ? 'The calls you took beat the ones you passed on by ' + gap.toFixed(2) + ' points.'
        : 'The calls you passed on did ' + Math.abs(gap).toFixed(2) +
          ' points better than the ones you took — the filtering is costing, not helping.';
  }

  return {
    ok: true,
    data: {
      window,
      benchmark: BENCHMARK,
      total_recommendations: rows.length,
      overall,
      accepted,
      skipped,
      by_strategy: byStrategy,
      filtering_verdict: filtering,
      portfolio,
      caveat: caveatFor(overall.n),
    },
  };
}

module.exports = { getMetrics, portfolioVsBenchmark, BENCHMARK, MEANINGFUL_SAMPLE };
