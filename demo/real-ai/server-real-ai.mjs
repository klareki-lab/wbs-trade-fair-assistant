// Gateway bootstrap pointing at the isolated REAL n8n (demo/real-ai/start.sh).
// Mirrors demo/server.mjs but uses pass-through fetch to the isolated n8n for
// /ai/extract and /ai/ask, keeps the demo mock /capture persistence for WF-A,
// and loads the Gateway's /api/leads mock from demo/server.mjs behaviour.
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import pg from '../../gateway/node_modules/pg/lib/index.js';
import { createGateway, loadConfig } from '../../gateway/server.mjs';
import { createDashboardCrm } from '../../gateway/dashboard-crm.mjs';
import { createDashboardDb } from '../../gateway/dashboard-db.mjs';
import { pgStartContainer, waitReady, applySchemaAndSeed, PG, demoLeads } from '../seed.mjs';

const DEMO_PORT = Number(process.env.DEMO_PORT || 3102);
const N8N_PORT = Number(process.env.N8N_PORT || 5679);
const DASHBOARD_KEY = process.env.DASHBOARD_ACCESS_KEY || 'demo-admin-key-16chars';
const FORM_KEY = process.env.TRADE_FAIR_ACCESS_KEY || 'demo-form-key-16chars-x';
const SESSION_SECRET = process.env.SESSION_SECRET || 'demo-session-secret-32-characters!!';
const HEADER_AUTH_KEY = process.env.N8N_HEADER_KEY;
if (!HEADER_AUTH_KEY) {
  console.error('ERROR: N8N_HEADER_KEY not set.');
  console.error('       Export the same value that start.sh printed/wrote as HEADER_AUTH_KEY.');
  process.exit(2);
}

const N8N_BASE = `http://127.0.0.1:${N8N_PORT}`;
const CAPTURE_URL = `${N8N_BASE}/webhook/messe-hub/ai-extract`; // placeholder: not used for WF-A capture here
const EXTRACT_URL = `${N8N_BASE}/webhook/messe-hub/ai-extract`;
const ASK_URL = `${N8N_BASE}/webhook/messe-hub/ai-ask`;
const STATUS_URL = `${N8N_BASE}/webhook/messe-hub/ai-extract`; // mock /status handled below

const root = new URL('../../', import.meta.url);
const wfaExport = JSON.parse(await readFile(new URL('workflows/wf-a-lead-capture.json', root), 'utf8'));
const wfa = Array.isArray(wfaExport) ? wfaExport[0] : wfaExport;
const normalize = wfa.nodes.find(n => n.name === 'Normalize Input') || wfa.nodes.find(n => n.parameters.jsCode?.includes('const candidateUUID'));
const validate = wfa.nodes.find(n => n.name === 'Validate Input');
const runCode = (node, json) => new Function('$input', node.parameters.jsCode)({ first: () => ({ json }) })[0].json;
const resp = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

function captureBodyHash(payload) {
  const copy = { ...payload }; delete copy.submission_id;
  const sortedKeys = Object.keys(copy).sort();
  return createHash('sha256').update(JSON.stringify(sortedKeys.map((k) => [k, copy[k]]))).digest('hex');
}
function normName(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); }
let ownerPool = null;
function ownerDb() {
  if (!ownerPool) ownerPool = new pg.Pool({ host: '127.0.0.1', port: PG.port, user: 'neondb_owner', password: PG.password, database: 'neondb', max: 4, ssl: false });
  return ownerPool;
}
async function persistCapture(payload) {
  // Reused verbatim from demo/server.mjs; same idempotency semantics.
  const db = ownerDb();
  const bodyHash = captureBodyHash(payload);
  const submissionId = String(payload.submission_id || '');
  if (submissionId) {
    const prior = await db.query("SELECT lead_id, receipt FROM trade_fair.lead_submissions WHERE submission_id=$1", [submissionId]);
    if (prior.rowCount) {
      const row = prior.rows[0];
      if (row.receipt?.body_hash && row.receipt.body_hash !== bodyHash) return { status: 409, body: { success: false, error: { code: 'IDEMPOTENCY_CONFLICT' } } };
      return { status: 200, body: { success: true, persisted: true, lead_id: row.lead_id, status: 'POSSIBLE_DUPLICATE', processing_status: 'pending', idempotent_replay: true, review_required: false } };
    }
  }
  const companyName = String(payload.company_name || '').trim();
  if (!companyName) return { status: 422, body: { success: false, error: { code: 'VALIDATION_FAILED', details: [{ field: 'company_name', code: 'REQUIRED' }] } } };
  const companyNorm = normName(companyName);
  let company = await db.query("SELECT company_id FROM trade_fair.companies WHERE company_name_normalized=$1 LIMIT 1", [companyNorm]);
  let companyId;
  if (company.rowCount) companyId = company.rows[0].company_id;
  else { companyId = randomUUID(); await db.query("INSERT INTO trade_fair.companies(company_id,company_name,company_name_normalized) VALUES ($1,$2,$3)", [companyId, companyName, companyNorm]); }
  const contactName = String(payload.contact_name || '').trim() || null;
  const email = String(payload.email || '').trim().toLowerCase() || null;
  let contactId = null;
  if (email) { const e = await db.query("SELECT contact_id FROM trade_fair.contacts WHERE company_id=$1 AND lower(email)=$2 LIMIT 1", [companyId, email]); if (e.rowCount) contactId = e.rows[0].contact_id; }
  if (!contactId && contactName) { const e = await db.query("SELECT contact_id FROM trade_fair.contacts WHERE company_id=$1 AND contact_name=$2 LIMIT 1", [companyId, contactName]); if (e.rowCount) contactId = e.rows[0].contact_id; }
  if (!contactId) { contactId = randomUUID(); await db.query("INSERT INTO trade_fair.contacts(contact_id,company_id,contact_name,email) VALUES ($1,$2,$3,$4)", [contactId, companyId, contactName || companyName, email]); }
  const dup = await db.query("SELECT 1 FROM trade_fair.lead_submissions WHERE company_id=$1 AND contact_id=$2 LIMIT 1", [companyId, contactId]);
  const leadId = 'FAIR-' + randomUUID();
  const normalized = { notes: payload.notes ?? null, budget_status: payload.budget_status ?? null, training_interest: payload.training_interest ?? null, follow_up: payload.follow_up ?? null, follow_up_date: payload.follow_up_date ?? null, phone: payload.phone ?? null, email, website: payload.website ?? null };
  const receipt = { submission_id: submissionId || null, body_hash: bodyHash, captured_at: new Date().toISOString() };
  await db.query(`INSERT INTO trade_fair.lead_submissions(lead_id,source,submission_id,company_id,contact_id,duplicate_status,raw_payload,normalized_payload,receipt,wf_b_payload,created_at)
    VALUES($1,'internal_form',$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,'{}',now())`,
    [leadId, submissionId || ('mock-' + leadId), companyId, contactId, dup.rowCount ? 'POSSIBLE_DUPLICATE' : 'NEW', JSON.stringify(payload), JSON.stringify(normalized), JSON.stringify(receipt)]);
  return { status: 201, body: { success: true, persisted: true, lead_id: leadId, status: dup.rowCount ? 'POSSIBLE_DUPLICATE' : 'NEW', processing_status: 'pending', idempotent_replay: false, review_required: false } };
}

const fetchImpl = async (url, init) => {
  const payload = init?.body ? JSON.parse(init.body) : {};
  // /ai/extract and /ai/ask go to the REAL isolated n8n via loopback webhook.
  if (url === EXTRACT_URL || url === ASK_URL) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Trade-Fair-Key': HEADER_AUTH_KEY }, body: JSON.stringify(payload) });
    const body = await r.text();
    return new Response(body, { status: r.status, headers: { 'Content-Type': r.headers.get('content-type') || 'application/json' } });
  }
  if (url.endsWith('/capture')) {
    const normalized = runCode(normalize, { headers: { 'content-type': 'application/json' }, body: payload, _server_candidate_uuid: '99999999-9999-4999-8999-999999999999' });
    const valid = runCode(validate, normalized);
    if (!valid.valid) return resp(422, { success: false, error: { code: 'VALIDATION_FAILED', details: valid.errors || [] } });
    try { const r = await persistCapture(payload); return resp(r.status, r.body); }
    catch (e) { process.stderr.write('[rc-capture] ' + e.message + '\n'); return resp(503, { success: false, error: { code: 'STORAGE_UNAVAILABLE' } }); }
  }
  if (url.endsWith('/status')) {
    return resp(200, { success: true, lead_id: payload.lead_id, processing_status: 'completed', processing_attempts: 1, next_retry_at: null, review_required: false, score_band: 'WARM', score_total: 72, email_status: 'delivered', email_next_retry_at: null, updated_at: new Date().toISOString(), last_error_code: null });
  }
  throw new Error('Unexpected upstream call: ' + url);
};

async function main() {
  console.log('[rc-ai] ensuring demo postgres…');
  await pgStartContainer(); await waitReady(); await applySchemaAndSeed();
  console.log('[rc-ai] postgres ready');
  const connectionString = `postgresql://trade_fair_dashboard:${PG.password}@127.0.0.1:${PG.port}/neondb`;
  const factory = (opts) => new pg.Pool({ ...opts, ssl: false });
  const config = loadConfig({
    HOST: '127.0.0.1', PORT: String(DEMO_PORT),
    APP_ORIGIN: `http://127.0.0.1:${DEMO_PORT}`,
    TRADE_FAIR_ACCESS_KEY: FORM_KEY, DASHBOARD_ACCESS_KEY: DASHBOARD_KEY,
    SESSION_SECRET: SESSION_SECRET, N8N_HEADER_KEY: HEADER_AUTH_KEY,
    N8N_CAPTURE_URL: CAPTURE_URL, N8N_STATUS_URL: STATUS_URL,
    N8N_AI_EXTRACT_URL: EXTRACT_URL, N8N_AI_ASK_URL: ASK_URL,
    N8N_AI_ALLOWED_ORIGIN: N8N_BASE,
    DASHBOARD_ENABLED: 'true', DASHBOARD_DATABASE_URL: connectionString,
  });
  const server = createGateway(config, {
    dashboardStore: createDashboardDb({ connectionString, poolFactory: factory }),
    crmStore: createDashboardCrm({ connectionString, poolFactory: factory }),
    fetchImpl,
  });
  server.on('request', (req, res) => res.on('finish', () => {
    process.stdout.write(`[${new Date().toISOString()}] ${req.method} ${req.url} → ${res.statusCode}\n`);
  }));
  server.listen(DEMO_PORT, '127.0.0.1'); await once(server, 'listening');
  console.log(`[rc-ai] Gateway on http://127.0.0.1:${DEMO_PORT} (admin key: ${DASHBOARD_KEY})`);
  console.log(`[rc-ai] AI routed to isolated n8n at ${N8N_BASE}`);
  const stop = () => { server.closeAllConnections(); server.close(() => process.exit(0)); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
main().catch((e) => { console.error('[rc-ai] fatal:', e); process.exit(1); });
