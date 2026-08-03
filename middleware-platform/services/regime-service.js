'use strict';

/**
 * What kind of market it was when a trade was taken.
 *
 * Without this you learn whether a strategy worked, never when. Mean reversion
 * typically behaves differently in a trending market than a choppy one, and a
 * strategy that only works in one regime looks like a weak strategy overall
 * rather than a conditional one — which is a materially different finding.
 *
 * Deliberately crude: two axes, computed from the benchmark alone, recorded at
 * signal time and never revised. A sophisticated regime model would need its
 * own validation, and this is metadata for later questions rather than an input
 * to any decision.
 *
 * Direction comes from the benchmark against its own 50-day average. Volatility
 * from the annualised standard deviation of daily returns over 20 sessions,
 * split at 18% — roughly the long-run average for a sector ETF, so "high" means
 * higher than usual rather than high in absolute terms.
 */

const { getHistoricalPrices } = require('./market-data-client');

const BENCHMARK = (process.env.PAPER_BENCHMARK || 'XLV').toUpperCase();
const VOL_SPLIT = Number(process.env.REGIME_VOL_SPLIT || 0.18);
const TREND_BAND = Number(process.env.REGIME_TREND_BAND || 0.02);

function mean(xs) {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function stdev(xs) {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

/**
 * A label like "bull_low_vol". Null when there is not enough history to say —
 * an unknown regime is recorded as unknown rather than guessed, since a wrong
 * label is worse than a missing one for a field whose only purpose is to
 * partition results later.
 */
async function currentRegime() {
  const series = await getHistoricalPrices(BENCHMARK, { range: '6mo', interval: '1d' });
  if (!series || !series.ok) return { ok: true, data: { regime: null, reason: 'no benchmark history' } };

  const quotes = (series.data.quotes || []).filter((q) => Number.isFinite(q.close));
  if (quotes.length < 50) {
    return { ok: true, data: { regime: null, reason: 'fewer than 50 sessions available' } };
  }

  const closes = quotes.map((q) => q.close);
  const last = closes[closes.length - 1];
  const ma50 = mean(closes.slice(-50));

  const distance = (last - ma50) / ma50;
  const direction = distance > TREND_BAND ? 'bull' : distance < -TREND_BAND ? 'bear' : 'sideways';

  const returns = [];
  for (let i = closes.length - 20; i < closes.length; i++) {
    if (i > 0) returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  const annualised = stdev(returns) * Math.sqrt(252);
  const vol = annualised > VOL_SPLIT ? 'high_vol' : 'low_vol';

  return {
    ok: true,
    data: {
      regime: direction + '_' + vol,
      direction,
      vol,
      distance_from_ma50_pct: Number((distance * 100).toFixed(2)),
      annualised_vol_pct: Number((annualised * 100).toFixed(1)),
      benchmark: BENCHMARK,
    },
  };
}

module.exports = { currentRegime, BENCHMARK };
