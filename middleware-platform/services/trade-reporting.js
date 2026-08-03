'use strict';

/**
 * What to show, and how to say it.
 *
 * Formatted for Telegram's HTML mode. Titles in bold so a message is scannable
 * in a notification, numbers in monospace so columns line up on a phone — a
 * proportional font makes -12.40% and +1.20% look like different lengths, which
 * is exactly wrong when the reader is comparing them.
 *
 * Every performance figure carries its sample size in the same breath. A hit
 * rate on eleven trades reads identically to one on a hundred, and the reader
 * cannot tell the difference unless it is written next to the number.
 */

const { getDb } = require('../database');
const { getCurrentPrice } = require('./market-data-client');
const { HOLD_TRADING_DAYS, STOP_PCT, TARGET_PCT, BENCHMARK } = require('./trade-service');

const MEANINGFUL_SAMPLE = 30;

/** Telegram's HTML mode needs these three escaped or the message is rejected. */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const b = (s) => '<b>' + esc(s) + '</b>';
const code = (s) => '<code>' + esc(s) + '</code>';

const money = (n) =>
  n === null || n === undefined
    ? '—'
    : (n < 0 ? '-$' : '$') +
      Math.abs(Number(n)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const signed = (n, suffix = '%') =>
  n === null || n === undefined ? '—' : (n >= 0 ? '+' : '') + Number(n).toFixed(2) + suffix;

function daysSince(iso) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
}

/** A row of aligned columns, monospaced so they stay aligned. */
function row(cols) {
  return code(cols.join(''));
}

async function openPositions(identityId) {
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT * FROM trade
       WHERE status = 'open' AND ((portfolio = 'user' AND identity_id IS ?) OR portfolio = 'research')
       ORDER BY fill_at DESC`
    )
    .all(identityId ?? null);

  if (rows.length === 0) {
    return (
      b('Open positions') + '\n\n' +
      'Nothing running.\n\n' +
      '<i>The research portfolio takes every signal automatically. Yours takes what you accept. ' +
      'Neither holds anything right now.</i>'
    );
  }

  const out = [b('Open positions'), ''];
  let userValue = 0;
  let userCost = 0;

  const research = [];
  const yours = [];

  for (const t of rows) {
    const q = await getCurrentPrice(t.ticker);
    const price = q && q.ok ? q.data.price : null;
    const pnlPct = price === null ? null : ((price - t.fill_price) / t.fill_price) * 100;
    const value = price === null ? null : t.quantity * price;

    if (t.portfolio === 'user' && value !== null) {
      userValue += value;
      userCost += t.net_notional;
    }

    const held = daysSince(t.fill_at);
    const due = t.planned_exit_at
      ? Math.max(0, Math.ceil((new Date(t.planned_exit_at) - Date.now()) / 86400000))
      : null;

    const line = row([
      t.ticker.padEnd(7),
      signed(pnlPct).padStart(8),
      '  ',
      (held + 'd').padStart(3),
      due !== null ? ' → ' + due + 'd' : '',
    ]);

    const worst =
      t.mae_pct !== null && t.mae_pct < -1 ? '\n   <i>worst point ' + signed(t.mae_pct) + '</i>' : '';

    (t.portfolio === 'research' ? research : yours).push(line + worst);
  }

  if (yours.length) {
    out.push(b('Yours'));
    out.push(...yours);
    if (userCost > 0) {
      out.push(row(['total', money(userValue).padStart(14)]));
      out.push(row(['', signed(((userValue - userCost) / userCost) * 100).padStart(19)]));
    }
    out.push('');
  }

  if (research.length) {
    out.push(b('Research') + ' <i>(automatic)</i>');
    out.push(...research);
    out.push('');
  }

  out.push(
    '<i>Each exits after ' + HOLD_TRADING_DAYS + ' days, or at ' +
      (STOP_PCT * 100).toFixed(0) + '% / +' + (TARGET_PCT * 100).toFixed(0) +
      '% against ' + BENCHMARK + '.</i>'
  );

  return out.join('\n');
}

function summarise(trades) {
  if (trades.length === 0) return null;
  const excess = trades.map((t) => t.realized_excess_pct).filter((x) => x !== null);
  if (excess.length === 0) return null;

  const wins = excess.filter((x) => x > 0).length;
  const mean = excess.reduce((s, x) => s + x, 0) / excess.length;
  const sorted = [...excess].sort((a, x) => a - x);

  return {
    n: excess.length,
    clusters: new Set(trades.map((t) => t.cluster_id).filter(Boolean)).size || null,
    hit: (wins / excess.length) * 100,
    mean,
    best: sorted[sorted.length - 1],
    worst: sorted[0],
    costs: trades.reduce((s, t) => s + (t.costs || 0), 0),
  };
}

async function experimentReport(identityId) {
  const account = await researchAccount();
  const db = getDb();

  const research = db.prepare("SELECT * FROM trade WHERE portfolio = 'research' AND status = 'closed'").all();
  const user = db
    .prepare("SELECT * FROM trade WHERE portfolio = 'user' AND identity_id IS ? AND status = 'closed'")
    .all(identityId ?? null);

  const r = summarise(research);
  const u = summarise(user);

  const out = [b('The experiment'), ''];

  const openCount = db.prepare("SELECT COUNT(*) n FROM trade WHERE status = 'open'").get().n;
  const invalidCount = db.prepare("SELECT COUNT(*) n FROM trade WHERE status = 'invalid'").get().n;

  // The portfolio's own numbers first — a hit rate without a return is only
  // half an answer.
  if (account.total !== null) {
    out.push(row([money(account.total).padStart(12), '  total']));
    out.push(row([signed(((account.total - account.starting) / account.starting) * 100).padStart(12), '  return']));
    out.push(row([money(account.cash).padStart(12), '  cash']));
    out.push('');
  }

  if (account.invalid.length) {
    out.push('<i>' + account.invalid.length + ' trade(s) excluded — /excluded</i>');
    out.push('');
  }

  if (!r && !u) {
    out.push('No trades have closed yet.');
    out.push('');
    out.push(row([String(openCount).padStart(3), '  open']));
    out.push(row([String(invalidCount).padStart(3), '  invalid']));
    out.push('');
    out.push(
      '<i>A trade needs ' + HOLD_TRADING_DAYS + ' days to complete, and roughly ' +
        MEANINGFUL_SAMPLE + ' completed trades before any figure means anything.</i>'
    );
    return out.join('\n');
  }

  if (r) {
    out.push(b('Research') + ' <i>— every signal taken</i>');
    out.push(row([String(r.n).padStart(4), ' trades', r.clusters ? ' · ' + r.clusters + ' days' : '']));
    out.push(row([r.hit.toFixed(0).padStart(4), '% beat ' + BENCHMARK]));
    out.push(row([signed(r.mean).padStart(8), '  mean']));
    out.push(row([signed(r.best).padStart(8), '  best']));
    out.push(row([signed(r.worst).padStart(8), '  worst']));
    out.push(row([money(r.costs).padStart(8), '  costs']));
    out.push('');
  }

  if (u) {
    out.push(b('Yours') + ' <i>— what you accepted</i>');
    out.push(row([String(u.n).padStart(4), ' trades']));
    out.push(row([u.hit.toFixed(0).padStart(4), '% beat ' + BENCHMARK]));
    out.push(row([signed(u.mean).padStart(8), '  mean']));
    out.push('');
  }

  if (r && u && r.n >= 5 && u.n >= 5) {
    const gap = u.mean - r.mean;
    out.push(
      gap > 0
        ? b('Your filtering added ' + gap.toFixed(2) + ' points.')
        : b('Taking everything would have done ' + Math.abs(gap).toFixed(2) + ' points better.') +
          '\n<i>The filtering is costing, not helping.</i>'
    );
    out.push('');
  }

  const byStrategy = {};
  for (const t of research) {
    const s = t.strategy || 'unlabelled';
    if (!byStrategy[s]) byStrategy[s] = [];
    byStrategy[s].push(t);
  }

  const strategies = Object.entries(byStrategy).filter(([, ts]) => summarise(ts));
  if (strategies.length > 1) {
    out.push(b('By strategy'));
    for (const [name, ts] of strategies) {
      const s = summarise(ts);
      out.push(row([String(s.n).padStart(4), '  ', s.hit.toFixed(0).padStart(3), '%  ', signed(s.mean).padStart(7)]));
      out.push('     <i>' + esc(name) + '</i>');
    }
    out.push('');
  }

  const total = r ? r.n : 0;
  if (total < MEANINGFUL_SAMPLE) {
    out.push(
      '<i>' + total + ' completed trades is noise. Around ' + MEANINGFUL_SAMPLE +
        ' before a pattern is worth looking at, and a hundred spanning a bad month before it is evidence.</i>'
    );
  } else if (r && r.clusters && r.clusters < total / 2) {
    out.push(
      '<i>' + total + ' trades but only ' + r.clusters + ' independent days. Same-day signals move together, ' +
        'so confidence is narrower than the trade count suggests.</i>'
    );
  }

  return out.join('\n');
}

function formatRecommendation(rec) {
  const head =
    b('#' + rec.id + '  ' + String(rec.side).toUpperCase() + ' ' + rec.ticker) +
    (rec.price_at_rec ? '  ' + code(money(rec.price_at_rec)) : '');

  const lines = [head];

  if (rec.rationale) lines.push(esc(rec.rationale));

  lines.push(
    code(
      'exit ' + HOLD_TRADING_DAYS + 'd · stop ' + (STOP_PCT * 100).toFixed(0) +
      '% · target +' + (TARGET_PCT * 100).toFixed(0) + '%'
    ) + ' <i>vs ' + BENCHMARK + '</i>'
  );

  try {
    const ev = JSON.parse(rec.evidence || '[]');
    const fda = ev.find((e) => e.type === 'fda_event');
    if (fda && typeof fda.lag_days === 'number') {
      lines.push('<i>news was ' + fda.lag_days + ' day' + (fda.lag_days === 1 ? '' : 's') + ' old when seen</i>');
    }
  } catch {
    // Evidence that will not parse should not stop the recommendation showing.
  }

  if (rec.strategy) {
    lines.push('<i>' + esc(rec.strategy) + (rec.conviction ? ' · ' + esc(rec.conviction) + ' conviction' : '') + '</i>');
  }

  return lines.join('\n');
}

async function dailyUpdate(identityId) {
  const db = getDb();

  const open = db
    .prepare("SELECT COUNT(*) n FROM trade WHERE status = 'open' AND (portfolio = 'research' OR identity_id IS ?)")
    .get(identityId ?? null).n;

  const closedToday = db
    .prepare("SELECT * FROM trade WHERE status = 'closed' AND date(exit_at) = date('now')")
    .all();

  const pending = db
    .prepare("SELECT COUNT(*) n FROM agent_recommendation WHERE identity_id IS ? AND status = 'pending'")
    .get(identityId ?? null).n;

  if (open === 0 && closedToday.length === 0 && pending === 0) return null;

  const lines = [];

  if (closedToday.length) {
    lines.push(b('Closed today'));
    for (const t of closedToday) {
      lines.push(
        row([t.ticker.padEnd(7), signed(t.realized_excess_pct).padStart(8), '  ', t.exit_reason])
      );
    }
    lines.push('');
  }

  const status = [];
  if (open) status.push(open + ' open');
  if (pending) status.push(pending + ' waiting');
  if (status.length) lines.push(status.join(' · ') + (pending ? '  →  /pending' : ''));

  return lines.join('\n');
}

/**
 * The research portfolio's own books.
 *
 * It starts with the same notional balance as a person's wallet and takes every
 * signal, so its return is the one that answers whether the signal is any good.
 * Without accounting it had positions and no result.
 */
async function researchAccount() {
  const db = getDb();
  const START = Number(process.env.PAPER_STARTING_BALANCE || 100000);

  const closed = db.prepare("SELECT * FROM trade WHERE portfolio = 'research' AND status = 'closed'").all();
  const open = db.prepare("SELECT * FROM trade WHERE portfolio = 'research' AND status = 'open'").all();
  const invalid = db.prepare("SELECT ticker, invalid_reason FROM trade WHERE portfolio = 'research' AND status = 'invalid'").all();

  const realised = closed.reduce((s, t) => s + (t.realized_pnl || 0), 0);

  let unrealised = 0;
  let unpriced = 0;
  for (const t of open) {
    const q = await getCurrentPrice(t.ticker);
    if (q && q.ok) unrealised += t.quantity * q.data.price - t.net_notional;
    else unpriced += 1;
  }

  const deployed = open.reduce((s, t) => s + t.net_notional, 0);

  return {
    starting: START,
    realised: Number(realised.toFixed(2)),
    unrealised: unpriced === 0 ? Number(unrealised.toFixed(2)) : null,
    deployed: Number(deployed.toFixed(2)),
    cash: Number((START + realised - deployed).toFixed(2)),
    total: unpriced === 0 ? Number((START + realised + unrealised).toFixed(2)) : null,
    open: open.length,
    closed: closed.length,
    invalid,
    unpriced,
  };
}

/** Every trade excluded from the results, and why. */
function invalidTrades() {
  const db = getDb();
  const rows = db
    .prepare("SELECT id, ticker, portfolio, invalid_reason, created_at FROM trade WHERE status = 'invalid' ORDER BY id DESC")
    .all();

  if (rows.length === 0) return b('Excluded trades') + '\n\nNone. Every trade so far could be measured.';

  const out = [b('Excluded trades'), '', '<i>These are not in any result. A dropped trade is a fact about the sample.</i>', ''];
  for (const r of rows) {
    out.push(code('#' + r.id + ' ' + r.ticker.padEnd(9) + r.portfolio));
    out.push('   <i>' + esc(r.invalid_reason || 'no reason recorded') + '</i>');
  }
  return out.join('\n');
}

/**
 * Close a position by hand, at the current price.
 *
 * Recorded as exit_reason 'manual' so it is separable in the results: a trade
 * you closed early is evidence about your judgement, not about the exit rule,
 * and averaging the two together would confuse both.
 */
async function closeTrade(identityId, tradeId) {
  const db = getDb();
  const t = db
    .prepare("SELECT * FROM trade WHERE id = ? AND status = 'open' AND portfolio = 'user' AND identity_id IS ?")
    .get(tradeId, identityId ?? null);

  if (!t) return { ok: false, error: 'No open position of yours with that number.' };

  const q = await getCurrentPrice(t.ticker);
  if (!q || !q.ok) return { ok: false, error: 'Could not price ' + t.ticker + '. Nothing was changed.' };

  const price = q.data.price;
  const proceeds = t.quantity * price;
  const pnl = proceeds - t.net_notional;

  db.prepare(
    `UPDATE trade SET status = 'closed', exit_at = datetime('now'), exit_price = ?,
       exit_reason = 'manual', realized_pnl = ?, realized_pct = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(price, Number(pnl.toFixed(2)), Number(((pnl / t.net_notional) * 100).toFixed(3)), t.id);

  db.prepare("UPDATE paper_positions SET quantity = 0, updated_at = datetime('now') WHERE identity_id IS ? AND ticker = ?")
    .run(t.identity_id, t.ticker);

  const w = db.prepare('SELECT cash FROM agent_wallet WHERE identity_id = ?').get(t.identity_id);
  if (w) {
    const next = Number((w.cash + proceeds).toFixed(2));
    db.prepare("UPDATE agent_wallet SET cash = ?, updated_at = datetime('now') WHERE identity_id = ?")
      .run(next, t.identity_id);
    db.prepare(
      `INSERT INTO agent_wallet_ledger (identity_id, kind, amount, balance_after, ref_type, ref_id, note)
       VALUES (?, 'manual_exit', ?, ?, 'trade', ?, ?)`
    ).run(t.identity_id, Number(proceeds.toFixed(2)), next, t.id, t.ticker + ' closed by hand');
  }

  return {
    ok: true,
    data: { ticker: t.ticker, price, pnl: Number(pnl.toFixed(2)), pct: Number(((pnl / t.net_notional) * 100).toFixed(2)) },
  };
}

/**
 * How far the fill moved from the price that triggered the signal.
 *
 * Recorded on every trade and never shown. It is the cost of not being able to
 * trade at the moment of the decision, and it belongs in the results rather
 * than the database.
 */
function slippageReport() {
  const db = getDb();
  const rows = db
    .prepare("SELECT ticker, portfolio, gap_pct FROM trade WHERE gap_pct IS NOT NULL ORDER BY id DESC LIMIT 20")
    .all();

  if (rows.length === 0) return b('Signal to fill') + '\n\nNo filled trades yet.';

  const gaps = rows.map((r) => r.gap_pct);
  const mean = gaps.reduce((s, x) => s + x, 0) / gaps.length;
  const worst = Math.min(...gaps);

  const out = [b('Signal to fill'), '', '<i>How far the price moved between the signal and the fill.</i>', ''];
  out.push(row([signed(mean).padStart(8), '  average']));
  out.push(row([signed(worst).padStart(8), '  worst']));
  out.push('');
  for (const r of rows.slice(0, 8)) {
    out.push(row([r.ticker.padEnd(8), signed(r.gap_pct).padStart(8), '  ', r.portfolio]));
  }
  return out.join('\n');
}

module.exports = { openPositions, experimentReport, formatRecommendation, dailyUpdate, researchAccount, invalidTrades, closeTrade, slippageReport, esc };
