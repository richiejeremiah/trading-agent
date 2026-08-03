'use strict';

/**
 * The daily cycle.
 *
 * Without this the experiment only advances when someone is at a keyboard, and
 * a hundred recommendations at three a day is a month of remembering to type.
 * A track record built from the days you happened to feel like running it is
 * not a track record.
 *
 * Order matters:
 *
 *   1. Ingest — new FDA events, so the signals see today's news.
 *   2. Score  — fill in what yesterday's calls did, before making new ones.
 *   3. Signal — generate today's recommendations.
 *   4. Notify — tell each verified identity what is waiting.
 *
 * Scoring before signalling is deliberate. If a signal ever consults the
 * scorecard — a conviction weighting, a strategy that turns itself off — it must
 * read yesterday's outcome and not a stale one.
 *
 * On weekends the market is shut, so signals are skipped and only scoring runs.
 * Generating a recommendation on a Saturday would price it at Friday's close and
 * date it Saturday, which quietly corrupts the point-in-time record.
 */

const { ingestFdaEvents } = require('./knowledge-ingest');
const { runSignals } = require('./signal-engine');
const { scoreAll } = require('../scripts/score-recommendations');
const { backfill } = require('../scripts/backfill-benchmark');
const { getDb } = require('../database');
const { openTrade, fillPending, markAndExit } = require('./trade-service');
const { currentRegime } = require('./regime-service');
const { runHealthChecks } = require('./health-service');
const { dailyUpdate } = require('./trade-reporting');

/** Hour of the day, local time, to run. Default is after the US close. */
const RUN_HOUR = Number(process.env.SCHEDULER_HOUR || 17);

let timer = null;
let running = false;

function isWeekend(d) {
  const day = d.getDay();
  return day === 0 || day === 6;
}

function verifiedIdentities() {
  try {
    return getDb()
      .prepare('SELECT id, chat_id FROM agent_identity WHERE verified_at IS NOT NULL AND chat_id IS NOT NULL')
      .all();
  } catch {
    return [];
  }
}

/**
 * One full cycle. Every step is allowed to fail without stopping the rest — a
 * broken ingest should not mean yesterday's calls go unscored.
 */
async function runCycle({ verbose = true, notify = null } = {}) {
  const started = new Date();
  const weekend = isWeekend(started);
  const result = { at: started.toISOString(), weekend, steps: {} };

  if (verbose) console.log('\n[cycle] ' + started.toISOString() + (weekend ? ' (weekend — scoring only)' : ''));

  // First, because everything after it is only as good as the data behind it.
  try {
    const health = await runHealthChecks({ verbose: false });
    result.steps.health = health.data;
    if (verbose) console.log('[cycle] health: ' + health.data.verdict);
  } catch (e) {
    result.steps.health = { error: e.message };
  }

  try {
    if (!weekend) {
      const ingest = await ingestFdaEvents(30);
      result.steps.ingest = ingest.ok ? ingest.data : { error: ingest.error.message };
      if (verbose) console.log('[cycle] ingest: ' + JSON.stringify(result.steps.ingest));
    }
  } catch (e) {
    result.steps.ingest = { error: e.message };
    if (verbose) console.warn('[cycle] ingest failed: ' + e.message);
  }

  try {
    const scored = await scoreAll({ verbose: false });
    result.steps.score = scored.ok ? scored.data : { error: scored.error.message };
    await backfill({ verbose: false });
    if (verbose) console.log('[cycle] score: ' + JSON.stringify(result.steps.score));
  } catch (e) {
    result.steps.score = { error: e.message };
    if (verbose) console.warn('[cycle] scoring failed: ' + e.message);
  }

  // Fills and exits before new signals. A trade opened yesterday should be
  // filled at today's open before today's cycle decides anything, and an exit
  // that is due should happen on its own date rather than a day late.
  try {
    const fills = await fillPending({ verbose: false });
    const exits = await markAndExit({ verbose: false });
    result.steps.trades = { ...fills.data, ...exits.data };
    if (verbose) console.log('[cycle] trades: ' + JSON.stringify(result.steps.trades));
  } catch (e) {
    result.steps.trades = { error: e.message };
    if (verbose) console.warn('[cycle] trade maintenance failed: ' + e.message);
  }

  if (!weekend) {
    const identities = verifiedIdentities();
    result.steps.signals = {};

    for (const who of identities) {
      try {
        const signals = await runSignals(who.id, { verbose: false });
        const n = signals.ok ? signals.data.generated : 0;
        result.steps.signals[who.id] = signals.ok ? n : signals.error.message;

        if (verbose) console.log('[cycle] identity ' + who.id + ': ' + n + ' recommendation(s)');

        // Every valid signal is taken by the research portfolio, whatever the
        // person does. That is the whole point: the research portfolio answers
        // whether the signal is good, and the user portfolio answers whether
        // the filtering adds anything. Mixing them answers neither.
        //
        // Signals from one run share a cluster id. Four managed care names on
        // one sector-wide drop is one macro trade logged four times, and the
        // effective sample size cannot be recovered later without this.
        if (signals.ok && n > 0) {
          // Signals on the same day share a cluster whatever run produced them.
          // Two runs producing two clusters would count one day's correlated
          // signals as two independent observations.
          const cluster = 'c' + started.toISOString().slice(0, 10) + '-' + who.id;
          for (const r of signals.data.recommendations) {
            try {
              openTrade({
                identityId: null,
                portfolio: 'research',
                recommendationId: r.id,
                ticker: r.ticker,
                strategy: r.strategy,
                side: 'buy',
                signalPrice: r.price_at_rec,
                clusterId: cluster,
              });
            } catch (e) {
              if (verbose) console.warn('[cycle] could not open research trade for ' + r.ticker + ': ' + e.message);
            }
          }
          try {
            const reg = await currentRegime();
            if (reg.data.regime) {
              getDb()
                .prepare("UPDATE trade SET regime = ? WHERE cluster_id = ? AND regime IS NULL")
                .run(reg.data.regime, cluster);
              if (verbose) console.log('[cycle] regime: ' + reg.data.regime);
            }
          } catch (e) {
            if (verbose) console.warn('[cycle] regime unavailable: ' + e.message);
          }
        }

        // Only interrupt someone when there is something to say.
        // What closed, what is running, what is waiting — sent whether or not
        // there are new signals, because a position that exited today is worth
        // knowing about even on a quiet day. Silent when there is nothing.
        if (notify) {
          try {
            const daily = await dailyUpdate(who.id);
            if (daily) await notify(who.chat_id, daily);
        } catch (e) {
            if (verbose) console.warn('[cycle] daily update failed: ' + e.message);
          }
        }

        if (notify && signals.ok && n > 0) {
          const lines = signals.data.recommendations.map(
            (r) => '#' + r.id + '  ' + r.ticker + '  ' + (r.strategy || '')
          );
          await notify(
            who.chat_id,
            n + ' new recommendation' + (n === 1 ? '' : 's') + ':\n' + lines.join('\n') + '\n\n/pending for the reasoning'
          );
        }
      } catch (e) {
        result.steps.signals[who.id] = e.message;
        if (verbose) console.warn('[cycle] signals failed for ' + who.id + ': ' + e.message);
      }
    }
  }

  const seconds = Math.round((Date.now() - started.getTime()) / 1000);
  if (verbose) console.log('[cycle] done in ' + seconds + 's');

  result.seconds = seconds;
  return result;
}

/** Milliseconds until the next RUN_HOUR. */
/**
 * When the next cycle runs.
 *
 * SCHEDULER_TEST_SECONDS overrides the hour, so the timer path can be proven
 * without waiting until evening. Everything else — the setTimeout, the reschedule
 * after the run — is the same code that runs in production.
 */
function msUntilNextRun() {
  const testSeconds = Number(process.env.SCHEDULER_TEST_SECONDS || 0);
  if (testSeconds > 0) return testSeconds * 1000;

  const now = new Date();
  const next = new Date(now);
  next.setHours(RUN_HOUR, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

function schedule(notify) {
  const wait = msUntilNextRun();
  const at = new Date(Date.now() + wait);

  console.log('[scheduler] next cycle ' + at.toLocaleString());

  timer = setTimeout(async () => {
    console.log('[scheduler] cycle firing at ' + new Date().toISOString());
    try {
      await runCycle({ notify });
    } catch (e) {
      console.error('[scheduler] cycle threw:', e.message);
    }
    // Rescheduled after the run rather than on an interval, so a cycle that
    // overruns cannot stack up behind itself.
    if (running) schedule(notify);
  }, wait);
}

function start(notify) {
  if (running) return;
  running = true;
  schedule(notify);
}

function stop() {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

if (require.main === module) {
  // Run once and exit — for testing, and for anyone who would rather drive this
  // from cron than leave a process up.
  runCycle({ verbose: true })
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('[cycle] failed:', e.message);
      process.exit(1);
    });
}

module.exports = { start, stop, runCycle, RUN_HOUR };
