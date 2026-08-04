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

const { ALLOWLISTS } = require('./tool-allowlists');

function validStep(lane, step) {
  const laneMap = ALLOWLISTS[lane];
  if (!laneMap || !step) return DEFAULT_STATE.step;
  return Object.prototype.hasOwnProperty.call(laneMap, step) ? step : DEFAULT_STATE.step;
}

function normalizeState(partial = {}) {
  return {
    active_lane: partial.active_lane || DEFAULT_STATE.active_lane,
    // A step nobody declared falls back to the default rather than being
    // written through. It used to persist, and a persisted bad step granted the
    // first step's tools on every turn after.
    step: validStep(partial.active_lane || DEFAULT_STATE.active_lane, partial.step),
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
