'use strict';

/**
 * What the guards actually did.
 *
 * policy.evaluate returns a verdict and the caller does `continue`. Nothing is
 * recorded, so when the signal engine reports "nothing met the thresholds
 * today" there is no way to tell whether that means the market was quiet, the
 * cooldowns were still running, or a guard was broken and refusing everything.
 *
 * That question came up for real: zero signals for three days running, and
 * answering it took writing a throwaway script to replay the evaluations by
 * hand. The answer should have been a query.
 *
 * More than convenience, it is the check on the guards themselves. A rule that
 * fires on every single evaluation is as broken as one that never fires, and
 * neither is visible without counting. Three guards shipped broken this week
 * and none announced itself.
 *
 * Allowed decisions are recorded too. A refusal count without a denominator
 * says nothing — "cooldown blocked 14" means something different against 20
 * evaluations than against 2,000.
 */

function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS policy_decision (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      decided_at  TEXT NOT NULL DEFAULT (datetime('now')),
      action      TEXT NOT NULL,
      ticker      TEXT,
      identity_id INTEGER,
      portfolio   TEXT,
      allowed     INTEGER NOT NULL,

      -- Which guards refused, comma separated. Every one, not just the first:
      -- a signal blocked by both cooldown and concentration is a different
      -- fact from one blocked by cooldown alone, and knowing only the first
      -- would make a guard look redundant when it is not.
      refused_by  TEXT,
      reason      TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_policy_time   ON policy_decision(decided_at DESC);
    CREATE INDEX IF NOT EXISTS idx_policy_action ON policy_decision(action, allowed);
    CREATE INDEX IF NOT EXISTS idx_policy_ticker ON policy_decision(ticker);
  `);
}

module.exports = { up };
