'use strict';

/**
 * Will Telegram accept these messages?
 *
 * HTML mode is unforgiving: an unclosed tag, a stray angle bracket outside a
 * tag, or an unsupported element and the entire message is refused. To the
 * person typing the command that looks like the bot ignoring them, which is the
 * worst kind of bug — no error, no output, nothing to search for.
 *
 * Telegram supports only b, strong, i, em, u, ins, s, strike, del, a, code,
 * pre, tg-spoiler and blockquote. Anything else is a rejection.
 */

require('dotenv').config();

const report = require('../services/trade-reporting');

const ALLOWED = new Set([
  'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del',
  'a', 'code', 'pre', 'tg-spoiler', 'blockquote',
]);

function validate(name, html) {
  const problems = [];

  // Balanced tags, and only tags Telegram knows.
  const stack = [];
  const tagRe = /<\/?([a-zA-Z-]+)[^>]*>/g;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const closing = m[0][1] === '/';

    if (!ALLOWED.has(tag)) {
      problems.push('unsupported tag <' + tag + '> — Telegram will refuse the whole message');
      continue;
    }
    if (closing) {
      if (stack.pop() !== tag) problems.push('closing </' + tag + '> does not match what was open');
    } else {
      stack.push(tag);
    }
  }
  if (stack.length) problems.push('unclosed: ' + stack.join(', '));

  // A bare angle bracket outside a tag. Common when a value is interpolated
  // without escaping.
  const stripped = html.replace(tagRe, '');
  if (stripped.includes('<') || stripped.includes('>')) {
    problems.push('a bare < or > outside a tag — needs escaping');
  }

  // An unescaped ampersand that is not a known entity.
  const badAmp = stripped.match(/&(?!amp;|lt;|gt;|quot;|#\d+;)/);
  if (badAmp) problems.push('an unescaped & — needs &amp;');

  if (html.length > 4096) problems.push('longer than 4096 characters, Telegram will truncate or refuse');

  return problems;
}

(async () => {
  const identityId = Number(process.argv[2] || 2);
  console.log('\nHTML validation — identity ' + identityId + '\n');

  const reports = [
    ['/open', await report.openPositions(identityId)],
    ['/experiment', await report.experimentReport(identityId)],
    ['/excluded', report.invalidTrades()],
    ['/slippage', report.slippageReport()],
    ['daily update', (await report.dailyUpdate(identityId)) || '(nothing to say — not sent)'],
  ];

  // A recommendation too, since /pending is built from them.
  const db = require('../database').getDb();
  const rec = db.prepare("SELECT * FROM agent_recommendation WHERE status = 'pending' LIMIT 1").get();
  if (rec) reports.push(['a recommendation', report.formatRecommendation(rec)]);

  let bad = 0;
  for (const [name, html] of reports) {
    const problems = validate(name, html);
    if (problems.length === 0) {
      console.log('  ok    ' + name.padEnd(18) + html.length + ' chars');
    } else {
      bad += 1;
      console.log('  FAIL  ' + name);
      for (const p of problems) console.log('          ' + p);
    }
  }

  console.log('\n' + (reports.length - bad) + ' of ' + reports.length + ' will render\n');

  if (process.argv.includes('--show')) {
    for (const [name, html] of reports) {
      console.log('\n--- ' + name + ' ---\n' + html);
    }
  }

  process.exit(bad ? 1 : 0);
})();
