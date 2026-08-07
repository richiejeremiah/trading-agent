'use strict';

/**
 * Broker interface contract (async).
 *
 * Implementations: PaperBroker (local SSOT), AlpacaBroker (live/paper API — not LLM-callable).
 *
 * Hard rule: LLM tools must NEVER call submitOrder / cancelOrder.
 * Path is: PROPOSED_ACTION → policy → risk → execution service → broker.
 *
 * Methods (all return Promises):
 *   getAccount()           → { cash, equity?, buying_power?, currency?, raw? }
 *   getPositions()         → Array<{ symbol, qty, avg_cost, market_value? }>
 *   submitOrder(order)     → { id, status, symbol, side, qty?, notional?, filled_price?, ... }
 *   cancelOrder(orderId)   → { id, status: 'canceled'|... }
 *
 * Order input shape (submitOrder):
 *   {
 *     symbol: string,
 *     side: 'buy' | 'sell',
 *     qty?: number,
 *     notional?: number,
 *     type?: 'market' | 'limit',
 *     limit_price?: number,
 *     client_order_id?: string,
 *     // PaperBroker: required fill price for simple market fill
 *     price?: number,
 *     wallet_id?: string,
 *     session_id?: string,
 *     actor?: { type, id },
 *   }
 */

class BrokerInterface {
  async getAccount() {
    throw new Error('BrokerInterface.getAccount not implemented');
  }

  async getPositions() {
    throw new Error('BrokerInterface.getPositions not implemented');
  }

  async submitOrder(_order) {
    throw new Error('BrokerInterface.submitOrder not implemented');
  }

  async cancelOrder(_orderId) {
    throw new Error('BrokerInterface.cancelOrder not implemented');
  }
}

module.exports = { BrokerInterface };
