'use strict';

/**
 * Sub-sector classification, and caps on how much of one bet the log may hold.
 *
 * Five signals produced ELV, CNC, HUM and one more managed care name. That is
 * not four bets on four companies; it is one bet on health insurers, taken four
 * times. A mean-reversion screen finds whatever sub-sector is being repriced and
 * returns all of it, so the track record ends up measuring a single sector move
 * rather than the strategy.
 *
 * The map is hardcoded rather than fetched. Yahoo's sector field needs the
 * quoteSummary endpoint, which now returns 401 without a crumb, and the
 * alternative — inferring sector from price behaviour — would be circular given
 * what it is used for here. Sixty-odd tickers classified by hand is honest,
 * checkable, and does not silently drift.
 *
 * Where a ticker is unknown it gets its own bucket rather than a shared one, so
 * an unclassified name is never wrongly grouped. That errs towards allowing a
 * signal through, which is the right direction: a missed cap is a smaller error
 * than a wrong grouping.
 */

const SUB_SECTOR = {
  // Managed care — the four names that showed the problem.
  UNH: 'managed_care',
  ELV: 'managed_care',
  CNC: 'managed_care',
  HUM: 'managed_care',
  CI: 'managed_care',

  // Large pharma
  LLY: 'pharma_large',
  JNJ: 'pharma_large',
  MRK: 'pharma_large',
  BMY: 'pharma_large',
  PFE: 'pharma_large',
  NVO: 'pharma_large',
  AZN: 'pharma_large',
  GSK: 'pharma_large',
  NVS: 'pharma_large',
  ZTS: 'pharma_large',
  RPRX: 'pharma_large',

  // Generics and speciality
  TEVA: 'generics',
  VTRS: 'generics',
  PRGO: 'generics',
  AMRX: 'generics',
  'CIPLA.NS': 'generics',
  'LUPIN.NS': 'generics',
  'SUNPHARMA.NS': 'generics',
  'DRREDDY.NS': 'generics',
  'AUROPHARMA.NS': 'generics',
  'ZYDUSLIFE.NS': 'generics',

  // Life science tools
  TMO: 'life_science_tools',
  DHR: 'life_science_tools',
  MTD: 'life_science_tools',
  WAT: 'life_science_tools',
  A: 'life_science_tools',
  ILMN: 'life_science_tools',
  WST: 'life_science_tools',
  ICLR: 'life_science_tools',

  // Devices and equipment
  SYK: 'medtech',
  DXCM: 'medtech',
  BSX: 'medtech',
  GEHC: 'medtech',
  MDT: 'medtech',
  RMD: 'medtech',
  EW: 'medtech',
  STE: 'medtech',
  ZBH: 'medtech',
  ABT: 'medtech',
  ISRG: 'medtech',
  BDX: 'medtech',
  PODD: 'medtech',
  IDXX: 'medtech',
  SNN: 'medtech',
  PHG: 'medtech',
  ALC: 'medtech',
  COO: 'medtech',

  // Providers, distributors, services
  HCA: 'providers',
  MCK: 'distribution',
  CAH: 'distribution',
  COR: 'distribution',
  CVS: 'services',
  LH: 'services',
  DGX: 'services',
  FMS: 'services',
  VEEV: 'health_it',
};

/** How many open positions one sub-sector may hold. */
const MAX_PER_SUB_SECTOR = Number(process.env.SIGNAL_MAX_PER_SUB_SECTOR || 2);

/** How many pending recommendations one sub-sector may have waiting. */
const MAX_PENDING_PER_SUB_SECTOR = Number(process.env.SIGNAL_MAX_PENDING_PER_SUB_SECTOR || 2);

function subSectorOf(ticker) {
  // Unknown names get their own bucket rather than sharing one, so a ticker
  // nobody classified is never grouped with something it has nothing to do with.
  return SUB_SECTOR[ticker] || 'unclassified:' + ticker;
}

/**
 * Whether another call in this name's sub-sector would breach the cap.
 *
 * Counts both open positions and recommendations still waiting on a decision —
 * three pending managed care names is the same concentration problem as three
 * held ones, just deferred.
 */
function concentrationCheck(db, identityId, ticker) {
  const sector = subSectorOf(ticker);

  // Both portfolios. This counted paper_positions, which the research side
  // never wrote to — so research positions were invisible to the cap and it
  // could hold any number in one sub-sector while reporting no concentration.
  const { allHeldTickers } = require('./positions');
  const held = allHeldTickers(identityId)
    .filter((t) => subSectorOf(t) === sector)
    .map((t) => ({ ticker: t }));

  if (held.length >= MAX_PER_SUB_SECTOR) {
    return {
      allowed: false,
      reason:
        'already holding ' + held.length + ' in ' + sector + ' (' +
        held.map((h) => h.ticker).join(', ') + ')',
      sector,
    };
  }

  const waiting = db
    .prepare("SELECT ticker FROM agent_recommendation WHERE identity_id IS ? AND status = 'pending'")
    .all(identityId ?? null)
    .filter((r) => subSectorOf(r.ticker) === sector);

  if (waiting.length >= MAX_PENDING_PER_SUB_SECTOR) {
    return {
      allowed: false,
      reason:
        already(waiting.length) + ' pending in ' + sector + ' (' +
        waiting.map((r) => r.ticker).join(', ') + ')',
      sector,
    };
  }

  return { allowed: true, sector };
}

function already(n) {
  return 'already ' + n;
}

module.exports = {
  SUB_SECTOR,
  subSectorOf,
  concentrationCheck,
  MAX_PER_SUB_SECTOR,
  MAX_PENDING_PER_SUB_SECTOR,
};
