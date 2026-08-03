'use strict';

const { runTradingTurn } = require('../services/trading-turn-resolver');

const AGENT_ENABLED = String(process.env.TRADING_AGENT_ENABLED || '').trim() === '1';

async function handleTradingChatMessage(req) {
  const body = req.body || {};
  // The browser supplies this from localStorage, so it is a claim rather than
  // a credential — anyone can set it to any value, including the 'id:N' form
  // the verified Telegram path uses. Namespacing it under web: means a guessed
  // id can only ever reach another anonymous web session, never a verified
  // identity's conversation.
  const raw = String(body.session_id || body.sessionId || req.headers['x-trading-session'] || '').trim();
  const sessiId = raw ? 'web:' + raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) : '';
  const message = String(body.message || '').trim();

  if (!AGENT_ENABLED) {
    return {
      status: 501,
      json: {
        success: false,
        error: 'Trading agent not implemented',
        product: 'somo-trading',
        mode: process.env.TRADING_MODE || 'paper',
        hint: 'Set TRADING_AGENT_ENABLED=1 when agent logic is ready',
      },
    };
  }

  if (!message) {
    return { status: 400, json: { success: false, error: 'message is required' } };
  }

  const out = await runTradingTurn({
    sessionId: sessionId || `web:anon-${Date.now()}`,
    // No identity. The web surface has no verification, so it gets research
    // and quotes and no wallet — stated explicitly rather than left to a null
    // that happens to land in the unowned bucket.
    identityId: null,
    message,
    channel: 'chat',
  });

  return {
    status: 200,
    json: {
      success: true,
      reply: out.reply,
      tools_used: out.toolsUsed || [],
      trading_rails: out.trading_rails,
    },
  };
}

module.exports = { handleTradingChatMessage, AGENT_ENABLED };
