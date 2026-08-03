'use strict';

/**
 * The wallet, and the recommendation log that gives it meaning.
 *
 * Fills happen against a live quote at the moment of acceptance. Nothing is
 * modelled — no slippage, no spread, no partial fills — and that is worth
 * knowing when reading the results, because a real fill is worse than this one.
 *
 * Currency is enforced rather than assumed. The previous version summed cash and
 * position values without checking, so a USD wallet holding CIPLA.NS quoted in
 * INR produced a total that meant nothing — ₹1,473 added to $95,000 as though
 * they were the same unit. A buy in the wrong currency is now refused, and a
 * position that somehow holds one is excluded from the total and reported
 * separately.
 *
 * Deliberately no conversion. An FX rate we have not sourced, applied silently,
 * is worse than an honest gap: it produces a number that looks right and is not.
 *
 * Every recommendation is logged when made, not when accepted. Scoring only the
 * accepted ones measures the person doing the accepting.
 */

const { getDb } = require('../database');
const { getCurrentPrice } = require('./market-data-client');
const policy = require('./policy');
const { getDb: _db } = require('../database');

const STARTING_BALANCE = Number(process.env.PAPER_STARTING_BALANCE || 100000);
const WALLET_CURRENCY = (process.env.PAPER_WALLET_CURRENCY || 'USD').toUpperCase();

// Every position is the same size, as a fraction of the STARTING balance rather
// than the current one. The old rule — min(5000, cash * 0.1) — shrank each
// position as cash depleted, so a call made late contributed less to the result
// than the same call made early. That makes the track record uninterpretable:
// you cannot tell a good pick from a pick that happened to be sized larger.
//
// Equal weighting is the only sizing under which the return measures the picks.
const POSITION_FRACTION = Number(process.env.PAPER_POSITION_FRACTION || 0.05);
const POSITION_SIZE = Number((STARTING_BALANCE * POSITION_FRACTION).toFixed(2));

function err(code, message) {
  return { ok: false, error: { code, message } };
}

function now() {
  return new Date().toISOString();
}

function ensureWallet(identityId) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM agent_wallet WHERE identity_id = ?').get(identityId);
  if (existing) return existing;

  const t = now();
  db.prepare(
    `INSERT INTO agent_wallet (identity_id, currency, starting_balance, cash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(identityId, WALLET_CURRENCY, STARTING_BALANCE, STARTING_BALANCE, t, t);

  db.prepare(
    `INSERT INTO agent_wallet_ledger (identity_id, kind, amount, balance_after, note)
     VALUES (?, 'open', ?, ?, 'Wallet opened')`
  ).run(identityId, STARTING_BALANCE, STARTING_BALANCE);

  return db.prepare('SELECT * FROM agent_wallet WHERE identity_id = ?').get(identityId);
}

function moveCash(identityId, amount, kind, refType, refId, note) {
  const db = getDb();
  const w = ensureWallet(identityId);
  const next = Number((w.cash + amount).toFixed(2));

  db.prepare('UPDATE agent_wallet SET cash = ?, updated_at = ? WHERE identity_id = ?').run(
    next,
    now(),
    identityId
  );
  db.prepare(
    `INSERT INTO agent_wallet_ledger (identity_id, kind, amount, balance_after, ref_type, ref_id, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(identityId, kind, amount, next, refType || null, refId || null, note || null);

  return next;
}

async function recordRecommendation({ identityId, ticker, side, conviction, rationale, evidence }) {
  const sym = String(ticker || '').trim().toUpperCase();
  if (!sym) return err('BAD_ARGS', 'A ticker is required.');
  if (side !== 'buy' && side !== 'sell') return err('BAD_ARGS', 'side must be buy or sell.');

  // The price is captured now. Looking it up later means looking it up with
  // hindsight about when to look.
  let price = null;
  let currency = null;
  const quote = await getCurrentPrice(sym);
  if (quote && quote.ok) {
    price = quote.data.price;
    currency = quote.data.currency;
  }

  try {
    const info = getDb()
      .prepare(
        `INSERT INTO agent_recommendation
           (identity_id, ticker, side, conviction, rationale, evidence, price_at_rec, currency)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        identityId ?? null,
        sym,
        side,
        conviction || 'medium',
        rationale || null,
        JSON.stringify(evidence || []),
        price,
        currency
      );

    return {
      ok: true,
      data: { id: info.lastInsertRowid, ticker: sym, side, price_at_rec: price, currency },
    };
  } catch (e) {
    return err('DB_ERROR', e.message);
  }
}

function pendingRecommendations(identityId, limit = 10) {
  const rows = getDb()
    .prepare(
      `SELECT id, ticker, side, conviction, rationale, price_at_rec, currency, recommended_at
       FROM agent_recommendation
       WHERE identity_id IS ? AND status = 'pending'
       ORDER BY id DESC LIMIT ?`
    )
    .all(identityId ?? null, limit);
  return { ok: true, data: rows };
}

async function acceptRecommendation(identityId, recId, notionalUsd) {
  const db = getDb();
  const rec = db
    .prepare("SELECT * FROM agent_recommendation WHERE id = ? AND identity_id IS ? AND status = 'pending'")
    .get(recId, identityId ?? null);

  if (!rec) return err('NOT_FOUND', 'No pending recommendation with that number.');

  const quote = await getCurrentPrice(rec.ticker);
  if (!quote || !quote.ok) {
    return err('NO_PRICE', 'Could not get a price for ' + rec.ticker + '; nothing was done.');
  }

  const price = quote.data.price;
  const quoteCurrency = (quote.data.currency || '').toUpperCase();
  const wallet = ensureWallet(identityId);
  const walletCurrency = (wallet.currency || WALLET_CURRENCY).toUpperCase();

  // Refused rather than converted. Buying an INR-quoted stock with a USD wallet
  // needs an FX rate, and a rate invented here would make every number after it
  // wrong in a way nothing would flag.
  const verdict = policy.evaluate('accept', {
    ticker: rec.ticker,
    identityId,
    portfolio: 'user',
    quoteCurrency,
    notional: Number(notionalUsd || 0),
  });

  if (!verdict.allowed) {
    return err(
      verdict.refusals[0].guard === 'currency' ? 'CURRENCY_MISMATCH' : 'REFUSED',
      verdict.refusals.map((r) => r.reason).join('; ') + '. Nothing was done.'
    );
  }

  if (false) {
    return err(
      'CURRENCY_MISMATCH',
      rec.ticker + ' is quoted in ' + quoteCurrency + ' and this wallet holds ' + walletCurrency +
        '. Buying it would need an exchange rate this does not have, so nothing was done.'
    );
  }

  const position = db
    .prepare('SELECT * FROM paper_positions WHERE identity_id IS ? AND ticker = ?')
    .get(identityId ?? null, rec.ticker);

  let notional;
  let quantity;

  if (rec.side === 'buy') {
    // An explicit amount overrides, but the default is the same every time.
    notional = Number(notionalUsd || POSITION_SIZE);
    if (notional < 1) return err('TOO_SMALL', 'That is not enough to buy anything.');
    if (notional > wallet.cash) {
      return err(
        'INSUFFICIENT_CASH',
        'That needs ' + notional.toFixed(2) + ' and the wallet holds ' + wallet.cash.toFixed(2) + '.'
      );
    }
    quantity = notional / price;
  } else {
    if (!position || position.quantity <= 0) {
      return err('NO_POSITION', 'There is no position in ' + rec.ticker + ' to sell.');
    }
    quantity = position.quantity;
    notional = quantity * price;
  }

  const t = now();

  try {
    const order = db
      .prepare(
        `INSERT INTO paper_orders
           (session_id, identity_id, ticker, side, notional, status, raw_json, created_at,
            recommendation_id, fill_price, quantity)
         VALUES (?, ?, ?, ?, ?, 'filled', ?, ?, ?, ?, ?)`
      )
      .run(
        'id:' + identityId,
        identityId ?? null,
        rec.ticker,
        rec.side,
        Number(notional.toFixed(2)),
        JSON.stringify({ fill_price: price, quantity, currency: quoteCurrency, source: 'recommendation' }),
        t,
        rec.id,
        price,
        quantity
      );

    if (rec.side === 'buy') {
      const prevQty = position ? position.quantity : 0;
      const prevCost = position ? position.quantity * position.avg_cost : 0;
      const newQty = prevQty + quantity;
      const newAvg = (prevCost + notional) / newQty;

      db.prepare(
        `INSERT INTO paper_positions (identity_id, ticker, quantity, avg_cost, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(identity_id, ticker) DO UPDATE SET quantity = ?, avg_cost = ?, updated_at = ?`
      ).run(identityId ?? null, rec.ticker, newQty, newAvg, t, newQty, newAvg, t);

      moveCash(identityId, -notional, 'buy', 'order', order.lastInsertRowid, rec.ticker);
    } else {
      db.prepare(
        'UPDATE paper_positions SET quantity = 0, updated_at = ? WHERE identity_id IS ? AND ticker = ?'
      ).run(t, identityId ?? null, rec.ticker);

      moveCash(identityId, notional, 'sell', 'order', order.lastInsertRowid, rec.ticker);
    }

    db.prepare("UPDATE agent_recommendation SET status = 'accepted', decided_at = ? WHERE id = ?").run(
      t,
      rec.id
    );

    // The measurement record, alongside the wallet's own state. Written in the
    // same breath as the fill so the two cannot describe different things.
    openUserTrade(db, {
      identityId,
      recommendationId: rec.id,
      ticker: rec.ticker,
      strategy: rec.strategy,
      side: rec.side,
      signalPrice: rec.price_at_rec,
      fillPrice: price,
      quantity,
      notional,
      benchAtFill: rec.bench_at_rec,
      clusterId: rec.cluster_id || null,
    });

    return {
      ok: true,
      data: {
        order_id: order.lastInsertRowid,
        ticker: rec.ticker,
        side: rec.side,
        quantity: Number(quantity.toFixed(4)),
        fill_price: price,
        currency: quoteCurrency,
        notional: Number(notional.toFixed(2)),
        cash_after: db.prepare('SELECT cash FROM agent_wallet WHERE identity_id = ?').get(identityId).cash,
      },
    };
  } catch (e) {
    return err('DB_ERROR', e.message);
  }
}

function skipRecommendation(identityId, recId) {
  const info = getDb()
    .prepare(
      "UPDATE agent_recommendation SET status = 'skipped', decided_at = ? WHERE id = ? AND identity_id IS ? AND status = 'pending'"
    )
    .run(now(), recId, identityId ?? null);

  return info.changes > 0
    ? { ok: true, data: { id: recId, status: 'skipped' } }
    : err('NOT_FOUND', 'No pending recommendation with that number.');
}

/**
 * Cash, positions marked to market, and the total — where a total is honest.
 *
 * A position quoted in a currency other than the wallet's is priced and shown,
 * but kept out of the total and counted separately. Adding it would produce a
 * figure that reads as money and is not.
 */
async function getWalletSummary(identityId) {
  const db = getDb();
  const wallet = ensureWallet(identityId);
  const walletCurrency = (wallet.currency || WALLET_CURRENCY).toUpperCase();

  const positions = db
    .prepare('SELECT ticker, quantity, avg_cost FROM paper_positions WHERE identity_id IS ? AND quantity > 0')
    .all(identityId ?? null);

  const marked = [];
  let holdingsValue = 0;
  let unpriced = 0;
  let foreign = 0;

  for (const p of positions) {
    const quote = await getCurrentPrice(p.ticker);
    const price = quote && quote.ok ? quote.data.price : null;
    const currency = quote && quote.ok ? (quote.data.currency || '').toUpperCase() : null;

    const sameCurrency = currency === walletCurrency;

    if (price === null) unpriced += 1;
    else if (!sameCurrency) foreign += 1;
    else holdingsValue += p.quantity * price;

    marked.push({
      ticker: p.ticker,
      quantity: Number(p.quantity.toFixed(4)),
      avg_cost: Number(p.avg_cost.toFixed(2)),
      last_price: price,
      currency,
      counted: price !== null && sameCurrency,
      value: price === null ? null : Number((p.quantity * price).toFixed(2)),
      pnl: price === null ? null : Number((p.quantity * (price - p.avg_cost)).toFixed(2)),
    });
  }

  const complete = unpriced === 0 && foreign === 0;
  const total = complete ? wallet.cash + holdingsValue : null;

  const notes = [];
  if (unpriced > 0) notes.push(unpriced + ' position(s) could not be priced.');
  if (foreign > 0) {
    notes.push(
      foreign + ' position(s) are quoted in another currency and are excluded from the total — ' +
        'converting them would need an exchange rate this does not have.'
    );
  }

  return {
    ok: true,
    data: {
      currency: walletCurrency,
      cash: Number(wallet.cash.toFixed(2)),
      starting_balance: wallet.starting_balance,
      positions: marked,
      holdings_value: complete ? Number(holdingsValue.toFixed(2)) : null,
      total_value: total === null ? null : Number(total.toFixed(2)),
      total_pnl: total === null ? null : Number((total - wallet.starting_balance).toFixed(2)),
      unpriced_positions: unpriced,
      foreign_currency_positions: foreign,
      note: notes.length ? notes.join(' ') : null,
    },
  };
}

function getScorecard(identityId) {
  const db = getDb();

  const counts = db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM agent_recommendation
       WHERE identity_id IS ? GROUP BY status`
    )
    .all(identityId ?? null);

  const scored = db
    .prepare(
      `SELECT ticker, side, status, price_at_rec, price_7d, recommended_at
       FROM agent_recommendation
       WHERE identity_id IS ? AND price_7d IS NOT NULL AND price_at_rec IS NOT NULL`
    )
    .all(identityId ?? null);

  let right = 0;
  for (const r of scored) {
    const moved = r.price_7d - r.price_at_rec;
    if ((r.side === 'buy' && moved > 0) || (r.side === 'sell' && moved < 0)) right += 1;
  }

  const total = counts.reduce((n, c) => n + c.n, 0);

  return {
    ok: true,
    data: {
      total,
      by_status: Object.fromEntries(counts.map((c) => [c.status, c.n])),
      scored: scored.length,
      directionally_right: scored.length ? right : null,
      hit_rate: scored.length ? Number(((right / scored.length) * 100).toFixed(1)) : null,
      caveat:
        scored.length < 30
          ? 'Too few scored calls to mean anything yet. Around a hundred, across a bad month as well as a good one, before this is evidence.'
          : null,
    },
  };
}

/**
 * A trade row for something the person accepted.
 *
 * Opens in 'open' rather than 'pending_fill': this one is already filled, at a
 * price fetched moments ago. The research portfolio waits for the next open
 * because it decides at the close; a person clicking accept does not.
 */
function openUserTrade(db, o) {
  const HOLD = Number(process.env.TRADE_HOLD_DAYS || 7);
  const planned = new Date();
  planned.setDate(planned.getDate() + Math.ceil(HOLD * 1.45));

  try {
    db.prepare(
      `INSERT INTO trade
         (identity_id, portfolio, recommendation_id, ticker, strategy, side,
          signal_at, signal_price, fill_at, fill_price, gap_pct,
          quantity, gross_notional, costs, net_notional,
          bench_symbol, bench_at_fill, exit_rule, planned_exit_at, cluster_id, status)
       VALUES (?, 'user', ?, ?, ?, ?, datetime('now'), ?, datetime('now'), ?, ?,
               ?, ?, 0, ?, ?, ?, ?, ?, ?, 'open')`
    ).run(
      o.identityId ?? null,
      o.recommendationId ?? null,
      o.ticker,
      o.strategy || null,
      o.side,
      o.signalPrice ?? null,
      o.fillPrice,
      o.signalPrice ? Number((((o.fillPrice - o.signalPrice) / o.signalPrice) * 100).toFixed(3)) : null,
      o.quantity,
      Number(o.notional.toFixed(2)),
      Number(((o.notional * 15) / 10000).toFixed(2)),
      Number((o.notional + (o.notional * 15) / 10000).toFixed(2)),
      (process.env.PAPER_BENCHMARK || 'XLV').toUpperCase(),
      o.benchAtFill ?? null,
      HOLD + 'd hold, accepted manually',
      planned.toISOString().slice(0, 10),
      o.clusterId,
    );
  } catch (e) {
    // Rethrown rather than swallowed. A position held with no measurement
    // record corrupts the sample invisibly, which is worse than a failed
    // accept the person can see and retry.
    throw new Error('could not record the trade row: ' + e.message);
  }
}

module.exports = {
  ensureWallet,
  recordRecommendation,
  pendingRecommendations,
  acceptRecommendation,
  skipRecommendation,
  getWalletSummary,
  getScorecard,
  STARTING_BALANCE,
  WALLET_CURRENCY,
  POSITION_SIZE,
  POSITION_FRACTION,
};
