// Demo seed: 8 synthetic leads with varied companies/contacts for a visually
// interesting Merge/Split/Extract/Ignore walkthrough. Mirrors tests/helpers/pg16.mjs
// but publishes PG16 on a stable loopback port and keeps the container running.
import { execFile as rawExec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import pg from '../gateway/node_modules/pg/lib/index.js';

const exec = promisify(rawExec);
const root = new URL('../', import.meta.url);
const PG_NAME = 'wbs-tf-demo-pg';
const PG_PORT = 15432;
const DB_PASSWORD = 'synthetic-local-only';

export const demoLeads = [
  // Duplicate cluster A: same person, two submissions (merge candidate)
  { lead_id: 'FAIR-00000000-0000-4000-8000-000000000001', company: 'Müller Logistik GmbH', contact: 'Anna Weber',   email: 'anna.weber@mueller-logistik.test',  phone: '+49 30 1111 0001', notes: 'Interesse an Grundkurs Projektmanagement', training: 'project_management', budget: 'planned',  follow: 'within_one_week' },
  { lead_id: 'FAIR-00000000-0000-4000-8000-000000000002', company: 'Mueller Logistik',        contact: 'A. Weber',       email: 'a.weber@mueller-logistik.test',    phone: '+49 30 1111 0002', notes: 'Zweiter Standbesuch, Fokus PM',                 training: 'project_management', budget: 'approved', follow: 'within_two_weeks' },
  // Duplicate cluster B: same company, different contacts (extract candidate)
  { lead_id: 'FAIR-00000000-0000-4000-8000-000000000003', company: 'Nordsee Energie AG',     contact: 'Jonas Schmidt',  email: 'j.schmidt@nordsee-energie.test',   phone: '+49 40 2222 0001', notes: 'Fachbereich Automation, Workshop gewünscht',   training: 'ai_automation',      budget: 'planned',  follow: 'within_one_month' },
  { lead_id: 'FAIR-00000000-0000-4000-8000-000000000004', company: 'Nordsee Energie AG',     contact: 'Lea Krüger',     email: 'l.krueger@nordsee-energie.test',   phone: '+49 40 2222 0002', notes: 'HR-Perspektive, Leadership-Training',          training: 'leadership',         budget: 'approved', follow: 'within_one_week' },
  // Independent singles (ignore / audit demo)
  { lead_id: 'FAIR-00000000-0000-4000-8000-000000000005', company: 'KonstruktSmart UG',      contact: 'Paul Hoffmann',  email: 'paul@konstruktsmart.test',         phone: '+49 89 3333 0001', notes: 'Nur Infomaterial, kein Follow-up',             training: 'digital_skills',     budget: 'no_budget', follow: 'no_follow_up' },
  { lead_id: 'FAIR-00000000-0000-4000-8000-000000000006', company: 'HanseVision Media',     contact: 'Sophie Lange',   email: 'sophie.lange@hansevision.test',    phone: '+49 40 4444 0001', notes: 'Content-Automation, Pilotphase Q1',            training: 'ai_automation',      budget: 'planned',  follow: 'within_two_weeks' },
  // Edge case: minimal data
  { lead_id: 'FAIR-00000000-0000-4000-8000-000000000007', company: 'Alpenwerk Services',    contact: 'Markus Reiter',  email: 'm.reiter@alpenwerk.test',          phone: '+49 71 5555 0001', notes: 'Kurzer Austausch, offene Fragen',              training: 'communication',      budget: 'unknown',  follow: 'not_decided' },
  { lead_id: 'FAIR-00000000-0000-4000-8000-000000000008', company: 'RheinData Analytics',   contact: 'Yvonne Peters',  email: 'y.peters@rheindata.test',          phone: '+49 221 6666 0001', notes: 'Daten-Compliance Beratung',                   training: 'other',              budget: 'approved', follow: 'on_date' },
];

export async function pgExists() {
  try {
    const { stdout } = await exec('docker', ['ps', '-a', '--filter', `name=^${PG_NAME}$`, '--format', '{{.Status}}']);
    return stdout.trim().split('\n').filter(Boolean)[0] || null;
  } catch { return null; }
}

export async function pgStartContainer() {
  const existing = await pgExists();
  if (existing && existing.startsWith('Up')) return 'already-running';
  if (existing) await exec('docker', ['rm', '-f', PG_NAME]);
  await exec('docker', ['run', '-d', '--name', PG_NAME,
    '-p', `127.0.0.1:${PG_PORT}:5432`,
    '-e', 'POSTGRES_USER=neondb_owner',
    '-e', `POSTGRES_PASSWORD=${DB_PASSWORD}`,
    '-e', 'POSTGRES_DB=neondb',
    'postgres:16-alpine'], { maxBuffer: 8 * 1024 * 1024 });
  return 'started';
}

export async function waitReady() {
  const pool = new pg.Pool({ host: '127.0.0.1', port: PG_PORT, user: 'neondb_owner', password: DB_PASSWORD, database: 'neondb', max: 2, idleTimeoutMillis: 1000 });
  for (let i = 0; i < 120; i++) {
    try { await pool.query('SELECT 1'); await pool.end(); return; }
    catch { await new Promise(r => setTimeout(r, 500)); }
  }
  await pool.end();
  throw new Error('PG16 did not become ready');
}

async function psql(args, inputContent) {
  return new Promise((resolve, reject) => {
    const child = rawExec('docker', ['exec', '-i', PG_NAME, 'psql', '-X', '-U', 'neondb_owner', '-d', 'neondb', ...args],
      { maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => err ? reject(Object.assign(err, { stdout, stderr })) : resolve({ stdout, stderr }));
    if (inputContent != null) child.stdin.end(inputContent);
  });
}

export async function applySchemaAndSeed() {
  const pool = new pg.Pool({ host: '127.0.0.1', port: PG_PORT, user: 'neondb_owner', password: DB_PASSWORD, database: 'neondb', max: 4 });
  try {
    const already = await pool.query("SELECT 1 FROM information_schema.schemata WHERE schema_name='trade_fair'");
    if (already.rowCount > 0) return 'already-seeded';
    await pool.query("CREATE SCHEMA trade_fair; CREATE ROLE trade_fair_dashboard LOGIN PASSWORD 'synthetic-local-only'; GRANT USAGE ON SCHEMA trade_fair TO trade_fair_dashboard;");
    await pool.query(await readFile(new URL('sql/dashboard_confirmed_ddl.sql', root), 'utf8'));
    await pool.query(await readFile(new URL('sql/dashboard_snapshot_definition.sql', root), 'utf8'));
    await pool.query('REVOKE ALL ON FUNCTION trade_fair.dashboard_snapshot(integer,integer,text,text,text,text,text,text,text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION trade_fair.dashboard_snapshot(integer,integer,text,text,text,text,text,text,text) TO trade_fair_dashboard;');
    // One company row per distinct company name; one contact row per lead.
    const companies = new Map();
    const contacts = new Map();
    let i = 0;
    for (const lead of demoLeads) {
      if (!companies.has(lead.company)) {
        const uuid = `aaaa${String(++i).padStart(4, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`.slice(0, 36);
        companies.set(lead.company, uuid);
        await pool.query('INSERT INTO trade_fair.companies(company_id,company_name,company_name_normalized) VALUES($1,$2,$3)',
          [uuid, lead.company, lead.company.toLowerCase()]);
      }
      const companyId = companies.get(lead.company);
      const contactId = `bbbb${String(i++).padStart(4, '0')}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`.slice(0, 36);
      contacts.set(lead.lead_id, contactId);
      await pool.query('INSERT INTO trade_fair.contacts(contact_id,company_id,contact_name,email) VALUES($1,$2,$3,$4)',
        [contactId, companyId, lead.contact, lead.email]);
      const normalized = JSON.stringify({
        notes: lead.notes, budget_status: lead.budget,
        training_interest: lead.training, follow_up: lead.follow,
        phone: lead.phone, email: lead.email,
      });
      await pool.query(`INSERT INTO trade_fair.lead_submissions(lead_id,source,submission_id,company_id,contact_id,duplicate_status,raw_payload,normalized_payload,receipt,wf_b_payload,created_at)
        VALUES($1,'internal_form',$2,$3,$4,$5,'{}',$6::jsonb,'{}','{}',now() - ($7 || ' minutes')::interval)`,
        [lead.lead_id, 'demo-' + lead.lead_id, companyId, contactId,
         i <= 4 ? 'POSSIBLE_DUPLICATE' : 'NEW', normalized, String(i * 7)]);
    }
    await psql(['-v', 'production_branch_confirmed=on'], await readFile(new URL('sql/production/dashboard_crm_v1_up.sql', root), 'utf8'));
    await pool.query("CREATE ROLE synthetic_context_login LOGIN PASSWORD 'synthetic-local-only'; GRANT trade_fair_ai_context TO synthetic_context_login;");
    return 'seeded';
  } finally { await pool.end(); }
}

export const PG = { name: PG_NAME, port: PG_PORT, password: DB_PASSWORD };

if (import.meta.url === `file://${process.argv[1]}`) {
  const startState = await pgStartContainer();
  console.log('postgres:', startState, `127.0.0.1:${PG_PORT}`);
  await waitReady();
  console.log('seeding...');
  const seedState = await applySchemaAndSeed();
  console.log('seed:', seedState, `${demoLeads.length} synthetic leads`);
}
