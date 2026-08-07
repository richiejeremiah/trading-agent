'use strict';

/**
 * Paper wallet cash SSOT + ledger + pending confirms.
 */

function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS paper_wallets (
      wallet_id TEXT PRIMARY KEY,
      cash_balance REAL NOT NULL DEFAULT 0 CHECK (cash_balance >= 0),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS paper_wallet_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      amount REAL NOT NULL CHECK (amount > 0),
      balance_before REAL NOT NULL,
      balance_after REAL NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      chat_id TEXT,
      command TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      request_message_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      meta_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_paper_wallet_ledger_wallet
      ON paper_wallet_ledger(wallet_id);
    CREATE INDEX IF NOT EXISTS idx_paper_wallet_ledger_actor_created
      ON paper_wallet_ledger(actor_id, created_at);

    CREATE TABLE IF NOT EXISTS paper_wallet_pending (
      wallet_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      pending_kind TEXT NOT NULL,
      amount REAL NOT NULL CHECK (amount > 0),
      idempotency_key TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      meta_json TEXT,
      PRIMARY KEY (wallet_id, actor_id)
    );
  `);

  const walletId = String(process.env.PAPER_WALLET_ID || 'default').trim() || 'default';
  db.prepare(
    `INSERT OR IGNORE INTO paper_wallets (wallet_id, cash_balance, updated_at, updated_by)
     VALUES (?, 0, datetime('now'), 'system:migration')`
  ).run(walletId);
}

module.exports = { up };
