'use strict';

/**
 * Real implementations for the read-only trading tools, scoped to an identity.
 *
 * Two things about the schema shape what these return:
 *
 *   paper_positions now carries identity_id, so a portfolio belongs to a
 *   verified email rather than to whichever chat asked. Rows written before
 *   that column existed have a null owner and are visible only to an
 *   unauthenticated caller — which in practice means the web UI, until that
 *   grows identities too.
 *
 *   paper_orders records notional — a dollar amount — rather than a quantity.
 *   An order is "$500 of AAPL" and the share count is derived at fill time, so
 *   raw_json carries the fill price and quantity for anything that needs them
 *   later.
 *
 * Contract: these throw on failure with a `code` property, matching the stub
 * they replaced. The newer clients return an ok/error union instead, so this is
 * the boundary where one becomes the other.
 */

const { getAllowedToolNames } = require('./trading-rails/tool-allowlists');
const { getCurrentPrice } = require('./market-data-client');
const { getDb } = require('../database');
const { positionsFor } = require('./positions');

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** The newer clients return a union; this layer throws. Convert once, here. */
function unwrap(result, code) {
  if (result && result.ok) return result.data;
  const msg = result && result.error ? result.error.message : 'unknown error';
  throw fail(code || 'TOOL_FAILED', msg);
}

function identityOf(context) {
  return context && context.identityId != null ? context.identityId : null;
}

async function getQuote(args) {
  const ticker = String((args && args.ticker) || '').trim().toUpperCase();
  if (!ticker) throw fail('BAD_ARGS', 'get_quote requires a ticker');

  const data = unwrap(await getCurrentPrice(ticker), 'QUOTE_FAILED');
  return {
    ticker: data.ticker,
    price: data.price,
    currency: data.currency,
    as_of: new Date((data.timestamp || 0) * 1000).toISOString(),
  };
}

async function getPortfolio(_args, context) {
  const db = getDb();
  const identityId = identityOf(context);

  // `IS` rather than `=` so a null owner matches null — the rows that predate
  // identities stay reachable rather than becoming invisible.
  const rows = positionsFor(identityId, 'user');

  if (rows.length === 0) {
    return { positions: [], total_cost: 0, total_value: null, note: 'No open positions.' };
  }

  // Mark to market. A position without a live price reports a null value rather
  // than its cost — a stale mark that looks real is worse than an obvious gap.
  const positions = [];
  let totalCost = 0;
  let totalValue = 0;
  let priced = 0;

  for (const r of rows) {
    const cost = (r.quantity || 0) * (r.avg_cost || 0);
    totalCost += cost;

    let price = null;
    const quote = await getCurrentPrice(r.ticker);
    if (quote && quote.ok) {
      price = quote.data.price;
      totalValue += (r.quantity || 0) * price;
      priced += 1;
    }

    positions.push({
      ticker: r.ticker,
      quantity: r.quantity,
      avg_cost: r.avg_cost,
      cost_basis: Number(cost.toFixed(2)),
      last_price: price,
      market_value: price === null ? null : Number(((r.quantity || 0) * price).toFixed(2)),
      unrealised_pnl:
        price === null ? null : Number(((r.quantity || 0) * price - cost).toFixed(2)),
      updated_at: r.updated_at,
    });
  }

  return {
    positions,
    total_cost: Number(totalCost.toFixed(2)),
    total_value: priced === rows.length ? Number(totalValue.toFixed(2)) : null,
    priced_positions: priced,
    total_positions: rows.length,
    ...(priced < rows.length
      ? { note: priced + ' of ' + rows.length + ' positions could be priced; totals are partial.' }
      : {}),
  };
}

function getTradeHistory(args, context) {
  const db = getDb();
  // Number of anything unparseable is NaN, and Math.max(1, NaN) is NaN — so a
  // model sending a string or an object reached the driver and was refused by
  // sqlite on a type mismatch. Safe by accident: the protection came from the
  // binding layer rather than a check, and the error said nothing the model
  // could act on.
  const raw = Number(args && args.limit);
  const limit = Number.isFinite(raw) ? Math.min(100, Math.max(1, Math.floor(raw))) : 20;
  const identityId = identityOf(context);

  const rows = db
    .prepare(
      'SELECT id, ticker, side, notional, status, created_at, raw_json FROM paper_orders WHERE identity_id IS ? ORDER BY id DESC LIMIT ?'
    )
    .all(identityId, limit);

  return {
    orders: rows.map((r) => {
      let extra = {};
      try {
        extra = r.raw_json ? JSON.parse(r.raw_json) : {};
      } catch {
        // A malformed raw_json should not lose the order it belongs to.
        extra = { raw_json_unparseable: true };
      }
      return {
        id: r.id,
        ticker: r.ticker,
        side: r.side,
        notional: r.notional,
        status: r.status,
        created_at: r.created_at,
        fill_price: extra.fill_price ?? null,
        quantity: extra.quantity ?? null,
      };
    }),
    count: rows.length,
  };
}

class TradingToolExecutor {
  static getAllowedTools(lane, step) {
    return getAllowedToolNames(lane, step);
  }

  static async execute(toolName, args, context) {
    switch (toolName) {
      case 'get_quote':
        return getQuote(args);

      case 'get_portfolio':
        return getPortfolio(args, context);

      case 'get_trade_history':
        return getTradeHistory(args, context);

      // Deliberately still stubs. generate_signal is the strategy engine and
      // needs a decision about what the strategy actually is; the other two
      // need sources that are not wired yet.
      case 'generate_signal':
      case 'get_catalysts':
      case 'search_biotech_news':
        throw fail(
          'TRADING_TOOL_NOT_IMPLEMENTED',
          toolName + ' is not implemented yet. Say so rather than inventing a result.'
        );

      default:
        throw fail('TRADING_TOOL_UNKNOWN', 'Unknown trading tool: ' + toolName);
    }
  }
}

module.exports = TradingToolExecutor;
