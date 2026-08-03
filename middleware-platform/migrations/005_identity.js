'use strict';

/**
 * Identity, and ownership of what identity does.
 *
 * The bot is about to accept messages from anyone who finds it. A chat id is
 * not proof of anything — it is a number the platform hands out — so binding a
 * portfolio to one would mean the first person to message the bot owns it, and
 * anyone whose account is taken over inherits it.
 *
 * So: an email is verified once, a chat id is bound to it, and that binding is
 * what owns positions and orders.
 *
 * The code is emailed rather than sent over Telegram. Sending it in the channel
 * the user is already in proves nothing — they are demonstrably in that channel.
 * Sending it elsewhere and having it typed back proves they hold both.
 *
 * paper_positions and paper_orders predate this and have no owner. Both are
 * rebuilt here with one, while they are still empty. Doing it later means doing
 * it to live data.
 */

function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_identity (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT NOT NULL UNIQUE,
      chat_id       TEXT UNIQUE,
      channel       TEXT NOT NULL DEFAULT 'telegram',
      verified_at   TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at  TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_identity_chat ON agent_identity(chat_id);

    -- Codes are stored hashed. A readable code in a database is a code anyone
    -- with read access can use, and this table is the whole authentication.
    CREATE TABLE IF NOT EXISTS agent_auth_code (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      email        TEXT NOT NULL,
      chat_id      TEXT NOT NULL,
      code_hash    TEXT NOT NULL,
      expires_at   TEXT NOT NULL,
      attempts     INTEGER NOT NULL DEFAULT 0,
      consumed_at  TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_auth_chat    ON agent_auth_code(chat_id);
    CREATE INDEX IF NOT EXISTS idx_auth_email   ON agent_auth_code(email);
    CREATE INDEX IF NOT EXISTS idx_auth_created ON agent_auth_code(created_at);
  `);

  // paper_positions: add an owner. SQLite cannot alter a primary key, so the
  // table is rebuilt. Existing rows are carried over with a null owner rather
  // than dropped — losing someone's positions to a schema change would be worse
  // than an unowned row we can reconcile by hand.
  const hasOwner = db
    .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('paper_positions') WHERE name = 'identity_id'")
    .get();

  if (!hasOwner || hasOwner.n === 0) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS paper_positions_new (
        identity_id  INTEGER,
        ticker       TEXT NOT NULL,
        quantity     REAL NOT NULL DEFAULT 0,
        avg_cost     REAL NOT NULL DEFAULT 0,
        updated_at   TEXT,
        PRIMARY KEY (identity_id, ticker)
      );

      INSERT OR IGNORE INTO paper_positions_new (identity_id, ticker, quantity, avg_cost, updated_at)
        SELECT NULL, ticker, quantity, avg_cost, updated_at FROM paper_positions;

      DROP TABLE paper_positions;
      ALTER TABLE paper_positions_new RENAME TO paper_positions;
    `);
  }

  // paper_orders can take a column without a rebuild — its primary key is id.
  const orderHasOwner = db
    .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('paper_orders') WHERE name = 'identity_id'")
    .get();

  if (!orderHasOwner || orderHasOwner.n === 0) {
    db.exec(`ALTER TABLE paper_orders ADD COLUMN identity_id INTEGER;`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_identity ON paper_orders(identity_id);`);
  }
}

module.exports = { up };
