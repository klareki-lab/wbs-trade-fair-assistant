// Faithful n8n-equivalent proxy for WF-07 (ai-extract) and WF-08 (ai-ask).
// Loads the exact Code-node JS and prompts from the committed workflow JSONs
// and calls the real OpenAI chat/completions API with the committed model,
// temperature, token limits, structured-output schemas and `store:false`.
//
// Why: n8n 2.41.7 production webhook registration from CLI-imported workflows
// is quirky in a disposable container; the workflow logic itself is
// deterministic and already contract-tested in tests/integration/workflow_contracts.mjs.
// This proxy keeps the inference REAL (OpenAI) and the logic BYTE-EQUIVALENT to the
// committed workflow, while giving the Owner webhook URLs that work out of the box.
// For production: Owner activates the SAME committed workflow in production n8n via UI.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import pg from '../../gateway/node_modules/pg/lib/index.js';

const PORT = Number(process.env.N8N_PORT || 5679);
const HEADER_AUTH_KEY = process.env.N8N_HEADER_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PG_HOST = process.env.PG_HOST || '127.0.0.1';
const PG_PORT = Number(process.env.PG_PORT || 15432);
const AI_CTX_LOGIN = process.env.AI_CTX_LOGIN || 'synthetic_context_login';
const AI_CTX_PASSWORD = process.env.AI_CTX_PASSWORD || 'synthetic-local-only';

if (!HEADER_AUTH_KEY) { console.error('N8N_HEADER_KEY required'); process.exit(2); }
if (!OPENAI_API_KEY) { console.error('OPENAI_API_KEY required — this proxy never falls back to mock'); process.exit(2); }

const root = new URL('../../', import.meta.url);
const wf07 = JSON.parse(await readFile(new URL('workflows/wf-07-messe-hub-ai-extract.adapted.json', root), 'utf8'));
const wf08 = JSON.parse(await readFile(new URL('workflows/wf-08-messe-hub-ai-ask.adapted.json', root), 'utf8'));

function nodeByName(wf, name) { return wf.nodes.find((n) => n.name === name); }
function runCode(node, context) { return new Function(...Object.keys(context), node.parameters.jsCode)(...Object.values(context)); }

// Reproduce the n8n Code-node $input/$('<node>') idiom with just the pieces WF-07/08 use.
function makeInput(json) { return { first: () => ({ json }) }; }
function makeDollar(nameToJson) { return (name) => ({ first: () => ({ json: nameToJson[name] }) }); }

const wf07Validator = nodeByName(wf07, 'Eingabe prüfen');
const wf07Postparser = nodeByName(wf07, 'Ausgabe prüfen');
const wf07LlmNode = nodeByName(wf07, 'LLM');
const wf07ChainNode = nodeByName(wf07, 'KI Extraktor');
const wf07ParserNode = wf07.nodes.find((n) => n.type === '@n8n/n8n-nodes-langchain.outputParserStructured');
const wf08Validator = nodeByName(wf08, 'Eingabe prüfen');
const wf08CtxFilter = nodeByName(wf08, 'Kontext filtern');
const wf08Postparser = nodeByName(wf08, 'Ausgabe prüfen');
const wf08LlmNode = nodeByName(wf08, 'LLM');
const wf08ChainNode = nodeByName(wf08, 'Assistent');
const wf08ParserNode = wf08.nodes.find((n) => n.type === '@n8n/n8n-nodes-langchain.outputParserStructured');

const wf07Schema = JSON.parse(wf07ParserNode.parameters.inputSchema);
const wf08Schema = JSON.parse(wf08ParserNode.parameters.inputSchema);
const wf07System = wf07ChainNode.parameters.messages.messageValues[0].message;
const wf08System = wf08ChainNode.parameters.messages.messageValues[0].message;

const pgPool = new pg.Pool({ host: PG_HOST, port: PG_PORT, user: AI_CTX_LOGIN, password: AI_CTX_PASSWORD, database: 'neondb', max: 2, ssl: false });

async function openAiStructured({ model, system, userJson, schema, maxTokens, timeoutMs }) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, temperature: 0, max_tokens: maxTokens, store: false,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userJson },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'structured', strict: true, schema } },
      }),
      signal: ac.signal,
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`OpenAI ${resp.status}: ${text.slice(0, 400)}`);
    }
    const body = await resp.json();
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('OpenAI returned no content');
    return JSON.parse(content);
  } finally { clearTimeout(t); }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 128 * 1024) { req.destroy(); reject(new Error('payload too large')); } chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function send(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(payload);
}
function fail(res, status, code) { send(res, status, { success: false, error: { code } }); }

async function handleExtract(req, res) {
  if (req.headers['x-trade-fair-key'] !== HEADER_AUTH_KEY) return fail(res, 401, 'AUTH_REQUIRED');
  const body = await readJson(req);
  let validated;
  try { validated = runCode(wf07Validator, { $input: makeInput({ body }) }); }
  catch { return fail(res, 400, 'EXTRACT_REQUEST_REJECTED'); }
  const inputToChain = validated[0].json;
  let modelOut;
  try {
    modelOut = await openAiStructured({
      model: wf07LlmNode.parameters.model,
      system: wf07System,
      userJson: JSON.stringify({ untrusted_notes: inputToChain.notes }),
      schema: wf07Schema,
      maxTokens: wf07LlmNode.parameters.options.maxTokens,
      timeoutMs: wf07LlmNode.parameters.options.timeout,
    });
  } catch (e) { process.stderr.write('[wf07] llm error: ' + e.message + '\n'); return fail(res, 502, 'EXTRACT_UPSTREAM'); }
  // Chain-LLM 1.7 + parser 1.3 wraps the parsed object; Code reads input.output ?? input.
  let shaped;
  try { shaped = runCode(wf07Postparser, { $input: makeInput(modelOut), $: makeDollar({ 'Eingabe prüfen': inputToChain }) }); }
  catch (e) { process.stderr.write('[wf07] postparse: ' + e.message + '\n'); return fail(res, 502, 'EXTRACT_SCHEMA_INVALID'); }
  return send(res, 200, shaped[0].json);
}

async function handleAsk(req, res) {
  if (req.headers['x-trade-fair-key'] !== HEADER_AUTH_KEY) return fail(res, 401, 'AUTH_REQUIRED');
  const body = await readJson(req);
  let validated;
  try { validated = runCode(wf08Validator, { $input: makeInput({ body }) }); }
  catch { return fail(res, 400, 'ASK_REQUEST_REJECTED'); }
  const vJson = validated[0].json;
  // "Leads lesen" node — scoped ai_lead_context via trade_fair_ai_context role.
  let payload;
  try {
    const r = await pgPool.query('SELECT trade_fair.ai_lead_context($1::jsonb) AS payload', [JSON.stringify(vJson.context_lead_ids)]);
    payload = r.rows[0]?.payload;
  } catch (e) { process.stderr.write('[wf08] pg: ' + e.message + '\n'); return fail(res, 502, 'ASK_CONTEXT_UNAVAILABLE'); }
  let filtered;
  try { filtered = runCode(wf08CtxFilter, { $input: makeInput({ payload }), $: makeDollar({ 'Eingabe prüfen': vJson }) }); }
  catch (e) { process.stderr.write('[wf08] filter: ' + e.message + '\n'); return fail(res, 502, 'ASK_CONTEXT_REJECTED'); }
  const fJson = filtered[0].json;
  let modelOut;
  try {
    modelOut = await openAiStructured({
      model: wf08LlmNode.parameters.model,
      system: wf08System,
      userJson: JSON.stringify({ untrusted_question: fJson.question, context: fJson.context }),
      schema: wf08Schema,
      maxTokens: wf08LlmNode.parameters.options.maxTokens,
      timeoutMs: wf08LlmNode.parameters.options.timeout,
    });
  } catch (e) { process.stderr.write('[wf08] llm: ' + e.message + '\n'); return fail(res, 502, 'ASK_UPSTREAM'); }
  let shaped;
  try { shaped = runCode(wf08Postparser, { $input: makeInput(modelOut), $: makeDollar({ 'Kontext filtern': fJson }) }); }
  catch (e) { process.stderr.write('[wf08] postparse: ' + e.message + '\n'); return fail(res, 502, 'ASK_SCHEMA_INVALID'); }
  return send(res, 200, shaped[0].json);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { success: true });
    if (req.method !== 'POST') return fail(res, 405, 'REQUEST_REJECTED');
    if (req.url === '/webhook/messe-hub/ai-extract') return handleExtract(req, res);
    if (req.url === '/webhook/messe-hub/ai-ask') return handleAsk(req, res);
    return fail(res, 404, 'NOT_FOUND');
  } catch (e) { process.stderr.write('[proxy] fatal: ' + e.message + '\n'); fail(res, 500, 'INTERNAL'); }
});
server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`[n8n-equivalent] listening on http://127.0.0.1:${PORT} · WF-07 model=${wf07LlmNode.parameters.model} · WF-08 model=${wf08LlmNode.parameters.model}\n`);
});
process.on('SIGINT', () => server.close(() => pgPool.end().then(() => process.exit(0))));
process.on('SIGTERM', () => server.close(() => pgPool.end().then(() => process.exit(0))));
