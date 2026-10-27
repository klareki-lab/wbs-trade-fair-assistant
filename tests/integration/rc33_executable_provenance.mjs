// RC3.3 R2.1b regression — the finalizer's published-provenance verifier must
// fingerprint EVERY executable node field, not just parameters/type/connections.
// Reproduces the Codex counterexample where a published Code node carries
// `disabled: true`: pre-RC3.3, `parameters` were still byte-equal to canonical
// so the verifier accepted it, but the Code node never executed and the
// grounding gate was silently bypassed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertCanonicalPublished, _internals } from '../../integration/n8n-live-01/verify-published.mjs';

const root = new URL('../../', import.meta.url);
const canonical08 = JSON.parse(await readFile(new URL('workflows/wf-08-messe-hub-ai-ask.adapted.json', root), 'utf8'));
const canonical07 = JSON.parse(await readFile(new URL('workflows/wf-07-messe-hub-ai-extract.adapted.json', root), 'utf8'));

const makeApi = (source, versionId = 'pub-v1') => ({
  workflowFromApi: { ...source, active: true, activeVersionId: versionId, versionId },
  publishedSnapshot: { ...source, versionId },
});

// --- POSITIVES ---

test('R2.1b pos: canonical WF-08 published → accept', () => {
  const { workflowFromApi, publishedSnapshot } = makeApi(canonical08);
  const r = assertCanonicalPublished({ source: canonical08, workflowFromApi, publishedSnapshot, workflowId: 'live01-wf08' });
  assert.equal(r.ok, true);
});

test('R2.1b pos: canonical WF-07 published → accept', () => {
  const { workflowFromApi, publishedSnapshot } = makeApi(canonical07);
  const r = assertCanonicalPublished({ source: canonical07, workflowFromApi, publishedSnapshot, workflowId: 'live01-wf07' });
  assert.equal(r.ok, true);
});

test('R2.1b pos: n8n materialises execution-flag defaults → accept (normaliser hides boring defaults)', () => {
  const materialised = structuredClone(canonical08);
  // n8n often returns `disabled:false, executeOnce:false, alwaysOutputData:false,
  // retryOnFail:false, continueOnFail:false, onError:'stopWorkflow'` even when
  // canonical source omits them. The normaliser must consider these equal.
  for (const n of materialised.nodes) {
    n.disabled = false;
    n.executeOnce = false;
    n.alwaysOutputData = false;
    n.retryOnFail = false;
    n.continueOnFail = false;
    n.onError = 'stopWorkflow';
  }
  const api = { ...canonical08, active: true, activeVersionId: 'pub-v1', versionId: 'pub-v1' };
  const r = assertCanonicalPublished({ source: canonical08, workflowFromApi: api, publishedSnapshot: { ...materialised, versionId: 'pub-v1' }, workflowId: 'live01-wf08' });
  assert.equal(r.ok, true);
});

test('R2.1b pos: credential rebinding is allowed; executable fingerprint unchanged', () => {
  const published = structuredClone(canonical08);
  for (const n of published.nodes) if (n.credentials?.openAiApi) n.credentials.openAiApi = { id: 'rotated', name: 'Rotated OpenAI' };
  const api = { ...canonical08, active: true, activeVersionId: 'pub-v1', versionId: 'pub-v1' };
  const r = assertCanonicalPublished({ source: canonical08, workflowFromApi: api, publishedSnapshot: { ...published, versionId: 'pub-v1' }, workflowId: 'live01-wf08' });
  assert.equal(r.ok, true);
});

test('R2.1b pos: position / notes / webhookId / notesInFlow differ → still accept (metadata only)', () => {
  const published = structuredClone(canonical08);
  for (const n of published.nodes) {
    if (Array.isArray(n.position)) n.position = [n.position[0] + 500, n.position[1] - 220];
    n.notes = 'operator scratch note — must not affect provenance';
    n.notesInFlow = true;
    if (n.type === 'n8n-nodes-base.webhook') n.webhookId = '00000000-rotated-webhook-id';
  }
  const api = { ...canonical08, active: true, activeVersionId: 'pub-v1', versionId: 'pub-v1' };
  const r = assertCanonicalPublished({ source: canonical08, workflowFromApi: api, publishedSnapshot: { ...published, versionId: 'pub-v1' }, workflowId: 'live01-wf08' });
  assert.equal(r.ok, true);
});

// --- NEGATIVES: single execution-affecting flag mutations ---

function tamper(nodeName, mutate) {
  const published = structuredClone(canonical08);
  mutate(published.nodes.find((n) => n.name === nodeName));
  const api = { ...canonical08, active: true, activeVersionId: 'pub-v1', versionId: 'pub-v1' };
  return { workflowFromApi: api, publishedSnapshot: { ...published, versionId: 'pub-v1' } };
}

test('R2.1b neg: Ausgabe prüfen.disabled=true → REJECT (Codex blocker counterexample)', () => {
  const api = tamper('Ausgabe prüfen', (n) => { n.disabled = true; });
  assert.throws(
    () => assertCanonicalPublished({ source: canonical08, ...api, workflowId: 'live01-wf08' }),
    /PUBLISHED_PROVENANCE_FAILED.*(fingerprint diverges|disabled)/,
    'disabling the grounding gate must trigger PUBLISHED_PROVENANCE_FAILED',
  );
});

test('R2.1b neg: executeOnce=true on Assistent → REJECT', () => {
  const api = tamper('Assistent', (n) => { n.executeOnce = true; });
  assert.throws(() => assertCanonicalPublished({ source: canonical08, ...api, workflowId: 'live01-wf08' }), /PUBLISHED_PROVENANCE_FAILED.*executeOnce/);
});

test('R2.1b neg: alwaysOutputData=true on Ausgabe prüfen → REJECT', () => {
  const api = tamper('Ausgabe prüfen', (n) => { n.alwaysOutputData = true; });
  assert.throws(() => assertCanonicalPublished({ source: canonical08, ...api, workflowId: 'live01-wf08' }), /PUBLISHED_PROVENANCE_FAILED.*alwaysOutputData/);
});

test('R2.1b neg: retryOnFail=true (with default maxTries) on Assistent → REJECT', () => {
  const api = tamper('Assistent', (n) => { n.retryOnFail = true; n.maxTries = 5; n.waitBetweenTries = 2000; });
  assert.throws(() => assertCanonicalPublished({ source: canonical08, ...api, workflowId: 'live01-wf08' }), /PUBLISHED_PROVENANCE_FAILED.*retryOnFail/);
});

test('R2.1b neg: onError=continueRegularOutput on Ausgabe prüfen → REJECT (would swallow grounding failures)', () => {
  const api = tamper('Ausgabe prüfen', (n) => { n.onError = 'continueRegularOutput'; });
  assert.throws(() => assertCanonicalPublished({ source: canonical08, ...api, workflowId: 'live01-wf08' }), /PUBLISHED_PROVENANCE_FAILED.*onError/);
});

test('R2.1b neg: legacy continueOnFail=true on Ausgabe prüfen → REJECT (even without onError set)', () => {
  const api = tamper('Ausgabe prüfen', (n) => { n.continueOnFail = true; });
  assert.throws(() => assertCanonicalPublished({ source: canonical08, ...api, workflowId: 'live01-wf08' }), /PUBLISHED_PROVENANCE_FAILED.*(continueOnFail|onError)/);
});

test('R2.1b neg: node name changed → REJECT (identity divergence)', () => {
  const api = tamper('Ausgabe prüfen', (n) => { n.name = 'Ausgabe prüfen (BYPASS)'; });
  assert.throws(() => assertCanonicalPublished({ source: canonical08, ...api, workflowId: 'live01-wf08' }), /PUBLISHED_PROVENANCE_FAILED.*name/);
});

test('R2.1b neg: typeVersion bumped → REJECT', () => {
  const api = tamper('Assistent', (n) => { n.typeVersion = (n.typeVersion ?? 1) + 1; });
  assert.throws(() => assertCanonicalPublished({ source: canonical08, ...api, workflowId: 'live01-wf08' }), /PUBLISHED_PROVENANCE_FAILED.*typeVersion/);
});

test('R2.1b neg: parameter mutation still rejected (RC3.2 behaviour preserved)', () => {
  const api = tamper('Ausgabe prüfen', (n) => { n.parameters.jsCode = 'return [{json:{tampered:true}}];'; });
  assert.throws(() => assertCanonicalPublished({ source: canonical08, ...api, workflowId: 'live01-wf08' }), /PUBLISHED_PROVENANCE_FAILED.*parameters diverge/);
});

test('R2.1b neg: extra node injected into published snapshot → REJECT', () => {
  const published = structuredClone(canonical08);
  published.nodes.push({ id: 'inj-01', name: 'Injected Exfil', type: 'n8n-nodes-base.httpRequest', typeVersion: 4, parameters: {}, position: [0, 0] });
  const api = { ...canonical08, active: true, activeVersionId: 'pub-v1', versionId: 'pub-v1' };
  assert.throws(
    () => assertCanonicalPublished({ source: canonical08, workflowFromApi: api, publishedSnapshot: { ...published, versionId: 'pub-v1' }, workflowId: 'live01-wf08' }),
    /PUBLISHED_PROVENANCE_FAILED.*(not present in canonical|Injected Exfil)/,
  );
});

test('R2.1b neg: unknown node property on published side → REJECT (fail-closed against new n8n fields)', () => {
  const published = structuredClone(canonical08);
  const target = published.nodes.find((n) => n.name === 'Ausgabe prüfen');
  target.executeConcurrently = true; // hypothetical future n8n field
  const api = { ...canonical08, active: true, activeVersionId: 'pub-v1', versionId: 'pub-v1' };
  assert.throws(
    () => assertCanonicalPublished({ source: canonical08, workflowFromApi: api, publishedSnapshot: { ...published, versionId: 'pub-v1' }, workflowId: 'live01-wf08' }),
    /PUBLISHED_PROVENANCE_FAILED.*(unknown property|executeConcurrently)/,
  );
});

test('R2.1b neg: connection graph change (even executable fingerprints equal) → REJECT', () => {
  const published = structuredClone(canonical08);
  const firstKey = Object.keys(published.connections)[0];
  delete published.connections[firstKey];
  const api = { ...canonical08, active: true, activeVersionId: 'pub-v1', versionId: 'pub-v1' };
  assert.throws(
    () => assertCanonicalPublished({ source: canonical08, workflowFromApi: api, publishedSnapshot: { ...published, versionId: 'pub-v1' }, workflowId: 'live01-wf08' }),
    /PUBLISHED_PROVENANCE_FAILED.*connections diverge/,
  );
});

test('R2.1b neg: canonical draft over older active published version (versionId !== activeVersionId) → REJECT (regression carry from RC3.2)', () => {
  const workflowFromApi = { ...canonical08, active: true, activeVersionId: 'pub-v1-OLD', versionId: 'canonical-draft-v2' };
  const olderPublished = structuredClone(canonical08);
  const post = olderPublished.nodes.find((n) => n.name === 'Ausgabe prüfen');
  post.disabled = true; // older published silently disabled the gate
  olderPublished.versionId = 'pub-v1-OLD';
  assert.throws(
    () => assertCanonicalPublished({ source: canonical08, workflowFromApi, publishedSnapshot: olderPublished, workflowId: 'live01-wf08' }),
    /PUBLISHED_PROVENANCE_FAILED.*(versionId|activeVersionId)/,
  );
});

// --- White-box normaliser checks ---

test('R2.1b norm: continueOnFail:true is treated as onError=continueRegularOutput (behavioural equivalence)', () => {
  const a = _internals.normaliseExecutable({ id: 'n', name: 'n', type: 't', typeVersion: 1, parameters: {}, continueOnFail: true });
  const b = _internals.normaliseExecutable({ id: 'n', name: 'n', type: 't', typeVersion: 1, parameters: {}, onError: 'continueRegularOutput', continueOnFail: true });
  assert.deepEqual(a, b);
});

test('R2.1b norm: retry sub-fields are zeroed when retryOnFail=false (prevents smuggling)', () => {
  const a = _internals.normaliseExecutable({ id: 'n', name: 'n', type: 't', typeVersion: 1, parameters: {}, retryOnFail: false, maxTries: 99, waitBetweenTries: 99999 });
  assert.equal(a.maxTries, 0);
  assert.equal(a.waitBetweenTries, 0);
});

test('R2.1b norm: unknown node property throws classifiable error', () => {
  assert.throws(
    () => _internals.normaliseExecutable({ id: 'n', name: 'n', type: 't', typeVersion: 1, parameters: {}, mysteryBehaviouralFlag: true }),
    /UNKNOWN_NODE_FIELD:mysteryBehaviouralFlag/,
  );
});
