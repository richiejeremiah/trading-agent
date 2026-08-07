'use strict';

/**
 * PaperBroker — local paper_orders / paper_positions + paper-wallet cash on fills.
 * Simple market fill at provided `price` (no live market feed on this path).
 */

const crypto = require('crypto');
const { BrokerInterface } = require('./broker-interface');
const walletWriter = require('../paper-wallet-writer');
const logger = require('../logger');

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function roundQty(n) {
  return Math.round(Number(n) * 1e6) / 1e6;
}

class PaperBroker extends BrokerInterface {
  constructor(opts = {}) {
    super();
    this.walletId =
      opts.walletId ||
      String(process.env.PAPER_WALLET_ID || 'default').trim() ||
      'default';
    this._db = opts.db || null;
  }

  _getDb() {
    return this._db || require('../../database').getDb();
  }

  async getAccount() {
    walletWriter.assertPaperMode();
    const bal = walletWriter.getBalance({ walletId: this.walletId });
    const positions = await this.getPositions();
    let positionsCost = 0;
    for (const p of positions) {
      positionsCost += Number(p.qty) * Number(p.avg_cost || 0);
    }
    const cash = Number(bal.cash_balance);
    return {
      cash,
      equity: round2(cash + positionsCost),
      buying_power: cash,
      currency: 'USD',
      wallet_id: this.walletId,
      positions_count: positions.length,
    };
  }

  async getPositions() {
    const db = this._getDb();
    const rows = db
      .prepare(
        `SELECT ticker, quantity, avg_cost, updated_at FROM paper_positions WHERE quantity != 0 ORDER BY ticker`
      )
      .all();
    return rows.map((r) => ({
      symbol: r.ticker,
      qty: Number(r.quantity),
      avg_cost: Number(r.avg_cost),
      market_value: null,
      updated_at: r.updated_at,
    }));
  }

  /**
   * Simple market fill. Requires `price` (or limit_price for type=limit treated as fill).
   */
  async submitOrder(order = {}) {
    walletWriter.assertPaperMode();
    const symbol = String(order.symbol || order.ticker || '')
      .trim()
      .toUpperCase();
    const side = String(order.side || '')
      .trim()
      .toLowerCase();
    if (!symbol) {
      const err = new Error('symbol is required');
      err.code = 'INVALID_ORDER';
      throw err;
    }
    if (side !== 'buy' && side !== 'sell') {
      const err = new Error("side must be 'buy' or 'sell'");
      err.code = 'INVALID_ORDER';
      throw err;
    }

    const price = Number(order.price != null ? order.price : order.limit_price);
    if (!Number.isFinite(price) || price <= 0) {
      const err = new Error('price is required for paper market fill');
      err.code = 'INVALID_ORDER';
      throw err;
    }

    let qty = order.qty != null ? Number(order.qty) : null;
    let notional = order.notional != null ? Number(order.notional) : null;
    if (qty != null && Number.isFinite(qty) && qty > 0) {
      notional = round2(qty * price);
    } else if (notional != null && Number.isFinite(notional) && notional > 0) {
      qty = roundQty(notional / price);
      notional = round2(qty * price);
    } else {
      const err = new Error('qty or notional is required');
      err.code = 'INVALID_ORDER';
      throw err;
    }
    if (!(qty > 0) || !(notional > 0)) {
      const err = new Error('computed qty/notional invalid');
      err.code = 'INVALID_ORDER';
      throw err;
    }

    const clientOrderId =
      order.client_order_id ||
      order.clientOrderId ||
      `pb-${crypto.randomBytes(8).toString('hex')}`;
    const walletId = order.wallet_id || this.walletId;
    const sessionId = order.session_id || null;
    const actor = order.actor || { type: 'paper_broker', id: 'system' };

    const db = this._getDb();

    const existing = db
      .prepare(`SELECT * FROM paper_orders WHERE client_order_id = ?`)
      .get(clientOrderId);
    if (existing) {
      return this._rowToOrder(existing);
    }

    const run = db.transaction(() => {
      // Sell: ensure position qty
      if (side === 'sell') {
        const pos = db
          .prepare(`SELECT quantity, avg_cost FROM paper_positions WHERE ticker = ?`)
          .get(symbol);
        const have = pos ? Number(pos.quantity) : 0;
        if (have + 1e-9 < qty) {
          const err = new Error(
            `Insufficient position: have ${have}, sell ${qty} ${symbol}`
          );
          err.code = 'INSUFFICIENT_POSITION';
          throw err;
        }
      }

      const insert = db
        .prepare(
          `INSERT INTO paper_orders (
            session_id, ticker, side, notional, qty, status, raw_json,
            filled_qty, filled_price, wallet_id, client_order_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, ?, datetime('now'), datetime('now'))`
        )
        .run(
          sessionId,
          symbol,
          side,
          notional,
          qty,
          JSON.stringify({ ...order, price, qty, notional }),
          walletId,
          clientOrderId
        );
      const orderId = Number(insert.lastInsertRowid);

      const cashDelta = side === 'buy' ? -notional : notional;
      const cashResult = walletWriter.applyTradeCashDelta({
        delta: cashDelta,
        walletId,
        actor,
        idempotencyKey: `paper_fill:${clientOrderId}`,
        reason: `fill ${side} ${qty} ${symbol} @ ${price}`,
        meta: { order_id: orderId, symbol, side, qty, price, notional },
      });

      this._applyPositionFill(db, symbol, side, qty, price);

      db.prepare(
        `UPDATE paper_orders SET
           status = 'filled',
           filled_qty = ?,
           filled_price = ?,
           notional = ?,
           updated_at = datetime('now')
         WHERE id = ?`
      ).run(qty, price, notional, orderId);

      const row = db.prepare(`SELECT * FROM paper_orders WHERE id = ?`).get(orderId);
      return { row, cashResult };
    });

    let result;
    try {
      result = run();
    } catch (e) {
      if (e && e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        const again = db
          .prepare(`SELECT * FROM paper_orders WHERE client_order_id = ?`)
          .get(clientOrderId);
        if (again) return this._rowToOrder(again);
      }
      throw e;
    }

    logger.info('paper_broker_fill', {
      order_id: result.row.id,
      symbol,
      side,
      qty,
      price,
      notional,
      cash_after: result.cashResult.balance_after,
    });

    return this._rowToOrder(result.row);
  }

  _applyPositionFill(db, symbol, side, qty, price) {
    const pos = db
      .prepare(`SELECT quantity, avg_cost FROM paper_positions WHERE ticker = ?`)
      .get(symbol);
    let quantity = pos ? Number(pos.quantity) : 0;
    let avgCost = pos ? Number(pos.avg_cost) : 0;

    if (side === 'buy') {
      const newQty = quantity + qty;
      avgCost = newQty > 0 ? (quantity * avgCost + qty * price) / newQty : price;
      quantity = newQty;
    } else {
      quantity = roundQty(quantity - qty);
      if (quantity <= 1e-9) {
        quantity = 0;
        avgCost = 0;
      }
    }

    db.prepare(
      `INSERT INTO paper_positions (ticker, quantity, avg_cost, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(ticker) DO UPDATE SET
         quantity = excluded.quantity,
         avg_cost = excluded.avg_cost,
         updated_at = datetime('now')`
    ).run(symbol, quantity, avgCost);
  }

  async cancelOrder(orderId) {
    const db = this._getDb();
    const id = Number(orderId);
    const row = db.prepare(`SELECT * FROM paper_orders WHERE id = ?`).get(id);
    if (!row) {
      const err = new Error(`Order not found: ${orderId}`);
      err.code = 'ORDER_NOT_FOUND';
      throw err;
    }
    if (row.status === 'filled') {
      const err = new Error('Cannot cancel filled paper order');
      err.code = 'ORDER_ALREADY_FILLED';
      throw err;
    }
    if (row.status === 'canceled') {
      return this._rowToOrder(row);
    }
    db.prepare(
      `UPDATE paper_orders SET status = 'canceled', updated_at = datetime('now') WHERE id = ?`
    ).run(id);
    return this._rowToOrder(db.prepare(`SELECT * FROM paper_orders WHERE id = ?`).get(id));
  }

  _rowToOrder(row) {
    return {
      id: row.id,
      status: row.status,
      symbol: row.ticker,
      side: row.side,
      qty: row.qty != null ? Number(row.qty) : null,
      notional: row.notional != null ? Number(row.notional) : null,
      filled_qty: row.filled_qty != null ? Number(row.filled_qty) : null,
      filled_price: row.filled_price != null ? Number(row.filled_price) : null,
      client_order_id: row.client_order_id,
      wallet_id: row.wallet_id,
      session_id: row.session_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}

module.exports = { PaperBroker };
