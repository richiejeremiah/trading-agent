'use strict';

/**
 * PEAD (Post-Earnings Announcement Drift) — arithmetic SUE/surprise only.
 * No LLM math. Outputs PROPOSED_ACTION when |surprise| >= threshold.
 */

const { createProposedAction } = require('../policy/proposed-action');

const DEFAULT_THRESHOLD = 1.0;

/**
 * Standardized unexpected earnings (SUE):
 *   surprise = (actual - consensus) / stdev
 *
 * @param {{ actual: number, consensus: number, stdev: number }} input
 * @returns {number}
 */
function computeSurprise({ actual, consensus, stdev }) {
  const a = Number(actual);
  const c = Number(consensus);
  const s = Number(stdev);
  if (![a, c, s].every(Number.isFinite)) {
    const err = new Error('actual, consensus, and stdev must be finite numbers');
    err.code = 'INVALID_SUE_INPUT';
    throw err;
  }
  if (s === 0) {
    const err = new Error('stdev must be non-zero');
    err.code = 'INVALID_SUE_INPUT';
    throw err;
  }
  return (a - c) / s;
}

function numEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {object} event
 * @param {string} event.symbol
 * @param {number} event.actual
 * @param {number} event.consensus
 * @param {number} event.stdev
 * @param {number} [event.price]
 * @param {number} [event.notional]
 * @param {number} [event.qty]
 * @param {string} [event.exchange]
 * @param {number} [event.avg_daily_volume]
 * @param {object} [opts]
 * @param {number} [opts.threshold] absolute SUE threshold (default 1.0 or PEAD_SURPRISE_THRESHOLD)
 * @returns {object|null} PROPOSED_ACTION or null if below threshold
 */
function proposeFromEarnings(event = {}, opts = {}) {
  const symbol = String(event.symbol || '')
    .trim()
    .toUpperCase();
  if (!symbol) return null;

  const surprise = computeSurprise({
    actual: event.actual,
    consensus: event.consensus,
    stdev: event.stdev,
  });

  const threshold =
    opts.threshold != null
      ? Number(opts.threshold)
      : numEnv('PEAD_SURPRISE_THRESHOLD', DEFAULT_THRESHOLD);

  if (!Number.isFinite(threshold) || Math.abs(surprise) < threshold) {
    return null;
  }

  const side = surprise > 0 ? 'buy' : 'sell';
  const intent = surprise > 0 ? 'open_long' : 'open_short';
  const notional =
    event.notional != null
      ? Number(event.notional)
      : numEnv('PEAD_DEFAULT_NOTIONAL', 5000);
  const qty = event.qty != null ? Number(event.qty) : undefined;

  return createProposedAction({
    symbol,
    side,
    intent,
    reason: `PEAD SUE=${surprise.toFixed(4)} (threshold=${threshold})`,
    notional: Number.isFinite(notional) && notional > 0 ? notional : 5000,
    qty: qty != null && Number.isFinite(qty) && qty > 0 ? qty : undefined,
    price: event.price != null ? Number(event.price) : undefined,
    exchange: event.exchange,
    avg_daily_volume: event.avg_daily_volume,
    // attach for callers/tests (not required by shape validator)
    sue: surprise,
  });
}

module.exports = {
  computeSurprise,
  proposeFromEarnings,
  DEFAULT_THRESHOLD,
};
