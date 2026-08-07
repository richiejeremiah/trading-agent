'use strict';

/**
 * Risk engine — size / exposure / penny / volume / kill-switch.
 * Runs after policy ALLOW (or can be called standalone).
 * LLM cannot override.
 */

const DECISIONS = {
  ALLOW: 'ALLOW',
  REJECT: 'REJECT',
  REQUIRE_HUMAN_CONFIRMATION: 'REQUIRE_HUMAN_CONFIRMATION',
};

function numEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function isKillSwitchOn(ctx = {}) {
  if (ctx.killSwitch === true) return true;
  const v = String(process.env.KILL_SWITCH || '')
    .trim()
    .toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * @param {object} action
 * @param {object} [ctx]
 * @param {number} [ctx.equity]
 * @param {number} [ctx.cash]
 * @param {number} [ctx.currentExposure]
 * @param {number} [ctx.maxPositionPct]
 * @param {number} [ctx.maxNotional]
 * @param {number} [ctx.minPrice] default 1
 * @param {number} [ctx.minAvgDailyVolume]
 */
function evaluate(action, ctx = {}) {
  const reasons = [];

  if (isKillSwitchOn(ctx)) {
    reasons.push('KILL_SWITCH is active');
    return { decision: DECISIONS.REJECT, reasons };
  }

  const price = action.price != null ? Number(action.price) : null;
  const exchange = String(action.exchange || ctx.exchange || '')
    .trim()
    .toUpperCase();
  const minPrice = ctx.minPrice != null ? Number(ctx.minPrice) : numEnv('RISK_MIN_PRICE', 1);

  // Penny / OTC reject
  if (exchange === 'OTC' || exchange === 'OTCMKTS' || exchange === 'PINK') {
    reasons.push(`exchange ${exchange || 'OTC'} is not allowed (penny/OTC policy)`);
    return { decision: DECISIONS.REJECT, reasons };
  }
  if (price != null && Number.isFinite(price) && price < minPrice) {
    reasons.push(`penny stock rejected: price $${price} < min $${minPrice}`);
    return { decision: DECISIONS.REJECT, reasons };
  }

  let notional = action.notional != null ? Number(action.notional) : null;
  if (
    (notional == null || !Number.isFinite(notional)) &&
    action.qty != null &&
    price != null
  ) {
    notional = Number(action.qty) * price;
  }

  const maxNotional =
    ctx.maxNotional != null ? Number(ctx.maxNotional) : numEnv('RISK_MAX_NOTIONAL', 50000);
  if (Number.isFinite(notional) && notional > maxNotional) {
    reasons.push(`notional $${notional.toFixed(2)} exceeds max $${maxNotional}`);
    return { decision: DECISIONS.REJECT, reasons };
  }

  const equity = ctx.equity != null ? Number(ctx.equity) : null;
  const maxPositionPct =
    ctx.maxPositionPct != null
      ? Number(ctx.maxPositionPct)
      : numEnv('RISK_MAX_POSITION_PCT', 0.25);
  if (
    Number.isFinite(equity) &&
    equity > 0 &&
    Number.isFinite(notional) &&
    notional / equity > maxPositionPct
  ) {
    reasons.push(
      `position size ${(100 * (notional / equity)).toFixed(1)}% exceeds max ${(100 * maxPositionPct).toFixed(1)}% of equity`
    );
    return { decision: DECISIONS.REJECT, reasons };
  }

  const cash = ctx.cash != null ? Number(ctx.cash) : null;
  if (
    String(action.side).toLowerCase() === 'buy' &&
    Number.isFinite(cash) &&
    Number.isFinite(notional) &&
    notional > cash + 1e-9
  ) {
    reasons.push(`insufficient cash: need $${notional.toFixed(2)}, have $${cash.toFixed(2)}`);
    return { decision: DECISIONS.REJECT, reasons };
  }

  const currentExposure =
    ctx.currentExposure != null ? Number(ctx.currentExposure) : null;
  const maxExposure =
    ctx.maxExposure != null ? Number(ctx.maxExposure) : numEnv('RISK_MAX_EXPOSURE', 100000);
  if (
    Number.isFinite(currentExposure) &&
    Number.isFinite(notional) &&
    currentExposure + notional > maxExposure
  ) {
    reasons.push(
      `exposure $${(currentExposure + notional).toFixed(2)} would exceed max $${maxExposure}`
    );
    return { decision: DECISIONS.REJECT, reasons };
  }

  const adv =
    action.avg_daily_volume != null
      ? Number(action.avg_daily_volume)
      : ctx.avgDailyVolume != null
        ? Number(ctx.avgDailyVolume)
        : null;
  const minAdv =
    ctx.minAvgDailyVolume != null
      ? Number(ctx.minAvgDailyVolume)
      : numEnv('RISK_MIN_ADV', 100000);
  const qty = action.qty != null ? Number(action.qty) : null;
  if (Number.isFinite(adv) && adv > 0 && Number.isFinite(qty) && qty > 0) {
    if (adv < minAdv) {
      reasons.push(`avg daily volume ${adv} below minimum ${minAdv}`);
      return { decision: DECISIONS.REJECT, reasons };
    }
    const maxPctOfAdv =
      ctx.maxPctOfAdv != null ? Number(ctx.maxPctOfAdv) : numEnv('RISK_MAX_PCT_OF_ADV', 0.05);
    if (qty > adv * maxPctOfAdv) {
      reasons.push(`order qty ${qty} exceeds ${(100 * maxPctOfAdv).toFixed(1)}% of ADV ${adv}`);
      return { decision: DECISIONS.REJECT, reasons };
    }
  }

  reasons.push('risk checks passed');
  return { decision: DECISIONS.ALLOW, reasons };
}

module.exports = {
  evaluate,
  isKillSwitchOn,
  DECISIONS,
};
