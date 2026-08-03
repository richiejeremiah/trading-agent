'use strict';

/**
 * Investment Agent schema — adds portfolio tracking, watchlist, and alerts tables.
 */

function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_portfolio (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL,
      ticker      TEXT NOT NULL,
      side        TEXT NOT NULL CHECK(side IN ('buy','sell')),
      quantity    REAL NOT NULL DEFAULT 0,
      price       REAL NOT NULL DEFAULT 0,
      notional    REAL GENERATED ALWAYS AS (quantity * price) STORED,
      pnl         REAL NOT NULL DEFAULT 0,
      status      TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
      rationale   TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at   TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_agent_portfolio_session ON agent_portfolio(session_id);
    CREATE INDEX IF NOT EXISTS idx_agent_portfolio_ticker  ON agent_portfolio(ticker);

    CREATE TABLE IF NOT EXISTS agent_watchlist (
      ticker      TEXT PRIMARY KEY,
      added_by    TEXT,
      note        TEXT,
      added_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agent_alerts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL,
      ticker      TEXT NOT NULL,
      alert_type  TEXT NOT NULL,
      threshold   REAL,
      message     TEXT,
      triggered   INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      triggered_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_agent_alerts_session ON agent_alerts(session_id);
  `);
}

module.exports = { up };
