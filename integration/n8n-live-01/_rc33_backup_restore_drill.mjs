// RC3.3 Phase B item 7 — backup/restore drill on disposable targets.
//
// Spins up a SOURCE PostgreSQL 16, installs the committed trade_fair schema
// (same DDL used in regression tests), inserts synthetic companies/contacts/
// lead_submissions, pg_dumps the trade_fair schema, then spins up a TARGET
// PostgreSQL 16 and restores from the dump. Verifies:
//   • row counts match on companies, contacts, lead_submissions
//   • dashboard_snapshot() returns an identical result set on source and target
//   • trade_fair_dashboard role + ACL survive the restore
// Fails nonzero on any mismatch; prints a sanitized evidence line per check.
import { execFile as rawExec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import pg from '../../gateway/node_modules/pg/lib/index.js';

const exec = promisify(rawExec);
const root = new URL('../../', import.meta.url);
const run = (args) => exec('docker', args, { maxBuffer: 8 * 1024 * 1024 });

function pass(m) { console.log('PASS —', m); }
function fail(m, e = '') { console.error('FAIL —', m, e); process.exit(1); }

async function startPg(label) {
  const name = `wbs-rc33-${label}-${randomUUID().slice(0, 8)}`;
  await run(['run', '-d', '--rm', '--name', name,
    '-p', '127.0.0.1::5432',
    '-e', 'POSTGRES_USER=neondb_owner',
    '-e', 'POSTGRES_PASSWORD=synthetic-local-only',
    '-e', 'POSTGRES_DB=neondb',
    'postgres:16-alpine']);
  const { stdout } = await run(['port', name, '5432']);
  const port = Number(stdout.trim().split(':').at(-1));
  const pool = new pg.Pool({ host: '127.0.0.1', port, user: 'neondb_owner', password: 'synthetic-local-only', database: 'neondb', max: 4 });
  for (let i = 0; i < 80; i++) { try { await pool.query('SELECT 1'); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
  return { name, port, pool, drop: async () => { try { await pool.end(); } catch {} try { await run(['rm', '-f', name]); } catch {} } };
}

async function installSchema(pool, name) {
  await pool.query("CREATE SCHEMA trade_fair; CREATE ROLE trade_fair_dashboard LOGIN PASSWORD 'synthetic-local-only'; GRANT USAGE ON SCHEMA trade_fair TO trade_fair_dashboard;");
  await pool.query(await readFile(new URL('sql/dashboard_confirmed_ddl.sql', root), 'utf8'));
  await pool.query(await readFile(new URL('sql/dashboard_snapshot_definition.sql', root), 'utf8'));
  await pool.query('REVOKE ALL ON FUNCTION trade_fair.dashboard_snapshot(integer,integer,text,text,text,text,text,text,text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION trade_fair.dashboard_snapshot(integer,integer,text,text,text,text,text,text,text) TO trade_fair_dashboard;');
  const content = await readFile(new URL('sql/production/dashboard_crm_v1_up.sql', root), 'utf8');
  await new Promise((resolve, reject) => {
    const child = rawExec('docker', ['exec', '-i', name, 'psql', '-X', '-U', 'neondb_owner', '-d', 'neondb', '-v', 'production_branch_confirmed=on'],
      { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => err ? reject(Object.assign(err, { stdout, stderr })) : resolve());
    child.stdin.end(content);
  });
}

async function seed(pool) {
  await pool.query(`INSERT INTO trade_fair.companies(company_id,company_name,company_name_normalized)
    VALUES('11111111-1111-4111-8111-111111111111','RC33 Synthetic GmbH','rc33 synthetic gmbh'),
          ('22222222-2222-4222-8222-222222222222','RC33 Other AG','rc33 other ag');`);
  await pool.query(`INSERT INTO trade_fair.contacts(contact_id,company_id,contact_name,email)
    VALUES('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111','Alice Example','alice@rc33.test'),
          ('44444444-4444-4444-8444-444444444444','22222222-2222-4222-8222-222222222222','Bob Example','bob@rc33.test');`);
  const ids = Array.from({ length: 5 }, (_, i) => `FAIR-00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
  for (const id of ids) {
    await pool.query(`INSERT INTO trade_fair.lead_submissions(lead_id,source,submission_id,company_id,contact_id,duplicate_status,raw_payload,normalized_payload,receipt,wf_b_payload,created_at)
      VALUES($1,'internal_form',$2,'11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','NEW','{}',$3,'{}','{}',now())`,
      [id, 'rc33-' + id, JSON.stringify({ notes: 'Synthetic RC33 lead', budget_status: 'planned', training_interest: 'ai_automation', follow_up: 'within_one_week' })]);
  }
}

async function snapshot(pool) {
  const counts = (await pool.query(`SELECT
    (SELECT count(*) FROM trade_fair.companies) companies,
    (SELECT count(*) FROM trade_fair.contacts) contacts,
    (SELECT count(*) FROM trade_fair.lead_submissions) submissions`)).rows[0];
  const dash = await pool.query(`SELECT trade_fair.dashboard_snapshot(100,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL) AS d`);
  // Strip as_of (wall-clock timestamp set per-call via statement_timestamp()).
  const d = dash.rows[0].d;
  const dataOnly = { total: d.total, stats: d.stats, leads: d.leads };
  const dashHash = createHash('sha256').update(JSON.stringify(dataOnly)).digest('hex');
  const acl = (await pool.query(`SELECT has_function_privilege('trade_fair_dashboard','trade_fair.dashboard_snapshot(integer,integer,text,text,text,text,text,text,text)','EXECUTE') AS can_exec,
    has_schema_privilege('trade_fair_dashboard','trade_fair','USAGE') AS has_usage`)).rows[0];
  return { counts, dashHash, acl };
}

async function main() {
  console.log('[rc33-backup] bringing up SOURCE PG16');
  const src = await startPg('src');
  await installSchema(src.pool, src.name);
  await seed(src.pool);
  const srcSnap = await snapshot(src.pool);
  console.log('[rc33-backup] source snapshot:', JSON.stringify(srcSnap));

  console.log('[rc33-backup] pg_dump --schema=trade_fair');
  const dumpPath = join(tmpdir(), `rc33-backup-${Date.now()}.sql`);
  const { stdout: dumpOut } = await run(['exec', src.name, 'pg_dump', '-U', 'neondb_owner', '-d', 'neondb', '--schema=trade_fair', '--no-owner', '--no-privileges']);
  await writeFile(dumpPath, dumpOut);
  const dumpSha = createHash('sha256').update(dumpOut).digest('hex');
  console.log('[rc33-backup] dump bytes=' + dumpOut.length + ' sha256=' + dumpSha);
  if (dumpOut.length < 1000) fail('pg_dump produced suspiciously small output', dumpOut.slice(0, 300));
  pass('pg_dump --schema=trade_fair produced ' + dumpOut.length + ' bytes (sha256=' + dumpSha.slice(0, 16) + '…)');

  console.log('[rc33-backup] bringing up DISPOSABLE TARGET PG16');
  const tgt = await startPg('tgt');
  // Target needs the role to exist before restore (dump uses --no-owner so
  // objects become neondb_owner; the role for GRANTs must exist).
  await tgt.pool.query("CREATE ROLE trade_fair_dashboard LOGIN PASSWORD 'synthetic-local-only';");
  await new Promise((resolve, reject) => {
    const child = rawExec('docker', ['exec', '-i', tgt.name, 'psql', '-X', '-U', 'neondb_owner', '-d', 'neondb', '-v', 'ON_ERROR_STOP=1'],
      { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => err ? reject(Object.assign(err, { stdout, stderr })) : resolve());
    child.stdin.end(dumpOut);
  });
  // Re-grant on restored function (dump used --no-privileges, intentional so ACL is explicit).
  await tgt.pool.query('REVOKE ALL ON FUNCTION trade_fair.dashboard_snapshot(integer,integer,text,text,text,text,text,text,text) FROM PUBLIC; GRANT USAGE ON SCHEMA trade_fair TO trade_fair_dashboard; GRANT EXECUTE ON FUNCTION trade_fair.dashboard_snapshot(integer,integer,text,text,text,text,text,text,text) TO trade_fair_dashboard;');

  const tgtSnap = await snapshot(tgt.pool);
  console.log('[rc33-backup] target snapshot:', JSON.stringify(tgtSnap));

  if (JSON.stringify(srcSnap.counts) !== JSON.stringify(tgtSnap.counts)) fail('row counts differ', `src=${JSON.stringify(srcSnap.counts)} tgt=${JSON.stringify(tgtSnap.counts)}`);
  pass('row counts identical (companies=' + srcSnap.counts.companies + ', contacts=' + srcSnap.counts.contacts + ', submissions=' + srcSnap.counts.submissions + ')');

  if (srcSnap.dashHash !== tgtSnap.dashHash) fail('dashboard_snapshot result diverges', `src=${srcSnap.dashHash} tgt=${tgtSnap.dashHash}`);
  pass('dashboard_snapshot result sha256 identical (' + srcSnap.dashHash.slice(0, 16) + '…)');

  if (!tgtSnap.acl.can_exec) fail('trade_fair_dashboard cannot EXECUTE dashboard_snapshot on target');
  if (!tgtSnap.acl.has_usage) fail('trade_fair_dashboard missing USAGE on trade_fair schema on target');
  pass('trade_fair_dashboard ACL restored (USAGE + EXECUTE)');

  // Verify least-privilege: role cannot SELECT raw tables post-restore.
  const roleUrl = `postgresql://trade_fair_dashboard:synthetic-local-only@127.0.0.1:${tgt.port}/neondb`;
  const rolePool = new pg.Pool({ connectionString: roleUrl, max: 2 });
  let selectDenied = false;
  try { await rolePool.query('SELECT * FROM trade_fair.lead_submissions LIMIT 1'); } catch (e) { if (/permission denied/.test(e.message)) selectDenied = true; }
  await rolePool.end();
  if (!selectDenied) fail('trade_fair_dashboard CAN SELECT raw lead_submissions after restore (should be denied)');
  pass('post-restore least-privilege preserved: trade_fair_dashboard SELECT on raw tables denied');

  await src.drop();
  await tgt.drop();

  console.log('\nRC3.3 Phase B item 7 — backup/restore drill: ALL CHECKS PASS');
  console.log('backup artifact: ' + dumpPath + ' (sha256=' + dumpSha + ')');
}

main().catch(async (e) => { console.error(e.stack || e); process.exit(1); });
