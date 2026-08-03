'use strict';

/**
 * A real turn.
 *
 * What this replaces returned a fixed string. Everything around it was already
 * right — session state normalised, the execute lane blocked, history appended,
 * the projection persisted — so all of that is kept and only the reply is now
 * earned rather than hardcoded.
 *
 * The router normalises both providers to OpenAI shape: a response is
 * `choices[0].message`, and tool calls arrive as `tool_calls` whichever model
 * answered. So there is one loop here, not two.
 *
 * Rail 3 stays blocked. This loop can read quotes, positions and history; it
 * cannot place an order, because no tool that places one is exposed to it.
 * That boundary is the point of the lane system and is not worked around here.
 */

const { normalizeState } = require('./state-schema');
const { getAllowedToolNames } = require('./tool-allowlists');
const db = require('../../database');
const llm = require('../llm-router');
const TradingToolExecutor = require('../trading-tool-executor');
const { assertCaller, identityIdOf } = require('../caller');

/** How many times the model may call tools before it has to answer. */
const MAX_STEPS = 6;

/** How much prior conversation to carry. Older turns cost tokens every step. */
const HISTORY_TURNS = 12;

/**
 * Tool schemas in the shape the router expects.
 *
 * Only the ones with real implementations are described here. A tool the model
 * can see but not use produces a confident call and a thrown error, which reads
 * to a user as the agent being broken rather than the feature being absent.
 */
const TOOL_SCHEMAS = {
  get_quote: {
    type: 'function',
    function: {
      name: 'get_quote',
      description: 'Current price for one ticker. Use before discussing what something is worth.',
      parameters: {
        type: 'object',
        properties: {
          ticker: { type: 'string', description: 'Ticker symbol, e.g. LLY or CIPLA.NS' },
        },
        required: ['ticker'],
      },
    },
  },
  get_portfolio: {
    type: 'function',
    function: {
      name: 'get_portfolio',
      description:
        'Open paper positions with cost basis and, where a price is available, market value.',
      parameters: { type: 'object', properties: {} },
    },
  },
  get_trade_history: {
    type: 'function',
    function: {
      name: 'get_trade_history',
      description: 'Recent paper orders for this session.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'How many orders, default 20, max 100.' },
        },
      },
    },
  },
};

function systemPrompt(state) {
  return [
    'You are a paper-trading research assistant. Nothing you do moves real money.',
    '',
    'Current lane: ' + state.active_lane + ', step: ' + state.step + '.',
    '',
    'Rules that matter more than being helpful:',
    '- Never state a price you have not fetched with get_quote. A price you',
    '  remember is a price that has moved.',
    '- You cannot place orders. No tool here does that. If asked to buy or sell,',
    '  say plainly that execution is not enabled rather than describing what you',
    '  would have done as though you did it.',
    '- If a tool fails, say what failed. Do not substitute a plausible answer.',
    '- Say what you do not know. An honest gap is worth more than a confident',
    '  guess to someone deciding what to do with money.',
    '',
    'Be brief. This is often read on a phone.',
  ].join('\n');
}

function toolsForState(state) {
  const allowed = getAllowedToolNames(state.active_lane, state.step) || [];
  return allowed.map((n) => TOOL_SCHEMAS[n]).filter(Boolean);
}

/** Prior turns, oldest first, in the shape the router wants. */
function priorMessages(sessionId) {
  let rows = [];
  try {
    rows = db.listTradingHistory(sessionId, HISTORY_TURNS) || [];
  } catch {
    // History is context, not correctness. A read failure should not lose the
    // turn the user is waiting on.
    rows = [];
  }
  return rows
    .filter((r) => r && r.content && (r.role === 'user' || r.role === 'assistant'))
    .map((r) => ({ role: r.role, content: String(r.content) }));
}

async function executeTurn(opts = {}) {
  // Identity arrives resolved or not at all. A bare number is a claim; this
  // refuses to act on claims. Anything that reaches here without going through
  // resolveCaller() is a programming error and should stop rather than quietly
  // become an anonymous session reading someone else's portfolio.
  const caller = assertCaller(opts.caller, 'executeTurn');
  const callerIdentityId = identityIdOf(caller);

  const sessionId =
    String(opts.session_id || opts.sessionId || '').trim() || `sess-${Date.now()}`;

  let state = normalizeState(opts);
  const prior = db.getTradingSessionProjection(sessionId);
  if (prior) {
    state = normalizeState({
      active_lane: prior.active_lane,
      step: prior.step,
      flags: prior.flags,
    });
  }

  // Rail 3 (execute lane) is cancelled — redirect any stale sessions to guard.
  if (state.active_lane === 'execute') {
    state = normalizeState({
      active_lane: 'guard',
      step: 'block',
      flags: { ...state.flags, rail3_cancelled: true },
    });
  }

  const message = String(opts.message || opts.last_user_message || '').trim();
  if (message) db.appendTradingHistory(sessionId, 'user', message);
  db.upsertTradingSessionProjection(sessionId, state);

  if (!message) {
    const reply = 'Say what you would like to look at — a ticker, your positions, or recent orders.';
    db.appendTradingHistory(sessionId, 'assistant', reply);
    return { state: { ...state, session_id: sessionId }, reply, toolsUsed: [], endCall: false };
  }

  const tools = toolsForState(state);
  const messages = [
    { role: 'system', content: systemPrompt(state) },
    ...priorMessages(sessionId),
  ];
  if (!messages.some((m) => m.role === 'user' && m.content === message)) {
    messages.push({ role: 'user', content: message });
  }

  const toolsUsed = [];
  let reply = '';

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const res = await llm.call({
        messages,
        tools: tools.length ? tools : undefined,
        maxTokens: 1024,
        channel: opts.channel || 'web',
      });

      const msg = res && res.choices && res.choices[0] && res.choices[0].message;
      if (!msg) throw new Error('The model returned no message.');

      const calls = msg.tool_calls || [];

      if (calls.length === 0) {
        reply = String(msg.content || '').trim();
        break;
      }

      messages.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });

      for (const c of calls) {
        const name = c.function && c.function.name;
        let args = {};
        try {
          args = c.function && c.function.arguments ? JSON.parse(c.function.arguments) : {};
        } catch {
          args = {};
        }

        toolsUsed.push(name);

        let content;
        try {
          const out = await TradingToolExecutor.execute(name, args, { sessionId, state, identityId: callerIdentityId, caller });
          content = JSON.stringify(out);
        } catch (e) {
          // The failure goes back to the model as a result, not as a crash —
          // it can then tell the user what did not work instead of the turn
          // dying with a stack trace.
          content = JSON.stringify({ error: e.code || 'TOOL_FAILED', message: e.message });
        }

        messages.push({ role: 'tool', tool_call_id: c.id, content });
      }

      // Last step and still calling tools: say so rather than looping out
      // silently with nothing to show.
      if (step === MAX_STEPS - 1) {
        reply =
          'I ran out of steps while looking that up. Ask again, more narrowly, and I will get further.';
      }
    }
  } catch (e) {
    reply =
      'That did not work: ' +
      (e && e.message ? e.message : 'unknown error') +
      '. Nothing was changed.';
  }

  if (!reply) {
    reply = 'I could not put an answer together for that. Try asking it a different way.';
  }

  db.appendTradingHistory(sessionId, 'assistant', reply);

  return {
    state: { ...state, session_id: sessionId },
    reply,
    toolsUsed,
    endCall: false,
  };
}

module.exports = { executeTurn };
