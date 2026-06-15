'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = process.env.TRADING_DB_PATH || path.join(DATA_DIR, 'trading.sqlite');

let _db = null;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
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

module.exports = {
  db: { get prepare() { return getDb().prepare.bind(getDb()); } },
  getDb,
  closeDb,
  runMigrations,
  getTradingSessionProjection,
  upsertTradingSessionProjection,
  appendTradingHistory,
  listTradingHistory,
};
