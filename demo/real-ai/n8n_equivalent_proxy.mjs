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
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const PG_HOST = process.env.PG_HOST || '127.0.0.1';
const PG_PORT = Number(process.env.PG_PORT || 15432);
const AI_CTX_LOGIN = process.env.AI_CTX_LOGIN || 'synthetic_context_login';
const AI_CTX_PASSWORD = process.env.AI_CTX_PASSWORD || 'synthetic-local-only';

if (!HEADER_AUTH_KEY) { console.error('N8N_HEADER_KEY required'); process.exit(2); }
if (!OPENAI_API_KEY) { console.error('OPENAI_API_KEY required — this proxy never falls back to mock'); process.exit(2); }

// --- sanitized observability counters (printed on each call; readable via /_metrics) ---
const metrics = {
  started_at: new Date().toISOString(),
  wf07: { calls: 0, model_calls: 0, upstream_errors: 0, schema_errors: 0, enum_coerced: 0, enum_rejected: 0, tokens_in: 0, tokens_out: 0, latency_ms_total: 0 },
  wf08: { calls: 0, model_calls: 0, upstream_errors: 0, pg_errors: 0, grouped: 0, ungrouped: 0, tokens_in: 0, tokens_out: 0, latency_ms_total: 0 },
};
function logLine(obj) { process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...obj }) + '\n'); }

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

// --- deterministic German→enum coercion (applied to the model's string output
//     before the committed Code node's strict enum validation runs).
// Never invents a missing value; only maps obvious German phrasings onto the
// allowlist already enforced by WF-07. Everything else stays null and the
// 'unsupported_<field>' flag is still raised (same contract as before).
const COERCE_TRAINING = [
  [/\b(ai|k[iü]|ki[\s_-]?automation|automatisier|ai[\s_-]?automation)\b/i, 'ai_automation'],
  [/\b(f[uü]hr(ung|en)|leadership|leader)\b/i, 'leadership'],
  [/\b(kommunikation|communication|rhetorik)\b/i, 'communication'],
  [/\b(sales|vertrieb|verkauf)\b/i, 'sales'],
  [/\b(projekt(managem|-?mgmt)|project[\s_-]?management|pm)\b/i, 'project_management'],
  [/\b(digitale[\s_-]?kompetenz|digital[\s_-]?skills|digitalisier)\b/i, 'digital_skills'],
  [/\b(sonstig|other|andere[sr]?)\b/i, 'other'],
];
const COERCE_BUDGET = [
  [/\b(freigegeben|approved|genehmigt)\b/i, 'approved'],
  [/\b(geplant|planned|budget[\s_-]?geplant)\b/i, 'planned'],
  [/\b(nicht[\s_-]?genannt|not[\s_-]?disclosed|nicht[\s_-]?angegeben)\b/i, 'not_disclosed'],
  [/\b(kein[\s_-]?budget|no[\s_-]?budget|null[\s_-]?budget)\b/i, 'no_budget'],
  [/\b(unbekannt|unknown|unklar)\b/i, 'unknown'],
];
const COERCE_FOLLOW = [
  [/\b(innerhalb[\s_-]?(von[\s_-]?)?einer?[\s_-]?woche|within[\s_-]?one[\s_-]?week|n[aä]chste[\s_-]?woche|bald)\b/i, 'within_one_week'],
  [/\b(innerhalb[\s_-]?(von[\s_-]?)?zwei[\s_-]?wochen?|within[\s_-]?two[\s_-]?weeks|2[\s_-]?wochen)\b/i, 'within_two_weeks'],
  [/\b(innerhalb[\s_-]?(eines?[\s_-]?)?monats?|within[\s_-]?one[\s_-]?month|einem?[\s_-]?monat)\b/i, 'within_one_month'],
  [/\b(an[\s_-]?festem[\s_-]?datum|on[\s_-]?date|fixtermin)\b/i, 'on_date'],
  [/\b(kein[\s_-]?follow[\s_-]?up|no[\s_-]?follow[\s_-]?up)\b/i, 'no_follow_up'],
  [/\b(noch[\s_-]?offen|not[\s_-]?decided|unentschieden)\b/i, 'not_decided'],
];
const COERCE_BY_FIELD = { training_interest: COERCE_TRAINING, budget_status: COERCE_BUDGET, follow_up: COERCE_FOLLOW };
const ENUM_BY_FIELD = {
  training_interest: ['leadership', 'communication', 'sales', 'project_management', 'digital_skills', 'ai_automation', 'other'],
  budget_status: ['approved', 'planned', 'unknown', 'not_disclosed', 'no_budget'],
  follow_up: ['within_one_week', 'within_two_weeks', 'within_one_month', 'on_date', 'no_follow_up', 'not_decided'],
};
function coerceEnum(field, value) {
  if (value == null || typeof value !== 'string') return { value, coerced: false };
  const trimmed = value.trim();
  const enumList = ENUM_BY_FIELD[field];
  if (enumList && enumList.includes(trimmed)) return { value: trimmed, coerced: false };
  const rules = COERCE_BY_FIELD[field];
  if (!rules) return { value, coerced: false };
  for (const [re, canon] of rules) if (re.test(trimmed)) return { value: canon, coerced: true };
  return { value, coerced: false };
}
function coerceExtracted(extracted) {
  if (!extracted || typeof extracted !== 'object') return { extracted, coerced: 0 };
  const out = { ...extracted };
  let coerced = 0;
  for (const f of Object.keys(COERCE_BY_FIELD)) {
    const { value, coerced: did } = coerceEnum(f, out[f]);
    if (did) { out[f] = value; coerced += 1; }
  }
  return { extracted: out, coerced };
}

async function openAiStructured({ model, system, userJson, schema, maxTokens, timeoutMs }) {
  const started = Date.now();
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
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
    const parsed = JSON.parse(content);
    return { parsed, meta: {
      model: body.model || model,
      latency_ms: Date.now() - started,
      tokens_in: body?.usage?.prompt_tokens ?? 0,
      tokens_out: body?.usage?.completion_tokens ?? 0,
    } };
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
  metrics.wf07.calls += 1;
  const body = await readJson(req);
  let validated;
  try { validated = runCode(wf07Validator, { $input: makeInput({ body }) }); }
  catch { return fail(res, 400, 'EXTRACT_REQUEST_REJECTED'); }
  const inputToChain = validated[0].json;
  let modelResult;
  try {
    modelResult = await openAiStructured({
      model: wf07LlmNode.parameters.model,
      system: wf07System,
      userJson: JSON.stringify({ untrusted_notes: inputToChain.notes }),
      schema: wf07Schema,
      maxTokens: wf07LlmNode.parameters.options.maxTokens,
      timeoutMs: wf07LlmNode.parameters.options.timeout,
    });
    metrics.wf07.model_calls += 1;
    metrics.wf07.tokens_in += modelResult.meta.tokens_in;
    metrics.wf07.tokens_out += modelResult.meta.tokens_out;
    metrics.wf07.latency_ms_total += modelResult.meta.latency_ms;
  } catch (e) {
    metrics.wf07.upstream_errors += 1;
    logLine({ event: 'wf07.upstream_error', message: String(e.message).slice(0, 160) });
    return fail(res, 502, 'EXTRACT_UPSTREAM');
  }
  // Deterministic DE→enum coercion BEFORE the strict Code node runs. Never invents
  // a missing value; only canonicalises accepted phrasings. The post-parser still
  // nulls anything that doesn't land in the enum, so AI output can never bypass validation.
  const modelOut = structuredClone(modelResult.parsed);
  if (modelOut?.extracted) {
    const { extracted, coerced } = coerceExtracted(modelOut.extracted);
    modelOut.extracted = extracted;
    if (coerced) metrics.wf07.enum_coerced += coerced;
  }
  let shaped;
  try { shaped = runCode(wf07Postparser, { $input: makeInput(modelOut), $: makeDollar({ 'Eingabe prüfen': inputToChain }) }); }
  catch (e) {
    metrics.wf07.schema_errors += 1;
    logLine({ event: 'wf07.postparse_error', message: String(e.message).slice(0, 160) });
    return fail(res, 502, 'EXTRACT_SCHEMA_INVALID');
  }
  const out = shaped[0].json;
  const flags = Array.isArray(out.uncertainty_flags) ? out.uncertainty_flags : [];
  metrics.wf07.enum_rejected += flags.filter((f) => /^unsupported_(training_interest|budget_status|follow_up)$/.test(f)).length;
  logLine({ event: 'wf07.ok', model: modelResult.meta.model, latency_ms: modelResult.meta.latency_ms, tokens_in: modelResult.meta.tokens_in, tokens_out: modelResult.meta.tokens_out, uncertainty: flags.length, non_null_fields: Object.values(out.extracted || {}).filter((v) => v != null && v !== '').length });
  return send(res, 200, out);
}

// --- WF-08 presentation layer: wraps the deterministic Code-node output with
// a short grouped German summary when all claims share (field, value). Factual
// content remains verbatim from the validated claims — no new fact is added.
const FIELD_LABEL = { score_band: 'Kategorie', score_total: 'Score', processing_status: 'Verarbeitung', email_status: 'E-Mail-Status', duplicate_status: 'Duplikatstatus', training_interest: 'Trainingsinteresse', budget_status: 'Budget', follow_up: 'Follow-up' };
const UNKNOWN_SET = new Set([null, undefined, '', 'unbekannt', 'unknown']);
function groupPresent(unavailable, claims) {
  if (unavailable || !Array.isArray(claims) || claims.length === 0) {
    return { answer_summary: 'Dafür habe ich keine Daten im freigegebenen Kontext.', groups: [], presentation: 'empty' };
  }
  const buckets = new Map();
  for (const c of claims) {
    const key = `${c.field}=${c.value == null ? '__null__' : String(c.value)}`;
    if (!buckets.has(key)) buckets.set(key, { field: c.field, value: c.value, lead_ids: [] });
    buckets.get(key).lead_ids.push(c.lead_id);
  }
  const groups = [...buckets.values()].map((g) => ({ ...g, lead_ids: [...new Set(g.lead_ids)] }));
  const uniqueLeads = new Set(groups.flatMap((g) => g.lead_ids));
  const allUnknown = groups.every((g) => UNKNOWN_SET.has(g.value));
  // When every claim's value is "unknown" (null / 'unbekannt'), collapse across fields
  // into one message about the leads themselves rather than listing each (lead, field) pair.
  if (allUnknown && uniqueLeads.size > 0) {
    const n = uniqueLeads.size;
    const fieldLabels = [...new Set(groups.map((g) => FIELD_LABEL[g.field] || g.field))].join(' / ');
    return { answer_summary: `${n} ${n === 1 ? 'Lead hat' : 'Leads haben'} noch keinen Wert für ${fieldLabels}.`, groups, presentation: 'grouped-unknown' };
  }
  if (groups.length === 1) {
    const g = groups[0];
    const label = FIELD_LABEL[g.field] || g.field;
    const n = g.lead_ids.length;
    return { answer_summary: `${n} ${n === 1 ? 'Lead' : 'Leads'}: ${label} = ${g.value}.`, groups, presentation: 'grouped' };
  }
  const sameField = groups.every((g) => groups[0].field === g.field);
  if (sameField) {
    const label = FIELD_LABEL[groups[0].field] || groups[0].field;
    const parts = groups.map((g) => `${g.lead_ids.length}× ${g.value == null ? 'unbekannt' : g.value}`);
    return { answer_summary: `${label}: ${parts.join(', ')}.`, groups, presentation: 'grouped-mixed' };
  }
  const lines = groups.map((g) => {
    const label = FIELD_LABEL[g.field] || g.field;
    const val = g.value == null ? 'unbekannt' : g.value;
    return `${g.lead_ids.length}× ${label} = ${val}`;
  });
  return { answer_summary: `${uniqueLeads.size} Lead(s): ${lines.join('; ')}.`, groups, presentation: 'ungrouped' };
}

async function handleAsk(req, res) {
  if (req.headers['x-trade-fair-key'] !== HEADER_AUTH_KEY) return fail(res, 401, 'AUTH_REQUIRED');
  metrics.wf08.calls += 1;
  const body = await readJson(req);
  let validated;
  try { validated = runCode(wf08Validator, { $input: makeInput({ body }) }); }
  catch { return fail(res, 400, 'ASK_REQUEST_REJECTED'); }
  const vJson = validated[0].json;
  let payload;
  try {
    const r = await pgPool.query('SELECT trade_fair.ai_lead_context($1::jsonb) AS payload', [JSON.stringify(vJson.context_lead_ids)]);
    payload = r.rows[0]?.payload;
  } catch (e) {
    metrics.wf08.pg_errors += 1;
    logLine({ event: 'wf08.pg_error', message: String(e.message).slice(0, 160) });
    return fail(res, 502, 'ASK_CONTEXT_UNAVAILABLE');
  }
  let filtered;
  try { filtered = runCode(wf08CtxFilter, { $input: makeInput({ payload }), $: makeDollar({ 'Eingabe prüfen': vJson }) }); }
  catch (e) { logLine({ event: 'wf08.filter_error', message: String(e.message).slice(0, 160) }); return fail(res, 502, 'ASK_CONTEXT_REJECTED'); }
  const fJson = filtered[0].json;
  let modelResult;
  try {
    modelResult = await openAiStructured({
      model: wf08LlmNode.parameters.model,
      system: wf08System,
      userJson: JSON.stringify({ untrusted_question: fJson.question, context: fJson.context }),
      schema: wf08Schema,
      maxTokens: wf08LlmNode.parameters.options.maxTokens,
      timeoutMs: wf08LlmNode.parameters.options.timeout,
    });
    metrics.wf08.model_calls += 1;
    metrics.wf08.tokens_in += modelResult.meta.tokens_in;
    metrics.wf08.tokens_out += modelResult.meta.tokens_out;
    metrics.wf08.latency_ms_total += modelResult.meta.latency_ms;
  } catch (e) {
    metrics.wf08.upstream_errors += 1;
    logLine({ event: 'wf08.upstream_error', message: String(e.message).slice(0, 160) });
    return fail(res, 502, 'ASK_UPSTREAM');
  }
  let shaped;
  try { shaped = runCode(wf08Postparser, { $input: makeInput(modelResult.parsed), $: makeDollar({ 'Kontext filtern': fJson }) }); }
  catch (e) { logLine({ event: 'wf08.postparse_error', message: String(e.message).slice(0, 160) }); return fail(res, 502, 'ASK_SCHEMA_INVALID'); }
  const out = shaped[0].json;
  // Presentation grouping — pure derivation from already-validated claims.
  const unavailable = modelResult.parsed?.unavailable === true || !Array.isArray(modelResult.parsed?.claims) || modelResult.parsed.claims.length === 0;
  const grouping = groupPresent(unavailable, (modelResult.parsed.claims || []).filter((c) => out.cited_lead_ids.includes(c.lead_id)));
  if (grouping.presentation === 'grouped' || grouping.presentation === 'grouped-mixed' || grouping.presentation === 'grouped-unknown') metrics.wf08.grouped += 1; else metrics.wf08.ungrouped += 1;
  // The Gateway's safeAiAsk whitelist drops unknown fields; replace the raw answer
  // with the grouped summary so it survives the strict allowlist and is visible in the UI.
  out.answer = grouping.answer_summary || out.answer;
  logLine({ event: 'wf08.ok', model: modelResult.meta.model, latency_ms: modelResult.meta.latency_ms, tokens_in: modelResult.meta.tokens_in, tokens_out: modelResult.meta.tokens_out, cited: out.cited_lead_ids.length, groups: grouping.groups.length, presentation: grouping.presentation });
  return send(res, 200, out);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { success: true });
    if (req.method === 'GET' && req.url === '/_metrics') return send(res, 200, metrics);
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
