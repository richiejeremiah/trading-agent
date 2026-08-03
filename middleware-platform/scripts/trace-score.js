const d = require('../database.js');
const db = d.getDb();

db.prepare('UPDATE agent_recommendation SET bench_at_rec=NULL, bench_symbol=NULL').run();

const orig = db.prepare.bind(db);
db.prepare = function (sql) {
  const st = orig(sql);
  if (sql.includes('bench_symbol')) {
    console.log('SQL : ' + sql);
    const run = st.run.bind(st);
    st.run = function (...a) {
      console.log('VALS: ' + JSON.stringify(a));
      const res = run(...a);
      console.log('CHANGES: ' + res.changes);
      return res;
    };
  }
  return st;
};

require('./score-recommendations.js')
  .scoreAll({ verbose: false })
  .then(() => {
    db.prepare = orig;
    console.log(db.prepare('SELECT id,bench_symbol,bench_at_rec FROM agent_recommendation LIMIT 3').all());
  });
