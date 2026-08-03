'use strict';

/**
 * Positions, derived rather than stored.
 *
 * There were two ledgers. `trade` recorded every fill and exit; `paper_positions`
 * held a running total that had to be updated alongside it. Four places wrote to
 * the second, one wrote to the first, and nothing kept them in step — which is
 * why /reconcile existed, a command whose only purpose was to ask whether the
 * system agreed with itself.
 *
 * They did not agree. At the point this was written, `trade` had no open rows at
 * all and `paper_positions` held two live positions, because the research
 * portfolio wrote only to `trade` and the accept path wrote only to
 * `paper_positions` until very recently.
 *
 * That had a consequence beyond untidiness: the concentration cap and the
 * metrics both read `paper_positions`, so **research positions were invisible to
 * both**. The research portfolio could open any number of trades in one
 * sub-sector, because the guard counted a table it never wrote to.
 *
 * A position is a fact about trades — what is open, at what average price. It is
 * not independent information, so it should not be independently stored. Every
 * reader now computes it, and there is nothing left to reconcile.
 *
 * The cost is a query per read rather than a lookup. For a portfolio measured in
 * tens of positions that is not worth a second source of truth.
 */

const { getDb } = require('../database');

/**
 * Open positions for one owner.
 *
 *   identityId — whose. Null means the research portfolio, which has no owner
 *                by design: it takes every signal on nobody's behalf.
 *   portfolio  — 'user' or 'research'. Omitted means both, which is what the
 *                tool-facing views want.
 *
 * Average cost is weighted by quantity, so two fills at different prices give
 * the blended basis rather than the later one.
 */
function positionsFor(identityId, portfolio) {
  const db = getDb();

  const where = ['status = ?'];
  const params = ['open'];

  if (portfolio) {
    where.push('portfolio = ?');
    params.push(portfolio);
  }

  // `IS` rather than `=` so a null owner matches null. The research portfolio's
  // rows have no identity, and `= NULL` would silently match nothing.
  where.push('identity_id IS ?');
  params.push(identityId ?? null);

  const rows = db
    .prepare(
      `SELECT ticker,
              SUM(quantity) AS quantity,
              SUM(quantity * fill_price) AS cost_total,
              MAX(fill_at) AS updated_at,
              COUNT(*) AS fills
       FROM trade
       WHERE ${where.join(' AND ')}
         AND quantity IS NOT NULL
         AND fill_price IS NOT NULL
       GROUP BY ticker
       HAVING SUM(quantity) > 0`
    )
    .all(...params);

  return rows.map((r) => ({
    ticker: r.ticker,
    quantity: r.quantity,
    avg_cost: r.quantity > 0 ? r.cost_total / r.quantity : 0,
    updated_at: r.updated_at,
    fills: r.fills,
  }));
}

/** One position, or null. */
function positionFor(identityId, ticker, portfolio) {
  return positionsFor(identityId, portfolio).find((p) => p.ticker === ticker) || null;
}

/**
 * Every ticker held, across both portfolios.
 *
 * The concentration cap needs this: a research position in a sub-sector is as
 * much exposure as a user one, and counting only user positions was how the
 * research side escaped the cap entirely.
 */
function allHeldTickers(identityId) {
  const db = getDb();
  return db
    .prepare(
      `SELECT DISTINCT ticker FROM trade
       WHERE status = 'open' AND (identity_id IS ? OR portfolio = 'research')
         AND quantity IS NOT NULL`
    )
    .all(identityId ?? null)
    .map((r) => r.ticker);
}

module.exports = { positionsFor, positionFor, allHeldTickers };
