'use strict';

/**
 * Telegram as the interface.
 *
 * Long polling rather than webhooks, because a webhook needs a public URL and
 * this runs on a laptop. No SDK — the Bot API is four HTTP calls and a
 * dependency here would be more code than it saves.
 *
 * A chat id is not an identity, so an unverified chat gets the enrolment flow
 * and nothing else. Only once an email has been verified is the chat bound to
 * an identity, and that identity — not the chat — owns the wallet.
 *
 * The agent recommends. It does not execute. Accepting a recommendation is
 * something the person does, by name, and both the acceptance and the refusal
 * are recorded — a log of only the accepted calls would measure the person
 * filtering rather than the agent.
 */

const identity = require('./identity-service');
const { resolveCaller } = require('./caller');
const wallet = require('./wallet-service');
const metrics = require('./metrics-service');
const report = require('./trade-reporting');
const { sendVerificationCode, activeProvider } = require('./email-sender');
const { executeTurn } = require('./trading-rails/execute-turn');

const API = 'https://api.telegram.org/bot';
const POLL_TIMEOUT_SEC = 25;

const pending = new Map();

let running = false;
let offset = 0;

function token() {
  return (process.env.TELEGRAM_BOT_TOKEN || '').trim();
}

async function api(method, body) {
  const res = await fetch(API + token() + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(method + ' failed: ' + (json.description || res.status));
  return json.result;
}

async function say(chatId, text, html) {
  try {
    await api('sendMessage', {
      chat_id: chatId,
      text: String(text).slice(0, 4000),
      disable_web_page_preview: true,
      // HTML only where the caller built it. A plain message containing a
      // stray angle bracket would be rejected outright with parse_mode set,
      // and losing a reply to a formatting rule is worse than losing the bold.
      ...(html ? { parse_mode: 'HTML' } : {}),
    });
  } catch (e) {
    console.warn('[telegram] could not reply to ' + chatId + ':', e.message);
  }
}

const money = (n) =>
  n === null || n === undefined ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const HELP = [
  'Ask me things:',
  '  "what is LLY at?"',
  '  "how is my portfolio doing?"',
  '',
  'Commands:',
  '  /open — what is running now',
  '  /excluded — trades left out of the results',
  '  /health — are the data sources sound',
  '  /close N — close one of your positions now',
  '  /slippage — signal price versus fill price',
  '  /reconcile — do the wallet and trade records agree',
  '  /experiment — does any of this work',
  '  /wallet — cash, positions, profit and loss',
  '  /pending — recommendations waiting on you',
  '  /accept N — take recommendation N',
  '  /skip N — decline it (recorded either way)',
  '  /scorecard — how the recommendations have done',
  '  /unlink — disconnect this chat',
  '',
  'I recommend. I do not execute. Accepting is yours.',
].join('\n');

async function handleEnrolment(chatId, text) {
  const state = pending.get(chatId);

  if (!state || state.step === 'email') {
    const result = identity.requestCode(text, chatId);
    if (!result.ok) {
      await say(chatId, result.error.message);
      return;
    }

    const sent = await sendVerificationCode(
      result.data.email,
      result.data.code,
      result.data.expiresInMinutes
    );

    if (!sent.ok) {
      // Never claim a mail was sent that was not — someone waiting for a code
      // that is not coming has no way to tell.
      await say(chatId, 'I could not send the code: ' + sent.error.message + '. Nothing was linked.');
      pending.delete(chatId);
      return;
    }

    pending.set(chatId, { step: 'code', email: result.data.email });
    await say(
      chatId,
      'Sent a six-digit code to ' + result.data.email + '. It expires in ' +
        result.data.expiresInMinutes + ' minutes.'
    );
    return;
  }

  if (state.step === 'code') {
    const result = identity.verifyCode(chatId, text);
    if (!result.ok) {
      await say(chatId, result.error.message);
      if (result.error.code === 'TOO_MANY_ATTEMPTS' || result.error.code === 'NO_PENDING_CODE') {
        pending.set(chatId, { step: 'email' });
        await say(chatId, 'Send your email address to start again.');
      }
      return;
    }

    pending.delete(chatId);
    wallet.ensureWallet(result.data.id);
    await say(
      chatId,
      'Verified as ' + result.data.email + '. Your paper wallet holds ' +
        money(wallet.STARTING_BALANCE) + '.\n\n' + HELP
    );
  }
}

async function showWallet(chatId, identityId) {
  const r = await wallet.getWalletSummary(identityId);
  if (!r.ok) {
    await say(chatId, 'Could not read the wallet: ' + r.error.message);
    return;
  }

  const d = r.data;
  const lines = ['Cash ' + money(d.cash)];

  if (d.positions.length === 0) {
    lines.push('No positions.');
  } else {
    lines.push('');
    for (const p of d.positions) {
      const pnl = p.pnl === null ? 'unpriced' : (p.pnl >= 0 ? '+' : '') + money(p.pnl);
      lines.push(p.ticker + '  ' + p.quantity + ' @ ' + money(p.avg_cost) + '  ' + pnl);
    }
  }

  lines.push('');
  if (d.total_value === null) {
    lines.push(d.unpriced_positions + ' position(s) could not be priced, so the total is unknown.');
  } else {
    const sign = d.total_pnl >= 0 ? '+' : '';
    const pct = ((d.total_pnl / d.starting_balance) * 100).toFixed(2);
    lines.push('Total ' + money(d.total_value) + '  (' + sign + money(d.total_pnl) + ', ' + sign + pct + '%)');
  }

  await say(chatId, lines.join('\n'), true);
}

async function showPending(chatId, identityId) {
  const r = wallet.pendingRecommendations(identityId, 10);
  const rows = r.data || [];

  if (rows.length === 0) {
    await say(chatId, 'Nothing waiting on you.');
    return;
  }

  const lines = rows.map((x) => report.formatRecommendation(x));


  lines.push('', '/accept N or /skip N');
  await say(chatId, lines.join('\n'));
}

async function showScorecard(chatId, identityId) {
  const m = await metrics.getMetrics(identityId, { window: '7d' });
  const d = m.data;
  const L = [d.total_recommendations + ' recommendations, judged against ' + d.benchmark + ' over 7 days'];

  if (d.overall.n > 0) {
    L.push('');
    L.push('All: ' + d.overall.hit_rate + '% beat the sector, mean ' + d.overall.mean_excess_pct + '%');
    if (d.accepted.n) L.push('Taken: ' + d.accepted.n + ' calls, mean ' + d.accepted.mean_excess_pct + '%');
    if (d.skipped.n) L.push('Passed: ' + d.skipped.n + ' calls, mean ' + d.skipped.mean_excess_pct + '%');
    const strat = Object.entries(d.by_strategy).filter(function (e) { return e[1].n > 0; });
    if (strat.length > 1) {
      L.push('');
      for (const e of strat) L.push(e[0] + ': ' + e[1].n + ' calls, ' + e[1].hit_rate + '%, mean ' + e[1].mean_excess_pct + '%');
    }
  }

  if (d.filtering_verdict) { L.push(''); L.push(d.filtering_verdict); }

  if (d.portfolio && d.portfolio.portfolio_return_pct !== null) {
    L.push('');
    L.push('Portfolio ' + d.portfolio.portfolio_return_pct + '% vs ' + d.benchmark + ' ' + d.portfolio.benchmark_return_pct + '%');
    L.push(d.portfolio.verdict);
  }

  // Always last, always said. A hit rate on a handful of calls reads exactly
  // like a result.
  if (d.caveat) { L.push(''); L.push(d.caveat); }

  await say(chatId, L.join('\n'));
}

async function showScorecardOld(chatId, identityId) {
  const d = wallet.getScorecard(identityId).data;
  const lines = [
    d.total + ' recommendation' + (d.total === 1 ? '' : 's'),
  ];

  for (const [k, v] of Object.entries(d.by_status || {})) lines.push('  ' + k + ': ' + v);

  lines.push('');
  if (d.hit_rate === null) {
    lines.push('None scored yet — a call needs seven days before it can be judged.');
  } else {
    lines.push(d.directionally_right + ' of ' + d.scored + ' went the right way after 7 days (' + d.hit_rate + '%)');
  }

  // The caveat is the point. A hit rate on a handful of calls is noise, and a
  // number without that said next to it invites the wrong conclusion.
  if (d.caveat) lines.push('', d.caveat);

  await say(chatId, lines.join('\n'));
}

async function handleMessage(msg) {
  const chatId = String(msg.chat && msg.chat.id);
  const text = String(msg.text || '').trim();
  if (!chatId || !text) return;

  if (text === '/start') {
    const who = identity.getIdentity(chatId);
    if (who) {
      await say(chatId, 'You are verified as ' + who.email + '.\n\n' + HELP);
      return;
    }
    pending.set(chatId, { step: 'email' });
    await say(
      chatId,
      'Before we start I need to know who you are, so your wallet is yours and ' +
        'not whoever else finds this bot.\n\nSend me your email address.'
    );
    return;
  }

  if (text === '/help') {
    await say(chatId, HELP);
    return;
  }

  if (text === '/unlink') {
    identity.unlink(chatId);
    pending.delete(chatId);
    await say(chatId, 'This chat is no longer linked. Send /start to verify again.');
    return;
  }

  // One resolution for the whole turn. Everything below uses this rather
  // than reaching for the identity again — five hand-passed ids were five
  // chances to pass the wrong one, or none.
  const resolved = resolveCaller('telegram', chatId);

  if (!resolved.ok) {
    await handleEnrolment(chatId, text);
    return;
  }

  const caller = resolved.data;
  const who = { id: caller.identityId, email: caller.email };

  identity.touch(chatId);

  if (text === '/wallet' || text === '/portfolio') {
    await showWallet(chatId, who.id);
    return;
  }

  if (text === '/open') {
    await say(chatId, await report.openPositions(who.id), true);
    return;
  }

  if (text === '/experiment') {
    await say(chatId, await report.experimentReport(who.id), true);
    return;
  }

  if (text === '/excluded') {
    await say(chatId, report.invalidTrades(), true);
    return;
  }

  if (text === '/health') {
    const { runHealthChecks } = require('./health-service');
    const h = await runHealthChecks({ verbose: false });
    const lines = ['<b>Data sources</b>', ''];
    for (const c of h.data.checks) {
      lines.push('<code>' + (c.pass ? 'ok  ' : 'FAIL') + '  ' + c.name.padEnd(9) + '</code>' + report.esc(c.detail));
    }
    lines.push('');
    lines.push('<i>' + report.esc(h.data.verdict) + '</i>');
    await say(chatId, lines.join('\n'), true);
    return;
  }

  const close = text.match(/^\/close\s+(\d+)$/);
  if (close) {
    const r = await report.closeTrade(who.id, Number(close[1]));
    await say(
      chatId,
      r.ok
        ? 'Closed ' + r.data.ticker + ' at ' + r.data.price + '  ' + (r.data.pct >= 0 ? '+' : '') + r.data.pct + '%'
        : r.error
    );
    return;
  }

  if (text === '/slippage') {
    await say(chatId, report.slippageReport(), true);
    return;
  }

  if (text === '/reconcile') {
    // Nothing to reconcile: positions are derived from trades rather than kept
    // alongside them. This command existed because two records of the same fact
    // could disagree, and they could disagree because there were two.
    await say(chatId, 'Positions are derived from trades — one source of truth now, so there is nothing to reconcile. Use /open.');
    return;
  }

  if (false) {
    // The wallet and the trade record describe the same positions from two
    // tables. Nothing guarantees they agree, and a silent divergence would
    // make one of them wrong without saying which.
    const db = require('../database').getDb();
    const positions = db.prepare('SELECT ticker, quantity FROM paper_positions WHERE identity_id IS ? AND quantity > 0').all(who.id);
    const trades = db.prepare("SELECT ticker, quantity FROM trade WHERE identity_id IS ? AND portfolio = 'user' AND status = 'open'").all(who.id);

    const byTicker = {};
    for (const p of positions) byTicker[p.ticker] = { wallet: p.quantity, trade: 0 };
    for (const t of trades) {
      if (!byTicker[t.ticker]) byTicker[t.ticker] = { wallet: 0, trade: 0 };
      byTicker[t.ticker].trade += t.quantity;
    }

    const drift = Object.entries(byTicker).filter(([, v]) => Math.abs(v.wallet - v.trade) > 0.0001);
    await say(
      chatId,
      drift.length === 0
        ? 'Wallet and trade records agree on ' + Object.keys(byTicker).length + ' position(s).'
        : '<b>They disagree</b>\n\n' + drift.map(([t, v]) => '<code>' + t + '  wallet ' + v.wallet.toFixed(4) + '  trade ' + v.trade.toFixed(4) + '</code>').join('\n'),
      true
    );
    return;
  }

  if (text === '/pending') {
    await showPending(chatId, who.id);
    return;
  }

  if (text === '/scorecard') {
    // Retired. It answered a similar question from a different table, and two
    // numbers for one question is worse than one.
    await say(chatId, 'Use /experiment — it measures completed trades rather than open recommendations.');
    return;
  }

  if (false) {
    await showScorecard(chatId, who.id);
    return;
  }

  const accept = text.match(/^\/accept\s+(\d+)(?:\s+(\d+))?$/);
  if (accept) {
    const result = await wallet.acceptRecommendation(
      who.id,
      Number(accept[1]),
      accept[2] ? Number(accept[2]) : undefined
    );
    if (!result.ok) {
      await say(chatId, result.error.message);
      return;
    }
    const d = result.data;
    await say(
      chatId,
      d.side.toUpperCase() + ' ' + d.quantity + ' ' + d.ticker + ' @ ' + money(d.fill_price) +
        '\n' + money(d.notional) + ' — cash now ' + money(d.cash_after)
    );
    return;
  }

  const skip = text.match(/^\/skip\s+(\d+)$/);
  if (skip) {
    const result = wallet.skipRecommendation(who.id, Number(skip[1]));
    await say(
      chatId,
      result.ok ? 'Skipped #' + skip[1] + '. Recorded — it still counts towards the scorecard.' : result.error.message
    );
    return;
  }

  try {
    const result = await executeTurn({
      sessionId: 'id:' + who.id,
      caller,
      message: text,
      channel: 'telegram',
    });
    await say(chatId, result.reply);
  } catch (e) {
    console.error('[telegram] turn failed:', e);
    await say(chatId, 'Something went wrong handling that. Nothing was changed.');
  }
}

async function poll() {
  while (running) {
    try {
      const updates = await api('getUpdates', {
        offset,
        timeout: POLL_TIMEOUT_SEC,
        allowed_updates: ['message'],
      });

      for (const u of updates) {
        offset = u.update_id + 1;
        // Awaited deliberately — one at a time keeps the enrolment state
        // machine honest and the rate limits meaningful.
        if (u.message) await handleMessage(u.message);
      }
    } catch (e) {
      console.warn('[telegram] poll error:', e.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

function start() {
  if (!token()) {
    console.log('[telegram] not started — TELEGRAM_BOT_TOKEN is not set');
    return false;
  }
  if (running) return true;

  running = true;
  console.log('[telegram] polling — verification email via ' + activeProvider());
  poll();
  return true;
}

function stop() {
  running = false;
}

// Used by the scheduler to announce new recommendations. Fails quietly — a
// notification that cannot be delivered should not take down the cycle that
// produced it.
async function notify(chatId, text, html) {
  await say(chatId, text, html);
}

module.exports = { start, stop, notify };
