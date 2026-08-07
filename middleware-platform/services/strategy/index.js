'use strict';

/**
 * Strategy runner — aggregates PEAD + FDA into PROPOSED_ACTION[].
 * Strategies propose only; never submit to broker.
 */

const pead = require('./pead');
const fda = require('./fda-supply');

/**
 * @param {object} [ctx]
 * @param {object|object[]} [ctx.earnings] PEAD earnings event(s)
 * @param {object|object[]} [ctx.fdaEvents] FDA event(s)
 * @param {object} [ctx.peadOpts]
 * @param {object} [ctx.fdaOpts]
 * @returns {object[]} PROPOSED_ACTION[]
 */
function runStrategies(ctx = {}) {
  const out = [];

  const earnings = Array.isArray(ctx.earnings)
    ? ctx.earnings
    : ctx.earnings
      ? [ctx.earnings]
      : [];
  for (const ev of earnings) {
    try {
      const action = pead.proposeFromEarnings(ev, ctx.peadOpts || {});
      if (action) out.push(action);
    } catch (_) {
      // skip invalid SUE inputs
    }
  }

  const fdaEvents = Array.isArray(ctx.fdaEvents)
    ? ctx.fdaEvents
    : ctx.fdaEvents
      ? [ctx.fdaEvents]
      : ctx.fdaEvent
        ? [ctx.fdaEvent]
        : [];
  for (const ev of fdaEvents) {
    const action = fda.proposeFromFdaEvent(ev, ctx.fdaOpts || {});
    if (action) out.push(action);
  }

  return out;
}

module.exports = {
  runStrategies,
  pead,
  fda,
  computeSurprise: pead.computeSurprise,
  proposeFromEarnings: pead.proposeFromEarnings,
  proposeFromFdaEvent: fda.proposeFromFdaEvent,
};
