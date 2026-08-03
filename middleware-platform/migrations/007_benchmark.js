'use strict';

/**
 * The benchmark.
 *
 * Without one, a track record is a number rather than evidence. Picks that
 * returned eight percent while the sector returned fourteen lost money in the
 * only sense that matters, and nothing in the log so far could tell you that.
 *
 * The benchmark is XLV — the healthcare sector — rather than SPY, because the
 * universe is healthcare. Beating the broad market while trailing your own
 * sector is not skill; it is sector exposure, and it would have been cheaper to
 * buy the sector.
 *
 * Filled by the scorer rather than captured at recommendation time. The scorer
 * already fetches price history, so it can fetch the benchmark's series once and
 * fill every row from it — which also means the benchmark price comes from the
 * same source, on the same dates, as the stock it is being compared against.
 */

function up(db) {
  const cols = db
    .prepare("SELECT name FROM pragma_table_info('agent_recommendation')")
    .all()
    .map((c) => c.name);

  const add = (name, type) => {
    if (!cols.includes(name)) {
      db.exec('ALTER TABLE agent_recommendation ADD COLUMN ' + name + ' ' + type + ';');
    }
  };

  add('bench_symbol', 'TEXT');
  add('bench_at_rec', 'REAL');
  add('bench_1d', 'REAL');
  add('bench_7d', 'REAL');
  add('bench_30d', 'REAL');

  // The wallet needs its own baseline: what the benchmark was worth when the
  // wallet opened, so the portfolio can be compared against having simply
  // bought the sector and done nothing.
  const wcols = db
    .prepare("SELECT name FROM pragma_table_info('agent_wallet')")
    .all()
    .map((c) => c.name);

  if (!wcols.includes('bench_symbol')) {
    db.exec("ALTER TABLE agent_wallet ADD COLUMN bench_symbol TEXT;");
  }
  if (!wcols.includes('bench_at_open')) {
    db.exec('ALTER TABLE agent_wallet ADD COLUMN bench_at_open REAL;');
  }
}

module.exports = { up };
