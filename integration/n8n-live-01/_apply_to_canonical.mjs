// RC3: apply Codex's integration-only adaptations directly to the canonical
// workflows/wf-07-messe-hub-ai-extract.adapted.json and
// workflows/wf-08-messe-hub-ai-ask.adapted.json so that a UI import of the
// committed JSON matches what the LIVE-01 isolated run produces. The transform
// logic is lifted verbatim from integration/n8n-live-01/adapt-workflows.mjs.
import { readFile, writeFile } from 'node:fs/promises';
import { adaptWorkflow } from './adapt-workflows.mjs';

const root = new URL('../../', import.meta.url);
const paths = [
  'workflows/wf-07-messe-hub-ai-extract.adapted.json',
  'workflows/wf-08-messe-hub-ai-ask.adapted.json',
];

for (const rel of paths) {
  const url = new URL(rel, root);
  const doc = JSON.parse(await readFile(url, 'utf8'));
  const wf = Array.isArray(doc) ? doc[0] : doc;
  const before = JSON.stringify(wf);
  // adaptWorkflow mutates in place and is now idempotent, including prompt contracts.
  // Already-canonical files must remain byte-for-byte untouched.
  adaptWorkflow(wf);
  const after = JSON.stringify(wf);
  if (before === after) { console.log(`no-op: ${rel}`); continue; }
  await writeFile(url, JSON.stringify(doc, null, 2) + '\n');
  console.log(`updated: ${rel}`);
}
