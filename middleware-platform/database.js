'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = process.env.TRADING_DB_PATH || path.join(DATA_DIR, 'trading.sqlite');

let _db = null;

function ensureDataDir() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getDb() {
  if (_db) return _db;
  ensureDataDir();
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  runMigrations(_db);
  return _db;
}

function runMigrations(db) {
  const migration = require('./migrations/001_trading_platform_init');
  migration.up(db);
  const migration2 = require('./migrations/002_investment_agent_init');
  migration2.up(db);
  const migration3 = require('./migrations/003_knowledge_graph');
  migration3.up(db);
  const migration4 = require('./migrations/004_kg_event');
  migration4.up(db);
  const migration5 = require('./migrations/005_identity');
  migration5.up(db);
  const migration6 = require('./migrations/006_wallet_and_recommendations');
  migration6.up(db);
  const migration7 = require('./migrations/007_benchmark');
  migration7.up(db);
  const migration8 = require('./migrations/008_strategy');
  migration8.up(db);
  const migration9 = require('./migrations/009_trade_lifecycle');
  migration9.up(db);
  const migration10 = require('./migrations/010_policy_trace');
  migration10.up(db);
  const migration11 = require('./migrations/011_paper_wallets');
  migration11.up(db);
  const migration12 = require('./migrations/012_paper_orders_broker');
  migration12.up(db);
}

function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// Session projection (SSOT for active lane/step)
function getTradingSessionProjection(sessionId) {
  const row = getDb()
    .prepare(
      `SELECT session_id, active_lane, step, flags_json, updated_at FROM trading_session_projection WHERE session_id = ?`
    )
    .get(sessionId);
  if (!row) return null;
  let flags = {};
  try {
    flags = JSON.parse(row.flags_json || '{}');
  } catch (_) {}
  return { session_id: row.session_id, active_lane: row.active_lane, step: row.step, flags };
}

function upsertTradingSessionProjection(sessionId, { active_lane, step, flags = {} }) {
  getDb()
    .prepare(
      `INSERT INTO trading_session_projection (session_id, active_lane, step, flags_json, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(session_id) DO UPDATE SET
         active_lane = excluded.active_lane,
         step = excluded.step,
         flags_json = excluded.flags_json,
         updated_at = datetime('now')`
    )
    .run(sessionId, active_lane, step, JSON.stringify(flags || {}));
}

function appendTradingHistory(sessionId, role, content) {
  getDb()
    .prepare(
      `INSERT INTO trading_conversation_history (session_id, role, content, created_at)
       VALUES (?, ?, ?, datetime('now'))`
    )
    .run(sessionId, role, String(content || '').slice(0, 8000));
}

function listTradingHistory(sessionId, limit = 20) {
  return getDb()
    .prepare(
      `SELECT role, content, created_at FROM trading_conversation_history
       WHERE session_id = ? ORDER BY id DESC LIMIT ?`
    )
    .all(sessionId, limit)
    .reverse();
}

function getPaperWalletBalance(walletId) {
  const id = walletId || String(process.env.PAPER_WALLET_ID || 'default').trim() || 'default';
  const row = getDb()
    .prepare(`SELECT wallet_id, cash_balance, updated_at, updated_by FROM paper_wallets WHERE wallet_id = ?`)
    .get(id);
  if (!row) return null;
  return {
    wallet_id: row.wallet_id,
    cash_balance: Number(row.cash_balance),
    updated_at: row.updated_at,
    updated_by: row.updated_by,
  };
}

function getPaperOrderById(orderId) {
  return getDb().prepare(`SELECT * FROM paper_orders WHERE id = ?`).get(orderId) || null;
}

function getPaperOrderByClientId(clientOrderId) {
  return (
    getDb()
      .prepare(`SELECT * FROM paper_orders WHERE client_order_id = ?`)
      .get(clientOrderId) || null
  );
}

function listPaperOrders({ walletId, status, limit = 50 } = {}) {
  const id = walletId || String(process.env.PAPER_WALLET_ID || 'default').trim() || 'default';
  if (status) {
    return getDb()
      .prepare(
        `SELECT * FROM paper_orders WHERE wallet_id = ? AND status = ? ORDER BY id DESC LIMIT ?`
      )
      .all(id, status, limit);
  }
  return getDb()
    .prepare(`SELECT * FROM paper_orders WHERE wallet_id = ? ORDER BY id DESC LIMIT ?`)
    .all(id, limit);
}

function getPaperPosition(ticker) {
  const row = getDb()
    .prepare(`SELECT ticker, quantity, avg_cost, updated_at FROM paper_positions WHERE ticker = ?`)
    .get(String(ticker || '').toUpperCase());
  if (!row) return null;
  return {
    ticker: row.ticker,
    quantity: Number(row.quantity),
    avg_cost: Number(row.avg_cost),
    updated_at: row.updated_at,
  };
}

function listPaperPositions() {
  return getDb()
    .prepare(
      `SELECT ticker, quantity, avg_cost, updated_at FROM paper_positions WHERE quantity != 0 ORDER BY ticker`
    )
    .all()
    .map((r) => ({
      ticker: r.ticker,
      quantity: Number(r.quantity),
      avg_cost: Number(r.avg_cost),
      updated_at: r.updated_at,
    }));
}

module.exports = {
  db: { get prepare() { return getDb().prepare.bind(getDb()); } },
  getDb,
  closeDb,
  runMigrations,
  getTradingSessionProjection,
  upsertTradingSessionProjection,
  appendTradingHistory,
  listTradingHistory,
  getPaperWalletBalance,
  getPaperOrderById,
  getPaperOrderByClientId,
  listPaperOrders,
  getPaperPosition,
  listPaperPositions,
};
