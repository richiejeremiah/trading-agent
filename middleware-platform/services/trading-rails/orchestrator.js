'use strict';

const { invokeMainGraph } = require('./main-graph');

async function handleTurn(opts = {}) {
  const out = await invokeMainGraph(opts);
  return {
    reply: out.reply || '',
    toolsUsed: out.toolsUsed || [],
    trading_rails: {
      active_lane: out.state?.active_lane,
      step: out.state?.step,
      flags: out.state?.flags,
    },
  };
}

module.exports = { handleTurn };
