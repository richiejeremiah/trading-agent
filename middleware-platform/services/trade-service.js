'use strict';

/**
 * The life of a trade.
 *
 *   open   — a signal becomes a pending order, priced at the signal close but
 *            not filled there
 *   fill   — at the next session's OPEN, because using the close both to decide
 *            and to execute is the oldest bias in backtesting
 *   mark   — daily, so the worst and best points of the hold are known rather
 *            than inferred from the endpoints
 *   exit   — by rule, at a stated horizon or a stop or a target, never by
 *            deciding afterwards what the rule was
 *
 * Costs are applied at both ends. Spread, slippage and commission are crude
 * assumptions here and crude beats zero: adding them later changes every
 * historical result, which means the earlier numbers were never comparable.
 *
 * On splits — the honest position. A 2:1 split reads as a 50% loss to anything
 * comparing raw prices, and there is no free source of corporate actions here.
 * So a single-session move beyond a threshold marks the trade INVALID rather
 * than scoring it. That loses a trade occasionally; the alternative loses trust
 * in every trade.
 */

const { getDb } = require('../database');
const { getHistoricalPrices, getCurrentPrice } = require('./market-data-client');
const { adjustmentFor } = require('./dividend-service');
const policy = require('./policy');

const BENCHMARK = (process.env.PAPER_BENCHMARK || 'XLV').toUpperCase();

/** Holding horizon in trading days. Both strategies play out over days to weeks. */
const HOLD_TRADING_DAYS = Number(process.env.TRADE_HOLD_DAYS || 7);

/** Exits, relative to the benchmark. Stated once, applied to every trade alike. */
const STOP_PCT = Number(process.env.TRADE_STOP_PCT || -0.08);
const TARGET_PCT = Number(process.env.TRADE_TARGET_PCT || 0.12);

/**
 * Costs in basis points, one way, by liquidity. Rough — a real desk would use
 * the spread at the moment of the fill. These are deliberately pessimistic:
 * a strategy that only works at optimistic costs does not work.
 */
const COST_BPS = {
  liquid: 8,    // mega-cap, tight spread
  normal: 15,
  thin: 35,     // small volume, wide spread — the .NS names and small devices
};

/** A single-session move beyond this is almost certainly a corporate action. */
const SPLIT_SUSPICION = 0.35;

/**
 * The currency the research portfolio keeps its books in.
 *
 * A rupee-quoted fill into a dollar portfolio produces a position whose value
 * cannot be added to anything. The user wallet already refuses these; the
 * research portfolio was opening them, which would have quietly corrupted every
 * aggregate it produced.
 */
const PORTFOLIO_CURRENCY = (process.env.PAPER_WALLET_CURRENCY || 'USD').toUpperCase();

const round = (n, d = 2) => Number(Number(n).toFixed(d));

function costTier(avgVolume) {
  if (!avgVolume) return 'thin';
  if (avgVolume > 5_000_000) return 'liquid';
  if (avgVolume > 500_000) return 'normal';
  return 'thin';
}

function costFor(notional, tier) {
  return (notional * COST_BPS[tier]) / 10_000;
}

function barsAfter(quotes, isoDate) {
  const t = new Date(isoDate).getTime();
  return quotes.filter((q) => new Date(q.date).getTime() > t);
}

function barOnOrBefore(quotes, isoDate) {
  const t = new Date(isoDate).getTime();
  let best = null;
  let bestT = -Infinity;
  for (const q of quotes) {
    const d = new Date(q.date).getTime();
    if (d <= t && d > bestT) {
      best = q;
      bestT = d;
    }
  }
  return best;
}

/**
 * Does this price series contain a move that looks like a split?
 *
 * Returns the offending pair, or null. A trade spanning one is marked invalid,
 * because without corporate action data there is no way to tell a split from a
 * catastrophe, and guessing wrong in either direction poisons the sample.
 */
function suspectedCorporateAction(quotes, fromIso, toIso) {
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso || Date.now()).getTime();
  const inRange = quotes.filter((q) => {
    const d = new Date(q.date).getTime();
    return d >= from && d <= to;
  });

  for (let i = 1; i < inRange.length; i++) {
    const prev = inRange[i - 1].close;
    const cur = inRange[i].close;
    if (!prev || !cur) continue;
    if (Math.abs((cur - prev) / prev) > SPLIT_SUSPICION) {
      return { date: inRange[i].date, from: prev, to: cur };
    }
  }
  return null;
}

/**
 * Turn a recommendation into a pending order.
 *
 * Nothing is filled here. The signal price is recorded so the gap to the actual
 * fill can be measured — that gap is the cost of not being able to trade at the
 * moment you decided, and it is worth knowing separately from the trade result.
 */
function openTrade({ identityId, portfolio, recommendationId, ticker, strategy, side, signalPrice, clusterId }) {
  const db = getDb();

  const info = db
    .prepare(
      `INSERT INTO trade
         (identity_id, portfolio, recommendation_id, ticker, strategy, side,
          signal_at, signal_price, exit_rule, cluster_id, bench_symbol, status)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, 'pending_fill')`
    )
    .run(
      identityId ?? null,
      portfolio,
      recommendationId ?? null,
      ticker,
      strategy || null,
      side,
      signalPrice ?? null,
      HOLD_TRADING_DAYS + 'd hold, stop ' + (STOP_PCT * 100).toFixed(0) + '% / target +' +
        (TARGET_PCT * 100).toFixed(0) + '% relative',
      clusterId || null,
      BENCHMARK
    );

  return { ok: true, data: { id: info.lastInsertRowid } };
}

/**
 * Fill anything waiting, at the first session open after the signal.
 *
 * A trade with no next bar yet stays pending — signalled after today's close,
 * it fills tomorrow. Nothing is invented to make it fillable now.
 */
/**
 * What the research portfolio has left to deploy.
 *
 * Starting balance, plus what closed trades realised, minus what open trades
 * are holding. Without this the portfolio could open unlimited positions and
 * its reported return would be measured against a balance that constrained
 * nothing.
 */
function researchCashAvailable(db) {
  const start = Number(process.env.PAPER_STARTING_BALANCE || 100000);
  const realised = db
    .prepare("SELECT COALESCE(SUM(realized_pnl), 0) v FROM trade WHERE portfolio = 'research' AND status = 'closed'")
    .get().v;
  const deployed = db
    .prepare("SELECT COALESCE(SUM(net_notional), 0) v FROM trade WHERE portfolio = 'research' AND status = 'open'")
    .get().v;
  return start + realised - deployed;
}

async function fillPending({ notional, verbose = true } = {}) {
  const db = getDb();
  const size = Number(notional || process.env.PAPER_POSITION_SIZE || 5000);

  const pending = db.prepare("SELECT * FROM trade WHERE status = 'pending_fill' ORDER BY id").all();
  if (pending.length === 0) {
    if (verbose) console.log('[trade] nothing to fill');
    return { ok: true, data: { filled: 0, waiting: 0, invalid: 0 } };
  }

  const bench = await getHistoricalPrices(BENCHMARK, { range: '3mo', interval: '1d' });
  const benchQuotes = bench && bench.ok ? bench.data.quotes : [];

  let filled = 0;
  let waiting = 0;
  let invalid = 0;

  for (const t of pending) {
    const series = await getHistoricalPrices(t.ticker, { range: '3mo', interval: '1d' });
    if (!series || !series.ok) {
      // No prices means no honest fill. Left pending rather than guessed.
      waiting += 1;
      continue;
    }

    const quotes = series.data.quotes || [];
    // getHistoricalPrices does not return a currency — only getCurrentPrice
    // does. Reading it from the wrong response gave an empty string, which
    // passed the check silently. A guard that never fires is worse than none,
    // because it looks like protection.
    const ccyQuote = await getCurrentPrice(t.ticker);
    const quoteCcy = ccyQuote && ccyQuote.ok ? (ccyQuote.data.currency || '').toUpperCase() : '';
    if (!quoteCcy) {
      db.prepare("UPDATE trade SET status = 'invalid', invalid_reason = ?, updated_at = datetime('now') WHERE id = ?")
        .run('could not establish the quote currency', t.id);
      invalid += 1;
      continue;
    }
    // Currency and cash in one question. Both were checked here already,
    // separately and in different styles; the policy layer is where a third
    // rule would go without this file needing to know.
    const verdict = policy.evaluate('fill', {
      ticker: t.ticker,
      identityId: t.identity_id,
      portfolio: t.portfolio,
      quoteCurrency: quoteCcy,
      notional: Number(notional || process.env.PAPER_POSITION_SIZE || 5000),
    });

    if (!verdict.allowed) {
      db.prepare("UPDATE trade SET status = 'invalid', invalid_reason = ?, updated_at = datetime('now') WHERE id = ?")
        .run(verdict.refusals.map((r) => r.reason).join('; '), t.id);
      invalid += 1;
      continue;
    }

    if (false) {
      db.prepare("UPDATE trade SET status = 'invalid', invalid_reason = ?, updated_at = datetime('now') WHERE id = ?")
        .run(t.ticker + ' is quoted in ' + quoteCcy + ' and the portfolio holds ' + PORTFOLIO_CURRENCY, t.id);
      invalid += 1;
      continue;
    }

    const after = barsAfter(quotes, t.signal_at);

    if (after.length === 0) {
      waiting += 1;
      continue;
    }


    const bar = after[0];
    if (!bar.open) {
      db.prepare("UPDATE trade SET status = 'invalid', invalid_reason = ?, updated_at = datetime('now') WHERE id = ?")
        .run('no open price on the fill bar', t.id);
      invalid += 1;
      continue;
    }

    const avgVol =
      quotes.slice(-20).reduce((s, q) => s + (q.volume || 0), 0) / Math.max(1, Math.min(20, quotes.length));
    const tier = costTier(avgVol);

    if (t.portfolio === 'research') {
      const available = researchCashAvailable(db);
      if (size > available) {
        db.prepare("UPDATE trade SET status = 'invalid', invalid_reason = ?, updated_at = datetime('now') WHERE id = ?")
          .run(
            'research portfolio has ' + available.toFixed(2) + ' available, needed ' + size.toFixed(2),
            t.id
          );
        invalid += 1;
        continue;
      }
    }

    const price = bar.open;
    const quantity = size / price;
    const cost = costFor(size, tier);

    const benchBar = barOnOrBefore(benchQuotes, bar.date);
    const gap = t.signal_price ? (price - t.signal_price) / t.signal_price : null;

    const planned = new Date(bar.date);
    // Trading days, roughly — weekends skipped, holidays not. Good enough for a
    // horizon measured in days, and the exit checks the real bars anyway.
    planned.setDate(planned.getDate() + Math.ceil(HOLD_TRADING_DAYS * 1.45));

    db.prepare(
      `UPDATE trade SET
         status = 'open', fill_at = ?, fill_price = ?, gap_pct = ?,
         quantity = ?, gross_notional = ?, costs = ?, net_notional = ?,
         bench_at_fill = ?, planned_exit_at = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      bar.date,
      price,
      gap === null ? null : round(gap * 100, 3),
      quantity,
      size,
      round(cost),
      round(size + cost),
      benchBar ? benchBar.close : null,
      planned.toISOString().slice(0, 10),
      t.id
    );

    filled += 1;
    if (verbose) {
      console.log(
        '[trade] filled #' + t.id + ' ' + t.ticker + ' at ' + round(price) +
        ' (' + tier + ', cost ' + round(cost) + ')' +
        (gap === null ? '' : ', gap ' + round(gap * 100, 2) + '%')
      );
    }
  }

  if (verbose) console.log('[trade] ' + filled + ' filled, ' + waiting + ' waiting, ' + invalid + ' invalid');
  return { ok: true, data: { filled, waiting, invalid } };
}

/**
 * Mark every open trade, and close the ones that are due.
 *
 * Marks come first so that a trade closing today still has its worst point
 * recorded — MAE computed only from the endpoints would miss it entirely.
 */
async function markAndExit({ verbose = true } = {}) {
  const db = getDb();
  const open = db.prepare("SELECT * FROM trade WHERE status = 'open' ORDER BY id").all();

  if (open.length === 0) {
    if (verbose) console.log('[trade] no open trades');
    return { ok: true, data: { marked: 0, closed: 0, invalid: 0 } };
  }

  const bench = await getHistoricalPrices(BENCHMARK, { range: '3mo', interval: '1d' });
  const benchQuotes = bench && bench.ok ? bench.data.quotes : [];
  const benchNow = benchQuotes.length ? benchQuotes[benchQuotes.length - 1].close : null;

  let marked = 0;
  let closed = 0;
  let invalid = 0;

  for (const t of open) {
    const series = await getHistoricalPrices(t.ticker, { range: '3mo', interval: '1d' });
    if (!series || !series.ok) continue;

    const quotes = series.data.quotes || [];

    // A split inside the holding window makes every price comparison wrong, and
    // there is no corporate action feed here to correct it. Marked invalid.
    const suspect = suspectedCorporateAction(quotes, t.fill_at, null);
    if (suspect) {
      db.prepare("UPDATE trade SET status = 'invalid', invalid_reason = ?, updated_at = datetime('now') WHERE id = ?")
        .run(
          'suspected corporate action on ' + suspect.date + ': ' + round(suspect.from) + ' to ' + round(suspect.to),
          t.id
        );
      invalid += 1;
      if (verbose) console.log('[trade] #' + t.id + ' ' + t.ticker + ' INVALID — likely split on ' + suspect.date);
      continue;
    }

    const last = quotes.length ? quotes[quotes.length - 1] : null;
    if (!last) continue;

    const price = last.close;
    const pnlPct = (price - t.fill_price) / t.fill_price;
    const benchPct = t.bench_at_fill && benchNow ? (benchNow - t.bench_at_fill) / t.bench_at_fill : 0;
    const excess = pnlPct - benchPct;

    db.prepare(
      'INSERT INTO trade_mark (trade_id, price, bench, pnl_pct, excess_pct) VALUES (?, ?, ?, ?, ?)'
    ).run(t.id, price, benchNow, round(pnlPct * 100, 3), round(excess * 100, 3));

    const mae = t.mae_pct === null || excess * 100 < t.mae_pct ? round(excess * 100, 3) : t.mae_pct;
    const mfe = t.mfe_pct === null || excess * 100 > t.mfe_pct ? round(excess * 100, 3) : t.mfe_pct;
    db.prepare('UPDATE trade SET mae_pct = ?, mfe_pct = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(mae, mfe, t.id);
    marked += 1;

    // Exit conditions, checked in order of what actually happened first where
    // that can be told. Stop before target: a trade that hit both intrabar is
    // assumed to have hit the stop, which is the pessimistic reading.
    let reason = null;
    if (excess <= STOP_PCT) reason = 'stop';
    else if (excess >= TARGET_PCT) reason = 'target';
    else if (t.planned_exit_at && new Date(last.date) >= new Date(t.planned_exit_at)) reason = 'time';

    if (!reason) continue;

    // Exits fill at the next open, for the same reason entries do. A stop seen
    // on today's close cannot be sold at today's close — the decision and the
    // execution would share a price. If tomorrow's bar does not exist yet the
    // exit waits; the trade stays open and is closed on the next cycle.
    const forward = barsAfter(quotes, last.date);
    if (forward.length === 0 || !forward[0].open) {
      if (verbose) console.log('[trade] #' + t.id + ' ' + t.ticker + ' ' + reason + ' triggered, exit waitsor the next open');
      continue;
    }
    const exitBar = forward[0];

    const exitCost = costFor(t.quantity * exitBar.open, costTier(
      quotes.slice(-20).reduce((s, q) => s + (q.volume || 0), 0) / Math.max(1, Math.min(20, quotes.length))
    ));

    // On the ex-date a stock drops by the dividend. Unadjusted, the holder is
    // scored as having lost cash they were paid. The benchmark distributes too,
    // so both sides are adjusted or neither is.
    const div = await adjustmentFor({
      ticker: t.ticker,
      benchmark: BENCHMARK,
      fillAt: t.fill_at,
      exitAt: exitBar.date,
      fillPrice: t.fill_price,
      benchAtFill: t.bench_at_fill,
    });

    if (!div.ok) {
      db.prepare("UPDATE trade SET status = 'invalid', invalid_reason = ?, updated_at = datetime('now') WHERE id = ?")
        .run(div.error.message, t.id);
      invalid += 1;
      continue;
    }

    const exitPrice = exitBar.open;
    const proceeds = t.quantity * exitPrice - exitCost;
    const realizedPnl = proceeds - t.net_notional;

    db.prepare(
      `UPDATE trade SET
         status = 'closed', exit_at = ?, exit_price = ?, exit_reason = ?,
         bench_at_exit = ?, costs = ?, realized_pnl = ?, realized_pct = ?,
         realized_excess_pct = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      exitBar.date,
      exitBar.open,
      reason,
      benchNow,
      round(t.costs + exitCost),
      round(realizedPnl),
      round((realizedPnl / t.net_notional) * 100, 3),
      round(excess * 100 + div.data.excess_adjustment_pct, 3),
      t.id
    );

    // A user trade is also a real position in the wallet. Closing the
    // measurement record without selling the position would leave the two
    // describing different worlds.
    if (t.portfolio === 'user' && t.identity_id !== null) {
      settleUserExit(db, t, exitPrice, proceeds);
    }

    closed += 1;
    if (verbose) {
      console.log(
        '[trade] closed #' + t.id + ' ' + t.ticker + ' on ' + reason +
        ' — ' + round(excess * 100, 2) + '% vs ' + BENCHMARK
      );
    }
  }

  if (verbose) console.log('[trade] ' + marked + ' marked, ' + closed + ' closed, ' + invalid + ' invalid');
  return { ok: true, data: { marked, closed, invalid } };
}

/** Completed trades only. Open ones are not results. */
function completedTrades(portfolio, identityId) {
  const db = getDb();
  return portfolio === 'research'
    ? db.prepare("SELECT * FROM trade WHERE portfolio = 'research' AND status = 'closed' ORDER BY id").all()
    : db
        .prepare("SELECT * FROM trade WHERE portfolio = 'user' AND identity_id IS ? AND status = 'closed' ORDER BY id")
        .all(identityId ?? null);
}

/** Sell the position and credit the wallet when a user trade exits by rule. */
function settleUserExit(db, t, exitPrice, proceeds) {
  try {
    db.prepare(
      "UPDATE paper_positions SET quantity = 0, updated_at = datetime('now') WHERE identity_id IS ? AND ticker = ?"
    ).run(t.identity_id, t.ticker);

    const w = db.prepare('SELECT cash FROM agent_wallet WHERE identity_id = ?').get(t.identity_id);
    if (!w) return;

    const next = Number((w.cash + proceeds).toFixed(2));
    db.prepare('UPDATE agent_wallet SET cash = ?, updated_at = datetime(\'now\') WHERE identity_id = ?')
      .run(next, t.identity_id);

    db.prepare(
      `INSERT INTO agent_wallet_ledger (identity_id, kind, amount, balance_after, ref_type, ref_id, note)
       VALUES (?, 'exit', ?, ?, 'trade', ?, ?)`
    ).run(t.identity_id, Number(proceeds.toFixed(2)), next, t.id, t.ticker + ' exited by rule');
  } catch (e) {
    console.warn('[trade] could not settle user exit for #' + t.id + ':', e.message);
  }
}

module.exports = {
  openTrade,
  fillPending,
  markAndExit,
  completedTrades,
  HOLD_TRADING_DAYS,
  STOP_PCT,
  TARGET_PCT,
  COST_BPS,
  BENCHMARK,
};
