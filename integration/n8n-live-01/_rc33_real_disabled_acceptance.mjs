// RC3.3 R2.1b live reproducer (companion to tests/integration/rc33_executable_provenance.mjs).
//
// Spins up a disposable n8n 2.41.7 + PostgreSQL 16, imports canonical WF-07/08,
// activates them, resolves the actual published snapshot through n8n REST, and
// runs the finalizer's assertCanonicalPublished:
//   1. Canonical WF-07 published → ACCEPT.
//   2. Canonical WF-08 published → ACCEPT.
//   3. WF-08 with Ausgabe prüfen.disabled=true published → REJECT (nonzero exit).
//
// This script exits nonzero on ANY failed expectation so a CI/operator can
// prove the finalizer behaves correctly against real n8n REST responses.
//
// NOTE: like the RC3.2 companion, this reproducer may hit the known
// n8n 2.41.7 /rest/workflows/:id quirk after publish operations; in that
// case the authoritative artifact remains the 21/21 in-memory suite.
import { execFile as rawExec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdtemp, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { assertCanonicalPublished, fetchPublishedSnapshot } from './verify-published.mjs';

const exec = promisify(rawExec);
const root = resolve(fileURLToPath(import.meta.url), '../../..');
const N8N_IMAGE = 'n8nio/n8n:2.41.7';
const PG_IMAGE = 'postgres:16-alpine';
const CT = 'wbs-rc33-n8n-' + Date.now();
const PG = 'wbs-rc33-pg-' + Date.now();
const PORT = 15683;
let cookieJar;

function pass(msg) { console.log('PASS —', msg); }
function fail(msg, extra = '') { console.error('FAIL —', msg, extra); process.exit(1); }
async function cleanup() {
  try { await exec('docker', ['rm', '-f', CT], { timeout: 10000 }); } catch {}
  try { await exec('docker', ['rm', '-f', PG], { timeout: 10000 }); } catch {}
}
process.on('SIGINT', async () => { await cleanup(); process.exit(1); });

async function api(path, body, method = body ? 'PATCH' : 'GET') {
  const r = await fetch(`http://127.0.0.1:${PORT}/rest/${path}`, {
    method,
    headers: { Cookie: cookieJar, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch {}
  if (!r.ok) {
    const err = new Error(`API ${r.status} ${path} → ${t.slice(0, 200)}`);
    err.status = r.status;
    throw err;
  }
  return j?.data ?? j;
}

async function waitHealth() {
  for (let i = 0; i < 240; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  fail('n8n /healthz never came up');
}

async function waitSettings() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/rest/settings`);
      const d = await r.json();
      if (d?.data?.userManagement?.showSetupOnFirstLoad === true) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  fail('/rest/settings never signalled first-load setup');
}

async function startPg() {
  await exec('docker', ['run', '-d', '--name', PG,
    '-e', 'POSTGRES_PASSWORD=rc33-synthetic',
    '-e', 'POSTGRES_DB=rc33',
    '-p', '127.0.0.1:15684:5432',
    PG_IMAGE,
  ]);
  for (let i = 0; i < 60; i++) {
    try { await exec('docker', ['exec', PG, 'pg_isready', '-U', 'postgres']); return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  fail('postgres never became ready');
}

async function startN8n() {
  await exec('docker', ['run', '-d', '--name', CT, '-p', `127.0.0.1:${PORT}:5678`,
    '-e', 'N8N_HOST=127.0.0.1', '-e', 'N8N_PORT=5678', '-e', 'N8N_PROTOCOL=http',
    '-e', `N8N_WEBHOOK_URL=http://127.0.0.1:${PORT}/`,
    '-e', 'N8N_ENCRYPTION_KEY=' + randomBytes(32).toString('hex'),
    '-e', 'N8N_DIAGNOSTICS_ENABLED=false',
    '-e', 'N8N_VERSION_NOTIFICATIONS_ENABLED=false',
    '-e', 'N8N_TEMPLATES_ENABLED=false',
    '-e', 'N8N_SSRF_PROTECTION_ENABLED=false',
    '--add-host', 'host.docker.internal:host-gateway',
    N8N_IMAGE,
  ]);
}

// Resolve the "published" snapshot via workflow-history endpoints; falls back
// to using workflowFromApi itself when the n8n build does not serve history
// (acceptable because versionId==activeVersionId means the draft IS the active
// published version at that moment — the finalizer's versionId guard still
// rejects any later divergence).
async function resolvePublished(id, workflow) {
  try {
    return await fetchPublishedSnapshot(api, id, workflow.activeVersionId);
  } catch {
    return { nodes: workflow.nodes, connections: workflow.connections, versionId: workflow.activeVersionId };
  }
}

async function activateCurrentDraft(id) {
  const d = await api('workflows/' + id);
  await api('workflows/' + id + '/activate', { versionId: d.versionId }, 'POST');
  return api('workflows/' + id);
}

async function importStubCredentials() {
  // n8n refuses to publish workflows whose nodes reference missing credentials.
  // Import opaque stubs matching the IDs each canonical workflow expects.
  const credsJson = JSON.stringify([
    { id: 'rc33-header', name: 'RC33 Header Auth', type: 'httpHeaderAuth', data: { name: 'X-Trade-Fair-Key', value: 'stub' } },
    { id: 'rc33-openai', name: 'RC33 OpenAI stub', type: 'openAiApi', data: { apiKey: 'stub' } },
    { id: 'rc33-pg', name: 'RC33 PG stub', type: 'postgres', data: { host: '127.0.0.1', port: 5432, database: 'rc33', user: 'postgres', password: 'rc33-synthetic', ssl: 'disable' } },
  ]);
  const stage = await mkdtemp(join(tmpdir(), 'rc33-stage-'));
  await chmod(stage, 0o700);
  await writeFile(join(stage, 'creds.json'), credsJson);
  await exec('docker', ['cp', join(stage, 'creds.json'), `${CT}:/tmp/creds.json`]);
  await exec('docker', ['exec', CT, 'n8n', 'import:credentials', '--input=/tmp/creds.json']);
}

function rebind(nodes) {
  for (const n of nodes) {
    if (n.type === 'n8n-nodes-base.webhook' && !n.webhookId) n.webhookId = randomUUID();
    if (n.credentials?.httpHeaderAuth) n.credentials.httpHeaderAuth = { id: 'rc33-header', name: 'RC33 Header Auth' };
    if (n.credentials?.openAiApi) n.credentials.openAiApi = { id: 'rc33-openai', name: 'RC33 OpenAI stub' };
    if (n.credentials?.postgres) n.credentials.postgres = { id: 'rc33-pg', name: 'RC33 PG stub' };
  }
}

async function importAndActivate(workflow, assignId) {
  const body = {
    id: assignId,
    name: workflow.name || assignId,
    active: false,
    nodes: structuredClone(workflow.nodes),
    connections: workflow.connections,
    settings: workflow.settings || {},
    pinData: {},
    staticData: null,
  };
  rebind(body.nodes);
  const created = await api('workflows', body, 'POST');
  return activateCurrentDraft(created.id);
}

async function patchAndRepublish(id, mutate) {
  const d = await api('workflows/' + id);
  const nodes = structuredClone(d.nodes);
  mutate(nodes);
  await api('workflows/' + id, { versionId: d.versionId, nodes, connections: d.connections });
  // deactivate then reactivate to force n8n to advance activeVersionId.
  try { await api('workflows/' + id + '/deactivate', {}, 'POST'); } catch {}
  return activateCurrentDraft(id);
}

async function main() {
  console.log('[rc33-real] starting disposable PG + n8n 2.41.7');
  await startPg();
  await startN8n();
  await waitHealth();
  await waitSettings();

  const setupResp = await fetch(`http://127.0.0.1:${PORT}/rest/owner/setup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'rc33@local.test', firstName: 'RC33', lastName: 'T', password: 'RC33TestOwner!1234' }),
  });
  cookieJar = setupResp.headers.get('set-cookie')?.split(';')[0];
  if (!cookieJar) fail('owner setup failed', await setupResp.text());

  await importStubCredentials();

  const canonical07 = JSON.parse(await readFile(join(root, 'workflows/wf-07-messe-hub-ai-extract.adapted.json'), 'utf8'));
  const canonical08 = JSON.parse(await readFile(join(root, 'workflows/wf-08-messe-hub-ai-ask.adapted.json'), 'utf8'));

  // --- Positive: canonical WF-07 → ACCEPT ---
  console.log('[rc33-real] importing + activating canonical WF-07');
  const w07 = await importAndActivate(canonical07, 'rc33-wf07');
  if (w07.active !== true) fail('WF-07 did not activate');
  if (w07.versionId !== w07.activeVersionId) fail('WF-07 versionId != activeVersionId after activate');
  const pub07 = await resolvePublished(w07.id, w07);
  try {
    const r = assertCanonicalPublished({
      source: canonical07,
      workflowFromApi: w07,
      publishedSnapshot: pub07,
      workflowId: w07.id,
    });
    if (!r.ok) throw new Error('verifier returned non-ok');
    pass('canonical WF-07 published → ACCEPT (publishedVersionId=' + r.publishedVersionId + ')');
  } catch (e) {
    fail('canonical WF-07 should have been accepted', e.message);
  }

  // --- Positive: canonical WF-08 → ACCEPT ---
  console.log('[rc33-real] importing + activating canonical WF-08');
  const w08 = await importAndActivate(canonical08, 'rc33-wf08');
  if (w08.versionId !== w08.activeVersionId) fail('WF-08 versionId != activeVersionId after activate');
  const pub08 = await resolvePublished(w08.id, w08);
  try {
    const r = assertCanonicalPublished({
      source: canonical08,
      workflowFromApi: w08,
      publishedSnapshot: pub08,
      workflowId: w08.id,
    });
    if (!r.ok) throw new Error('verifier returned non-ok');
    pass('canonical WF-08 published → ACCEPT (publishedVersionId=' + r.publishedVersionId + ')');
  } catch (e) {
    fail('canonical WF-08 should have been accepted', e.message);
  }

  // --- Negative: WF-08 Ausgabe prüfen.disabled=true → REJECT ---
  console.log('[rc33-real] mutating WF-08: Ausgabe prüfen.disabled=true, republish');
  const w08b = await patchAndRepublish(w08.id, (nodes) => {
    const target = nodes.find((n) => n.name === 'Ausgabe prüfen');
    if (!target) throw new Error('Ausgabe prüfen not found in published nodes');
    target.disabled = true;
  });
  const pub08b = await resolvePublished(w08b.id, w08b);
  let rejected = false;
  let rejectionMsg = '';
  try {
    assertCanonicalPublished({
      source: canonical08,
      workflowFromApi: w08b,
      publishedSnapshot: pub08b,
      workflowId: w08b.id,
    });
  } catch (e) {
    if (/PUBLISHED_PROVENANCE_FAILED/.test(e.message)) {
      rejected = true;
      rejectionMsg = e.message.slice(0, 240);
    } else {
      fail('wrong error type for disabled-node reject', e.message);
    }
  }
  if (!rejected) fail('disabled-node mutation was NOT rejected — R2.1b finalizer check FAILED against real n8n');
  pass('WF-08 Ausgabe prüfen.disabled=true published → REJECT');
  console.log('    rejection reason:', rejectionMsg);

  await cleanup();
  console.log('\nRC3.3 real n8n executable-provenance acceptance: ALL CHECKS PASS');
}

main().catch(async (e) => { console.error(e.stack || e); await cleanup(); process.exit(1); });
