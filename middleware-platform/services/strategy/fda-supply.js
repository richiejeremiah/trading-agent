'use strict';

/**
 * FDA supply-disruption strategy — normalize event → proposed short.
 * Stub private-company → ticker mapping (no live FDA API here).
 */

const { createProposedAction } = require('../policy/proposed-action');

/** Stub: private / facility name → public ticker (or null if unmapped). */
const PRIVATE_TO_TICKER = Object.freeze({
  'acme biologics': 'ACME',
  'northwind pharma': 'NWPH',
  'helio therapeutics private': 'HLIO',
  'summit sterile fill': 'SMST',
});

function numEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Resolve ticker from event.symbol, event.ticker, or private-name stub map.
 * @returns {string|null}
 */
function resolveTicker(event = {}) {
  const direct = String(event.symbol || event.ticker || '')
    .trim()
    .toUpperCase();
  if (direct) return direct;

  const privateName = String(
    event.private_company || event.company || event.facility || event.name || ''
  )
    .trim()
    .toLowerCase();
  if (!privateName) return null;
  const mapped = PRIVATE_TO_TICKER[privateName];
  return mapped ? String(mapped).toUpperCase() : null;
}

/**
 * Normalize FDA supply / shortage / warning event into a short PROPOSED_ACTION.
 * @param {object} event
 * @param {object} [opts]
 * @returns {object|null}
 */
function proposeFromFdaEvent(event = {}, opts = {}) {
  const symbol = resolveTicker(event);
  if (!symbol) return null;

  const severity = String(event.severity || event.class || 'warning')
    .trim()
    .toLowerCase();
  // Soft events can be ignored unless force
  if (
    !opts.force &&
    (severity === 'info' || severity === 'cleared' || severity === 'resolved')
  ) {
    return null;
  }

  const notional =
    event.notional != null
      ? Number(event.notional)
      : opts.notional != null
        ? Number(opts.notional)
        : numEnv('FDA_DEFAULT_NOTIONAL', 2500);

  return createProposedAction({
    symbol,
    side: 'sell',
    intent: 'open_short',
    reason: `FDA supply event (${severity}): ${String(event.summary || event.title || event.type || 'supply disruption').slice(0, 200)}`,
    notional: Number.isFinite(notional) && notional > 0 ? notional : 2500,
    qty: event.qty != null ? Number(event.qty) : undefined,
    price: event.price != null ? Number(event.price) : undefined,
    exchange: event.exchange || 'NASDAQ',
    avg_daily_volume: event.avg_daily_volume,
  });
}

module.exports = {
  PRIVATE_TO_TICKER,
  resolveTicker,
  proposeFromFdaEvent,
};
