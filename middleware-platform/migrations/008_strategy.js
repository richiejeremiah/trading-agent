'use strict';

/**
 * Which strategy produced a recommendation.
 *
 * Without this the scorecard averages every call together, so a strategy that
 * works and one that does not cancel out into a number that says nothing. The
 * point of running two is to find out which — and that needs them separable.
 */

function up(db) {
  const cols = db
    .prepare("SELECT name FROM pragma_table_info('agent_recommendation')")
    .all()
    .map((c) => c.name);

  if (!cols.includes('strategy')) {
    db.exec("ALTER TABLE agent_recommendation ADD COLUMN strategy TEXT DEFAULT 'manual';");
    db.exec('CREATE INDEX IF NOT EXISTS idx_rec_strategy ON agent_recommendation(strategy);');
  }

  // A cooldown needs to know when a ticker was last called, whatever the
  // outcome. The index makes that lookup cheap.
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_rec_ticker_time ON agent_recommendation(ticker, recommended_at DESC);'
  );
}

module.exports = { up };
