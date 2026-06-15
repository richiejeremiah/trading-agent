'use strict';

const { handleTurn } = require('./trading-rails/orchestrator');

async function runTradingTurn(opts = {}) {
  return handleTurn(opts);
}

module.exports = { runTradingTurn };
