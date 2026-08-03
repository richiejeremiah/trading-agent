'use strict';

/**
 * Migration 004 — kg_event table.
 *
 * Stores resolved knowledge-graph events (recalls, trial terminations) that
 * have been matched to a watchlist ticker by entity-resolver.
 *
 * Unique index on (ticker, kind, source, published_at) makes re-runs
 * idempotent: duplicate rows are silently ignored via INSERT OR IGNORE.
 */

function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kg_event (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker       TEXT    NOT NULL,
      kind         TEXT    NOT NULL CHECK(kind IN ('recall', 'trial_termination')),
      headline     TEXT,
      detail       TEXT,
      source       TEXT    NOT NULL,
      published_at TEXT,
      raw_company  TEXT    NOT NULL,
      captured_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_kg_event_dedup
      ON kg_event (ticker, kind, source, COALESCE(published_at, ''));
  `);
}

module.exports = { up };
