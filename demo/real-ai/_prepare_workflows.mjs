// Rewrite the adapted WF-07/WF-08 JSONs so credential bindings point at the
// deterministic IDs created by demo/real-ai/start.sh, and the workflows import
// under stable IDs (rc-wf07 / rc-wf08). Leaves nodes/logic untouched.
import { readFile, writeFile } from 'node:fs/promises';

const [wf07Path, wf08Path, outPath] = process.argv.slice(2);
if (!wf07Path || !wf08Path || !outPath) {
  console.error('Usage: _prepare_workflows.mjs <wf07.json> <wf08.json> <out.json>');
  process.exit(2);
}

const openAiBinding = { id: 'rc-ai-openai', name: 'WBS Trade Fair — OpenAI  19.10' };
const headerBinding = { id: 'rc-ai-header', name: 'WBS Trade Fair — Gateway Auth' };
const pgBinding = { id: 'rc-ai-pg', name: 'WBS Trade Fair — AI Context (scoped read only)' };

async function prep(path, id, name) {
  const wf = JSON.parse(await readFile(path, 'utf8'));
  wf.id = id;
  wf.name = name;
  delete wf.versionId;
  delete wf.triggerCount;
  wf.active = true;
  for (const node of wf.nodes) {
    if (node.credentials?.openAiApi) node.credentials.openAiApi = { ...openAiBinding };
    if (node.credentials?.httpHeaderAuth) node.credentials.httpHeaderAuth = { ...headerBinding };
    if (node.credentials?.postgres) node.credentials.postgres = { ...pgBinding };
  }
  return wf;
}

const workflows = [
  await prep(wf07Path, 'rc-wf07', 'WBS Trade Fair — WF-07 Messe Hub AI Extract (RC isolated)'),
  await prep(wf08Path, 'rc-wf08', 'WBS Trade Fair — WF-08 Messe Hub AI Ask (RC isolated)'),
];
await writeFile(outPath, JSON.stringify(workflows, null, 2));
console.log(`wrote ${outPath} (${workflows.length} workflows)`);
