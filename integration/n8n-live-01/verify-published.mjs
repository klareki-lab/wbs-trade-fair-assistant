// Published-version provenance check for the LIVE-01 finalizer.
// Fixes R2.1 (PR #27 independent review): the previous finalizer compared the
// returned workflow draft (`d.nodes`) to canonical source and only required
// `d.active` + nonempty `d.activeVersionId`. That accepts a canonical draft
// over an older active published version — a release-validation hole, because
// the webhook executes the published version, not the draft.
//
// Contract — fails CLOSED on any of:
//   • d.active !== true
//   • d.activeVersionId absent / empty
//   • d.versionId !== d.activeVersionId  (unpublished draft diverges from active)
//   • apiGetPublished(id, activeVersionId) throws / returns no graph
//   • published snapshot's non-ignored node parameters differ from canonical source
//   • published snapshot's connections differ from canonical source
//
// Allowed differences between canonical source and the published snapshot are
// restricted to EXPLICIT_METADATA (workflow identity) and credential-binding
// changes on each node's `credentials` map. Nothing else is permitted.
import assert from 'node:assert/strict';

const EXPLICIT_METADATA = new Set([
  'id', 'name', 'active', 'activeVersionId', 'versionId', 'triggerCount',
  'pinData', 'staticData', 'tags', 'meta', 'settings', 'createdAt', 'updatedAt',
  'isArchived', 'description', 'parentFolder', 'isHistoric',
  'homeProject', 'sharedWithProjects', 'scopes', 'resourcePolicyMode',
]);

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
  if (!publishedSnapshot || !Array.isArray(publishedSnapshot.nodes) || typeof publishedSnapshot.connections !== 'object') {
    throw new Error(`PUBLISHED_PROVENANCE_FAILED: workflow ${workflowId} published snapshot missing or malformed`);
  }
  if (publishedSnapshot.versionId && publishedSnapshot.versionId !== workflowFromApi.activeVersionId) {
    throw new Error(
      `PUBLISHED_PROVENANCE_FAILED: published snapshot versionId (${publishedSnapshot.versionId}) ` +
      `does not match workflow activeVersionId (${workflowFromApi.activeVersionId})`,
    );
  }

  // Node-by-node parameter equality against canonical source.
  const sourceNodes = source.nodes;
  const publishedNodes = publishedSnapshot.nodes;
  const want = new Map(sourceNodes.map((n) => [n.id, n]));
  const have = new Map(publishedNodes.map((n) => [n.id, n]));
  for (const [id, node] of want) {
    if (allowedNodeIds && !allowedNodeIds.has(id)) continue;
    const pub = have.get(id);
    if (!pub) {
      throw new Error(`PUBLISHED_PROVENANCE_FAILED: canonical node ${node.name} (${id}) missing in published snapshot`);
    }
    try {
      assert.deepEqual(pub.parameters, node.parameters);
    } catch (e) {
      throw new Error(
        `PUBLISHED_PROVENANCE_FAILED: published node ${node.name} parameters diverge from canonical.\n` +
        `  canonical: ${JSON.stringify(node.parameters).slice(0, 300)}\n` +
        `  published: ${JSON.stringify(pub.parameters).slice(0, 300)}`,
      );
    }
    try {
      assert.deepEqual(pub.type, node.type);
      assert.deepEqual(pub.typeVersion, node.typeVersion);
    } catch (e) {
      throw new Error(`PUBLISHED_PROVENANCE_FAILED: published node ${node.name} type/typeVersion diverges from canonical`);
    }
  }
  // Connection graph equality.
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
