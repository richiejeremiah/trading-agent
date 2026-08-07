'use strict';

/**
 * Reconcile local paper_positions vs broker.getPositions().
 * With PaperBroker (same SSOT) diffs are empty when in sync.
 */

const { getBroker } = require('../broker');

function normalizeQty(n) {
  return Math.round(Number(n) * 1e6) / 1e6;
}

function loadLocalPositions(db) {
  const rows = db
    .prepare(
      `SELECT ticker, quantity, avg_cost FROM paper_positions WHERE quantity != 0 ORDER BY ticker`
    )
    .all();
  return rows.map((r) => ({
    symbol: String(r.ticker).toUpperCase(),
    qty: Number(r.quantity),
    avg_cost: Number(r.avg_cost),
  }));
}

/**
 * @param {object} [opts]
 * @param {object} [opts.db]
 * @param {object} [opts.broker]
 * @returns {Promise<{
 *   inSync: boolean,
 *   diffs: Array<{ symbol: string, field: string, local: any, broker: any }>,
 *   local: object[],
 *   broker: object[]
 * }>}
 */
async function reconcilePositions(opts = {}) {
  const db = opts.db || require('../../database').getDb();
  const broker = opts.broker || getBroker(opts.brokerOpts || {});

  const local = loadLocalPositions(db);
  const brokerPositions = await broker.getPositions();
  const brokerNorm = (brokerPositions || []).map((p) => ({
    symbol: String(p.symbol || p.ticker || '')
      .trim()
      .toUpperCase(),
    qty: Number(p.qty != null ? p.qty : p.quantity),
    avg_cost: Number(p.avg_cost != null ? p.avg_cost : p.avgCost || 0),
  }));

  const localMap = new Map(local.map((p) => [p.symbol, p]));
  const brokerMap = new Map(brokerNorm.map((p) => [p.symbol, p]));
  const symbols = new Set([...localMap.keys(), ...brokerMap.keys()]);
  const diffs = [];

  for (const symbol of [...symbols].sort()) {
    const L = localMap.get(symbol);
    const B = brokerMap.get(symbol);
    if (!L) {
      diffs.push({
        symbol,
        field: 'presence',
        local: null,
        broker: { qty: B.qty, avg_cost: B.avg_cost },
      });
      continue;
    }
    if (!B) {
      diffs.push({
        symbol,
        field: 'presence',
        local: { qty: L.qty, avg_cost: L.avg_cost },
        broker: null,
      });
      continue;
    }
    if (normalizeQty(L.qty) !== normalizeQty(B.qty)) {
      diffs.push({ symbol, field: 'qty', local: L.qty, broker: B.qty });
    }
    if (Math.abs(Number(L.avg_cost) - Number(B.avg_cost)) > 1e-6) {
      diffs.push({
        symbol,
        field: 'avg_cost',
        local: L.avg_cost,
        broker: B.avg_cost,
      });
    }
  }

  return {
    inSync: diffs.length === 0,
    diffs,
    local,
    broker: brokerNorm,
  };
}

module.exports = {
  reconcilePositions,
  loadLocalPositions,
};
