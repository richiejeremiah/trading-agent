'use strict';

/**
 * Propose-only guard — LLM / agent tools may read + propose, never submit/broker.
 * Hard rule: reject tool names matching submit|broker|alpaca_order.
 */

const FORBIDDEN_RE = /submit|broker|alpaca_order/i;

function isForbiddenToolName(toolName) {
  const name = String(toolName || '').trim();
  if (!name) return true;
  return FORBIDDEN_RE.test(name);
}

/**
 * @param {string} toolName
 * @returns {{ ok: true } | { ok: false, code: string, reason: string }}
 */
function assertProposeOnlyTool(toolName) {
  const name = String(toolName || '').trim();
  if (!name) {
    return {
      ok: false,
      code: 'EMPTY_TOOL',
      reason: 'tool name is required',
    };
  }
  if (isForbiddenToolName(name)) {
    return {
      ok: false,
      code: 'PROPOSE_ONLY_VIOLATION',
      reason: `tool '${name}' is forbidden for LLM (matches submit|broker|alpaca_order); LLM may only propose`,
    };
  }
  return { ok: true };
}

module.exports = {
  FORBIDDEN_RE,
  isForbiddenToolName,
  assertProposeOnlyTool,
};
