// Full E2E for WBS-TF-REAL-AI-02: proxy ↔ (real OR stubbed) OpenAI ↔ Gateway ↔ PG.
// Default mode: STUB OpenAI (OPENAI_BASE_URL points at stub_openai.mjs) so the test
// is reproducible without burning a real key. Set REAL_OPENAI=1 (and OPENAI_API_KEY)
// to run the identical flow against api.openai.com.
import { execFile as rawExec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createGateway, loadConfig } from '../../gateway/server.mjs';
import { createDashboardCrm } from '../../gateway/dashboard-crm.mjs';
import { createDashboardDb } from '../../gateway/dashboard-db.mjs';
import { pgStartContainer, waitReady, applySchemaAndSeed, PG } from '../seed.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from '../../gateway/node_modules/pg/lib/index.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const exec = promisify(rawExec);
const USE_REAL = process.env.REAL_OPENAI === '1';
const PROXY_PORT = 51579;
const GATEWAY_PORT = 51102;
const STUB_PORT = 51190;
const HEADER_KEY = 'rc2-' + randomUUID().slice(0, 10);
const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');

const results = [];
function record(name, ok, detail = '') { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? '  ·  ' + detail : ''}`); }

function captureBodyHash(payload) {
  const copy = { ...payload }; delete copy.submission_id;
  return createHash('sha256').update(JSON.stringify(Object.keys(copy).sort().map((k) => [k, copy[k]]))).digest('hex');
}

async function startProxy() {
  const env = {
    ...process.env, N8N_PORT: String(PROXY_PORT), N8N_HEADER_KEY: HEADER_KEY,
    OPENAI_API_KEY: USE_REAL ? process.env.OPENAI_API_KEY : 'stub-key-not-real',
    OPENAI_BASE_URL: USE_REAL ? (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1') : `http://127.0.0.1:${STUB_PORT}`,
    PG_PORT: String(PG.port), AI_CTX_LOGIN: 'synthetic_context_login', AI_CTX_PASSWORD: 'synthetic-local-only',
  };
  const child = spawn(process.execPath, [path.join(ROOT, 'demo/real-ai/n8n_equivalent_proxy.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  child.stdout.on('data', (b) => { const t = b.toString(); lines.push(t); process.stdout.write('[proxy] ' + t); });
  child.stderr.on('data', (b) => process.stderr.write('[proxy-err] ' + b.toString()));
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/healthz`); if (r.ok) return { child, lines }; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('proxy did not start');
}
function startStub() {
  const child = spawn(process.execPath, [path.join(ROOT, 'demo/real-ai/stub_openai.mjs')], { env: { ...process.env, STUB_PORT: String(STUB_PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (b) => process.stderr.write('[stub-err] ' + b.toString()));
  return child;
}

async function startGateway() {
  const connectionString = `postgresql://trade_fair_dashboard:${PG.password}@127.0.0.1:${PG.port}/neondb`;
  const factory = (opts) => new pg.Pool({ ...opts, ssl: false });
  // Load the committed WF-A Validate Input code so the mock /capture performs
  // the same enum validation production would. Keeps 422-with-details on the UI path.
  const wfaDoc = JSON.parse(await readFile(path.join(ROOT, 'workflows/wf-a-lead-capture.json'), 'utf8'));
  const wfa = Array.isArray(wfaDoc) ? wfaDoc[0] : wfaDoc;
  const wfaNormalize = wfa.nodes.find((n) => n.name === 'Normalize Input') || wfa.nodes.find((n) => n.parameters.jsCode?.includes('const candidateUUID'));
  const wfaValidate = wfa.nodes.find((n) => n.name === 'Validate Input');
  const runWfa = (node, json) => new Function('$input', node.parameters.jsCode)({ first: () => ({ json }) })[0].json;
  const config = loadConfig({
    HOST: '127.0.0.1', PORT: String(GATEWAY_PORT), APP_ORIGIN: `http://127.0.0.1:${GATEWAY_PORT}`,
    TRADE_FAIR_ACCESS_KEY: 'rc2-form-key-16chars-ok', DASHBOARD_ACCESS_KEY: 'rc2-admin-key-16chars-ok',
    SESSION_SECRET: 'rc2-session-secret-32-characters!!', N8N_HEADER_KEY: HEADER_KEY,
    N8N_CAPTURE_URL: `http://127.0.0.1:${PROXY_PORT}/webhook/messe-hub/ai-extract`, // placeholder; mock /capture overrides
    N8N_STATUS_URL: `http://127.0.0.1:${PROXY_PORT}/webhook/messe-hub/ai-extract`,
    N8N_AI_EXTRACT_URL: `http://127.0.0.1:${PROXY_PORT}/webhook/messe-hub/ai-extract`,
    N8N_AI_ASK_URL: `http://127.0.0.1:${PROXY_PORT}/webhook/messe-hub/ai-ask`,
    N8N_AI_ALLOWED_ORIGIN: `http://127.0.0.1:${PROXY_PORT}`,
    DASHBOARD_ENABLED: 'true', DASHBOARD_DATABASE_URL: connectionString,
  });

  // Owner-pool for the mock /capture persistence (same semantics as demo/server.mjs).
  const ownerPool = new pg.Pool({ host: '127.0.0.1', port: PG.port, user: 'neondb_owner', password: PG.password, database: 'neondb', max: 2, ssl: false });
  async function persistCapture(payload) {
    const bodyHash = captureBodyHash(payload);
    const submissionId = String(payload.submission_id || '');
    if (submissionId) {
      const prior = await ownerPool.query('SELECT lead_id, receipt FROM trade_fair.lead_submissions WHERE submission_id=$1', [submissionId]);
      if (prior.rowCount) {
        const row = prior.rows[0];
        if (row.receipt?.body_hash && row.receipt.body_hash !== bodyHash) return { status: 409, body: { success: false, error: { code: 'IDEMPOTENCY_CONFLICT' } } };
        return { status: 200, body: { success: true, persisted: true, lead_id: row.lead_id, status: 'POSSIBLE_DUPLICATE', processing_status: 'pending', idempotent_replay: true, review_required: false } };
      }
    }
    const companyName = String(payload.company_name || '').trim();
    if (!companyName) return { status: 422, body: { success: false, error: { code: 'VALIDATION_FAILED', details: [{ field: 'company_name', code: 'REQUIRED' }] } } };
    const normName = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');
    let company = await ownerPool.query('SELECT company_id FROM trade_fair.companies WHERE company_name_normalized=$1 LIMIT 1', [normName(companyName)]);
    const companyId = company.rowCount ? company.rows[0].company_id : randomUUID();
    if (!company.rowCount) await ownerPool.query('INSERT INTO trade_fair.companies(company_id,company_name,company_name_normalized) VALUES ($1,$2,$3)', [companyId, companyName, normName(companyName)]);
    const email = (payload.email || '').trim().toLowerCase() || null;
    const contactName = (payload.contact_name || '').trim() || null;
    let contactId = null;
    if (email) { const r = await ownerPool.query('SELECT contact_id FROM trade_fair.contacts WHERE company_id=$1 AND lower(email)=$2 LIMIT 1', [companyId, email]); if (r.rowCount) contactId = r.rows[0].contact_id; }
    if (!contactId) { contactId = randomUUID(); await ownerPool.query('INSERT INTO trade_fair.contacts(contact_id,company_id,contact_name,email) VALUES ($1,$2,$3,$4)', [contactId, companyId, contactName || companyName, email]); }
    const leadId = 'FAIR-' + randomUUID();
    const receipt = { submission_id: submissionId, body_hash: bodyHash, captured_at: new Date().toISOString() };
    // Populate normalized_payload so ai_lead_context can read enum fields (matches production WF-B).
    const normalized = { notes: payload.notes ?? null, budget_status: payload.budget_status ?? null, training_interest: payload.training_interest ?? null, follow_up: payload.follow_up ?? null, follow_up_date: payload.follow_up_date ?? null, phone: payload.phone ?? null, email, website: payload.website ?? null };
    await ownerPool.query(`INSERT INTO trade_fair.lead_submissions(lead_id,source,submission_id,company_id,contact_id,duplicate_status,raw_payload,normalized_payload,receipt,wf_b_payload,created_at)
      VALUES($1,'internal_form',$2,$3,$4,'NEW',$5::jsonb,$6::jsonb,$7::jsonb,'{}',now())`,
      [leadId, submissionId || ('mock-' + leadId), companyId, contactId, JSON.stringify(payload), JSON.stringify(normalized), JSON.stringify(receipt)]);
    return { status: 201, body: { success: true, persisted: true, lead_id: leadId, status: 'NEW', processing_status: 'pending', idempotent_replay: false, review_required: false } };
  }
  const fetchImpl = async (url, init) => {
    const payload = init?.body ? JSON.parse(init.body) : {};
    if (url.startsWith(`http://127.0.0.1:${PROXY_PORT}/webhook/messe-hub/`)) {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Trade-Fair-Key': HEADER_KEY }, body: JSON.stringify(payload) });
      return new Response(await r.text(), { status: r.status, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/webhook/messe-hub/ai-extract') || url.includes('/webhook/messe-hub/ai-ask')) {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Trade-Fair-Key': HEADER_KEY }, body: JSON.stringify(payload) });
      return new Response(await r.text(), { status: r.status, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/capture') || url.includes('ai-extract')) {
      const r = await persistCapture(payload); return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error('unexpected upstream ' + url);
  };
  // The gateway uses N8N_CAPTURE_URL for /api/leads capture. In this test harness we
  // make /api/leads go through persistCapture directly by intercepting any URL whose
  // path ends with the capture webhook path when the body is a capture payload (has company_name).
  const smartFetch = async (url, init) => {
    const payload = init?.body ? JSON.parse(init.body) : {};
    if ('company_name' in payload || ('source' in payload && 'submission_id' in payload)) {
      // Mirror production WF-A: normalize → validate → persist. Enum rejections return 422.
      const normalized = runWfa(wfaNormalize, { headers: { 'content-type': 'application/json' }, body: payload, _server_candidate_uuid: '99999999-9999-4999-8999-999999999999' });
      const valid = runWfa(wfaValidate, normalized);
      if (!valid.valid) {
        // WF-A Validate Input wraps the response in response_body.error — mirror it faithfully.
        const upstream = valid.response_body || {};
        const body = { success: false, error: { code: upstream.error?.code || 'VALIDATION_FAILED', message: upstream.error?.message, details: upstream.error?.details || [] }, retryable: !!upstream.retryable, persistence_status: upstream.persistence_status || 'not_stored' };
        return new Response(JSON.stringify(body), { status: valid.http_status || 422, headers: { 'Content-Type': 'application/json' } });
      }
      const r = await persistCapture(payload);
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
    }
    return fetchImpl(url, init);
  };

  const server = createGateway(config, {
    dashboardStore: createDashboardDb({ connectionString, poolFactory: factory }),
    crmStore: createDashboardCrm({ connectionString, poolFactory: factory }),
    fetchImpl: smartFetch,
  });
  server.listen(GATEWAY_PORT, '127.0.0.1'); await once(server, 'listening');
  config.origin = `http://127.0.0.1:${GATEWAY_PORT}`;
  return { server, ownerPool, config };
}

let cookie = '';
async function req(base, method, path, body) {
  const headers = { 'Content-Type': 'application/json', Origin: base, Accept: 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}

(async () => {
  console.log(`Mode: ${USE_REAL ? 'REAL OpenAI (billed)' : 'STUB OpenAI'}  ·  proxy port ${PROXY_PORT}  ·  gateway ${GATEWAY_PORT}`);
  await pgStartContainer(); await waitReady(); await applySchemaAndSeed();
  // Ensure the AI-context login role exists on the shared PG (idempotent).
  const owner0 = new pg.Pool({ host: '127.0.0.1', port: PG.port, user: 'neondb_owner', password: PG.password, database: 'neondb', max: 1, ssl: false });
  await owner0.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='synthetic_context_login') THEN CREATE ROLE synthetic_context_login LOGIN PASSWORD 'synthetic-local-only'; GRANT trade_fair_ai_context TO synthetic_context_login; END IF; END $$;");
  await owner0.end();

  const stub = USE_REAL ? null : startStub();
  await new Promise((r) => setTimeout(r, 400));
  const { child: proxyChild } = await startProxy();
  const { server, ownerPool, config } = await startGateway();
  const base = `http://127.0.0.1:${GATEWAY_PORT}`;

  try {
    // 1. Login + health
    let r = await req(base, 'POST', '/api/login', { access_key: config.dashboardAccessKey });
    record('Admin login', r.status === 200);

    const metricsBefore = await (await fetch(`http://127.0.0.1:${PROXY_PORT}/_metrics`)).json();
    record('Proxy /_metrics endpoint responds (sanitized)', typeof metricsBefore?.wf07?.calls === 'number' && typeof metricsBefore?.wf08?.calls === 'number');

    // 2. WF-07 — arbitrary German note that includes a colloquial enum
    const note = 'Heute am Stand: Firma AlpenTronic AG, Herr Dr. Paul Weinberger, Interesse an KI-Automation. Budget für Q1 freigegeben. Bitte Rückruf innerhalb zwei Wochen. p.weinberger@alpentronic.test, +43 1 5551234.';
    r = await req(base, 'POST', '/api/dashboard/ai/extract', { notes: note, session_id: 'rc2-' + Date.now() });
    const ex = r.body?.extracted || {};
    const flags = r.body?.uncertainty_flags || [];
    record('WF-07 extraction returns 200 with structured fields', r.status === 200 && r.body?.success === true);
    record('WF-07 enum coercion canonicalised training_interest to ai_automation', ex.training_interest === 'ai_automation', `value=${ex.training_interest}`);
    record('WF-07 enum coercion canonicalised budget_status to approved', ex.budget_status === 'approved', `value=${ex.budget_status}`);
    record('WF-07 enum coercion canonicalised follow_up to within_two_weeks', ex.follow_up === 'within_two_weeks', `value=${ex.follow_up}`);
    record('WF-07 did NOT fabricate missing website', ex.website == null);
    record('WF-07 did not emit unsupported_* flags for coerced enums', !flags.some((f) => /^unsupported_(training_interest|budget_status|follow_up)$/.test(f)), `flags=${flags.join(',')}`);

    // 3. Submit the corrected lead → persisted
    const submissionId = 'rc2-' + randomUUID();
    const payload = { source: 'internal_form', submission_id: submissionId,
      company_name: ex.company_name || 'AlpenTronic AG', contact_name: ex.contact_name || 'Paul Weinberger',
      email: ex.email || 'p.weinberger@alpentronic.test', phone: ex.phone || '+43 1 5551234',
      training_interest: ex.training_interest || 'ai_automation', budget_status: ex.budget_status || 'approved',
      follow_up: ex.follow_up || 'within_two_weeks', notes: 'RC2 synthetic test.' };
    r = await req(base, 'POST', '/api/leads', payload);
    const leadId = r.body?.lead_id;
    record('/api/leads 201 persisted after enum-valid submit', r.status === 201 && !!leadId && r.body?.persisted === true);

    // 4. Idempotency replay
    r = await req(base, 'POST', '/api/leads', payload);
    record('Retry same submission_id + same body → 200 idempotent_replay, same lead_id', r.status === 200 && r.body?.lead_id === leadId && r.body?.idempotent_replay === true);

    // 5. Verify no duplicate in PG
    const dupCheck = await ownerPool.query("SELECT count(*) FROM trade_fair.lead_submissions WHERE submission_id=$1", [submissionId]);
    record('PG contains exactly one row for this submission_id', Number(dupCheck.rows[0].count) === 1);

    // 6. WF-08 — three different relevant questions on the new lead's context
    const ctx = [leadId];
    // Gateway's safeAiAsk strips any field outside its allowlist. The proxy
    // replaces body.answer with the grouped summary so it survives the whitelist.
    const q1 = await req(base, 'POST', '/api/dashboard/ai/ask', { question: 'Welches Follow-up ist geplant?', context_lead_ids: ctx, session_id: 'rc2-q1' });
    const q1Answer = q1.body?.answer || '';
    record('WF-08 Q1 (follow-up): grouped answer, cited only context, correct value',
      q1.status === 200 && /within_two_weeks/.test(q1Answer) && q1.body?.cited_lead_ids?.length === 1 && q1.body.cited_lead_ids[0] === leadId,
      `answer="${q1Answer}"`);

    const q2 = await req(base, 'POST', '/api/dashboard/ai/ask', { question: 'Wie ist der Budgetstatus?', context_lead_ids: ctx, session_id: 'rc2-q2' });
    const q2Answer = q2.body?.answer || '';
    record('WF-08 Q2 (budget): different answer, grouped, no fabrication',
      q2.status === 200 && /approved/.test(q2Answer) && !/\b\d{1,3}\s*(?:\/\s*100|punkte|points)\b/i.test(q2Answer),
      `answer="${q2Answer}"`);

    const unscored = 'FAIR-00000000-0000-4000-8000-000000000001'; // seeded, no processing_results row
    const q3 = await req(base, 'POST', '/api/dashboard/ai/ask', { question: 'Welche Leads haben noch keinen AI-Score?', context_lead_ids: [unscored, leadId], session_id: 'rc2-q3' });
    const q3Answer = q3.body?.answer || '';
    record('WF-08 Q3 (unscored): concise grouped summary with count, not a wall of IDs',
      q3.status === 200 && /\d+\s+Leads?.*(?:keinen|ohne|noch keinen)/i.test(q3Answer) && q3Answer.length < 220,
      `answer="${q3Answer}"`);

    // 7. Anti-fabrication: ask about a lead NOT in context — expect refusal, no fake score
    const q4 = await req(base, 'POST', '/api/dashboard/ai/ask', { question: 'Welches Budget hat KonstruktSmart UG?', context_lead_ids: [leadId], session_id: 'rc2-q4' });
    record('WF-08 Q4 (out of context): no fabricated claim, cited only context',
      q4.status === 200 && (q4.body?.cited_lead_ids || []).every((id) => id === leadId) && !/\b\d{1,3}\s*(?:\/\s*100|punkte|points)\b/i.test(q4.body?.answer || ''),
      `answer="${q4.body?.answer}"`);

    // 7b. Truncation surfaces visibly when context exceeds the 20-claim cap.
    //     Build the full 8-seed context and ask a multi-field question so the
    //     stub emits enough claims to hit the cap; proxy must prefix answer with
    //     '⚠ unvollständig' instead of silently dropping information.
    const bigCtx = (await ownerPool.query("SELECT lead_id FROM trade_fair.lead_submissions ORDER BY created_at ASC LIMIT 15")).rows.map((r) => r.lead_id);
    const qT = await req(base, 'POST', '/api/dashboard/ai/ask', { question: 'Welchen Score und welche Kategorie haben die Leads?', context_lead_ids: bigCtx, session_id: 'rc2-trunc' });
    const qTAnswer = qT.body?.answer || '';
    record('WF-08 truncation visible (⚠ unvollständig) when claims exceed 20',
      qT.status === 200 && /unvollst[aä]ndig/i.test(qTAnswer),
      `answer="${qTAnswer.slice(0, 180)}"`);

    // 8. Negative WF-07: user POSTs an invalid enum → mock capture validates and 422 details
    const bad = { ...payload, submission_id: 'rc2-bad-' + randomUUID(), training_interest: 'not-an-enum', notes: 'different body for new submission' };
    r = await req(base, 'POST', '/api/leads', bad);
    record('/api/leads invalid enum returns 422 with field-level details (visible in UI)',
      r.status === 422 && Array.isArray(r.body?.error?.details) && r.body.error.details.length > 0,
      `status=${r.status}  body=${JSON.stringify(r.body).slice(0, 300)}`);

    // 9. Metrics: confirm real model-equivalent calls happened and were measured
    const metricsAfter = await (await fetch(`http://127.0.0.1:${PROXY_PORT}/_metrics`)).json();
    const wf07Delta = metricsAfter.wf07.model_calls - metricsBefore.wf07.model_calls;
    const wf08Delta = metricsAfter.wf08.model_calls - metricsBefore.wf08.model_calls;
    record('Metrics: WF-07 made at least 1 model call', wf07Delta >= 1, `WF-07 calls=${wf07Delta}, tokens_in+out=${metricsAfter.wf07.tokens_in + metricsAfter.wf07.tokens_out}`);
    record('Metrics: WF-08 made at least 3 distinct model calls', wf08Delta >= 3, `WF-08 calls=${wf08Delta}`);
    record('Metrics: WF-07 enum coercion counted', metricsAfter.wf07.enum_coerced >= 3, `coerced=${metricsAfter.wf07.enum_coerced}`);

  } finally {
    server.closeAllConnections(); server.close(); await ownerPool.end();
    proxyChild.kill('SIGINT'); if (stub) stub.kill('SIGINT');
    await new Promise((r) => setTimeout(r, 200));
  }

  const failed = results.filter((x) => !x.ok);
  console.log('');
  console.log(`RC2 chain: ${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) { console.log('FAILED:'); for (const f of failed) console.log('  -', f.name, f.detail); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
