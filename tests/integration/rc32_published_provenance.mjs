// RC3.2 R2.1 regression — the finalizer's published-provenance verifier must
// reject every state in which the published snapshot (what the webhook executes)
// diverges from canonical source, even when the API draft looks correct.
//
// Reproduces Codex's counterexample in-memory with synthetic workflow API
// responses so the full matrix runs without a live n8n container.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertCanonicalPublished, fetchPublishedSnapshot } from '../../integration/n8n-live-01/verify-published.mjs';

const root = new URL('../../', import.meta.url);
const canonical08 = JSON.parse(await readFile(new URL('workflows/wf-08-messe-hub-ai-ask.adapted.json', root), 'utf8'));
const canonical07 = JSON.parse(await readFile(new URL('workflows/wf-07-messe-hub-ai-extract.adapted.json', root), 'utf8'));

function makeApi(fromDraft, published, { activeVersionId, draftVersionId, active = true } = {}) {
  return {
    workflowFromApi: { ...fromDraft, active, activeVersionId: activeVersionId ?? 'pub-v1', versionId: draftVersionId ?? activeVersionId ?? 'pub-v1' },
    publishedSnapshot: published,
  };
}

// --- POSITIVE CASES ---

test('R2.1 pos: canonical published matches canonical source — accept', () => {
  const api = makeApi(canonical08, { ...canonical08, versionId: 'pub-v1' }, { activeVersionId: 'pub-v1', draftVersionId: 'pub-v1' });
  const r = assertCanonicalPublished({ source: canonical08, workflowFromApi: api.workflowFromApi, publishedSnapshot: api.publishedSnapshot, workflowId: 'live01-wf08' });
  assert.equal(r.ok, true);
  assert.equal(r.publishedVersionId, 'pub-v1');
});

test('R2.1 pos: WF-07 canonical published matches — accept', () => {
  const api = makeApi(canonical07, { ...canonical07, versionId: 'pub-v1' }, { activeVersionId: 'pub-v1', draftVersionId: 'pub-v1' });
  const r = assertCanonicalPublished({ source: canonical07, workflowFromApi: api.workflowFromApi, publishedSnapshot: api.publishedSnapshot, workflowId: 'live01-wf07' });
  assert.equal(r.ok, true);
});

test('R2.1 pos: credential-binding changes on each node are allowed; parameters still match', () => {
  const api = makeApi(canonical08, { ...canonical08, versionId: 'pub-v1' }, { activeVersionId: 'pub-v1', draftVersionId: 'pub-v1' });
  // Rebind credentials on a published node — verifier ignores credentials map.
  const draftLike = structuredClone(api.publishedSnapshot);
  for (const n of draftLike.nodes) if (n.credentials?.openAiApi) n.credentials.openAiApi = { id: 'live01-openai', name: 'LIVE01 Owner staging OpenAI' };
  const r = assertCanonicalPublished({ source: canonical08, workflowFromApi: api.workflowFromApi, publishedSnapshot: draftLike, workflowId: 'live01-wf08' });
  assert.equal(r.ok, true);
});

// --- NEGATIVE CASES — must throw PUBLISHED_PROVENANCE_FAILED ---

test('R2.1 neg: active=false — reject', () => {
  const api = makeApi(canonical08, { ...canonical08, versionId: 'pub-v1' }, { activeVersionId: 'pub-v1', draftVersionId: 'pub-v1', active: false });
  assert.throws(() => assertCanonicalPublished({ source: canonical08, workflowFromApi: api.workflowFromApi, publishedSnapshot: api.publishedSnapshot, workflowId: 'live01-wf08' }), /PUBLISHED_PROVENANCE_FAILED.*not active/);
});

test('R2.1 neg: activeVersionId empty — reject', () => {
  const api = makeApi(canonical08, { ...canonical08, versionId: 'pub-v1' }, { activeVersionId: '', draftVersionId: 'draft-v2' });
  assert.throws(() => assertCanonicalPublished({ source: canonical08, workflowFromApi: api.workflowFromApi, publishedSnapshot: api.publishedSnapshot, workflowId: 'live01-wf08' }), /PUBLISHED_PROVENANCE_FAILED.*activeVersionId/);
});

test('R2.1 neg: Codex counterexample — draft equals canonical but ACTIVE PUBLISHED is older RC3 code — reject', () => {
  // Codex's exact scenario: RC3.1 canonical sat as a Draft; n8n's webhook executed older RC3 published code.
  // n8n signals the divergence via versionId !== activeVersionId.
  const activeOld = { ...canonical08, nodes: structuredClone(canonical08.nodes), versionId: 'pub-v1-OLD-RC3' };
  // Swap the Ausgabe prüfen post-parser to the RC3 (pre-R1) implementation — missing warning path.
  const post = activeOld.nodes.find((n) => n.name === 'Ausgabe prüfen');
  post.parameters.jsCode = post.parameters.jsCode.replace(/\/\/ Completeness is distinct \*validated\*[\s\S]*?return \[\{json:\{success:true,answer,cited_lead_ids:\[\.\.\.new Set\(lines\.map\(c=>c\.lead_id\)\)\]\}\}\];/u,
    "const usable=result.unavailable?[]:verified;\nconst answer=usable.length ? usable.map(c=>`${c.lead_id}: ${labels[c.field]} = ${c.value ?? 'unbekannt'}`).join('\\n') : 'Dafür habe ich keine Daten im freigegebenen Kontext.';\nreturn [{json:{success:true,answer,cited_lead_ids:[...new Set(usable.map(c=>c.lead_id))]}}];");
  // Draft matches canonical; activeVersionId points at the older published snapshot.
  const workflowFromApi = { ...canonical08, active: true, activeVersionId: 'pub-v1-OLD-RC3', versionId: 'df295dcf-f791-4dd2-ab5e-c0f0efc00513' };
  assert.throws(() => assertCanonicalPublished({ source: canonical08, workflowFromApi, publishedSnapshot: activeOld, workflowId: 'live01-wf08' }),
    /PUBLISHED_PROVENANCE_FAILED/,
    'Finalizer must reject the Codex counterexample before any export or manifest write');
});

test('R2.1 neg: versionId !== activeVersionId alone — reject (unpublished draft present)', () => {
  // Even if a snapshot were accidentally equal to canonical, the version mismatch alone is a hard reject
  // because the webhook router executes activeVersionId, which may change without the draft changing.
  const workflowFromApi = { ...canonical08, active: true, activeVersionId: 'pub-v1', versionId: 'draft-v2' };
  assert.throws(() => assertCanonicalPublished({ source: canonical08, workflowFromApi, publishedSnapshot: { ...canonical08, versionId: 'pub-v1' }, workflowId: 'live01-wf08' }),
    /PUBLISHED_PROVENANCE_FAILED.*versionId.*activeVersionId/);
});

test('R2.1 neg: published snapshot missing/malformed — reject', () => {
  const workflowFromApi = { ...canonical08, active: true, activeVersionId: 'pub-v1', versionId: 'pub-v1' };
  assert.throws(() => assertCanonicalPublished({ source: canonical08, workflowFromApi, publishedSnapshot: null, workflowId: 'live01-wf08' }), /PUBLISHED_PROVENANCE_FAILED/);
  assert.throws(() => assertCanonicalPublished({ source: canonical08, workflowFromApi, publishedSnapshot: { nodes: null, connections: {} }, workflowId: 'live01-wf08' }), /PUBLISHED_PROVENANCE_FAILED/);
});

test('R2.1 neg: published node parameter differs from canonical — reject', () => {
  const tampered = structuredClone(canonical08);
  const post = tampered.nodes.find((n) => n.name === 'Ausgabe prüfen');
  post.parameters.jsCode = 'return [{json:{tampered:true}}];';
  const workflowFromApi = { ...canonical08, active: true, activeVersionId: 'pub-v1', versionId: 'pub-v1' };
  assert.throws(() => assertCanonicalPublished({ source: canonical08, workflowFromApi, publishedSnapshot: { ...tampered, versionId: 'pub-v1' }, workflowId: 'live01-wf08' }),
    /PUBLISHED_PROVENANCE_FAILED.*parameters diverge/);
});

test('R2.1 neg: connection graph differs from canonical — reject', () => {
  const tampered = structuredClone(canonical08);
  // Remove a connection.
  const firstKey = Object.keys(tampered.connections)[0];
  delete tampered.connections[firstKey];
  const workflowFromApi = { ...canonical08, active: true, activeVersionId: 'pub-v1', versionId: 'pub-v1' };
  assert.throws(() => assertCanonicalPublished({ source: canonical08, workflowFromApi, publishedSnapshot: { ...tampered, versionId: 'pub-v1' }, workflowId: 'live01-wf08' }),
    /PUBLISHED_PROVENANCE_FAILED.*connections diverge/);
});

test('R2.1 neg: published snapshot versionId mismatches activeVersionId — reject', () => {
  const workflowFromApi = { ...canonical08, active: true, activeVersionId: 'pub-v1', versionId: 'pub-v1' };
  const stale = { ...canonical08, versionId: 'other-version-id' };
  assert.throws(() => assertCanonicalPublished({ source: canonical08, workflowFromApi, publishedSnapshot: stale, workflowId: 'live01-wf08' }),
    /PUBLISHED_PROVENANCE_FAILED.*snapshot versionId.*activeVersionId/);
});

test('R2.1 neg: fetchPublishedSnapshot — all endpoints fail → fail closed', async () => {
  const api = async () => { throw new Error('404'); };
  await assert.rejects(() => fetchPublishedSnapshot(api, 'live01-wf08', 'pub-v1'),
    /PUBLISHED_PROVENANCE_FAILED.*no published-snapshot endpoint/);
});

test('R2.1 pos: fetchPublishedSnapshot — first endpoint succeeds', async () => {
  const api = async (p) => { if (p.startsWith('workflow-history/workflow/')) return { nodes: canonical08.nodes, connections: canonical08.connections, versionId: 'pub-v1' }; throw new Error('404'); };
  const r = await fetchPublishedSnapshot(api, 'live01-wf08', 'pub-v1');
  assert.equal(r.versionId, 'pub-v1');
  assert.equal(Array.isArray(r.nodes), true);
});
