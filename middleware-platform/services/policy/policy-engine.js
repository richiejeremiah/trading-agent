'use strict';

/**
 * Policy engine — is this proposed action permitted?
 * Decision: ALLOW | REJECT | REQUIRE_HUMAN_CONFIRMATION
 * LLM cannot override.
 */

const { validateProposedActionShape } = require('./proposed-action');

const DECISIONS = {
  ALLOW: 'ALLOW',
  REJECT: 'REJECT',
  REQUIRE_HUMAN_CONFIRMATION: 'REQUIRE_HUMAN_CONFIRMATION',
};

function numEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {object} action - PROPOSED_ACTION
 * @param {object} [ctx]
 * @param {boolean} [ctx.humanConfirmed]
 * @param {string[]} [ctx.blockedSymbols]
 * @param {number} [ctx.confirmNotionalThreshold]
 */
function evaluate(action, ctx = {}) {
  const reasons = [];
  const shape = validateProposedActionShape(action);
  if (!shape.ok) {
    return { decision: DECISIONS.REJECT, reasons: shape.reasons };
  }

  const symbol = String(action.symbol).toUpperCase();
  const blocked = new Set(
    (ctx.blockedSymbols || String(process.env.POLICY_BLOCKED_SYMBOLS || '').split(','))
      .map((s) => String(s).trim().toUpperCase())
      .filter(Boolean)
  );
  if (blocked.has(symbol)) {
    reasons.push(`symbol ${symbol} is policy-blocked`);
    return { decision: DECISIONS.REJECT, reasons };
  }

  const intent = String(action.intent || '').toLowerCase();
  if (intent === 'research_preview' || intent === 'simulate') {
    reasons.push(`intent ${intent} is not executable`);
    return { decision: DECISIONS.REJECT, reasons };
  }

  const confirmThreshold =
    ctx.confirmNotionalThreshold != null
      ? Number(ctx.confirmNotionalThreshold)
      : numEnv('POLICY_CONFIRM_NOTIONAL', 25000);

  let notional = action.notional != null ? Number(action.notional) : null;
  if (
    (notional == null || !Number.isFinite(notional)) &&
    action.qty != null &&
    action.price != null
  ) {
    notional = Number(action.qty) * Number(action.price);
  }

  if (
    Number.isFinite(notional) &&
    notional >= confirmThreshold &&
    !ctx.humanConfirmed
  ) {
    reasons.push(
      `notional $${notional.toFixed(2)} requires human confirmation (threshold $${confirmThreshold})`
    );
    return { decision: DECISIONS.REQUIRE_HUMAN_CONFIRMATION, reasons };
  }

  if (ctx.requireHuman && !ctx.humanConfirmed) {
    reasons.push('policy requires human confirmation');
    return { decision: DECISIONS.REQUIRE_HUMAN_CONFIRMATION, reasons };
  }

  reasons.push('policy checks passed');
  return { decision: DECISIONS.ALLOW, reasons };
}

module.exports = {
  evaluate,
  DECISIONS,
};
