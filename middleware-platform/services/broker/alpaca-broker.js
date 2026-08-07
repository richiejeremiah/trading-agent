'use strict';

/**
 * AlpacaBroker — equities adapter stub.
 *
 * MUST NOT be called from LLM tools. Only the execution service (Task 7+)
 * may invoke this after policy + risk ALLOW.
 *
 * Behavior:
 * - If APCA_API_KEY / APCA_SECRET_KEY missing → throws NOT_WIRED (missing creds)
 * - If creds present → still throws NOT_WIRED (HTTP client not implemented yet)
 */

const { BrokerInterface } = require('./broker-interface');

function hasApcaCreds() {
  const key = String(process.env.APCA_API_KEY || '').trim();
  const secret = String(process.env.APCA_SECRET_KEY || '').trim();
  return Boolean(key && secret);
}

function notWired(detail) {
  const err = new Error(detail || 'AlpacaBroker is not wired for live/API execution');
  err.code = 'NOT_WIRED';
  throw err;
}

class AlpacaBroker extends BrokerInterface {
  constructor(opts = {}) {
    super();
    this.baseUrl =
      opts.baseUrl ||
      process.env.APCA_BASE_URL ||
      'https://paper-api.alpaca.markets';
    this._credsOk = hasApcaCreds();
  }

  _assertCallable() {
    if (!this._credsOk) {
      notWired('AlpacaBroker: APCA_API_KEY / APCA_SECRET_KEY not set (NOT_WIRED)');
    }
    notWired(
      'AlpacaBroker: APCA_* present but HTTP order path is not implemented (NOT_WIRED). Do not call from LLM tools.'
    );
  }

  async getAccount() {
    this._assertCallable();
  }

  async getPositions() {
    this._assertCallable();
  }

  async submitOrder(_order) {
    this._assertCallable();
  }

  async cancelOrder(_orderId) {
    this._assertCallable();
  }
}

module.exports = { AlpacaBroker, hasApcaCreds };
