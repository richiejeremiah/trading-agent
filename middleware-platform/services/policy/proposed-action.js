'use strict';

/**
 * PROPOSED_ACTION shape — strategy/agent output only.
 * Never a raw broker order. Policy + risk decide ALLOW/REJECT/CONFIRM.
 *
 * {
 *   symbol: string,          // e.g. "AAPL"
 *   side: 'buy' | 'sell',
 *   intent: string,          // e.g. 'open_long' | 'close' | 'hedge' | 'research_preview'
 *   reason: string,          // human/strategy rationale
 *   notional?: number,       // USD
 *   qty?: number,
 *   // optional context for risk
 *   price?: number,
 *   exchange?: string,       // e.g. 'NYSE' | 'NASDAQ' | 'OTC'
 *   avg_daily_volume?: number,
 * }
 */

const SIDES = new Set(['buy', 'sell']);

function createProposedAction(partial = {}) {
  return {
    symbol: partial.symbol != null ? String(partial.symbol).trim().toUpperCase() : '',
    side: partial.side != null ? String(partial.side).trim().toLowerCase() : '',
    intent: partial.intent != null ? String(partial.intent).trim() : '',
    reason: partial.reason != null ? String(partial.reason).trim() : '',
    notional: partial.notional != null ? Number(partial.notional) : undefined,
    qty: partial.qty != null ? Number(partial.qty) : undefined,
    price: partial.price != null ? Number(partial.price) : undefined,
    exchange: partial.exchange != null ? String(partial.exchange).trim().toUpperCase() : undefined,
    avg_daily_volume:
      partial.avg_daily_volume != null ? Number(partial.avg_daily_volume) : undefined,
  };
}

function validateProposedActionShape(action) {
  const reasons = [];
  if (!action || typeof action !== 'object') {
    return { ok: false, reasons: ['action must be an object'] };
  }
  if (!action.symbol) reasons.push('symbol is required');
  if (!SIDES.has(String(action.side || '').toLowerCase())) {
    reasons.push("side must be 'buy' or 'sell'");
  }
  if (!action.intent) reasons.push('intent is required');
  if (!action.reason) reasons.push('reason is required');
  const hasNotional = action.notional != null && Number.isFinite(Number(action.notional));
  const hasQty = action.qty != null && Number.isFinite(Number(action.qty));
  if (!hasNotional && !hasQty) reasons.push('notional or qty is required');
  if (hasNotional && Number(action.notional) <= 0) reasons.push('notional must be > 0');
  if (hasQty && Number(action.qty) <= 0) reasons.push('qty must be > 0');
  return { ok: reasons.length === 0, reasons };
}

module.exports = {
  createProposedAction,
  validateProposedActionShape,
  SIDES,
};
