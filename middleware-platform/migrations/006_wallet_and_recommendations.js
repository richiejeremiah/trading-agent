'use strict';

/**
 * A wallet, and — more importantly — a record of every recommendation.
 *
 * The wallet is the obvious part: notional cash, positions bought against live
 * quotes, profit and loss. It answers "what would have happened".
 *
 * The recommendation log is the part that decides whether this experiment is
 * worth anything. If only accepted recommendations are recorded, the resulting
 * track record measures the agent and the person filtering it, together, with
 * no way to separate them — and the filtering is doing the selecting, so the
 * log will flatter whatever was already believed.
 *
 * So every recommendation is written here the moment it is made: what, which
 * way, why, and the price at that instant. Accepted, skipped or ignored, it is
 * scored later against what the price actually did. That is the only version of
 * this that can tell you the strategy works rather than tell you what you want.
 *
 * Prices are recorded at recommendation time rather than looked up afterwards,
 * because a price looked up later is a price chosen with hindsight about when
 * to look.
 */

function up(db) {
  db.exec(`
    -- One wallet per verified identity. Cash only; positions live in
    -- paper_positions, which already carries identity_id.
    CREATE TABLE IF NOT EXISTS agent_wallet (
      identity_id      INTEGER PRIMARY KEY,
      currency         TEXT    NOT NULL DEFAULT 'USD',
      starting_balance REAL    NOT NULL,
      cash             REAL    NOT NULL,
      created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- Every cash movement, so a balance can always be explained rather than
    -- just asserted. A wallet whose number cannot be reconstructed from its
    -- history is a number nobody should trust.
    CREATE TABLE IF NOT EXISTS agent_wallet_ledger (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      identity_id  INTEGER NOT NULL,
      kind         TEXT    NOT NULL,
      amount       REAL    NOT NULL,
      balance_after REAL   NOT NULL,
      ref_type     TEXT,
      ref_id       INTEGER,
      note         TEXT,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_ledger_identity ON agent_wallet_ledger(identity_id, id DESC);

    -- The record that makes this measurable.
    CREATE TABLE IF NOT EXISTS agent_recommendation (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      identity_id    INTEGER,
      ticker         TEXT    NOT NULL,
      side           TEXT    NOT NULL CHECK (side IN ('buy', 'sell')),
      conviction     TEXT    CHECK (conviction IN ('low', 'medium', 'high')),
      rationale      TEXT,

      -- What the agent was looking at. Without this a good call cannot be told
      -- from a lucky one, and the whole log is anecdote.
      evidence       TEXT    NOT NULL DEFAULT '[]',

      -- The price when the call was made, not when it was reviewed.
      price_at_rec   REAL,
      currency       TEXT,
      recommended_at TEXT    NOT NULL DEFAULT (datetime('now')),

      -- pending until acted on, then accepted or skipped. expired if neither
      -- happened before it went stale. A recommendation nobody answered is
      -- still evidence about the agent.
      status         TEXT    NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'accepted', 'skipped', 'expired')),
      decided_at     TEXT,

      -- Filled in later by the scorer, for every row regardless of status.
      price_1d       REAL,
      price_7d       REAL,
      price_30d      REAL,
      scored_at      TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_rec_identity ON agent_recommendation(identity_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_rec_status   ON agent_recommendation(status);
    CREATE INDEX IF NOT EXISTS idx_rec_ticker   ON agent_recommendation(ticker);

    -- Which recommendation an order came from, so the wallet's performance can
    -- be traced back to the calls that produced it.
    CREATE INDEX IF NOT EXISTS idx_orders_ticker ON paper_orders(ticker);
  `);

  // paper_orders predates this. Link orders back to the recommendation that
  // caused them, and record the fill price the notional was converted at —
  // without it a position's share count cannot be recovered.
  const cols = db.prepare("SELECT name FROM pragma_table_info('paper_orders')").all().map((c) => c.name);

  if (!cols.includes('recommendation_id')) {
    db.exec('ALTER TABLE paper_orders ADD COLUMN recommendation_id INTEGER;');
  }
  if (!cols.includes('fill_price')) {
    db.exec('ALTER TABLE paper_orders ADD COLUMN fill_price REAL;');
  }
  if (!cols.includes('quantity')) {
    db.exec('ALTER TABLE paper_orders ADD COLUMN quantity REAL;');
  }
}

module.exports = { up };
