// Published-version provenance check for the LIVE-01 finalizer.
//
// RC3.3 (R2.1b): fingerprint the COMPLETE executable definition of every node
// against raw canonical source. The RC3.2 check compared only
// `parameters`+`type`+`typeVersion`+`connections`, which left execution-affecting
// node flags (`disabled`, `executeOnce`, `alwaysOutputData`, retry settings,
// `onError`, legacy `continueOnFail`) unverified: a published workflow with
// `Ausgabe prüfen.disabled=true` would silently pass because the Code node
// never runs, letting ungrounded model output reach the gateway unfiltered.
//
// Contract — fails CLOSED on any of:
//   • workflowFromApi.active !== true
//   • workflowFromApi.activeVersionId absent / empty
//   • workflowFromApi.versionId !== workflowFromApi.activeVersionId
//     (unpublished draft present — webhook executes older published code)
//   • publishedSnapshot missing or malformed
//   • publishedSnapshot.versionId !== workflowFromApi.activeVersionId
//   • published nodes set ≠ canonical nodes set (by id)
//   • for any canonical node, its normalised executable fingerprint
//     ≠ published node's normalised executable fingerprint
//   • publishedSnapshot.connections ≠ source.connections
//
// Fields in the EXECUTABLE fingerprint (compared, with 2.41.7 defaults
// normalised on both sides so a canonical source that omits a default is
// equal to a published snapshot that materialises it):
//   id, name, type, typeVersion, parameters, disabled, executeOnce,
//   alwaysOutputData, retryOnFail, maxTries, waitBetweenTries,
//   continueOnFail, onError
//
// Fields explicitly IGNORED (metadata only, never affect execution):
//   position, notes, notesInFlow, credentials (binding may rotate),
//   webhookId (identity, not behaviour), disabledEdges (per-connection UI)
//
// Any node property we have NOT classified above is a hard reject. This
// keeps the verifier fail-closed against new n8n fields that may silently
// change behaviour; a future n8n minor version adding e.g. `executeConcurrently`
// will trip the "unknown property" rule and force an explicit RC bump.
import assert from 'node:assert/strict';

const EXPLICIT_METADATA = new Set([
  'id', 'name', 'active', 'activeVersionId', 'versionId', 'triggerCount',
  'pinData', 'staticData', 'tags', 'meta', 'settings', 'createdAt', 'updatedAt',
  'isArchived', 'description', 'parentFolder', 'isHistoric',
  'homeProject', 'sharedWithProjects', 'scopes', 'resourcePolicyMode',
]);

// Node-level: declare every property we classify. Unknown ones fail closed.
const EXECUTABLE_NODE_FIELDS = new Set([
  'id', 'name', 'type', 'typeVersion', 'parameters',
  'disabled', 'executeOnce', 'alwaysOutputData',
  'retryOnFail', 'maxTries', 'waitBetweenTries',
  'continueOnFail', 'onError',
]);
const IGNORED_NODE_FIELDS = new Set([
  'position', 'notes', 'notesInFlow', 'credentials', 'webhookId',
  'disabledEdges',
]);

// n8n 2.41.7 node defaults — applied on BOTH sides so canonical sources that
// omit a flag compare equal to published snapshots that materialise it.
function normaliseExecutable(node) {
  if (!node || typeof node !== 'object') {
    throw new Error('normaliseExecutable: non-object node');
  }
  const unknown = Object.keys(node).filter(
    (k) => !EXECUTABLE_NODE_FIELDS.has(k) && !IGNORED_NODE_FIELDS.has(k),
  );
  if (unknown.length) {
    const err = new Error(
      `UNKNOWN_NODE_FIELD:${unknown.join(',')} on node ${node.name ?? node.id}`,
    );
    err.unknown = unknown;
    throw err;
  }
  const retryOnFail = node.retryOnFail === true;
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    typeVersion: node.typeVersion,
    parameters: node.parameters ?? {},
    disabled: node.disabled === true,
    executeOnce: node.executeOnce === true,
    alwaysOutputData: node.alwaysOutputData === true,
    retryOnFail,
    // Retry sub-fields only matter when retryOnFail is true; otherwise 0 so
    // a published snapshot cannot smuggle different values past the check.
    maxTries: retryOnFail ? (node.maxTries ?? 3) : 0,
    waitBetweenTries: retryOnFail ? (node.waitBetweenTries ?? 1000) : 0,
    // continueOnFail is deprecated in n8n 2.x in favour of onError but is
    // still honoured when present. Normalise both so either representation
    // of the same behaviour compares equal.
    continueOnFail: node.continueOnFail === true,
    onError: node.onError ?? (node.continueOnFail === true ? 'continueRegularOutput' : 'stopWorkflow'),
  };
}

export function assertCanonicalPublished(
  { source, workflowFromApi, publishedSnapshot, workflowId },
  { allowedNodeIds = null } = {},
) {
  if (!workflowFromApi || typeof workflowFromApi !== 'object') {
    throw new Error(`PUBLISHED_PROVENANCE_FAILED: workflow ${workflowId} API response empty`);
  }
  if (workflowFromApi.active !== true) {
    throw new Error(`PUBLISHED_PROVENANCE_FAILED: workflow ${workflowId} is not active`);
  }
  if (!workflowFromApi.activeVersionId || typeof workflowFromApi.activeVersionId !== 'string') {
    throw new Error(`PUBLISHED_PROVENANCE_FAILED: workflow ${workflowId} has no activeVersionId`);
  }
  if (workflowFromApi.versionId !== workflowFromApi.activeVersionId) {
    throw new Error(
      `PUBLISHED_PROVENANCE_FAILED: workflow ${workflowId} draft versionId (${workflowFromApi.versionId}) ` +
      `does not equal activeVersionId (${workflowFromApi.activeVersionId}); unpublished draft present — webhook executes older published code.`,
    );
  }
  if (!publishedSnapshot || !Array.isArray(publishedSnapshot.nodes) || typeof publishedSnapshot.connections !== 'object' || publishedSnapshot.connections === null) {
    throw new Error(`PUBLISHED_PROVENANCE_FAILED: workflow ${workflowId} published snapshot missing or malformed`);
  }
  if (publishedSnapshot.versionId && publishedSnapshot.versionId !== workflowFromApi.activeVersionId) {
    throw new Error(
      `PUBLISHED_PROVENANCE_FAILED: published snapshot versionId (${publishedSnapshot.versionId}) ` +
      `does not match workflow activeVersionId (${workflowFromApi.activeVersionId})`,
    );
  }

  const sourceNodes = source.nodes;
  const publishedNodes = publishedSnapshot.nodes;
  const want = new Map(sourceNodes.map((n) => [n.id, n]));
  const have = new Map(publishedNodes.map((n) => [n.id, n]));

  // Identity: canonical and published node ID sets must match exactly
  // (unless an allowlist narrows the comparison — used by non-canonical fixtures).
  if (!allowedNodeIds) {
    for (const id of have.keys()) {
      if (!want.has(id)) {
        const extra = have.get(id);
        throw new Error(
          `PUBLISHED_PROVENANCE_FAILED: published snapshot contains node ${extra?.name ?? id} ` +
          `(${id}) not present in canonical source`,
        );
      }
    }
  }

  for (const [id, node] of want) {
    if (allowedNodeIds && !allowedNodeIds.has(id)) continue;
    const pub = have.get(id);
    if (!pub) {
      throw new Error(`PUBLISHED_PROVENANCE_FAILED: canonical node ${node.name} (${id}) missing in published snapshot`);
    }
    let canonicalFingerprint;
    let publishedFingerprint;
    try {
      canonicalFingerprint = normaliseExecutable(node);
    } catch (e) {
      if (e.unknown) {
        throw new Error(
          `PUBLISHED_PROVENANCE_FAILED: canonical node ${node.name} (${id}) carries unknown property/properties ` +
          `[${e.unknown.join(',')}] — classify in EXECUTABLE_NODE_FIELDS or IGNORED_NODE_FIELDS before accepting`,
        );
      }
      throw e;
    }
    try {
      publishedFingerprint = normaliseExecutable(pub);
    } catch (e) {
      if (e.unknown) {
        throw new Error(
          `PUBLISHED_PROVENANCE_FAILED: published node ${pub.name} (${id}) carries unknown property/properties ` +
          `[${e.unknown.join(',')}] — n8n may have introduced an execution-affecting field; verifier is fail-closed until classified`,
        );
      }
      throw e;
    }
    try {
      assert.deepEqual(publishedFingerprint, canonicalFingerprint);
    } catch (e) {
      // Produce a focused diff for operator triage without dumping full params.
      const diff = {};
      for (const k of Object.keys(canonicalFingerprint)) {
        const a = JSON.stringify(canonicalFingerprint[k]);
        const b = JSON.stringify(publishedFingerprint[k]);
        if (a !== b) {
          diff[k] = { canonical: canonicalFingerprint[k], published: publishedFingerprint[k] };
        }
      }
      const changedKeys = Object.keys(diff);
      // Preserve the "parameters diverge" phrase so existing R2.1 regression tests still match.
      const msg = changedKeys.length === 1 && changedKeys[0] === 'parameters'
        ? `PUBLISHED_PROVENANCE_FAILED: published node ${node.name} parameters diverge from canonical.\n` +
          `  canonical: ${JSON.stringify(canonicalFingerprint.parameters).slice(0, 300)}\n` +
          `  published: ${JSON.stringify(publishedFingerprint.parameters).slice(0, 300)}`
        : `PUBLISHED_PROVENANCE_FAILED: published node ${node.name} executable fingerprint diverges from canonical ` +
          `(fields: ${changedKeys.join(',')}).\n  diff: ${JSON.stringify(diff).slice(0, 500)}`;
      throw new Error(msg);
    }
  }

  try {
    assert.deepEqual(publishedSnapshot.connections, source.connections);
  } catch (e) {
    throw new Error(`PUBLISHED_PROVENANCE_FAILED: published connections diverge from canonical`);
  }
  return { ok: true, publishedVersionId: workflowFromApi.activeVersionId };
}

// Helper: given an api(path) function (as finalize.mjs uses), fetch the
// published snapshot for a given workflow + versionId. Tries n8n 2.41.7's
// workflow-history endpoints; if neither path is served, the caller must
// treat that as PUBLISHED_PROVENANCE_FAILED (fail closed).
export async function fetchPublishedSnapshot(api, workflowId, versionId) {
  const paths = [
    `workflow-history/workflow/${workflowId}/version/${versionId}`,
    `workflow-history/${workflowId}/version/${versionId}`,
    `workflows/${workflowId}/versions/${versionId}`,
  ];
  for (const p of paths) {
    try {
      const r = await api(p);
      if (r && Array.isArray(r.nodes) && typeof r.connections === 'object') return r;
      if (r?.workflow && Array.isArray(r.workflow.nodes)) return r.workflow;
    } catch { /* try next */ }
  }
  throw new Error(`PUBLISHED_PROVENANCE_FAILED: no published-snapshot endpoint responded for ${workflowId} v=${versionId}`);
}

// Exported for white-box regression testing. Not intended for callers.
export const _internals = { normaliseExecutable, EXECUTABLE_NODE_FIELDS, IGNORED_NODE_FIELDS };
