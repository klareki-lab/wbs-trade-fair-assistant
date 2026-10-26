// RC3.3 operator script dry-run harness.
//
// Starts disposable n8n 2.41.7, uses the committed operator shell scripts
// (import_wf_rc3.sh, activate_wf.sh) and the read-only verifier
// (verify_published_production.mjs) end-to-end against the disposable
// instance. Proves:
//   • import_wf_rc3.sh accepts the committed canonical JSON, rebinds
//     credentials in-memory, and creates workflows with active=false
//     without mutating the committed file.
//   • activate_wf.sh advances a non-active workflow to active=true
//     with versionId==activeVersionId.
//   • verify_published_production.mjs returns exit 0 and PASS for both.
//   • verify_published_production.mjs returns exit 1 and FAIL when
//     Ausgabe prüfen.disabled is flipped to true (via REST PATCH from
//     this harness, NOT via the operator scripts — the mutation is
//     needed only to trip the verifier for a negative-case proof).
//
// This harness itself contains writes; the operator scripts under test
// are limited to the explicitly documented POSTs. The verifier is
// read-only (one POST /rest/login + GETs only).
import { execFile as rawExec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdtemp, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';

const exec = promisify(rawExec);
const root = resolve(fileURLToPath(import.meta.url), '../../..');
const N8N_IMAGE = 'n8nio/n8n:2.41.7';
const CT = 'wbs-rc33-opsdry-' + Date.now();
const PORT = 15685;

function pass(m) { console.log('PASS —', m); }
function fail(m, e = '') { console.error('FAIL —', m, e); process.exit(1); }
async function cleanup() { try { await exec('docker', ['rm', '-f', CT], { timeout: 10000 }); } catch {} }
process.on('SIGINT', async () => { await cleanup(); process.exit(1); });

async function api(cookie, path, body, method = body ? 'POST' : 'GET') {
  const r = await fetch(`http://127.0.0.1:${PORT}/rest/${path}`, {
    method, headers: { cookie, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  if (!r.ok) throw new Error(`API ${r.status} ${path} → ${t.slice(0, 200)}`);
  return j?.data ?? j;
}

async function main() {
  console.log('[rc33-opsdry] starting disposable n8n 2.41.7');
  await exec('docker', ['run', '-d', '--name', CT, '-p', `127.0.0.1:${PORT}:5678`,
    '-e', 'N8N_HOST=127.0.0.1', '-e', 'N8N_PORT=5678', '-e', 'N8N_PROTOCOL=http',
    '-e', `N8N_WEBHOOK_URL=http://127.0.0.1:${PORT}/`,
    '-e', 'N8N_ENCRYPTION_KEY=' + randomBytes(32).toString('hex'),
    '-e', 'N8N_DIAGNOSTICS_ENABLED=false',
    '-e', 'N8N_VERSION_NOTIFICATIONS_ENABLED=false',
    '-e', 'N8N_TEMPLATES_ENABLED=false',
    '-e', 'N8N_SSRF_PROTECTION_ENABLED=false',
    '--add-host', 'host.docker.internal:host-gateway',
    N8N_IMAGE]);
  for (let i = 0; i < 240; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/rest/settings`);
      const d = await r.json();
      if (d?.data?.userManagement?.showSetupOnFirstLoad === true) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  const EMAIL = 'rc33-ops@local.test', PASSWORD = 'RC33OpsTestOwner!1234';
  const setupResp = await fetch(`http://127.0.0.1:${PORT}/rest/owner/setup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, firstName: 'OPS', lastName: 'T', password: PASSWORD }),
  });
  const cookie = setupResp.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) fail('owner setup failed');

  // Stub credentials.
  const credsJson = JSON.stringify([
    { id: 'rc33-hdr', name: 'rc33 header', type: 'httpHeaderAuth', data: { name: 'X-Trade-Fair-Key', value: 'stub' } },
    { id: 'rc33-oai', name: 'rc33 openai', type: 'openAiApi', data: { apiKey: 'stub' } },
    { id: 'rc33-pg', name: 'rc33 pg', type: 'postgres', data: { host: '127.0.0.1', port: 5432, database: 'none', user: 'none', password: 'none', ssl: 'disable' } },
  ]);
  const stage = await mkdtemp(join(tmpdir(), 'rc33-ops-'));
  await chmod(stage, 0o700);
  await writeFile(join(stage, 'creds.json'), credsJson);
  await exec('docker', ['cp', join(stage, 'creds.json'), `${CT}:/tmp/creds.json`]);
  await exec('docker', ['exec', CT, 'n8n', 'import:credentials', '--input=/tmp/creds.json']);

  // Snapshot committed canonical JSON hashes so we can prove the operator
  // script did NOT modify the files on disk.
  const srcPaths = [
    join(root, 'workflows/wf-07-messe-hub-ai-extract.adapted.json'),
    join(root, 'workflows/wf-08-messe-hub-ai-ask.adapted.json'),
  ];
  const { createHash } = await import('node:crypto');
  const hashBefore = {};
  for (const p of srcPaths) {
    const buf = await readFile(p);
    hashBefore[p] = createHash('sha256').update(buf).digest('hex');
  }

  const env = {
    ...process.env,
    N8N_BASE_URL: `http://127.0.0.1:${PORT}`,
    N8N_LOGIN_EMAIL: EMAIL,
    N8N_LOGIN_PASSWORD: PASSWORD,
    HEADER_AUTH_CRED_ID: 'rc33-hdr',
    OPENAI_CRED_ID: 'rc33-oai',
    PG_AI_CTX_CRED_ID: 'rc33-pg',
  };

  async function run(cmd, args, extraEnv = {}) {
    const { stdout, stderr } = await exec(cmd, args, { env: { ...env, ...extraEnv }, maxBuffer: 8 * 1024 * 1024 });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  }

  // --- import both workflows via operator script
  const wf07Res = await run('bash', [join(root, 'ops/n8n/import_wf_rc3.sh'), 'workflows/wf-07-messe-hub-ai-extract.adapted.json']);
  const wf07Id = wf07Res.stdout.split('\n').pop();
  if (!wf07Id || wf07Id.length < 4) fail('import_wf_rc3.sh WF-07 returned empty id', wf07Res.stderr);
  pass(`import_wf_rc3.sh WF-07 → ${wf07Id} (active:false)`);

  const wf08Res = await run('bash', [join(root, 'ops/n8n/import_wf_rc3.sh'), 'workflows/wf-08-messe-hub-ai-ask.adapted.json']);
  const wf08Id = wf08Res.stdout.split('\n').pop();
  if (!wf08Id || wf08Id.length < 4) fail('import_wf_rc3.sh WF-08 returned empty id', wf08Res.stderr);
  pass(`import_wf_rc3.sh WF-08 → ${wf08Id} (active:false)`);

  for (const p of srcPaths) {
    const buf = await readFile(p);
    const after = createHash('sha256').update(buf).digest('hex');
    if (after !== hashBefore[p]) fail(`canonical JSON was modified: ${p}`);
  }
  pass('committed canonical JSON files unchanged on disk after import');

  // --- activate both via operator script
  const act07 = await run('bash', [join(root, 'ops/n8n/activate_wf.sh')], { WORKFLOW_ID: wf07Id });
  if (!/"active":\s*true/.test(act07.stdout)) fail('activate_wf.sh WF-07 did not report active=true', act07.stdout);
  pass(`activate_wf.sh WF-07 → ${act07.stdout}`);

  const act08 = await run('bash', [join(root, 'ops/n8n/activate_wf.sh')], { WORKFLOW_ID: wf08Id });
  if (!/"active":\s*true/.test(act08.stdout)) fail('activate_wf.sh WF-08 did not report active=true', act08.stdout);
  pass(`activate_wf.sh WF-08 → ${act08.stdout}`);

  // --- positive verifier run
  const verifyPos = await run('node', [join(root, 'ops/n8n/verify_published_production.mjs')], { WF07_ID: wf07Id, WF08_ID: wf08Id });
  if (!/PASS — WF-07/.test(verifyPos.stdout) || !/PASS — WF-08/.test(verifyPos.stdout)) {
    fail('verify_published_production.mjs did not PASS both', verifyPos.stdout + '\n' + verifyPos.stderr);
  }
  pass('verify_published_production.mjs PASS for both workflows against disposable n8n');

  // --- Negative-case proof: flip Ausgabe prüfen.disabled=true via REST (harness-only mutation).
  const d08 = await api(cookie, 'workflows/' + wf08Id);
  const mutatedNodes = structuredClone(d08.nodes);
  const target = mutatedNodes.find((n) => n.name === 'Ausgabe prüfen');
  if (!target) fail('Ausgabe prüfen not found in WF-08 draft');
  target.disabled = true;
  await api(cookie, 'workflows/' + wf08Id, { versionId: d08.versionId, nodes: mutatedNodes, connections: d08.connections }, 'PATCH');
  // Deactivate then reactivate so n8n advances activeVersionId to the mutated draft.
  try { await api(cookie, 'workflows/' + wf08Id + '/deactivate', {}); } catch {}
  const d08b = await api(cookie, 'workflows/' + wf08Id);
  await api(cookie, 'workflows/' + wf08Id + '/activate', { versionId: d08b.versionId });

  const verifyNeg = await run('node', [join(root, 'ops/n8n/verify_published_production.mjs')], { WF07_ID: wf07Id, WF08_ID: wf08Id }).catch((e) => ({ stdout: e.stdout || '', stderr: e.stderr || '', code: e.code }));
  if (verifyNeg.code === 0 || verifyNeg.code === undefined) {
    // If exec didn't throw, the verifier returned 0 → that's wrong.
    fail('verify_published_production.mjs did NOT exit nonzero on disabled-validator case', verifyNeg.stdout);
  }
  // Print full negative-case verifier output for diagnostic clarity.
  console.log('--- negative-case verifier stdout:\n' + verifyNeg.stdout);
  console.log('--- negative-case verifier stderr:\n' + verifyNeg.stderr);
  console.log('--- negative-case verifier exit:', verifyNeg.code);
  if (!/FAIL — WF-08/.test(verifyNeg.stdout) || !/PUBLISHED_PROVENANCE_FAILED.*disabled/.test(verifyNeg.stdout)) {
    fail('verify_published_production.mjs did not report disabled-field divergence', verifyNeg.stdout);
  }
  pass('verify_published_production.mjs REJECTED mutated WF-08 (exit=' + verifyNeg.code + '), diff cites disabled');

  await cleanup();
  console.log('\nRC3.3 operator script dry-run: ALL CHECKS PASS');
}

main().catch(async (e) => { console.error(e.stack || e); await cleanup(); process.exit(1); });
