'use strict';

/**
 * Knowledge-graph migration.
 *
 * kg_company      — one row per ticker; BICS sector/industry, peer list (JSON array).
 * kg_relationship — directed supply-chain / customer edges between tickers.
 * kg_estimate     — forward EPS and 30-day revision for each ticker.
 *
 * Every row carries source and captured_at so provenance is always queryable.
 */

function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kg_company (
      ticker       TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      bics_sector  TEXT,
      bics_industry TEXT,
      peers        TEXT NOT NULL DEFAULT '[]',   -- JSON array of ticker strings
      source       TEXT NOT NULL,
      captured_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS kg_relationship (
      from_ticker  TEXT NOT NULL,
      to_ticker    TEXT NOT NULL,
      kind         TEXT NOT NULL CHECK (kind IN ('supplier', 'customer')),
      revenue_pct  REAL,                         -- % of from_ticker revenue, nullable
      source       TEXT NOT NULL,
      captured_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (from_ticker, to_ticker, kind)
    );

    CREATE INDEX IF NOT EXISTS idx_kg_rel_to   ON kg_relationship(to_ticker);
    CREATE INDEX IF NOT EXISTS idx_kg_rel_kind ON kg_relationship(kind);

    CREATE TABLE IF NOT EXISTS kg_estimate (
      ticker       TEXT PRIMARY KEY,
      eps_fy1      REAL,
      revision_30d REAL,
      source       TEXT NOT NULL,
      captured_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

module.exports = { up };
