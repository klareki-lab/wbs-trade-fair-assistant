// End-to-end REAL-AI smoke:
//   - Arbitrary German text → /api/dashboard/ai/extract → real OpenAI via isolated n8n
//   - Human-equivalent correction → /api/leads → PG persistence
//   - /api/dashboard/ai/ask → real OpenAI answers a question about actual DB rows
//     via the scoped ai_lead_context function; cited_lead_ids ⊂ supplied context.
//
// Fails loudly on OPENAI_API_KEY absence or n8n unreachability. No mock fallback.
import { execFile as rawExec } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(rawExec);

const BASE = process.env.DEMO_BASE || 'http://127.0.0.1:3102';
const ADMIN_KEY = process.env.DASHBOARD_ACCESS_KEY || 'demo-admin-key-16chars';
const N8N_PORT = process.env.N8N_PORT || '5679';
const PG = process.env.PG_CONTAINER || 'wbs-tf-demo-pg';

let cookie = '';
const results = [];
function record(name, ok, detail = '') { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? '  ·  ' + detail : ''}`); }

async function req(method, path, body) {
  const headers = { 'Content-Type': 'application/json', Origin: BASE, Accept: 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}
async function pgQuery(sql) {
  const { stdout } = await exec('docker', ['exec', PG, 'psql', '-U', 'neondb_owner', '-d', 'neondb', '-At', '-F', '|', '-c', sql]);
  return stdout.trim().split('\n').filter(Boolean).map((l) => l.split('|'));
}

(async () => {
  console.log(`Target: ${BASE}  ·  n8n: http://127.0.0.1:${N8N_PORT}  ·  PG: ${PG}`);

  // -- Preflight: n8n health
  const health = await fetch(`http://127.0.0.1:${N8N_PORT}/healthz`).catch(() => null);
  record('Isolated n8n healthz reachable', !!health && health.ok, health ? `HTTP ${health.status}` : 'no response');

  // -- 1. Login
  let r = await req('POST', '/api/login', { access_key: ADMIN_KEY });
  record('Admin login', r.status === 200);

  // -- 2. Arbitrary German text (never used anywhere before)
  const uniqueNote = `Heute am Stand: Firma AlpenTronic AG, Herr Dr. Paul Weinberger, Interesse an Trainings zu KI-Automation und Projektmanagement. Budget ist für Q1 freigegeben. Bitte Rückruf innerhalb der nächsten zwei Wochen. Erreichbar unter p.weinberger@alpentronic.test, Telefon +43 1 5551234. Firmensitz Wien.`;
  r = await req('POST', '/api/dashboard/ai/extract', { notes: uniqueNote, session_id: 'realai-' + Date.now() });
  const ex = r.body?.extracted || {};
  const extractOk = r.status === 200 && r.body?.success === true &&
    typeof ex.company_name === 'string' && /alpentronic/i.test(ex.company_name) &&
    typeof ex.contact_name === 'string' && /weinberger/i.test(ex.contact_name) &&
    typeof ex.email === 'string' && ex.email.includes('alpentronic.test') &&
    ex.training_interest != null &&
    ex.follow_up != null;
  record('WF-07 extracts company/contact/email/interest/follow-up from arbitrary German text',
    extractOk,
    `company=${ex.company_name}  contact=${ex.contact_name}  email=${ex.email}  training=${ex.training_interest}  follow=${ex.follow_up}`);
  if (!extractOk && r.status !== 200) {
    try { console.log('  upstream body:', JSON.stringify(r.body).slice(0, 400)); } catch {}
  }

  // -- 3. Submit corrected lead (same persistence path as DEBUG-02 fix)
  const corrected = {
    source: 'internal_form', submission_id: 'ai-' + crypto.randomUUID(),
    company_name: ex.company_name || 'AlpenTronic AG',
    contact_name: ex.contact_name || 'Dr. Paul Weinberger',
    email: ex.email || 'p.weinberger@alpentronic.test',
    phone: ex.phone || '+43 1 5551234',
    training_interest: ex.training_interest || 'ai_automation',
    budget_status: ex.budget_status || 'approved',
    follow_up: ex.follow_up || 'within_two_weeks',
    notes: 'Owner-korrigiert nach KI-Vorschlag.',
  };
  r = await req('POST', '/api/leads', corrected);
  const leadId = r.body?.lead_id;
  record('/api/leads 201 persisted', r.status === 201 && !!leadId && r.body?.persisted === true);

  const rows = await pgQuery(
    `SELECT c.company_name, co.contact_name, co.email FROM trade_fair.lead_submissions ls
     JOIN trade_fair.companies c ON c.company_id=ls.company_id
     JOIN trade_fair.contacts  co ON co.contact_id=ls.contact_id
     WHERE ls.lead_id='${leadId}'`);
  record('PG row present for new lead with corrected company/contact/email',
    rows.length === 1 && rows[0][0] === corrected.company_name && rows[0][2] === corrected.email.toLowerCase(),
    rows[0]?.join(' | '));

  // -- 4. WF-08 Q&A: ask about an actual field value of this new lead
  const question = `Welches Follow-up ist für ${corrected.company_name} geplant?`;
  r = await req('POST', '/api/dashboard/ai/ask', { question, context_lead_ids: [leadId], session_id: 'realai-ask' });
  const ans = r.body?.answer || '';
  const cited = r.body?.cited_lead_ids || [];
  const citedOk = Array.isArray(cited) && cited.every((id) => id === leadId);
  // WF-08 extracts claims from the scoped ai_lead_context payload. The answer
  // text is deterministic phrasing built from allowed field claims; we check
  // the follow_up enum appears somewhere in the response and no fabricated score.
  const followOk = typeof ans === 'string' && (
    ans.toLowerCase().includes(corrected.follow_up.replace(/_/g, ' ')) ||
    ans.includes(corrected.follow_up)
  );
  const noFabrication = !/\b\d{1,3}\s*(?:\/\s*100|points|punkte)\b/i.test(ans) || corrected.score_total != null;
  record('WF-08 cites only supplied context + mentions the correct follow_up (no fabrication)',
    r.status === 200 && citedOk && followOk && noFabrication,
    `cited=${cited.length}  answer="${ans.slice(0, 160)}"`);

  // -- 5. Negative: ask about a lead NOT in context — must not fabricate
  r = await req('POST', '/api/dashboard/ai/ask', { question: 'Welches Budget hat KonstruktSmart UG?', context_lead_ids: [leadId], session_id: 'realai-neg' });
  const negAns = r.body?.answer || '';
  const negCited = r.body?.cited_lead_ids || [];
  const refuses = /nicht|kein|unavailable|unknown|keine Angabe/i.test(negAns) || negCited.length === 0;
  record('WF-08 refuses to answer about leads not in context', r.status === 200 && refuses && (negCited.length === 0 || negCited.every((id) => id === leadId)),
    `answer="${negAns.slice(0, 160)}"`);

  // -- 6. Logout
  r = await req('POST', '/api/logout');
  record('Logout', r.status === 200);

  const failed = results.filter((x) => !x.ok);
  console.log('');
  console.log(`REAL-AI chain: ${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) { console.log('FAILED:'); for (const f of failed) console.log('  -', f.name, f.detail); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
