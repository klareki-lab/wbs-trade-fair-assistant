// End-to-end chain test for WBS-TF-DEBUG-02:
// AI extract → human correction → /api/leads → PG row present → Dashboard search returns it → retry same submission_id = no dupe.
import { execFile as rawExec } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(rawExec);

const BASE = process.env.DEMO_BASE || 'http://127.0.0.1:3101';
const ADMIN_KEY = process.env.DASHBOARD_ACCESS_KEY || 'demo-admin-key-16chars';
const ORIGIN = BASE;
const PG = process.env.PG_CONTAINER || 'wbs-tf-demo-pg';

let cookie = '';
const results = [];
function record(name, ok, detail = '') { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? '  ·  ' + detail : ''}`); }

async function req(method, path, body) {
  const headers = { 'Content-Type': 'application/json', Origin: ORIGIN, Accept: 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}

async function pgQuery(sql, args = []) {
  const substituted = sql.replace(/\$(\d+)/g, (_, n) => {
    const v = args[Number(n) - 1];
    if (v === null || v === undefined) return 'NULL';
    return "'" + String(v).replaceAll("'", "''") + "'";
  });
  const { stdout } = await exec('docker', ['exec', PG, 'psql', '-U', 'neondb_owner', '-d', 'neondb', '-At', '-F', '|', '-c', substituted]);
  return stdout.trim().split('\n').filter(Boolean).map((l) => l.split('|'));
}

(async () => {
  console.log(`Target: ${BASE}  ·  PG container: ${PG}`);

  // ----- 1. Baseline leads count -----
  const before = await pgQuery('SELECT count(*) FROM trade_fair.lead_submissions');
  const baseCount = Number(before[0][0]);
  record('Baseline PG lead count fetched', !Number.isNaN(baseCount), `${baseCount} rows`);

  // ----- 2. Login -----
  let r = await req('POST', '/api/login', { access_key: ADMIN_KEY });
  record('Admin login', r.status === 200 && r.body?.authenticated === true);

  // ----- 3. AI extract (mock WF-07) with free-text note -----
  const note = 'Müller Technik GmbH, Lisa Hoffmann, Interesse an KI-Automation, Rückruf nächste Woche. l.hoffmann@mueller-technik.test';
  r = await req('POST', '/api/dashboard/ai/extract', { notes: note, session_id: 'chain-' + Date.now() });
  record('AI extract (mock) returned fields', r.status === 200 && r.body?.success === true && typeof r.body.extracted === 'object');

  // ----- 4. Human correction + submit via /api/leads -----
  const submissionId = 'ai-' + crypto.randomUUID();
  const corrected = {
    source: 'internal_form', submission_id: submissionId,
    company_name: 'Müller Technik GmbH',           // Owner-corrected name
    contact_name: 'Lisa Hoffmann',
    email: 'l.hoffmann@mueller-technik.test',
    phone: '+49 30 7777 0001',
    training_interest: 'ai_automation',
    budget_status: 'planned',
    follow_up: 'within_one_week',
    notes: 'Owner-korrigiert: Technik, nicht Logistik.',
  };
  r = await req('POST', '/api/leads', corrected);
  const leadId = r.body?.lead_id;
  record('/api/leads first submit → 201 persisted', r.status === 201 && r.body?.success === true && r.body?.persisted === true && r.body?.idempotent_replay === false && !!leadId, `lead_id=${leadId?.slice(0, 18)}…`);

  // ----- 5. PG row exists for the new lead with correct company -----
  const rows = await pgQuery(
    `SELECT ls.lead_id, c.company_name, co.contact_name, co.email, ls.duplicate_status, ls.submission_id
     FROM trade_fair.lead_submissions ls
     JOIN trade_fair.companies c ON c.company_id = ls.company_id
     JOIN trade_fair.contacts co ON co.contact_id = ls.contact_id
     WHERE ls.lead_id = '${leadId}'`
  );
  record('PG row present with correct company/contact', rows.length === 1 && rows[0][1] === 'Müller Technik GmbH' && rows[0][2] === 'Lisa Hoffmann' && rows[0][3] === 'l.hoffmann@mueller-technik.test', rows[0]?.join(' | '));

  // ----- 6. Total lead count increased by exactly 1 -----
  const after = await pgQuery('SELECT count(*) FROM trade_fair.lead_submissions');
  const afterCount = Number(after[0][0]);
  record('Lead count increased by exactly 1', afterCount === baseCount + 1, `${baseCount} → ${afterCount}`);

  // ----- 7. Dashboard search finds the new lead -----
  r = await req('GET', '/api/dashboard?page=1&limit=50&search=' + encodeURIComponent('Müller Technik GmbH'));
  const found = (r.body?.leads || []).some((l) => l.lead_id === leadId);
  record('Dashboard search returns the new lead', r.status === 200 && found, `${(r.body?.leads || []).length} search results`);

  // ----- 8. Retry with same submission_id + same body → idempotent replay, no dupe -----
  r = await req('POST', '/api/leads', corrected);
  const after2 = await pgQuery('SELECT count(*) FROM trade_fair.lead_submissions');
  const after2Count = Number(after2[0][0]);
  record('Retry same submission_id + same body → 200 replay, no new row',
    r.status === 200 && r.body?.success === true && r.body?.lead_id === leadId && r.body?.idempotent_replay === true && after2Count === afterCount,
    `HTTP ${r.status}, idempotent_replay=${r.body?.idempotent_replay}, count=${after2Count}`);

  // ----- 9. Different body under same submission_id → 409 IDEMPOTENCY_CONFLICT, no new row -----
  r = await req('POST', '/api/leads', { ...corrected, company_name: 'Müller Technik GmbH', notes: 'Konflikt-Test, geänderter Inhalt' });
  const after3 = await pgQuery('SELECT count(*) FROM trade_fair.lead_submissions');
  record('Different body + same submission_id → 409, still no new row',
    r.status === 409 && Number(after3[0][0]) === afterCount, `HTTP ${r.status}, count=${after3[0][0]}`);

  // ----- 10. Dashboard still shows the single lead (no dupe visible) -----
  r = await req('GET', '/api/dashboard?page=1&limit=50&search=' + encodeURIComponent('Müller Technik GmbH'));
  const matches = (r.body?.leads || []).filter((l) => l.lead_id === leadId).length;
  record('Dashboard shows exactly one Müller Technik row (no dupe)', matches === 1, `${matches} matching`);

  // ----- 11. Logout -----
  r = await req('POST', '/api/logout');
  record('Logout', r.status === 200);

  const failed = results.filter((x) => !x.ok);
  console.log('');
  console.log(`Chain summary: ${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) { console.log('FAILED:'); for (const f of failed) console.log('  -', f.name, f.detail); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
