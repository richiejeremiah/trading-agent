const db = require('../database.js').getDb();
const { getHistoricalPrices } = require('../services/market-data-client.js');
const { concentrationCheck } = require('../services/sub-sectors.js');

const IDENTITY = 2;
const LOOKBACK = 120;
const DROP = 0.05;

function closeOnOrBefore(quotes, target) {
  const t = target.getTime();
  let best = null, bestT = -Infinity;
  for (const q of quotes) {
    const d = new Date(q.date).getTime();
    if (d <= t && d > bestT) { best = q; bestT = d; }
  }
  return best ? best.close : null;
}

(async () => {
  const events = db.prepare(
    "SELECT ticker, kind, published_at, captured_at FROM kg_event " +
    "WHERE published_at > datetime('now','-" + LOOKBACK + " days') ORDER BY published_at DESC"
  ).all();

  console.log(events.length + ' events in window\n');

  const bench = await getHistoricalPrices('XLV', { range: '6mo', interval: '1d' });
  const bq = bench.ok ? bench.data.quotes : [];
  const seen = new Set();

  for (const e of events) {
    const why = [];
    if (seen.has(e.ticker)) { console.log(e.ticker.padEnd(14) + 'skip: already seen this run'); continue; }
    seen.add(e.ticker);

    const cool = db.prepare(
      "SELECT recommended_at FROM agent_recommendation WHERE ticker = ? AND identity_id IS ? " +
      "AND recommended_at > datetime('now','-14 days') ORDER BY recommended_at DESC LIMIT 1"
    ).get(e.ticker, IDENTITY);
    if (cool) why.push('cooldown until 14d after ' + cool.recommended_at);

    const conc = concentrationCheck(db, IDENTITY, e.ticker);
    if (!conc.allowed) why.push('concentration: ' + conc.reason);

    const s = await getHistoricalPrices(e.ticker, { range: '3mo', interval: '1d' });
    if (!s.ok) { console.log(e.ticker.padEnd(14) + 'skip: no history'); continue; }
    const q = s.data.quotes;

    const publishedAt = new Date(e.published_at);
    const seenAt = e.captured_at ? new Date(e.captured_at) : publishedAt;
    const from = seenAt > publishedAt ? seenAt : publishedAt;

    const before = closeOnOrBefore(q, from);
    const latest = q.length ? q[q.length - 1].close : null;
    const bBefore = closeOnOrBefore(bq, from);
    const bLatest = bq.length ? bq[bq.length - 1].close : null;

    if (!before || !latest || !bBefore || !bLatest) {
      console.log(e.ticker.padEnd(14) + 'skip: missing bar (before=' + before + ' bench=' + bBefore + ') tradeable from ' + from.toISOString().slice(0,10));
      continue;
    }

    const rel = (latest - before) / before - (bLatest - bBefore) / bBefore;
    const passes = rel <= -DROP;
    console.log(
      e.ticker.padEnd(14) + 'from ' + from.toISOString().slice(0,10) +
      '  rel ' + (rel * 100).toFixed(1) + '%  ' +
      (passes ? 'PASSES threshold' : 'below threshold') +
      (why.length ? '  BLOCKED: ' + why.join('; ') : '')
    );
    await new Promise(r => setTimeout(r, 250));
  }
})();
