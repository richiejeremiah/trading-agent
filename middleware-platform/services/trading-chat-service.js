'use strict';

const { runTradingTurn } = require('../services/trading-turn-resolver');

const AGENT_ENABLED = String(process.env.TRADING_AGENT_ENABLED || '').trim() === '1';

async function handleTradingChatMessage(req) {
  const body = req.body || {};
  const sessionId = String(body.session_id || body.sessionId || req.headers['x-trading-session'] || '').trim();
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
    sessionId: sessionId || `sess-${Date.now()}`,
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
