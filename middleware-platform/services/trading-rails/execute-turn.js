'use strict';

const { normalizeState } = require('./state-schema');
const db = require('../../database');

const STUB_REPLY =
  'Trading agent is not implemented yet. This shell is ready for research, signals, and paper execution lanes.';

async function executeTurn(opts = {}) {
  const sessionId = String(opts.session_id || opts.sessionId || '').trim() || `sess-${Date.now()}`;
  let state = normalizeState(opts);

  const prior = db.getTradingSessionProjection(sessionId);
  if (prior) {
    state = normalizeState({ active_lane: prior.active_lane, step: prior.step, flags: prior.flags });
  }

  const message = String(opts.message || opts.last_user_message || '').trim();
  if (message) db.appendTradingHistory(sessionId, 'user', message);

  db.upsertTradingSessionProjection(sessionId, state);
  db.appendTradingHistory(sessionId, 'assistant', STUB_REPLY);

  return {
    state: { ...state, session_id: sessionId },
    reply: STUB_REPLY,
    toolsUsed: [],
    endCall: false,
  };
}

module.exports = { executeTurn };
