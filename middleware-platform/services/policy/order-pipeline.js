'use strict';

/**
 * Combined order evaluation: policy then risk.
 * Only ALLOW from both proceeds toward execution (Task 7).
 */

const policyEngine = require('./policy-engine');
const riskEngine = require('../risk/risk-engine');

/**
 * @returns {{ decision: string, reasons: string[], policy: object, risk: object|null }}
 */
function evaluateOrderPipeline(action, ctx = {}) {
  const policy = policyEngine.evaluate(action, ctx);
  if (policy.decision !== policyEngine.DECISIONS.ALLOW) {
    return {
      decision: policy.decision,
      reasons: [...policy.reasons],
      policy,
      risk: null,
    };
  }

  const risk = riskEngine.evaluate(action, ctx);
  return {
    decision: risk.decision,
    reasons: [...policy.reasons, ...risk.reasons],
    policy,
    risk,
  };
}

module.exports = {
  evaluateOrderPipeline,
  DECISIONS: policyEngine.DECISIONS,
};
