#!/usr/bin/env node
// RC3.3 production provenance verifier — READ-ONLY.
//
// Audit guarantee: this script issues exactly one write (POST /rest/login)
// to open a session cookie. Every other HTTP method used is GET. It never
// PATCHes workflow settings, never calls /activate or /deactivate, never
// writes any file. Grep the source for '`method:' + 'POST'' and '`method:' +
// 'PATCH'' — only the login line matches.
//
// Reads canonical WF-07/08 JSON from the repository, logs into the given
// n8n instance via /rest/login, fetches each workflow + its published
// workflow-history snapshot, and runs the RC3.3 verifier
// (verify-published.mjs) against both. Exits 0 iff BOTH workflows pass.
//
// Required env (never log their values):
//   N8N_BASE_URL         e.g. http://127.0.0.1:5678  (or https://… for remote)
//   N8N_LOGIN_EMAIL      Owner-approved n8n login
//   N8N_LOGIN_PASSWORD   Owner-approved n8n password
//   WF07_ID              production workflow id for WF-07
//   WF08_ID              production workflow id for WF-08
//
// Example:
//   N8N_BASE_URL=http://127.0.0.1:5678 \
//   N8N_LOGIN_EMAIL=<owner-email> N8N_LOGIN_PASSWORD='<owner-password>' \
//   WF07_ID=<id> WF08_ID=<id> \
//     node ops/n8n/verify_published_production.mjs
//
// This script is the production-safe replacement for the isolated
// finalize.mjs when all you need is provenance verification. finalize.mjs
// does PATCH /rest/workflows/:id to normalize retention settings and
// therefore MUST NOT be invoked as a production read-only verifier.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { assertCanonicalPublished, fetchPublishedSnapshot } from '../../integration/n8n-live-01/verify-published.mjs';

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !v.length) {
    console.error(`FAIL — required env ${name} is empty`);
    process.exit(2);
  }
  return v;
}

const BASE = requireEnv('N8N_BASE_URL').replace(/\/+$/, '');
const EMAIL = requireEnv('N8N_LOGIN_EMAIL');
const PASSWORD = requireEnv('N8N_LOGIN_PASSWORD');
const WF07_ID = requireEnv('WF07_ID');
const WF08_ID = requireEnv('WF08_ID');

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../..');

async function login() {
  // The ONLY non-GET call this script performs.
  // n8n 2.41.7 throttles /rest/login (HTTP 429 after a few back-to-back
  // attempts). Retry with exponential backoff so a legitimate operator
  // re-run after a prior failed attempt still succeeds.
  const delays = [0, 3000, 10000, 30000, 60000];
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]));
    const r = await fetch(`${BASE}/rest/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailOrLdapLoginId: EMAIL, password: PASSWORD }),
    });
    if (r.ok) {
      const cookieHeader = r.headers.getSetCookie();
      const cookie = (cookieHeader && cookieHeader.length ? cookieHeader.map((x) => x.split(';')[0]).join('; ') : '');
      if (!cookie) {
        console.error('FAIL — /rest/login returned no session cookie');
        process.exit(2);
      }
      return cookie;
    }
    if (r.status !== 429) {
      console.error(`FAIL — /rest/login HTTP ${r.status}`);
      process.exit(2);
    }
    // 429: silently retry on next loop iteration.
  }
  console.error('FAIL — /rest/login HTTP 429 after retries exhausted');
  process.exit(2);
}

function makeGet(cookie) {
  return async function get(path) {
    const r = await fetch(`${BASE}/rest/${path}`, {
      method: 'GET',
      headers: { cookie, 'Content-Type': 'application/json' },
    });
    if (!r.ok) {
      const err = new Error(`GET ${path} → HTTP ${r.status}`);
      err.status = r.status;
      throw err;
    }
    const body = await r.json();
    return body?.data ?? body;
  };
}

async function verifyOne(get, workflowId, canonicalPath, label) {
  const source = JSON.parse(await readFile(resolve(repoRoot, canonicalPath), 'utf8'));
  const workflowFromApi = await get(`workflows/${workflowId}`);
  if (!workflowFromApi?.activeVersionId) {
    throw new Error(`PUBLISHED_PROVENANCE_FAILED: ${label} has no activeVersionId`);
  }
  const publishedSnapshot = await fetchPublishedSnapshot(get, workflowId, workflowFromApi.activeVersionId);
  const result = assertCanonicalPublished({
    source,
    workflowFromApi,
    publishedSnapshot,
    workflowId,
  });
  // Advisory read-only checks on retention (do NOT patch — only report).
  const r = workflowFromApi.settings || {};
  const retentionWarnings = [];
  if (r.saveDataErrorExecution !== 'none') retentionWarnings.push(`settings.saveDataErrorExecution=${r.saveDataErrorExecution}`);
  if (r.saveDataSuccessExecution !== 'none') retentionWarnings.push(`settings.saveDataSuccessExecution=${r.saveDataSuccessExecution}`);
  if (r.saveManualExecutions !== false) retentionWarnings.push(`settings.saveManualExecutions=${r.saveManualExecutions}`);
  if (r.saveExecutionProgress !== false) retentionWarnings.push(`settings.saveExecutionProgress=${r.saveExecutionProgress}`);
  return {
    workflowId,
    label,
    active: workflowFromApi.active,
    publishedVersionId: result.publishedVersionId,
    draftVersionId: workflowFromApi.versionId,
    executionTimeout: r.executionTimeout ?? null,
    retentionWarnings,
  };
}

async function main() {
  console.log(`[rc33-verify] base=${BASE}`);
  const cookie = await login();
  const get = makeGet(cookie);
  const results = [];
  let anyFail = false;
  for (const spec of [
    { id: WF07_ID, path: 'workflows/wf-07-messe-hub-ai-extract.adapted.json', label: 'WF-07' },
    { id: WF08_ID, path: 'workflows/wf-08-messe-hub-ai-ask.adapted.json', label: 'WF-08' },
  ]) {
    try {
      const r = await verifyOne(get, spec.id, spec.path, spec.label);
      results.push({ ...r, verdict: 'PASS' });
      console.log(`PASS — ${spec.label} published provenance OK (publishedVersionId=${r.publishedVersionId})`);
      if (r.retentionWarnings.length) {
        console.log(`WARN — ${spec.label} retention not fully silenced: ${r.retentionWarnings.join(', ')}`);
      }
    } catch (e) {
      anyFail = true;
      results.push({ workflowId: spec.id, label: spec.label, verdict: 'FAIL', error: String(e.message || e).slice(0, 400) });
      console.log(`FAIL — ${spec.label}: ${String(e.message || e).slice(0, 400)}`);
    }
  }
  console.log(JSON.stringify({ base: BASE, results }, null, 2));
  process.exit(anyFail ? 1 : 0);
}

main().catch((e) => { console.error('FATAL —', e.stack || e); process.exit(2); });
