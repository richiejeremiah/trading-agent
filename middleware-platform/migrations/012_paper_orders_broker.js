'use strict';

/**
 * Extend paper_orders for PaperBroker fills + client order idempotency.
 * paper_positions already exists from 001; add wallet scoping helpers.
 */

function up(db) {
  const cols = db.prepare(`PRAGMA table_info(paper_orders)`).all().map((c) => c.name);

  const add = (name, ddl) => {
    if (!cols.includes(name)) {
      db.exec(`ALTER TABLE paper_orders ADD COLUMN ${ddl}`);
    }
  };

  add('qty', 'qty REAL');
  add('filled_qty', 'filled_qty REAL');
  add('filled_price', 'filled_price REAL');
  add('wallet_id', "wallet_id TEXT DEFAULT 'default'");
  add('client_order_id', 'client_order_id TEXT');
  add('updated_at', "updated_at TEXT DEFAULT (datetime('now'))");

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_orders_client_order_id
      ON paper_orders(client_order_id)
      WHERE client_order_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_paper_orders_wallet_status
      ON paper_orders(wallet_id, status);

    CREATE INDEX IF NOT EXISTS idx_paper_orders_ticker
      ON paper_orders(ticker);
  `);
}

module.exports = { up };
