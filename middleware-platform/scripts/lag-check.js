const { getRecentRecalls } = require(process.env.HOME + '/.arch-viz/repos/21a6c9c0-4774-4a8c-9cac-128919b48170/middleware-platform/services/fda-client.js');

getRecentRecalls(60).then((r) => {
  if (!r.ok) { console.log('failed: ' + r.error.message); return; }

  const now = Date.now();
  const ages = r.data
    .map((x) => Math.floor((now - new Date(x.published_at)) / 86400000))
    .sort((a, b) => a - b);

  console.log(r.data.length + ' recalls over 60 days');
  console.log('  newest    ' + ages[0] + ' days old');
  console.log('  median    ' + ages[Math.floor(ages.length / 2)] + ' days');
  console.log('  under 5d  ' + ages.filter((a) => a <= 5).length);
  console.log('');
  console.log('The staleness rule rejects anything over 5 days. If that count is');
  console.log('zero, no recall will ever clear it however long the cycle runs —');
  console.log('and the event strategy does not resolve with time.');
});
