'use strict';

/**
 * Trading platform schema — initial migration.
 */

function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trading_session_projection (
      session_id TEXT PRIMARY KEY,
      active_lane TEXT NOT NULL DEFAULT 'research',
      step TEXT NOT NULL DEFAULT 'query',
      flags_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS trading_conversation_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_trading_history_session ON trading_conversation_history(session_id);

    CREATE TABLE IF NOT EXISTS paper_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      ticker TEXT NOT NULL,
      side TEXT NOT NULL,
      notional REAL,
      status TEXT NOT NULL DEFAULT 'pending',
      raw_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS paper_positions (
      ticker TEXT PRIMARY KEY,
      quantity REAL NOT NULL DEFAULT 0,
      avg_cost REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

module.exports = { up };
