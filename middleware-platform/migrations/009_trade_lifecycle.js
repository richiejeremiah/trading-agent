'use strict';

/**
 * Trades, as distinct from recommendations.
 *
 * Until now the system had recommendations and marked them at one, seven and
 * thirty days. That is a snapshot of an open position, not the result of a
 * trade — and a trade is a buy AND a sell. Without an end there is nothing to
 * measure, only a series of readings on something still running.
 *
 * So a trade is its own object with its own life:
 *
 *   signal -> order -> fill -> position -> exit -> completed
 *
 * A completed trade never changes again. That is what makes it research data
 * rather than a view of current state.
 *
 * Two portfolios share this table, separated by the `portfolio` column:
 *
 *   research — takes every valid signal automatically, exits by rule, is never
 *     touched by hand. Answers: is the signal any good?
 *
 *   user — what was actually accepted. Answers: does the filtering add value?
 *
 * They use identical sizing and caps deliberately. If they differed, a gap
 * between their results could be sizing rather than judgement, and the
 * comparison would be worthless.
 *
 * Several columns here are not populated yet — mae, mfe, regime, cluster_id.
 * They are created now because altering a table with live research data in it
 * is worse than carrying a few nulls.
 */

function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trade (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      identity_id       INTEGER,
      portfolio         TEXT NOT NULL CHECK (portfolio IN ('research', 'user')),
      recommendation_id INTEGER,

      ticker            TEXT NOT NULL,
      strategy          TEXT,
      side              TEXT NOT NULL CHECK (side IN ('buy', 'sell')),

      -- Signal and fill are separate moments. A signal generated at the close
      -- cannot be filled at that close: using the same price to decide and to
      -- execute is the oldest bias in backtesting. The gap between them is
      -- itself worth measuring.
      signal_at         TEXT NOT NULL,
      signal_price      REAL,
      fill_at           TEXT,
      fill_price        REAL,
      gap_pct           REAL,

      quantity          REAL,
      gross_notional    REAL,
      costs             REAL DEFAULT 0,
      net_notional      REAL,

      -- Stated when the trade opens, not decided afterwards. An exit rule
      -- chosen once the outcome is visible is not a rule.
      exit_rule         TEXT,
      planned_exit_at   TEXT,

      exit_at           TEXT,
      exit_price        REAL,
      exit_reason       TEXT CHECK (exit_reason IN ('time', 'stop', 'target', 'manual', NULL)),

      realized_pnl      REAL,
      realized_pct      REAL,
      realized_excess_pct REAL,

      bench_symbol      TEXT,
      bench_at_fill     REAL,
      bench_at_exit     REAL,

      -- Worst and best marks during the hold. Free to record and the only way
      -- to later ask whether the exits capture what the trades offered.
      mae_pct           REAL,
      mfe_pct           REAL,

      -- Four managed care names on one sector-wide drop is one macro trade
      -- logged four times. Signals from the same run share a cluster so the
      -- effective sample size can be computed rather than assumed.
      cluster_id        TEXT,
      regime            TEXT,

      status            TEXT NOT NULL DEFAULT 'pending_fill'
                          CHECK (status IN ('pending_fill', 'open', 'closed', 'invalid')),
      -- A trade that cannot be measured honestly is marked invalid rather than
      -- scored with a guess. Prefer no answer to a wrong one.
      invalid_reason    TEXT,

      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_trade_portfolio ON trade(portfolio, status);
    CREATE INDEX IF NOT EXISTS idx_trade_identity  ON trade(identity_id, status);
    CREATE INDEX IF NOT EXISTS idx_trade_ticker    ON trade(ticker);
    CREATE INDEX IF NOT EXISTS idx_trade_strategy  ON trade(strategy);
    CREATE INDEX IF NOT EXISTS idx_trade_cluster   ON trade(cluster_id);
    CREATE INDEX IF NOT EXISTS idx_trade_open      ON trade(status, planned_exit_at);

    -- Daily marks on open trades. Without these, MAE and MFE cannot be known
    -- after the fact — the worst point of a hold is invisible from the endpoints.
    CREATE TABLE IF NOT EXISTS trade_mark (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_id   INTEGER NOT NULL,
      marked_at  TEXT NOT NULL DEFAULT (datetime('now')),
      price      REAL NOT NULL,
      bench      REAL,
      pnl_pct    REAL,
      excess_pct REAL
    );

    CREATE INDEX IF NOT EXISTS idx_mark_trade ON trade_mark(trade_id, marked_at);
  `);
}

module.exports = { up };
