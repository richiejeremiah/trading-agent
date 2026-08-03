'use strict';

const TRADING_LANE = {
  RESEARCH: 'research',
  SIGNAL: 'signal',
  // EXECUTE: 'execute' — Rail 3 CANCELLED
  REVIEW: 'review',
  GUARD: 'guard',
};

const DEFAULT_STATE = {
  active_lane: TRADING_LANE.RESEARCH,
  step: 'query',
  flags: {},
};

function normalizeState(partial = {}) {
  return {
    active_lane: partial.active_lane || DEFAULT_STATE.active_lane,
    step: partial.step || DEFAULT_STATE.step,
    flags: partial.flags && typeof partial.flags === 'object' ? partial.flags : {},
  };
}

function routeOrchestratorLane(_message, state = {}) {
  const lane = state.active_lane || TRADING_LANE.RESEARCH;
  return { lane, step: state.step || 'query' };
}

module.exports = {
  TRADING_LANE,
  DEFAULT_STATE,
  normalizeState,
  routeOrchestratorLane,
};
