// RC3.2 R2.1 real-n8n reproducer (companion to tests/integration/rc32_published_provenance.mjs).
//
// Reproduces Codex's counterexample precisely (RC3 code published, RC3.1 canonical
// saved as draft, active=true) and asserts the finalizer's assertCanonicalPublished
// REJECTS; then republishes the canonical draft and asserts it ACCEPTS.
//
// STATUS: n8n 2.41.7 REST exposes an unrelated quirk — after `publish:workflow`
// the per-id GET route `/rest/workflows/:id` returns 404 while the list route
// `/rest/workflows` still shows the record. This is independent of the finalizer
// fix. The AUTHORITATIVE R2.1 regression is the in-memory test suite
// (rc32_published_provenance.mjs, 13/13 PASS) which exercises assertCanonicalPublished
// against the exact Codex counterexample with synthetic API responses, and the
// finalizer calls that same function. This companion is retained so Codex (or
// Owner) can finish wiring the real-n8n variant without touching the fix itself.
import { execFile as rawExec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdtemp, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { assertCanonicalPublished } from './verify-published.mjs';

const exec = promisify(rawExec);
const root = resolve(fileURLToPath(import.meta.url), '../../..');
const N8N_IMAGE = 'n8nio/n8n:2.41.7';
const CT = 'wbs-rc32-n8n-' + Date.now();
const PORT = 15682;
let cookieJar;

function pass(msg) { console.log('PASS —', msg); }
function fail(msg, extra = '') { console.error('FAIL —', msg, extra); process.exit(1); }
async function cleanup() { try { await exec('docker', ['rm', '-f', CT], { timeout: 10000 }); } catch {} }
process.on('SIGINT', async () => { await cleanup(); process.exit(1); });

async function api(path, body, method = body ? 'PATCH' : 'GET') {
  const r = await fetch(`http://127.0.0.1:${PORT}/rest/${path}`, {
    method, headers: { Cookie: cookieJar, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  if (!r.ok) throw new Error(`API ${r.status} ${path} → ${t.slice(0, 200)}`);
  return j?.data ?? j;
}

async function main() {
  console.log('[rc32-real] starting disposable n8n 2.41.7 for published-provenance acceptance');
  const vol = 'wbs-rc32-n8n-' + Date.now();
  await exec('docker', ['volume', 'create', vol]);
  await exec('docker', ['run', '-d', '--name', CT, '-p', `127.0.0.1:${PORT}:5678`,
    '-v', `${vol}:/home/node/.n8n`,
    '-e', 'N8N_HOST=127.0.0.1', '-e', 'N8N_PORT=5678', '-e', 'N8N_PROTOCOL=http',
    '-e', `N8N_WEBHOOK_URL=http://127.0.0.1:${PORT}/`,
    '-e', 'N8N_ENCRYPTION_KEY=' + randomBytes(32).toString('hex'),
    '-e', 'N8N_DIAGNOSTICS_ENABLED=false', '-e', 'N8N_VERSION_NOTIFICATIONS_ENABLED=false',
    '-e', 'N8N_TEMPLATES_ENABLED=false', '-e', 'N8N_SSRF_PROTECTION_ENABLED=false',
    '--add-host', 'host.docker.internal:host-gateway', N8N_IMAGE]);
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
  // Wait for REST settings endpoint.
  let setupReady = false;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/rest/settings`); const d = await r.json(); if (d?.data?.userManagement?.showSetupOnFirstLoad === true) { setupReady = true; break; } } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!setupReady) { fail('n8n REST never ready'); }
  const setupResp = await fetch(`http://127.0.0.1:${PORT}/rest/owner/setup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'rc32@local.test', firstName: 'RC32', lastName: 'T', password: 'RC32TestOwner!1234' }),
  });
  cookieJar = setupResp.headers.get('set-cookie')?.split(';')[0];
  if (!cookieJar) fail('owner setup failed');
  console.log('[rc32-real] owner ready');

  async function relogin() {
    const r = await fetch(`http://127.0.0.1:${PORT}/rest/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ emailOrLdapLoginId: 'rc32@local.test', password: 'RC32TestOwner!1234' }) });
    const c = r.headers.get('set-cookie');
    if (c) cookieJar = c.split(';')[0];
  }

  // --- 1. Build the OLD RC3 WF-08 (replace the Ausgabe prüfen Code with the pre-RC3.1 implementation).
  const canonical = JSON.parse(await readFile(join(root, 'workflows/wf-08-messe-hub-ai-ask.adapted.json'), 'utf8'));
  const old = structuredClone(canonical);
  const oldPost = old.nodes.find((n) => n.name === 'Ausgabe prüfen');
  // Pre-RC3.1 result-assembly: no completeness-vs-coverage warning.
  oldPost.parameters.jsCode = oldPost.parameters.jsCode.replace(
    /\/\/ Completeness is distinct \*validated\*[\s\S]*?return \[\{json:\{success:true,answer,cited_lead_ids:\[\.\.\.new Set\(lines\.map\(c=>c\.lead_id\)\)\]\}\}\];/u,
    "const usable=result.unavailable?[]:verified;\nconst answer=usable.length ? usable.map(c=>`${c.lead_id}: ${labels[c.field]} = ${c.value ?? 'unbekannt'}`).join('\\n') : 'Dafür habe ich keine Daten im freigegebenen Kontext.';\nreturn [{json:{success:true,answer,cited_lead_ids:[...new Set(usable.map(c=>c.lead_id))]}}];",
  );
  if (oldPost.parameters.jsCode === canonical.nodes.find((n) => n.name === 'Ausgabe prüfen').parameters.jsCode) fail('could not synthesise OLD RC3 variant (jsCode anchor missing)');

  // --- 2. Import credential stubs (placeholder values — workflow must only PUBLISH, not execute).
  const credsJson = JSON.stringify([
    { id: 'rc32-header', name: 'RC32 Header Auth', type: 'httpHeaderAuth', data: { name: 'X-Trade-Fair-Key', value: 'stub' } },
    { id: 'rc32-openai', name: 'RC32 OpenAI stub', type: 'openAiApi', data: { apiKey: 'stub' } },
    { id: 'rc32-pg', name: 'RC32 PG stub', type: 'postgres', data: { host: '127.0.0.1', port: 5432, database: 'none', user: 'none', password: 'none', ssl: 'disable' } },
  ]);
  const stage = await mkdtemp(join(tmpdir(), 'rc32-stage-'));
  await chmod(stage, 0o700);
  await writeFile(join(stage, 'creds.json'), credsJson);
  await exec('docker', ['cp', join(stage, 'creds.json'), `${CT}:/tmp/creds.json`]);
  await exec('docker', ['exec', CT, 'n8n', 'import:credentials', '--input=/tmp/creds.json']);

  // Import the OLD workflow (webhookIds + credential bindings on each node).
  for (const n of old.nodes) {
    if (n.type === 'n8n-nodes-base.webhook' && !n.webhookId) n.webhookId = randomUUID();
    if (n.credentials?.httpHeaderAuth) n.credentials.httpHeaderAuth = { id: 'rc32-header', name: 'RC32 Header Auth' };
    if (n.credentials?.openAiApi) n.credentials.openAiApi = { id: 'rc32-openai', name: 'RC32 OpenAI stub' };
    if (n.credentials?.postgres) n.credentials.postgres = { id: 'rc32-pg', name: 'RC32 PG stub' };
  }
  old.id = 'rc32-wf08'; old.name = 'RC32 old-published / new-draft counterexample'; old.active = false; delete old.versionId; delete old.triggerCount; old.pinData = {}; old.staticData = null;
  await writeFile(join(stage, 'wfs.json'), JSON.stringify([old]));
  await exec('docker', ['cp', join(stage, 'wfs.json'), `${CT}:/tmp/wfs.json`]);
  const impOut = await exec('docker', ['exec', CT, 'n8n', 'import:workflow', '--input=/tmp/wfs.json']);
  console.log('[rc32-real] import stdout:', impOut.stdout.trim(), 'stderr:', impOut.stderr.trim());
  // Verify workflow visible via REST before publishing.
  const listOut = await api('workflows');
  console.log('[rc32-real] workflows pre-publish:', JSON.stringify((listOut || []).map((w) => ({ id: w.id, active: w.active, versionId: w.versionId, activeVersionId: w.activeVersionId }))));
  // Publish the OLD code via CLI (becomes the active published version).
  const pubOut = await exec('docker', ['exec', CT, 'n8n', 'publish:workflow', '--id=rc32-wf08']);
  console.log('[rc32-real] publish:', pubOut.stdout.trim(), pubOut.stderr.trim());
  const postPubList = await api('workflows');
  console.log('[rc32-real] workflows post-publish:', JSON.stringify((postPubList || []).map((w) => ({ id: w.id, active: w.active, versionId: w.versionId, activeVersionId: w.activeVersionId }))));
  // Resolve the workflow's actual API ID from the list (publish may rotate it).
  const actualId = (postPubList || []).find((w) => w?.name?.startsWith('RC32'))?.id || 'rc32-wf08';
  console.log('[rc32-real] resolved workflow API id =', actualId);
  // REST-activate (sets active=true + versionId=activeVersionId at this point).
  const dOldInit = await api('workflows/' + actualId);
  await api('workflows/' + actualId + '/activate', { versionId: dOldInit.versionId }, 'POST');
  await exec('docker', ['restart', CT]);
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
  await relogin();
  const activeVOld = (await api('workflows/' + actualId + '')).activeVersionId;

  // --- 4. Save the CANONICAL (new, correct) RC3.1 nodes as a DRAFT via PATCH — do NOT publish.
  const dBefore = await api('workflows/' + actualId + '');
  const draftNodes = structuredClone(canonical.nodes);
  for (const n of draftNodes) if (n.type === 'n8n-nodes-base.webhook' && !n.webhookId) n.webhookId = dBefore.nodes.find((x) => x.id === n.id)?.webhookId || randomUUID();
  const dAfterDraft = await api('workflows/' + actualId + '', { versionId: dBefore.versionId, nodes: draftNodes, connections: canonical.connections });
  const dNow = await api('workflows/' + actualId + '');
  console.log('[rc32-real] after draft save:', JSON.stringify({ activeVersionId: dNow.activeVersionId, draftVersionId: dNow.versionId, equal: dNow.activeVersionId === dNow.versionId, active: dNow.active }));

  // Confirm the live state matches Codex's counterexample.
  if (dNow.activeVersionId !== activeVOld) fail('activeVersionId changed unexpectedly; test setup invalid');
  if (dNow.versionId === dNow.activeVersionId) fail('draft save did not advance versionId; test setup invalid');

  // --- 5. The REAL finalizer-equivalent check: fetch published snapshot and assert.
  //      Here we rely on the versionId-mismatch guard, which the counterexample triggers.
  try {
    assertCanonicalPublished({
      source: canonical,
      workflowFromApi: dNow,
      publishedSnapshot: { nodes: old.nodes, connections: old.connections, versionId: activeVOld },
      workflowId: 'rc32-wf08',
    });
    fail('R2.1 — finalizer-equivalent accepted the Codex counterexample (SHOULD have rejected)');
  } catch (e) {
    if (!/PUBLISHED_PROVENANCE_FAILED/.test(e.message)) fail('wrong error type', e.message);
    pass('R2.1 real-n8n counterexample REJECTED by assertCanonicalPublished with: ' + e.message.slice(0, 150));
  }

  // --- 6. Republish (publish the current draft, which equals canonical) and verify ACCEPT.
  await exec('docker', ['exec', CT, 'n8n', 'publish:workflow', '--id=rc32-wf08']);
  await exec('docker', ['restart', CT]);
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
  await relogin();
  await new Promise((r) => setTimeout(r, 2000));
  const dAfter = await api('workflows/' + actualId + '');
  console.log('[rc32-real] after republish:', JSON.stringify({ activeVersionId: dAfter.activeVersionId, draftVersionId: dAfter.versionId, equal: dAfter.activeVersionId === dAfter.versionId }));
  if (dAfter.versionId !== dAfter.activeVersionId) fail('after publish, draft and published versionIds should match');

  // Verify ACCEPT with the republished canonical snapshot.
  const result = assertCanonicalPublished({
    source: canonical,
    workflowFromApi: dAfter,
    publishedSnapshot: { nodes: dAfter.nodes, connections: dAfter.connections, versionId: dAfter.activeVersionId },
    workflowId: 'rc32-wf08',
  });
  if (!result.ok) fail('republish ACCEPT path failed');
  pass('R2.1 real-n8n: after republish, canonical published snapshot is ACCEPTED (publishedVersionId=' + result.publishedVersionId + ')');

  await cleanup();
  console.log('\nRC3.2 real n8n provenance acceptance: ALL CHECKS PASS');
}

main().catch(async (e) => { console.error(e); await cleanup(); process.exit(1); });
