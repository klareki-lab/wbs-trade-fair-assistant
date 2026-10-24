// One PostgreSQL connection for the dashboard, created lazily. Not imported by browser.
// Requires npm dependency pg@8; no credentials appear in source/logs.
import { makeDashboardHandler } from './dashboard-api.mjs';
export const DASHBOARD_SQL = `SELECT trade_fair.dashboard_snapshot($1::integer,$2::integer,$3::text,$4::text,$5::text,$6::text,$7::text,$8::text,$9::text) AS payload`;

export function createDashboardDb({connectionString, poolFactory}={}) {
  if (!connectionString || !/^postgres(?:ql)?:\/\//.test(connectionString)) throw new Error('DASHBOARD_DATABASE_URL must be a PostgreSQL URL');
  // Avoid URI sslmode/sslcert flags silently overriding Node TLS verification.
  const safeUrl=new URL(connectionString);
  for (const key of ['sslmode','sslrootcert','sslcert','sslkey']) safeUrl.searchParams.delete(key);
  let pool;
  const ensurePool=async()=>{
    if (!pool) {
      if (!poolFactory) {
        const module=await import('pg');
        const Pool=module.Pool || module.default?.Pool;
        if (!Pool) throw new Error('PostgreSQL adapter is not installed');
        poolFactory=opts=>new Pool(opts);
      }
      pool=poolFactory({connectionString:safeUrl.toString(),ssl:{rejectUnauthorized:true},max:3,connectionTimeoutMillis:4000,idleTimeoutMillis:15000,application_name:'trade_fair_dashboard'});
    }
    return pool;
  };
  const handler=makeDashboardHandler(async params=>{
    const db=await ensurePool();
    const client=await db.connect();
    try {
      // Defense in depth. The function itself is SELECT-only / STABLE.
      await client.query('BEGIN READ ONLY');
      await client.query("SET LOCAL statement_timeout = '5000ms'");
      const {rows}=await client.query(DASHBOARD_SQL,[params.limit,params.offset,params.search,params.band,params.processing,params.email,params.duplicate,params.sort,params.direction]);
      await client.query('COMMIT');
      if (rows.length !== 1) throw new Error('Unexpected dashboard result');
      return rows[0].payload;
    } catch(e) {
      try {await client.query('ROLLBACK');}catch{}
      throw e;
    } finally {client.release();}
  });
  return {query:handler,close:async()=>{if(pool)await pool.end()}};
}
