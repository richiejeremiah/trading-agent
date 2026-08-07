'use strict';

/**
 * Execution service — PROPOSED_ACTION → policy/risk pipeline → broker submit.
 * Never calls broker on REJECT / REQUIRE_HUMAN_CONFIRMATION.
 * Idempotency via client_order_id.
 */

const crypto = require('crypto');
const { evaluateOrderPipeline, DECISIONS } = require('../policy/order-pipeline');
const { getBroker } = require('../broker');
const logger = require('../logger');

function buildIdempotencyKey(action, ctx = {}) {
  if (ctx.idempotencyKey) return String(ctx.idempotencyKey);
  if (ctx.client_order_id) return String(ctx.client_order_id);
  if (action && action.client_order_id) return String(action.client_order_id);
  const base = [
    action?.symbol || '',
    action?.side || '',
    action?.intent || '',
    action?.notional != null ? action.notional : '',
    action?.qty != null ? action.qty : '',
    ctx.session_id || '',
  ].join('|');
  return `exec-${crypto.createHash('sha256').update(base).digest('hex').slice(0, 24)}`;
}

/**
 * @param {object} action PROPOSED_ACTION
 * @param {object} [ctx] pipeline + broker context
 * @param {object} [ctx.broker] inject broker (tests)
 * @returns {Promise<{
 *   decision: string,
 *   submitted: boolean,
 *   reasons: string[],
 *   order: object|null,
 *   client_order_id: string|null,
 *   pipeline: object
 * }>}
 */
async function executeProposedAction(action, ctx = {}) {
  const pipeline = evaluateOrderPipeline(action, ctx);
  const clientOrderId = buildIdempotencyKey(action, ctx);

  if (pipeline.decision !== DECISIONS.ALLOW) {
    logger.info('execution_skipped', {
      decision: pipeline.decision,
      symbol: action?.symbol,
      reasons: pipeline.reasons,
      client_order_id: clientOrderId,
    });
    return {
      decision: pipeline.decision,
      submitted: false,
      reasons: [...pipeline.reasons],
      order: null,
      client_order_id: clientOrderId,
      pipeline,
    };
  }

  const broker = ctx.broker || getBroker(ctx.brokerOpts || {});
  const orderInput = {
    symbol: action.symbol,
    side: action.side,
    qty: action.qty,
    notional: action.notional,
    price: action.price != null ? action.price : ctx.price,
    type: ctx.type || 'market',
    limit_price: ctx.limit_price,
    client_order_id: clientOrderId,
    wallet_id: ctx.walletId || ctx.wallet_id,
    session_id: ctx.session_id || ctx.sessionId || null,
    actor: ctx.actor || { type: 'execution_service', id: 'system' },
  };

  const order = await broker.submitOrder(orderInput);

  logger.info('execution_submitted', {
    order_id: order?.id,
    symbol: order?.symbol,
    side: order?.side,
    client_order_id: clientOrderId,
  });

  return {
    decision: DECISIONS.ALLOW,
    submitted: true,
    reasons: [...pipeline.reasons],
    order,
    client_order_id: clientOrderId,
    pipeline,
  };
}

module.exports = {
  executeProposedAction,
  buildIdempotencyKey,
  DECISIONS,
};
