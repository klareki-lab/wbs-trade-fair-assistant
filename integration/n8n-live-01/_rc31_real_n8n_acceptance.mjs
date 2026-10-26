// RC3.1 Codex-required acceptance: canonical WF-08 → real isolated n8n 2.41.7
// → RespondToWebhook, with a mock OpenAI upstream so the test is deterministic
// and never bills a staging key. Reproduces the 9 leads × 3 fields = 27 cells /
// 20 valid claims scenario and asserts the HTTP response's `answer` begins with
// "⚠ Ergebnis unvollständig (20 von 27 angefragten Werten)".
//
// This is the real-n8n complement to tests/integration/rc31_regression.mjs
// (which exercises the Code node in isolation) and the Gateway allowlist test
// appended to tests/test_gateway_dashboard.mjs. Together they close R1 end-to-end.
import { execFile as rawExec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdtemp, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { startPg16, ids } from '../../tests/helpers/pg16.mjs';

const exec = promisify(rawExec);
const root = resolve(fileURLToPath(import.meta.url), '../../..');
const N8N_IMAGE = 'n8nio/n8n:2.41.7';
const CT = 'wbs-rc31-n8n-' + Date.now();
const PORT = 15681;

let db, container, stub, cookieJar;

function assertEq(actual, expected, msg) { if (actual !== expected) { console.error('FAIL —', msg, '\n  expected:', expected, '\n  actual:', actual); process.exit(1); } console.log('PASS —', msg); }
function assertMatch(actual, re, msg) { if (!re.test(String(actual))) { console.error('FAIL —', msg, '\n  pattern:', re, '\n  actual:', actual); process.exit(1); } console.log('PASS —', msg); }

async function cleanup() {
  try { await exec('docker', ['rm', '-f', CT], { timeout: 10000 }); } catch {}
  try { await db?.close(); } catch {}
  try { stub?.close(); } catch {}
}
process.on('SIGINT', async () => { await cleanup(); process.exit(1); });

async function main() {
  console.log('[rc31-real] starting disposable PG16 + mock OpenAI + isolated n8n 2.41.7');
  db = await startPg16();

  // --- 1. Mock OpenAI server. Emits 20 claims covering 7 unique leads × ≤3 fields.
  // Extracts the JSON prefix at the start of a user content string, handling
  // the langchain outputParserStructured which appends schema instructions after
  // the model-facing JSON payload.
  function extractLeadingJson(s) {
    let depth = 0, inStr = false, esc = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(0, i + 1)); } catch { return {}; } } }
    }
    return {};
  }
  stub = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const user = body.messages?.find((m) => m.role === 'user');
    const parsed = extractLeadingJson(user?.content || '');
    const ctx = Array.isArray(parsed.context) ? parsed.context : [];
    const requested = (parsed.untrusted_question || parsed.question || '').replace(/^Return these attributes:\s*/i, '').split(',').map((s) => s.trim()).filter(Boolean);
    const claims = [];
    outer: for (const lead of ctx) for (const f of requested) { if (claims.length >= 20) break outer; if (Object.hasOwn(lead, f)) claims.push({ lead_id: lead.lead_id, field: f, value: lead[f] }); }
    const out = { output: { claims, unavailable: claims.length === 0 } };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'stub-' + Date.now(), object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(out) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }));
  });
  stub.listen(0, '127.0.0.1');
  await new Promise((r) => stub.once('listening', r));
  const stubPort = stub.address().port;
  console.log('[rc31-real] mock OpenAI on 127.0.0.1:' + stubPort);

  // --- 2. Seed PG with 9 synthetic leads, all without scores (so expected cells = 27,
  //      achievable claims = 9, forcing truncation only via requested fields * leads > 20).
  //      Fixture already seeded 8 leads from startPg16; we need 9, so add one more.
  await db.pool.query("INSERT INTO trade_fair.lead_submissions(lead_id,source,submission_id,company_id,contact_id,duplicate_status,raw_payload,normalized_payload,receipt,wf_b_payload,created_at) VALUES ($1,'internal_form','synthetic-rc31-lead-00000009','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','POSSIBLE_DUPLICATE','{}','{}','{}','{}',now())",
    ['FAIR-00000000-0000-4000-8000-000000000009']);
  const scopedIds = Array.from({ length: 9 }, (_, i) => 'FAIR-00000000-0000-4000-8000-' + String(i + 1).padStart(12, '0'));

  // --- 3. Start isolated n8n container
  const vol = 'wbs-rc31-n8n-' + Date.now();
  await exec('docker', ['volume', 'create', vol]);
  await exec('docker', ['run', '-d', '--name', CT, '-p', `127.0.0.1:${PORT}:5678`,
    '-v', `${vol}:/home/node/.n8n`,
    '-e', 'N8N_HOST=127.0.0.1', '-e', 'N8N_PORT=5678', '-e', 'N8N_PROTOCOL=http',
    '-e', `N8N_WEBHOOK_URL=http://127.0.0.1:${PORT}/`,
    '-e', 'N8N_ENCRYPTION_KEY=' + randomBytes(32).toString('hex'),
    '-e', 'N8N_DIAGNOSTICS_ENABLED=false', '-e', 'N8N_VERSION_NOTIFICATIONS_ENABLED=false',
    '-e', 'N8N_TEMPLATES_ENABLED=false', '-e', 'N8N_SSRF_PROTECTION_ENABLED=false',
    '--add-host', 'host.docker.internal:host-gateway',
    N8N_IMAGE]);
  container = CT;
  for (let i = 0; i < 120; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/healthz`); if (r.ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
  console.log('[rc31-real] n8n healthy on 127.0.0.1:' + PORT);
  // Poll /rest/settings until REST is fully ready and reports showSetupOnFirstLoad.
  // Codex's LIVE-01 bootstrap fix (apply.mjs references) uses this same signal.
  let setupReady = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/rest/settings`);
      if (r.ok) {
        const d = await r.json();
        if (d?.data?.userManagement?.showSetupOnFirstLoad === true) { setupReady = true; break; }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!setupReady) { console.error('rest/settings never reported showSetupOnFirstLoad'); process.exit(1); }

  // --- 4. Setup owner so published workflow activation works; capture session cookie.
  const setupResp = await fetch(`http://127.0.0.1:${PORT}/rest/owner/setup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'rc31@local.test', firstName: 'RC31', lastName: 'Test', password: 'RC31TestOwner!1234' }),
  });
  const setupCookie = setupResp.headers.get('set-cookie');
  if (!setupCookie) { console.error('owner setup failed, status=', setupResp.status, 'body=', (await setupResp.text()).slice(0, 400)); process.exit(1); }
  cookieJar = setupCookie.split(';')[0];

  // --- 5. Create scoped PG login + grant ai_lead_context role (idempotent)
  await db.pool.query("CREATE ROLE rc31_ai_ctx LOGIN PASSWORD 'synthetic-local-only'; GRANT trade_fair_ai_context TO rc31_ai_ctx;");

  // --- 6. Import credentials + canonical WF-08 (NO adapt — Codex's exact path)
  const headerKey = 'rc31-' + randomBytes(16).toString('hex');
  const credsJson = JSON.stringify([
    { id: 'rc31-header', name: 'RC31 Header Auth', type: 'httpHeaderAuth', data: { name: 'X-Trade-Fair-Key', value: headerKey } },
    { id: 'rc31-openai', name: 'RC31 OpenAI stub', type: 'openAiApi', data: { apiKey: 'stub-key-not-real', url: `http://host.docker.internal:${stubPort}` } },
    { id: 'rc31-pg', name: 'RC31 scoped AI context', type: 'postgres', data: { host: 'host.docker.internal', port: db.port, database: 'neondb', user: 'rc31_ai_ctx', password: 'synthetic-local-only', ssl: 'disable' } },
  ]);
  const wf08 = JSON.parse(await readFile(join(root, 'workflows/wf-08-messe-hub-ai-ask.adapted.json'), 'utf8'));
  const wf = Array.isArray(wf08) ? wf08[0] : wf08;
  // ONLY change: workflow identity + credential bindings. Byte-for-byte canonical node parameters.
  wf.id = 'rc31-wf08'; wf.name = 'RC31 canonical WF-08'; wf.active = false; delete wf.versionId; delete wf.triggerCount; wf.pinData = {}; wf.staticData = null;
  for (const n of wf.nodes) {
    if (n.type === 'n8n-nodes-base.webhook' && !n.webhookId) n.webhookId = randomUUID();
    if (n.credentials?.httpHeaderAuth) n.credentials.httpHeaderAuth = { id: 'rc31-header', name: 'RC31 Header Auth' };
    if (n.credentials?.openAiApi) n.credentials.openAiApi = { id: 'rc31-openai', name: 'RC31 OpenAI stub' };
    if (n.credentials?.postgres) n.credentials.postgres = { id: 'rc31-pg', name: 'RC31 scoped AI context' };
  }
  const stage = await mkdtemp(join(tmpdir(), 'rc31-stage-'));
  await chmod(stage, 0o700);
  await writeFile(join(stage, 'creds.json'), credsJson);
  await writeFile(join(stage, 'wfs.json'), JSON.stringify([wf]));
  await exec('docker', ['cp', join(stage, 'creds.json'), `${CT}:/tmp/creds.json`]);
  await exec('docker', ['cp', join(stage, 'wfs.json'), `${CT}:/tmp/wfs.json`]);
  await exec('docker', ['exec', CT, 'n8n', 'import:credentials', '--input=/tmp/creds.json']);
  await exec('docker', ['exec', CT, 'n8n', 'import:workflow', '--input=/tmp/wfs.json']);
  await exec('docker', ['exec', CT, 'n8n', 'publish:workflow', '--id=rc31-wf08']);
  // Login + REST-activate (publish:workflow alone doesn't register webhook in 2.41.7)
  const wfGet = await (await fetch(`http://127.0.0.1:${PORT}/rest/workflows/rc31-wf08`, { headers: { Cookie: cookieJar } })).json();
  const versionId = wfGet?.data?.versionId;
  await fetch(`http://127.0.0.1:${PORT}/rest/workflows/rc31-wf08/activate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieJar },
    body: JSON.stringify({ versionId }),
  });
  await exec('docker', ['restart', CT]);
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/healthz`); if (r.ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
  // Poll /webhook/… until registration finishes (anything other than 404 proves route is wired).
  // n8n 2.41.7 registers webhooks asynchronously after restart; up to ~30 s observed.
  let probe = null;
  for (let i = 0; i < 120; i++) {
    probe = await fetch(`http://127.0.0.1:${PORT}/webhook/messe-hub/ai-ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => null);
    if (probe && probe.status !== 404) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  // --- 7. Negative: no auth header → 403 (not 404)
  assertEq(probe?.status, 403, 'Isolated n8n webhook rejects no-auth with 403 (registration verified)');

  // --- 8. Real request through canonical n8n webhook: 9 leads × 3 fields = 27 cells.
  //      Mock OpenAI will cap at 20 claims (matching WF-08 schema maxItems:20).
  const r = await fetch(`http://127.0.0.1:${PORT}/webhook/messe-hub/ai-ask`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Trade-Fair-Key': headerKey },
    body: JSON.stringify({ question: 'Welche Scores und Budgets sind erfasst?', context_lead_ids: scopedIds }),
  });
  assertEq(r.status, 200, 'Isolated n8n webhook returns HTTP 200 with correct auth');
  const body = await r.json();
  console.log('[rc31-real] body preview:', JSON.stringify({ success: body.success, answerLines: (body.answer || '').split('\n').length, cited: body.cited_lead_ids?.length, firstLine: (body.answer || '').split('\n')[0]?.slice(0, 120) }));
  assertEq(body.success, true, 'Canonical response envelope success=true');
  assertMatch(body.answer, /^⚠ Ergebnis unvollständig \(20 von 27 angefragten Werten\)/, 'R1 — real canonical n8n webhook returns the required "unvollständig" warning for 27-requested / 20-returned');
  assertEq((body.answer.split('\n').length), 21, 'Answer contains warning + 20 distinct claim lines');

  await cleanup();
  console.log('\nRC3.1 real n8n acceptance: ALL CHECKS PASS');
}

main().catch(async (e) => { console.error(e); await cleanup(); process.exit(1); });
