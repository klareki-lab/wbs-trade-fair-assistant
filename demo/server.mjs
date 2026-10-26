// Persistent demo Gateway: real PG16, real UI, mock n8n/AI upstream.
// Mirrors tests/browser/messe_hub.mjs harness but keeps the server running.
// WBS-TF-DEBUG-02: the mock /capture now really persists a lead_submissions
// row (and companies/contacts if new), dedupes by submission_id, and returns
// a receipt that matches the Gateway's safeCaptureReceipt contract exactly.
// Production WF-A is unchanged; this change is confined to demo/server.mjs.
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import pg from '../gateway/node_modules/pg/lib/index.js';
import { createGateway, loadConfig } from '../gateway/server.mjs';
import { createDashboardCrm } from '../gateway/dashboard-crm.mjs';
import { createDashboardDb } from '../gateway/dashboard-db.mjs';
import { pgStartContainer, waitReady, applySchemaAndSeed, PG, demoLeads } from './seed.mjs';

const DEMO_PORT = Number(process.env.DEMO_PORT || 3100);
const DASHBOARD_KEY = process.env.DASHBOARD_ACCESS_KEY || 'demo-admin-key-16chars';
const FORM_KEY = process.env.TRADE_FAIR_ACCESS_KEY || 'demo-form-key-16chars-x';
const SESSION_SECRET = process.env.SESSION_SECRET || 'demo-session-secret-32-characters!!';
const MOCK_ORIGIN = 'http://127.0.0.1:3199'; // isolated upstream origin for AI allowlist

const root = new URL('../', import.meta.url);

// WF-A validator pulled from the exported workflow so mocks mirror production shape.
const wfaExport = JSON.parse(await readFile(new URL('workflows/wf-a-lead-capture.json', root), 'utf8'));
const wfa = Array.isArray(wfaExport) ? wfaExport[0] : wfaExport;
const normalize = wfa.nodes.find(n => n.name === 'Normalize Input') ||
  wfa.nodes.find(n => n.parameters.jsCode?.includes('const candidateUUID'));
const validate = wfa.nodes.find(n => n.name === 'Validate Input');
const runCode = (node, json) => new Function('$input', node.parameters.jsCode)({ first: () => ({ json }) })[0].json;

const response = (status, data) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const CAPTURED = []; // visible via /_demo/captured

// --- Mock WF-A persistence helpers ---
// Deterministic body hash so retries with identical content idempotently return
// the same lead_id, and changes under the same submission_id raise 409.
function captureBodyHash(payload) {
  const copy = { ...payload };
  delete copy.submission_id;
  const sortedKeys = Object.keys(copy).sort();
  const canonical = JSON.stringify(sortedKeys.map((k) => [k, copy[k]]));
  return createHash('sha256').update(canonical).digest('hex');
}
function newFairLeadId() { return 'FAIR-' + randomUUID(); }
function normName(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); }

let ownerPool = null;
function ownerDb() {
  if (!ownerPool) ownerPool = new pg.Pool({ host: '127.0.0.1', port: PG.port, user: 'neondb_owner', password: PG.password, database: 'neondb', max: 4, ssl: false });
  return ownerPool;
}

async function persistCapture(payload) {
  const db = ownerDb();
  const bodyHash = captureBodyHash(payload);
  const submissionId = String(payload.submission_id || '');
  // 1. Idempotency / conflict check by submission_id.
  if (submissionId) {
    const prior = await db.query(
      "SELECT lead_id, receipt FROM trade_fair.lead_submissions WHERE submission_id = $1",
      [submissionId]
    );
    if (prior.rowCount > 0) {
      const row = prior.rows[0];
      const priorHash = row.receipt?.body_hash;
      if (priorHash && priorHash !== bodyHash) return { status: 409, body: { success: false, error: { code: 'IDEMPOTENCY_CONFLICT' } } };
      return { status: 200, body: { success: true, persisted: true, lead_id: row.lead_id, status: 'POSSIBLE_DUPLICATE', processing_status: 'pending', idempotent_replay: true, review_required: false } };
    }
  }
  // 2. Resolve / insert company by normalized name.
  const companyName = String(payload.company_name || '').trim();
  if (!companyName) return { status: 422, body: { success: false, error: { code: 'VALIDATION_FAILED', details: [{ field: 'company_name', code: 'REQUIRED' }] } } };
  const companyNorm = normName(companyName);
  let company = await db.query("SELECT company_id FROM trade_fair.companies WHERE company_name_normalized = $1 LIMIT 1", [companyNorm]);
  let companyId;
  if (company.rowCount) companyId = company.rows[0].company_id;
  else {
    companyId = randomUUID();
    await db.query("INSERT INTO trade_fair.companies(company_id, company_name, company_name_normalized) VALUES ($1, $2, $3)", [companyId, companyName, companyNorm]);
  }
  // 3. Resolve / insert contact by (company_id, email) when present, else by name.
  const contactName = String(payload.contact_name || '').trim() || null;
  const email = String(payload.email || '').trim().toLowerCase() || null;
  let contactId = null;
  if (email) {
    const existing = await db.query("SELECT contact_id FROM trade_fair.contacts WHERE company_id = $1 AND lower(email) = $2 LIMIT 1", [companyId, email]);
    if (existing.rowCount) contactId = existing.rows[0].contact_id;
  }
  if (!contactId && contactName) {
    const existing = await db.query("SELECT contact_id FROM trade_fair.contacts WHERE company_id = $1 AND contact_name = $2 LIMIT 1", [companyId, contactName]);
    if (existing.rowCount) contactId = existing.rows[0].contact_id;
  }
  if (!contactId) {
    contactId = randomUUID();
    await db.query("INSERT INTO trade_fair.contacts(contact_id, company_id, contact_name, email) VALUES ($1, $2, $3, $4)", [contactId, companyId, contactName || companyName, email]);
  }
  // 4. Classify as duplicate if the same (company, contact) already has a lead.
  const dupCheck = await db.query("SELECT 1 FROM trade_fair.lead_submissions WHERE company_id = $1 AND contact_id = $2 LIMIT 1", [companyId, contactId]);
  const duplicate = dupCheck.rowCount > 0 ? 'POSSIBLE_DUPLICATE' : 'NEW';
  // 5. Insert lead_submissions row.
  const leadId = newFairLeadId();
  const normalized = {
    notes: payload.notes ?? null,
    budget_status: payload.budget_status ?? null,
    training_interest: payload.training_interest ?? null,
    follow_up: payload.follow_up ?? null,
    follow_up_date: payload.follow_up_date ?? null,
    phone: payload.phone ?? null, email,
    website: payload.website ?? null,
  };
  const receipt = { submission_id: submissionId || null, body_hash: bodyHash, captured_at: new Date().toISOString() };
  await db.query(
    `INSERT INTO trade_fair.lead_submissions(lead_id, source, submission_id, company_id, contact_id,
       duplicate_status, raw_payload, normalized_payload, receipt, wf_b_payload, created_at)
     VALUES ($1, 'internal_form', $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, '{}', now())`,
    [leadId, submissionId || ('mock-' + leadId), companyId, contactId, duplicate,
     JSON.stringify(payload), JSON.stringify(normalized), JSON.stringify(receipt)]
  );
  return { status: 201, body: { success: true, persisted: true, lead_id: leadId, status: duplicate, processing_status: 'pending', idempotent_replay: false, review_required: false } };
}

const fetchImpl = async (url, init) => {
  const payload = init?.body ? JSON.parse(init.body) : {};
  if (url.endsWith('/extract')) {
    // Mock WF-07: parse free notes into structured fields (no real LLM).
    const text = String(payload.notes || '');
    const guess = {
      company_name: text.match(/^([A-Z][\w .&-]{2,40})/)?.[1] || 'Demo Firma',
      contact_name: text.match(/\b([A-ZÄÖÜ][a-zäöüß]+\s+[A-ZÄÖÜ][a-zäöüß]+)\b/)?.[1] || 'Demo Kontakt',
      email: text.match(/\b[\w.-]+@[\w.-]+\.\w{2,}\b/)?.[0] || null,
      phone: text.match(/\+?\d[\d \-()]{7,}/)?.[0] || null,
      website: null,
      training_interest: /automat|ai|ki/i.test(text) ? 'ai_automation' : /lead|führ/i.test(text) ? 'leadership' : null,
      budget_status: /budget|planen|freigegeben/i.test(text) ? 'planned' : null,
      follow_up: /nächste woche|rückruf|bald/i.test(text) ? 'within_one_week' : null,
      follow_up_date: null,
      notes: text.slice(0, 1000),
      summary: text.slice(0, 200), // kept server-side only; UI never forwards it
    };
    return response(200, {
      success: true, extracted: guess,
      confidence: Object.fromEntries(Object.keys(guess).map(k => [k, guess[k] ? 0.8 : 0])),
      uncertainty_flags: guess.email ? [] : ['email_missing'],
      assistant_message: 'Mock-KI: Felder vorgeschlagen. Bitte prüfen.',
    });
  }
  if (url.endsWith('/ask')) {
    const ctx = payload.context_lead_ids || [];
    // Mock WF-08: deterministic answer that only cites supplied IDs.
    const cited = ctx.slice(0, Math.min(3, ctx.length));
    const answer = cited.length
      ? `Mock-KI-Antwort: Für ${cited.length} Lead(s) im Kontext kein akuter Handlungsbedarf; Follow-ups sind geplant. (Antwort ist synthetisch, kein echtes Modell wurde kontaktiert.)`
      : 'Mock-KI: Kein Kontext übergeben.';
    return response(200, {
      success: true, answer, cited_lead_ids: cited,
      tokens: { total_input: 120, total_output: 60 },
    });
  }
  if (url.endsWith('/capture')) {
    CAPTURED.push({ at: new Date().toISOString(), payload });
    const normalized = runCode(normalize, { headers: { 'content-type': 'application/json' }, body: payload, _server_candidate_uuid: '99999999-9999-4999-8999-999999999999' });
    const valid = runCode(validate, normalized);
    if (!valid.valid) return response(422, { success: false, error: { code: 'VALIDATION_FAILED', details: valid.errors || [] } });
    try {
      const { status, body } = await persistCapture(payload);
      return response(status, body);
    } catch (e) {
      process.stderr.write('[demo-capture] persistence failed: ' + e.message + '\n');
      return response(503, { success: false, error: { code: 'STORAGE_UNAVAILABLE' } });
    }
  }
  if (url.endsWith('/status')) {
    return response(200, {
      success: true, lead_id: payload.lead_id,
      processing_status: 'completed', processing_attempts: 1, next_retry_at: null,
      review_required: false, score_band: 'WARM', score_total: 72,
      email_status: 'delivered', email_next_retry_at: null,
      updated_at: new Date().toISOString(), last_error_code: null,
    });
  }
  throw new Error('Unexpected upstream call: ' + url);
};

async function main() {
  console.log('[demo] starting postgres…');
  await pgStartContainer();
  await waitReady();
  const seedState = await applySchemaAndSeed();
  console.log(`[demo] postgres ready on 127.0.0.1:${PG.port} (${seedState}, ${demoLeads.length} leads)`);

  const connectionString = `postgresql://trade_fair_dashboard:${PG.password}@127.0.0.1:${PG.port}/neondb`;
  const factory = (opts) => new pg.Pool({ ...opts, ssl: false });

  const config = loadConfig({
    HOST: '127.0.0.1', PORT: String(DEMO_PORT),
    APP_ORIGIN: `http://127.0.0.1:${DEMO_PORT}`,
    TRADE_FAIR_ACCESS_KEY: FORM_KEY,
    DASHBOARD_ACCESS_KEY: DASHBOARD_KEY,
    SESSION_SECRET: SESSION_SECRET,
    N8N_HEADER_KEY: 'demo-mock-header',
    N8N_CAPTURE_URL: `${MOCK_ORIGIN}/capture`,
    N8N_STATUS_URL: `${MOCK_ORIGIN}/status`,
    N8N_AI_EXTRACT_URL: `${MOCK_ORIGIN}/extract`,
    N8N_AI_ASK_URL: `${MOCK_ORIGIN}/ask`,
    N8N_AI_ALLOWED_ORIGIN: MOCK_ORIGIN,
    DASHBOARD_ENABLED: 'true',
    DASHBOARD_DATABASE_URL: connectionString,
  });

  const server = createGateway(config, {
    dashboardStore: createDashboardDb({ connectionString, poolFactory: factory }),
    crmStore: createDashboardCrm({ connectionString, poolFactory: factory }),
    fetchImpl,
  });

  // Observability for the operator — never used by the Gateway itself.
  const originalEmit = server.emit.bind(server);
  server.emit = (event, ...rest) => {
    if (event === 'request') {
      const req = rest[0], res = rest[1];
      res.on('finish', () => {
        if (!req.url.startsWith('/_demo')) {
          process.stdout.write(`[${new Date().toISOString()}] ${req.method} ${req.url} → ${res.statusCode}\n`);
        }
      });
    }
    return originalEmit(event, ...rest);
  };

  server.listen(DEMO_PORT, '127.0.0.1');
  await once(server, 'listening');

  const dashboardUrl = `http://127.0.0.1:${DEMO_PORT}/dashboard`;
  console.log('');
  console.log('================================================================');
  console.log(' WBS Messe Hub — LOCAL DEMO READY');
  console.log('================================================================');
  console.log(`  Dashboard:        ${dashboardUrl}`);
  console.log(`  Admin key:        ${DASHBOARD_KEY}`);
  console.log(`  Form key:         ${FORM_KEY}  (not needed for CRM demo)`);
  console.log(`  Public form:      http://127.0.0.1:${DEMO_PORT}/`);
  console.log(`  PostgreSQL:       127.0.0.1:${PG.port}  (db=neondb, user=neondb_owner, pwd=${PG.password})`);
  console.log(`  Synthetic leads:  ${demoLeads.length}`);
  console.log(`  AI/n8n upstream:  mocked in-process (NO network, NO real credentials)`);
  console.log('----------------------------------------------------------------');
  console.log(' Press Ctrl+C to stop the Gateway (PG container stays up).');
  console.log(' To stop + remove PG container:  ./demo.sh stop');
  console.log('================================================================');

  const stop = () => {
    console.log('\n[demo] shutting down Gateway…');
    server.closeAllConnections();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => { console.error('[demo] fatal:', e); process.exit(1); });
