'use strict';

/**
 * Dividends, which otherwise read as losses.
 *
 * On the ex-date a stock drops by roughly the dividend. To anything comparing
 * raw prices that is a real fall, and the holder — who received the cash — is
 * scored as though they lost it.
 *
 * Over a seven-day hold this is not noise. Healthcare pays reliably: LLY, JNJ,
 * PFE, ABT and MRK all yield one to three percent, so a quarterly ex-date
 * inside the window is roughly half a percent of phantom loss. Against a
 * measured mean excess of −0.17%, a systematic bias of that size on exactly the
 * names most likely to be held would make every strategy look worse than it is
 * — and would do so invisibly.
 *
 * The benchmark has the same problem in the other direction. XLV distributes
 * too, so comparing a dividend-adjusted stock against an unadjusted benchmark
 * would overcorrect. Both sides are adjusted or neither is.
 *
 * Where dividend data cannot be fetched the trade is marked invalid rather than
 * scored unadjusted. The same rule as splits: prefer no answer to a wrong one.
 */

const RATE_MS = 200;

/**
 * Dividends paid between two dates, from Yahoo's chart endpoint.
 *
 * Returns an ok/error union like everything else. An empty array means no
 * dividends in the window; a failure means we do not know, and those are
 * different answers that must not collapse into each other.
 */
async function dividendsBetween(ticker, fromIso, toIso, { range = '1y' } = {}) {
  const url =
    'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(ticker) +
    '?interval=1d&range=' + range + '&events=div';

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    });

    if (!res.ok) {
      return { ok: false, error: { code: 'FETCH_ERROR', message: 'HTTP ' + res.status + ' for ' + ticker } };
    }

    const json = await res.json();
    const result = json && json.chart && json.chart.result && json.chart.result[0];
    if (!result) {
      return { ok: false, error: { code: 'PARSE_ERROR', message: 'no chart result for ' + ticker } };
    }

    const events = result.events && result.events.dividends ? Object.values(result.events.dividends) : [];

    const from = new Date(fromIso).getTime();
    const to = new Date(toIso || Date.now()).getTime();

    // Yahoo dates are seconds. An ex-date exactly on the fill date counts —
    // the buyer at that morning's open does not receive it, which is the
    // conservative reading.
    const inWindow = events
      .filter((d) => {
        const t = d.date * 1000;
        return t > from && t <= to;
      })
      .map((d) => ({ amount: d.amount, date: new Date(d.date * 1000).toISOString().slice(0, 10) }));

    const total = inWindow.reduce((s, d) => s + d.amount, 0);

    return { ok: true, data: { ticker, dividends: inWindow, total } };
  } catch (e) {
    return { ok: false, error: { code: 'FETCH_ERROR', message: e.message } };
  }
}

/**
 * The dividend adjustment for one trade, and for the benchmark over the same
 * window.
 *
 * Both or neither. Adjusting the stock and not the benchmark would replace an
 * understatement with an overstatement, which is not an improvement.
 */
async function adjustmentFor({ ticker, benchmark, fillAt, exitAt, fillPrice, benchAtFill }) {
  const stock = await dividendsBetween(ticker, fillAt, exitAt);
  await new Promise((r) => setTimeout(r, RATE_MS));

  if (!stock.ok) {
    return {
      ok: false,
      error: {
        code: 'NO_DIVIDEND_DATA',
        message: 'could not establish dividends for ' + ticker + ': ' + stock.error.message,
      },
    };
  }

  const bench = await dividendsBetween(benchmark, fillAt, exitAt);
  await new Promise((r) => setTimeout(r, RATE_MS));

  if (!bench.ok) {
    return {
      ok: false,
      error: {
        code: 'NO_DIVIDEND_DATA',
        message: 'could not establish dividends for ' + benchmark + ': ' + bench.error.message,
      },
    };
  }

  // Expressed as a percentage of the entry price, so it adds directly to the
  // return rather than needing the share count.
  const stockPct = fillPrice ? stock.data.total / fillPrice : 0;
  const benchPct = benchAtFill ? bench.data.total / benchAtFill : 0;

  return {
    ok: true,
    data: {
      stock_dividends: stock.data.dividends,
      stock_total: Number(stock.data.total.toFixed(4)),
      stock_pct: Number((stockPct * 100).toFixed(4)),
      bench_dividends: bench.data.dividends,
      bench_pct: Number((benchPct * 100).toFixed(4)),
      // What to add to the trade's excess return. Positive when the stock paid
      // more than the benchmark over the same days.
      excess_adjustment_pct: Number(((stockPct - benchPct) * 100).toFixed(4)),
      any: stock.data.dividends.length > 0 || bench.data.dividends.length > 0,
    },
  };
}

module.exports = { dividendsBetween, adjustmentFor };
