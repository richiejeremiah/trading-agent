/**
 * Force a weekday cycle, whatever day it actually is.
 *
 * The scheduler skips weekends, which is right — a recommendation generated on
 * a Saturday would be priced at Friday's close and dated Saturday. But it also
 * means the full path has never run, and a scheduler tested only on the days it
 * refuses to work is not tested.
 *
 * Date.prototype.getDay is stubbed for the duration. Crude, contained, and it
 * exercises ingest, scoring and signals in the order the real cycle uses.
 */
const real = Date.prototype.getDay;
Date.prototype.getDay = function () { return 2; };

require('dotenv').config();

require('../services/scheduler.js')
  .runCycle({
    verbose: true,
    notify: async (chatId, text) => {
      console.log('\n[notify → ' + chatId + ']\n' + text + '\n');
    },
  })
  .then((r) => {
    Date.prototype.getDay = real;
    console.log('\n' + JSON.stringify(r, null, 1));
    process.exit(0);
  })
  .catch((e) => {
    Date.prototype.getDay = real;
    console.error('cycle threw:', e.message);
    process.exit(1);
  });
