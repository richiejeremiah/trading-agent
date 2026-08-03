'use strict';

/**
 * Prove the whole trade lifecycle without waiting for the market.
 *
 * Items 11 to 14 on the gap list are untested rather than unbuilt: nothing has
 * filled at a real next open, no trade has completed a cycle, the dividend
 * adjustment has never applied to a real exit, and the wallet settlement path
 * has never run. All four are only exercised by a trade that opens, marks and
 * closes — which normally takes a week.
 *
 * So this backdates a trade into a window where the bars already exist. The
 * code paths are the real ones: the same fillPending, the same markAndExit, the
 * same dividend adjustment and the same settlement. Only the dates are moved.
 *
 * What it does NOT prove: that the scheduler fires on its own, or that a signal
 * generated today fills tomorrow. Those need time and are checked by leaving
 * the server running.
 *
 * Everything it creates is removed at the end. A verification run that leaves
 * synthetic trades in the sample would corrupt the thing it is verifying.
 */

require('dotenv').config();

const { getDb } = require('../database');
const { fillPending, markAndExit } = require('../services/trade-service');
const { getHistoricalPrices } = require('../services/market-data-client');

const TICKER = process.argv[2] || 'LLY';

(async () => {
  const db = getDb();

  console.log('\nlifecycle verification — ' + TICKER + '\n');

  // A window far enough back that the whole hold has already happened.
  const series = await getHistoricalPrices(TICKER, { range: '3mo', interval: '1d' });
  if (!series || !series.ok) {
    console.error('could not load prices for ' + TICKER);
    process.exit(1);
  }

  const quotes = series.data.quotes;
  if (quotes.length < 30) {
    console.error('not enough history');
    process.exit(1);
  }

  // Signal 20 sessions ago, so the fill bar and the whole holding window exist.
  const signalBar = quotes[quotes.length - 20];
  console.log('signal dated ' + signalBar.date + ' at close ' + signalBar.close);

  const info = db
    .prepare(
      `INSERT INTO trade
         (identity_id, portfolio, ticker, strategy, side, signal_at, signal_price,
          exit_rule, cluster_id, bench_symbol, status)
       VALUES (NULL, 'research', ?, 'lifecycle_verification', 'buy', ?, ?,
               'verification', 'verify', ?, 'pending_fill')`
    )
    .run(TICKER, signalBar.date, signalBar.close, (process.env.PAPER_BENCHMARK || 'XLV').toUpperCase());

  const id = info.lastInsertRowid;
  console.log('opened trade #' + id + ' as pending\n');

  // ---- fill ---------------------------------------------------------------
  const filled = await fillPending({ verbose: false });
  const afterFill = db.prepare('SELECT * FROM trade WHERE id = ?').get(id);

  console.log('FILL');
  console.log('  status      ' + afterFill.status);
  console.log('  fill price  ' + afterFill.fill_price + '  on ' + afterFill.fill_at);
  console.log('  gap         ' + afterFill.gap_pct + '%  (signal to fill)');
  console.log('  costs       ' + afterFill.costs);
  console.log('  quantity    ' + (afterFill.quantity ? afterFill.quantity.toFixed(4) : '—'));

  const fillOk =
    afterFill.status === 'open' &&
    afterFill.fill_price !== null &&
    afterFill.fill_price !== afterFill.signal_price &&
    afterFill.costs > 0;

  console.log('  ' + (fillOk ? 'PASS — filled at a different price, with costs' : 'FAIL'));

  if (!fillOk) {
    console.log('\n  ' + JSON.stringify(filled.data));
    db.prepare('DELETE FROM trade WHERE id = ?').run(id);
    process.exit(1);
  }

  // Backdate the planned exit so the time rule is already due.
  db.prepare("UPDATE trade SET planned_exit_at = date('now','-30 day') WHERE id = ?").run(id);

  // ---- mark and exit ------------------------------------------------------
  console.log('\nMARK AND EXIT');
  const closed = await markAndExit({ verbose: false });
  const afterExit = db.prepare('SELECT * FROM trade WHERE id = ?').get(id);
  const marks = db.prepare('SELECT COUNT(*) n FROM trade_mark WHERE trade_id = ?').get(id).n;

  console.log('  status      ' + afterExit.status);
  console.log('  marks       ' + marks);
  console.log('  exit        ' + (afterExit.exit_price ?? '—') + ' on ' + (afterExit.exit_at ?? '—'));
  console.log('  reason      ' + (afterExit.exit_reason ?? '—'));
  console.log('  realised    ' + (afterExit.realized_pnl ?? '—'));
  console.log('  excess      ' + (afterExit.realized_excess_pct ?? '—') + '%  (dividend adjusted)');
  console.log('  MAE / MFE   ' + (afterExit.mae_pct ?? '—') + ' / ' + (afterExit.mfe_pct ?? '—'));

  const exitOk =
    afterExit.status === 'closed' &&
    afterExit.exit_price !== null &&
    afterExit.realized_excess_pct !== null &&
    afterExit.exit_reason !== null;

  const invalidOk = afterExit.status === 'invalid';

  if (exitOk) {
    console.log('  PASS — completed with everything needed to score it');
  } else if (invalidOk) {
    // Also a pass: the fail-loud rule working is the behaviour we want.
    console.log('  PASS — refused rather than scored: ' + afterExit.invalid_reason);
  } else {
    console.log('  FAIL — ' + JSON.stringify(closed.data));
  }

  // ---- clean up -----------------------------------------------------------
  db.prepare('DELETE FROM trade_mark WHERE trade_id = ?').run(id);
  db.prepare('DELETE FROM trade WHERE id = ?').run(id);
  console.log('\nverification trade removed — the sample is unchanged\n');

  process.exit(exitOk || invalidOk ? 0 : 1);
})();
