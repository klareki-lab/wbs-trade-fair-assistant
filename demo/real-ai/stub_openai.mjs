// Minimal OpenAI-compatible stub for local acceptance tests of the n8n-equivalent proxy.
// Produces responses that mirror what gpt-4.1-mini would return for the committed
// WF-07/WF-08 prompts, including occasional German enum values that must be coerced.
// Launched by smoke_real_ai_v2.mjs; never invoked in production.
import http from 'node:http';

const PORT = Number(process.env.STUB_PORT || 4190);
let seen = 0;

function parseUserPayload(msgs) {
  const u = msgs?.find((m) => m.role === 'user');
  try { return JSON.parse(u?.content || '{}'); } catch { return {}; }
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/chat/completions') { res.writeHead(404); res.end(); return; }
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const user = parseUserPayload(body.messages);
  seen += 1;
  let out;
  if ('untrusted_notes' in user) {
    // WF-07 extraction. The stub deliberately emits German colloquial enums so
    // the proxy's deterministic coerceEnum() path is exercised, and uses evidence
    // substrings that MUST appear in the original notes (WF-07 Code node verifies this).
    const n = String(user.untrusted_notes);
    const match = (re) => (n.match(re) || [null])[0];
    const company = match(/\b[A-ZÄÖÜ][\w .&-]{2,40}(?:AG|GmbH|UG|Services|Media|Analytics|Energie|Technik|Logistik)\b/) || match(/\b[A-ZÄÖÜ][\w .&-]{2,40}\b/);
    const contact = match(/\b(?:Herr\s+Dr\.?\s+|Herr\s+|Frau\s+)?[A-ZÄÖÜ][a-zäöüß]+\s+[A-ZÄÖÜ][a-zäöüß]+\b/);
    const email = match(/[\w.-]+@[\w.-]+\.[A-Za-z]{2,}/);
    const phone = match(/\+?\d[\d\s\-()]{7,}/);
    // Emit a value AND the exact substring from notes as evidence (WF-07 Code node
    // asserts notes.includes(evidence)). The value may be a German colloquial form
    // that the proxy's coerceEnum then canonicalises before enum validation.
    const trEv = match(/\b(KI[\s_-]?Automation|AI[\s_-]?Automation|Automatisierung|F[uü]hrung|leadership|Kommunikation|Sales|Vertrieb|Projektmanagement|digitale[\s_-]?Kompetenz)\b/i);
    const bdEv = match(/\b(freigegeben|approved|geplant|planned|not[\s_-]?disclosed|kein[\s_-]?Budget|unbekannt)\b/i);
    const foEv = match(/\b(innerhalb[\s_-]?(?:von[\s_-]?)?zwei[\s_-]?Wochen|zwei[\s_-]?Wochen|innerhalb[\s_-]?(?:von[\s_-]?)?einer?[\s_-]?Woche|n[aä]chste[\s_-]?Woche|innerhalb[\s_-]?eines?[\s_-]?Monats?|an[\s_-]?festem[\s_-]?Datum|kein[\s_-]?Follow[\s_-]?up|noch[\s_-]?offen)\b/i);
    const training = trEv ? (/\b(KI|AI|Automat)/i.test(trEv) ? 'KI-Automation' : trEv) : null;
    const budget = bdEv ? (/\bfreigegeben\b/i.test(bdEv) ? 'Freigegeben' : /\bgeplant\b/i.test(bdEv) ? 'Geplant' : /\bkein[\s_-]?Budget\b/i.test(bdEv) ? 'Kein Budget' : /\bunbekannt\b/i.test(bdEv) ? 'Unbekannt' : bdEv) : null;
    const follow = foEv ? (/\bzwei\b/i.test(foEv) ? 'Innerhalb zwei Wochen' : /\beinen?\b/i.test(foEv) ? 'Innerhalb eines Monats' : /\bn[aä]chste|einer?\b/i.test(foEv) ? 'Innerhalb einer Woche' : /\bfestem\b/i.test(foEv) ? 'An festem Datum' : /\bkein\b/i.test(foEv) ? 'Kein Follow-up' : /\boffen\b/i.test(foEv) ? 'Noch offen' : foEv) : null;
    const extracted = { company_name: company, contact_name: contact, email, phone, website: null, training_interest: training, budget_status: budget, follow_up: follow, follow_up_date: null, notes: null, summary: null };
    const evidence = { company_name: company, contact_name: contact, email, phone, website: null, training_interest: trEv, budget_status: bdEv, follow_up: foEv, follow_up_date: null, notes: null, summary: null };
    out = { extracted, evidence };
  } else if ('untrusted_question' in user) {
    // WF-08 ask. Pull the question text and the pre-validated allowed field hint
    // the Code node already derived; only emit claims about those (lead_id, field, value).
    const ctx = Array.isArray(user.context) ? user.context : [];
    const q = String(user.untrusted_question);
    const requested = q.replace(/^Return these attributes:\s*/i, '').split(',').map((s) => s.trim()).filter(Boolean);
    const claims = [];
    for (const lead of ctx) for (const f of requested) if (Object.hasOwn(lead, f)) claims.push({ lead_id: lead.lead_id, field: f, value: lead[f] });
    out = { claims, unavailable: claims.length === 0 };
  } else {
    out = {};
  }
  const resp = { id: 'stub-' + seen, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(out) }, finish_reason: 'stop' }], usage: { prompt_tokens: 42 + seen, completion_tokens: 24 + seen, total_tokens: 66 + 2 * seen } };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(resp));
});
server.listen(PORT, '127.0.0.1', () => process.stdout.write(`[stub-openai] http://127.0.0.1:${PORT}  (NOT a real model)\n`));
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
