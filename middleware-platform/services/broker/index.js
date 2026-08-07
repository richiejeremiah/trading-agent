'use strict';

/**
 * Broker factory.
 *
 * Selection (paper-first):
 *   BROKER_DRIVER=paper|alpaca  (explicit wins)
 *   else TRADING_MODE=live → alpaca
 *   else → paper (default)
 *
 * LLM tools must never call getBroker().submitOrder — use policy/risk/execution.
 */

const { PaperBroker } = require('./paper-broker');
const { AlpacaBroker } = require('./alpaca-broker');
const { BrokerInterface } = require('./broker-interface');

function resolveDriver() {
  const explicit = String(process.env.BROKER_DRIVER || '')
    .trim()
    .toLowerCase();
  if (explicit === 'paper' || explicit === 'alpaca') return explicit;
  const mode = String(process.env.TRADING_MODE || 'paper')
    .trim()
    .toLowerCase();
  if (mode === 'live') return 'alpaca';
  return 'paper';
}

function getBroker(opts = {}) {
  const driver = opts.driver || resolveDriver();
  if (driver === 'alpaca') return new AlpacaBroker(opts);
  return new PaperBroker(opts);
}

module.exports = {
  getBroker,
  resolveDriver,
  PaperBroker,
  AlpacaBroker,
  BrokerInterface,
};
