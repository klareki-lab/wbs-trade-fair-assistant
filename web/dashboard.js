// WBS Messe Hub Admin — same-origin, read+CRM+AI. textContent-only renderers.
'use strict';
const $ = (id) => document.getElementById(id);
const LEAD_ID = /^FAIR-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function elem(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.appendChild(document.createTextNode(String(text))); return n; }
function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); }
function setText(el, v) { if (!el) return; clear(el); el.appendChild(document.createTextNode(v == null || v === '' ? '–' : String(v))); }
function pill(value, kind) {
  const cls = kind || (/^(HOT|delivered|completed|NEW)$/.test(value) ? 'p-ok' : /^(failed|uncertain|retired)$/.test(value) ? 'p-err' : /^(WARM|POSSIBLE_DUPLICATE|processing|sending|ignored)$/.test(value) ? 'p-warn' : 'p-n');
  return elem('span', 'pill ' + cls, value || 'unbekannt');
}
function dateDE(iso) { if (!iso) return '–'; const d = new Date(iso); return Number.isNaN(d.getTime()) ? '–' : d.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }); }

const state = { page: 1, limit: 50, search: '', band: '', processing: '', email: '', duplicate: '', sort: 'created', direction: 'desc' };
let items = [], total = 0, lastRequest = 0, tab = 'all', stats = null;
let selected = new Set();
let aiEnabled = false, crmEnabled = false, sessionId = 'session-' + Math.random().toString(36).slice(2, 10);
let groupsCache = [];

function liveState(msg, errorFlag) { const t = $('liveText'); if (t) setText(t, msg); const p = $('pulse'); if (p) p.classList.toggle('unavailable', !!errorFlag); }

function dashUrl() {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(state)) if (v !== '' && v != null) q.set(k, String(v));
  return '/api/dashboard?' + q.toString();
}

async function fetchJson(url, init) {
  const resp = await fetch(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json', ...(init?.headers || {}) }, ...init });
  if (resp.status === 401) { window.location.assign('/'); throw new Error('AUTH'); }
  const body = await resp.json().catch(() => ({}));
  return { status: resp.status, body };
}

function renderStats(s) {
  stats = s; const set = (id, v) => setText($(id), v == null ? '–' : String(v));
  set('kGesamt', s.total); set('kA', s.hot); set('kSchnitt', s.scored_average); set('kDup', s.duplicates); set('kFaellig', s.failed);
  set('kGesamtSub', `${s.today ?? '–'} heute · ${s.unscored ?? '–'} unbewertet`);
  set('kASub', `${s.warm ?? '–'} WARM · ${s.cold ?? '–'} COLD`);
  set('kSchnittSub', 'Nur bewertete Leads'); set('kDupSub', 'Virtuelle Gruppen im CRM-Panel'); set('kFaelligSub', `${s.email_attention ?? '–'} E-Mail-Fehler / unklar`);
  const bands = [['HOT', s.hot], ['WARM', s.warm], ['COLD', s.cold], ['Unbewertet', s.unscored]];
  const katBox = $('katBox'); clear(katBox);
  const bars = elem('div', 'bars'); const max = Math.max(1, s.total || 1);
  for (const [k, n] of bands) {
    const row = elem('div', 'bar-row'); row.appendChild(elem('span', null, k));
    const track = elem('div', 'bar-track'); const meter = document.createElement('meter'); meter.min = 0; meter.max = max; meter.value = Math.max(0, n || 0); track.appendChild(meter);
    row.appendChild(track); row.appendChild(elem('b', null, n ?? '–')); bars.appendChild(row);
  }
  katBox.appendChild(bars);
  const interests = Array.isArray(s.interests) ? s.interests : [];
  const ib = $('interestBars'); clear(ib);
  if (!interests.length) ib.appendChild(elem('div', 'empty', 'Noch keine Trainingsinteressen erfasst.'));
  else for (const v of interests) {
    const row = elem('div', 'bar-row'); row.appendChild(elem('span', null, v.name));
    const track = elem('div', 'bar-track'); const meter = document.createElement('meter'); meter.min = 0; meter.max = max; meter.value = Math.max(0, Number(v.count) || 0); track.appendChild(meter);
    row.appendChild(track); row.appendChild(elem('b', null, v.count)); ib.appendChild(row);
  }
  setText($('navDup'), s.duplicates || '');
}

function tabsRender() {
  const el = $('tabs'); clear(el);
  for (const [k, t] of [['all', 'Alle Leads'], ['dups', 'Duplikate']]) {
    const b = elem('button', 'btn sm' + (tab === k ? ' primary' : ''), t); b.type = 'button'; b.dataset.tab = k; el.appendChild(b);
  }
}

function renderTable() {
  tabsRender();
  const box = $('tableBox'); clear(box);
  if (!items.length) { box.appendChild(elem('div', 'empty', 'Keine Leads für die aktuelle Auswahl gefunden.')); updateActionBar(); return; }
  const table = document.createElement('table');
  const thead = document.createElement('thead'); const hr = document.createElement('tr');
  const selTh = document.createElement('th'); const selAll = document.createElement('input'); selAll.type = 'checkbox'; selAll.id = 'selAll'; selAll.className = 'sel';
  selTh.appendChild(selAll); hr.appendChild(selTh);
  for (const h of ['Erfasst', 'Firma / Kontakt', 'Score', 'Verarbeitung', 'E-Mail', 'Duplikat', 'Details']) hr.appendChild(elem('th', null, h));
  thead.appendChild(hr); table.appendChild(thead);
  const tbody = document.createElement('tbody');
  // Each row carries role="button" and aria-label="Details für …" for keyboard access.
  for (const l of items) {
    const tr = document.createElement('tr');
    tr.dataset.id = l.lead_id;
    tr.tabIndex = 0;
    tr.setAttribute('role', 'button');
    tr.setAttribute('aria-label', 'Details für ' + (l.company || l.lead_id) + ' öffnen');
    const td0 = document.createElement('td'); const cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'sel row-sel'; cb.dataset.id = l.lead_id; cb.checked = selected.has(l.lead_id); td0.appendChild(cb); tr.appendChild(td0);
    tr.appendChild(elem('td', null, dateDE(l.created_at)));
    const td2 = document.createElement('td');
    td2.appendChild(elem('strong', null, l.company || '–'));
    td2.appendChild(document.createElement('br'));
    td2.appendChild(elem('span', 'muted', (l.contact || '–') + ' · ' + (l.email || '–')));
    tr.appendChild(td2);
    const td3 = document.createElement('td'); td3.appendChild(pill(l.score_band || 'UNSCORED'));
    td3.appendChild(document.createTextNode(' ' + (l.score_total == null ? '–' : l.score_total + '/100'))); tr.appendChild(td3);
    const td4 = document.createElement('td'); td4.appendChild(pill(l.processing_status));
    if (l.processing_error) { td4.appendChild(document.createElement('br')); td4.appendChild(elem('span', 'p-err', l.processing_error)); } tr.appendChild(td4);
    const td5 = document.createElement('td'); td5.appendChild(pill(l.email_status || 'none'));
    if (l.email_error) { td5.appendChild(document.createElement('br')); td5.appendChild(elem('span', 'p-err', l.email_error)); } tr.appendChild(td5);
    const td6 = document.createElement('td'); td6.appendChild(pill(l.duplicate_status)); tr.appendChild(td6);
    const td7 = document.createElement('td'); const btn = elem('button', 'btn sm', 'Details'); btn.type = 'button'; btn.dataset.id = l.lead_id; td7.appendChild(btn); tr.appendChild(td7);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody); box.appendChild(table);
  setText($('pageInfo'), `Seite ${state.page} · ${total} Treffer`);
  $('prev').disabled = state.page === 1; $('next').disabled = state.page * state.limit >= total;
  setText($('tableFoot'), `${items.length} angezeigt · ${total} gefilterte Einträge · Admin-Session`);
  const sa = $('selAll'); if (sa) sa.checked = items.length > 0 && items.every((l) => selected.has(l.lead_id));
  updateActionBar();
}

function updateActionBar() {
  const bar = $('actionbar');
  const n = selected.size;
  if (n > 0) { bar.hidden = false; setText($('auswahlText'), `${n} ausgewählt`); $('mergeBtn').disabled = n < 2; $('ignoreBtn').disabled = n < 1; }
  else bar.hidden = true;
}

async function load() {
  const id = ++lastRequest; liveState('Lade Live-Daten …'); $('refreshBtn').disabled = true;
  try {
    const { status, body } = await fetchJson(dashUrl());
    if (status !== 200 || !body.success || !Array.isArray(body.leads) || !body.stats) throw new Error('Ungültige API-Antwort');
    if (id !== lastRequest) return;
    items = body.leads; total = body.total; renderStats(body.stats); renderTable();
    setText($('pageSub'), 'Neon PostgreSQL · zuletzt aktualisiert ' + dateDE(body.as_of));
    liveState('Live · aktuell');
  } catch (e) {
    if (id !== lastRequest) return;
    if (e.message === 'AUTH') return;
    liveState('Daten nicht verfügbar', true); setText($('pageSub'), e.message || 'Fehler');
    const box = $('tableBox'); clear(box); box.appendChild(elem('div', 'empty', 'Daten konnten nicht geladen werden.'));
  } finally { if (id === lastRequest) $('refreshBtn').disabled = false; }
}

// ---------- Lead details drawer ----------
const safeUrlDisplay = (v) => { try { const u = new URL(v); return ['http:', 'https:'].includes(u.protocol) ? u.href : null; } catch { return null; } };
function showDetail(id) {
  const l = items.find((x) => x.lead_id === id); if (!l) return;
  setText($('dTitle'), l.company || 'Unbekannte Firma'); setText($('dSub'), l.lead_id);
  const msgs = $('msgs'); clear(msgs);
  const kv = (dl, label, value) => { dl.appendChild(elem('dt', null, label)); dl.appendChild(elem('dd', null, value == null || value === '' ? '–' : String(value))); };
  const panel = (title) => { const p = elem('div', 'panel'); p.appendChild(elem('h3', null, title)); return p; };
  const p1 = panel('Score und Zustellung'); const dl1 = elem('dl', 'kv');
  kv(dl1, 'Score', l.score_total == null ? 'Nicht bewertet' : l.score_total + '/100');
  kv(dl1, 'Kategorie', l.score_band); kv(dl1, 'Verarbeitung', l.processing_status); kv(dl1, 'Fehler', l.processing_error);
  kv(dl1, 'E-Mail', l.email_status); kv(dl1, 'E-Mail-Fehler', l.email_error); kv(dl1, 'Versuche', l.processing_attempts);
  p1.appendChild(dl1); msgs.appendChild(p1);
  const p2 = panel('Kontakt'); const dl2 = elem('dl', 'kv');
  kv(dl2, 'Firma', l.company); kv(dl2, 'Name', l.contact); kv(dl2, 'E-Mail', l.email); kv(dl2, 'Telefon', l.phone);
  kv(dl2, 'E-Mail bestätigt', l.email_verified ? 'Ja' : 'Nein');
  const web = safeUrlDisplay(l.website);
  if (web) { dl2.appendChild(elem('dt', null, 'Website')); const dd = document.createElement('dd'); const a = document.createElement('a'); a.target = '_blank'; a.rel = 'noopener noreferrer'; a.href = web; a.appendChild(document.createTextNode(web)); dd.appendChild(a); dl2.appendChild(dd); }
  kv(dl2, 'Erfasst', dateDE(l.created_at)); p2.appendChild(dl2); msgs.appendChild(p2);
  const p3 = panel('Angaben'); const dl3 = elem('dl', 'kv');
  kv(dl3, 'Training', l.training_interest); kv(dl3, 'Budget', l.budget_status); kv(dl3, 'Follow-up', l.follow_up); kv(dl3, 'Datum', l.follow_up_date);
  kv(dl3, 'Duplikat', l.duplicate_status); kv(dl3, 'Prüfung nötig', l.review_required ? 'Ja' : 'Nein'); p3.appendChild(dl3); msgs.appendChild(p3);
  const p4 = panel('Notizen'); p4.appendChild(elem('pre', 'notiz', l.notes == null ? '–' : String(l.notes))); msgs.appendChild(p4);
  const p5 = panel('Unsicherheiten / Duplikat-Hinweise'); p5.appendChild(elem('pre', 'detailJson', JSON.stringify({ flags: l.uncertainty_flags, possible_contact_ids: l.possible_contact_ids, ai_uncertainty: l.ai_uncertainty }, null, 2))); msgs.appendChild(p5);
  const p6 = panel('KI-Auswertung'); p6.appendChild(elem('pre', 'detailJson', l.ai_extraction ? JSON.stringify(l.ai_extraction, null, 2) : 'Nicht vorhanden / noch nicht verarbeitet')); msgs.appendChild(p6);
  const p7 = panel('Firmenrecherche'); p7.appendChild(elem('pre', 'detailJson', l.company_research ? JSON.stringify(l.company_research, null, 2) : 'Nicht vorhanden / noch nicht verarbeitet')); msgs.appendChild(p7);
  $('drawer').classList.add('open'); $('backdrop').classList.add('open'); $('drawer').setAttribute('aria-hidden', 'false');
}
const closeDrawer = () => { $('drawer').classList.remove('open'); $('backdrop').classList.remove('open'); $('drawer').setAttribute('aria-hidden', 'true'); };

// ---------- CRM groups ----------
async function loadGroups() {
  if (!crmEnabled) return;
  const q = new URLSearchParams(); q.set('page', '1'); q.set('limit', '50');
  if ($('toggleRetired')?.checked) q.set('include_retired', 'true');
  try {
    const { status, body } = await fetchJson('/api/dashboard/groups?' + q.toString());
    if (status !== 200 || !body.success || !Array.isArray(body.groups)) { renderGroups([]); return; }
    groupsCache = body.groups;
    renderGroups(body.groups);
    setText($('navGroups'), body.groups.filter((g) => g.status !== 'retired').length || '');
  } catch { renderGroups([]); }
}
function renderGroups(groups) {
  const box = $('groupsBox'); clear(box);
  if (!groups.length) { box.appendChild(elem('div', 'empty', 'Noch keine CRM-Gruppen angelegt.')); return; }
  for (const g of groups) {
    const card = elem('div', 'group-card'); const head = elem('div', 'group-head');
    head.appendChild(elem('strong', null, g.label || g.group_id.slice(0, 8)));
    head.appendChild(pill(g.status));
    head.appendChild(elem('span', 'muted', ' · ' + (g.members?.length || 0) + ' Lead(s) · ' + dateDE(g.created_at) + ' · ' + (g.created_by || '–')));
    card.appendChild(head);
    const members = elem('ul', 'group-members');
    for (const m of g.members || []) {
      const li = document.createElement('li');
      li.appendChild(elem('strong', null, m.company_name || '–'));
      li.appendChild(elem('span', 'muted', ' · ' + (m.contact_name || '–') + ' · ' + m.lead_id.slice(0, 13) + '…'));
      if (m.removed_at) li.appendChild(elem('span', 'p-err', ' · entfernt ' + dateDE(m.removed_at)));
      const actions = elem('span', 'row-actions');
      if (g.status === 'active' && !m.removed_at) {
        const bExtract = elem('button', 'btn sm', 'Herauslösen'); bExtract.type = 'button'; bExtract.dataset.action = 'extract'; bExtract.dataset.group = g.group_id; bExtract.dataset.lead = m.lead_id; actions.appendChild(bExtract);
      }
      li.appendChild(actions); members.appendChild(li);
    }
    card.appendChild(members);
    const foot = elem('div', 'group-foot');
    if (g.status === 'active') {
      const bSplit = elem('button', 'btn sm', 'Trennen'); bSplit.type = 'button'; bSplit.dataset.action = 'split'; bSplit.dataset.group = g.group_id; foot.appendChild(bSplit);
    } else {
      const bRevert = elem('button', 'btn sm', 'Rückgängig (Audit-ID)'); bRevert.type = 'button'; bRevert.dataset.action = 'revert'; foot.appendChild(bRevert);
    }
    card.appendChild(foot);
    box.appendChild(card);
  }
}

async function postJson(path, body) {
  const resp = await fetch(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
  if (resp.status === 401) { window.location.assign('/'); throw new Error('AUTH'); }
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, body: data };
}

async function askLabel(defaultText) {
  const label = window.prompt('Bezeichnung für die Gruppe:', defaultText || '');
  if (label === null) return null;
  const t = String(label || '').trim();
  if (!t) return null;
  return t.slice(0, 160);
}

async function mergeSelected() {
  const ids = [...selected].filter((x) => LEAD_ID.test(x));
  if (ids.length < 2) return;
  const label = await askLabel('Zusammenführung ' + new Date().toISOString().slice(0, 10));
  if (!label) return;
  const { status, body } = await postJson('/api/dashboard/groups', { lead_ids: ids, label });
  if (status === 200 && body.success) { selected.clear(); await loadGroups(); renderTable(); liveState('CRM-Gruppe erstellt'); }
  else liveState('CRM-Aktion abgelehnt', true);
}
async function ignoreSelected() {
  const ids = [...selected].filter((x) => LEAD_ID.test(x));
  if (!ids.length) return;
  const note = window.prompt('Begründung (optional):', '');
  const { status, body } = await postJson('/api/dashboard/groups/ignore', { lead_ids: ids, label: 'Ignoriert ' + new Date().toISOString().slice(0, 10), note: note || null });
  if (status === 200 && body.success) { selected.clear(); await loadGroups(); renderTable(); liveState('Als Duplikate ignoriert'); }
  else liveState('CRM-Aktion abgelehnt', true);
}
async function doGroupAction(action, groupId, leadId) {
  if (action === 'split' && UUID.test(groupId)) { const { status } = await postJson('/api/dashboard/groups/split', { group_id: groupId }); if (status === 200) await loadGroups(); return; }
  if (action === 'extract' && UUID.test(groupId) && LEAD_ID.test(leadId)) { const { status } = await postJson('/api/dashboard/groups/extract', { group_id: groupId, lead_id: leadId }); if (status === 200) await loadGroups(); return; }
  if (action === 'revert') {
    const auditId = window.prompt('Audit-ID der rückgängig zu machenden Aktion:');
    if (!auditId || !UUID.test(auditId)) return;
    const { status } = await postJson('/api/dashboard/groups/revert', { audit_id: auditId });
    if (status === 200) await loadGroups();
  }
}

// ---------- AI capture (WF-07) ----------
const EXTRACT_FIELDS = ['company_name','contact_name','email','phone','website','training_interest','budget_status','follow_up','follow_up_date','notes','summary'];
let aiExtractCurrent = null;
function openAiExtract() {
  $('aiExtractModal').hidden = false; $('aiExtractBackdrop').hidden = false; $('aiExtractModal').setAttribute('aria-hidden', 'false');
  $('aiExtractInput').value = ''; $('aiExtractPanel').hidden = true; $('aiExtractSubmit').disabled = true; $('aiExtractError').hidden = true; aiExtractCurrent = null;
  if (!aiEnabled) { const err = $('aiExtractError'); setText(err, 'WF-07 (AI-Erfassung) ist nicht konfiguriert. Owner aktiviert N8N_AI_EXTRACT_URL.'); err.hidden = false; $('aiExtractAnalyze').disabled = true; }
  else $('aiExtractAnalyze').disabled = false;
}
function closeAiExtract() { $('aiExtractModal').hidden = true; $('aiExtractBackdrop').hidden = true; $('aiExtractModal').setAttribute('aria-hidden', 'true'); }
async function aiAnalyze() {
  const err = $('aiExtractError'); err.hidden = true; const btn = $('aiExtractAnalyze'); btn.disabled = true;
  try {
    const notes = $('aiExtractInput').value.trim(); if (notes.length < 10) { setText(err, 'Notiz ist zu kurz (mind. 10 Zeichen).'); err.hidden = false; return; }
    const { status, body } = await postJson('/api/dashboard/ai/extract', { notes, session_id: sessionId });
    if (status !== 200 || !body.success) { setText(err, body?.error?.message || 'AI nicht erreichbar.'); err.hidden = false; return; }
    aiExtractCurrent = body;
    const panel = $('aiExtractPanel'); panel.hidden = false;
    setText($('aiExtractMeta'), body.assistant_message || '');
    const form = $('aiExtractForm'); clear(form);
    for (const k of EXTRACT_FIELDS) {
      const value = body.extracted[k] ?? '';
      const conf = typeof body.confidence?.[k] === 'number' ? Math.round(body.confidence[k] * 100) : null;
      const row = elem('div', 'field');
      const lab = elem('label', null, k + (conf !== null ? ' · Konfidenz ' + conf + '%' : ''));
      lab.setAttribute('for', 'aix_' + k);
      row.appendChild(lab);
      const inp = (k === 'notes' || k === 'summary') ? document.createElement('textarea') : document.createElement('input');
      if (inp.tagName === 'TEXTAREA') inp.rows = 3;
      inp.id = 'aix_' + k; inp.name = k; inp.value = value || '';
      inp.setAttribute('maxlength', k === 'notes' ? 20000 : k === 'summary' ? 2000 : 254);
      row.appendChild(inp);
      form.appendChild(row);
    }
    const warnings = $('aiExtractWarnings'); clear(warnings);
    for (const f of body.uncertainty_flags || []) { warnings.appendChild(elem('li', 'p-warn', f)); }
    $('aiExtractSubmit').disabled = false;
  } catch (_) { setText(err, 'Verbindungsfehler.'); err.hidden = false; }
  finally { btn.disabled = aiEnabled ? false : true; }
}
async function aiSubmit() {
  const err = $('aiExtractError'); err.hidden = true;
  const payload = { source: 'messe-form', submission_id: 'ai-' + (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)) };
  const form = $('aiExtractForm');
  for (const el of form.querySelectorAll('[name]')) if (el.value && String(el.value).trim() !== '') payload[el.name] = String(el.value).trim();
  if (!payload.company_name) { setText(err, 'Firmenname ist erforderlich.'); err.hidden = false; return; }
  const { status, body } = await postJson('/api/leads', payload);
  if (status === 201 && body.success) { closeAiExtract(); liveState('Lead übernommen · ' + body.lead_id); load(); }
  else { setText(err, body?.error?.message || ('HTTP ' + status)); err.hidden = false; }
}

// ---------- AI assistant (WF-08) ----------
function openAiAsk() {
  $('aiAskModal').hidden = false; $('aiAskBackdrop').hidden = false; $('aiAskModal').setAttribute('aria-hidden', 'false');
  clear($('aiAskThread')); $('aiAskError').hidden = true; $('aiAskInput').value = '';
  if (!aiEnabled) { const err = $('aiAskError'); setText(err, 'WF-08 (Lead-Assistent) ist nicht konfiguriert. Owner aktiviert N8N_AI_ASK_URL.'); err.hidden = false; $('aiAskSend').disabled = true; }
  else $('aiAskSend').disabled = false;
}
function closeAiAsk() { $('aiAskModal').hidden = true; $('aiAskBackdrop').hidden = true; $('aiAskModal').setAttribute('aria-hidden', 'true'); }
async function aiAsk() {
  const err = $('aiAskError'); err.hidden = true;
  const q = $('aiAskInput').value.trim(); if (q.length < 3) return;
  const thread = $('aiAskThread');
  const userMsg = elem('div', 'msg user'); userMsg.appendChild(elem('div', 'msg-head', 'Du')); userMsg.appendChild(elem('div', 'msg-body', q)); thread.appendChild(userMsg);
  $('aiAskInput').value = ''; $('aiAskSend').disabled = true;
  try {
    const ctx = items.slice(0, 20).map((l) => l.lead_id);
    const { status, body } = await postJson('/api/dashboard/ai/ask', { question: q, context_lead_ids: ctx, session_id: sessionId });
    if (status !== 200 || !body.success) { setText(err, body?.error?.message || 'AI nicht erreichbar.'); err.hidden = false; return; }
    const aiMsg = elem('div', 'msg assistant'); aiMsg.appendChild(elem('div', 'msg-head', 'Lead-Assistent'));
    aiMsg.appendChild(elem('div', 'msg-body', body.answer));
    if (Array.isArray(body.cited_lead_ids) && body.cited_lead_ids.length) {
      const cite = elem('div', 'msg-cite', 'Zitiert: ');
      for (const id of body.cited_lead_ids) { cite.appendChild(elem('span', 'pill p-n', id.slice(0, 13) + '…')); cite.appendChild(document.createTextNode(' ')); }
      aiMsg.appendChild(cite);
    }
    thread.appendChild(aiMsg);
    thread.scrollTop = thread.scrollHeight;
  } catch (_) { setText(err, 'Verbindungsfehler.'); err.hidden = false; }
  finally { $('aiAskSend').disabled = false; }
}

// ---------- Session detection + wiring ----------
async function detectSession() {
  try {
    const r = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
    const data = await r.json();
    crmEnabled = !!data.crm_enabled; aiEnabled = !!data.ai_enabled;
    const show = (badgeId, flag) => { const el = $(badgeId); if (!el) return; if (flag) { el.hidden = true; } else { el.hidden = false; setText(el, 'aus'); } };
    show('navAiExtract', aiEnabled); show('navAiAsk', aiEnabled);
    if (crmEnabled) await loadGroups();
  } catch (_) {}
}

function selectTab(nextTab) {
  if (nextTab !== 'all' && nextTab !== 'dups') return;
  tab = nextTab; state.duplicate = tab === 'dups' ? 'yes' : '';
  state.band = ''; state.processing = ''; state.email = ''; state.search = '';
  if ($('search')) $('search').value = '';
  for (const id of ['filterBand', 'filterProcessing', 'filterEmail']) { const el = $(id); if (el) el.value = ''; }
  state.page = 1; load();
}
function resetFilters() {
  state.search = ''; state.band = ''; state.processing = ''; state.email = ''; state.duplicate = ''; tab = 'all';
  if ($('search')) $('search').value = '';
  for (const id of ['filterBand', 'filterProcessing', 'filterEmail']) { const el = $(id); if (el) el.value = ''; }
  state.page = 1; load();
}
let debounce;
$('search').addEventListener('input', (e) => { clearTimeout(debounce); debounce = setTimeout(() => { state.search = e.target.value; state.page = 1; load(); }, 280); });
for (const [id, key] of [['filterBand', 'band'], ['filterProcessing', 'processing'], ['filterEmail', 'email']]) $(id).addEventListener('change', (e) => { state[key] = e.target.value; state.page = 1; load(); });
$('sort').addEventListener('change', (e) => { [state.sort, state.direction] = e.target.value.split(':'); state.page = 1; load(); });
$('tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) selectTab(b.dataset.tab); });
document.querySelectorAll('.side .nav[data-tab]').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));
$('resetFiltersBtn')?.addEventListener('click', resetFilters);
$('prev').addEventListener('click', () => { if (state.page > 1) { state.page--; load(); } });
$('next').addEventListener('click', () => { if (state.page * state.limit < total) { state.page++; load(); } });
$('refreshBtn').addEventListener('click', load);
$('tableBox').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('tr[data-id]'); if (!row) return;
  if (e.target.closest('input, button, a')) return;
  e.preventDefault(); showDetail(row.dataset.id);
});
$('tableBox').addEventListener('click', (e) => {
  const cb = e.target.closest('input.row-sel'); if (cb) { if (cb.checked) selected.add(cb.dataset.id); else selected.delete(cb.dataset.id); updateActionBar(); return; }
  if (e.target.id === 'selAll') { const on = e.target.checked; for (const l of items) if (on) selected.add(l.lead_id); else selected.delete(l.lead_id); for (const el of document.querySelectorAll('.row-sel')) el.checked = on; updateActionBar(); return; }
  const db = e.target.closest('button[data-id]'); if (db) { showDetail(db.dataset.id); return; }
  const a = e.target.closest('a'); if (a) return;
  const row = e.target.closest('tr[data-id]'); if (row) showDetail(row.dataset.id);
});
$('mergeBtn').addEventListener('click', mergeSelected);
$('ignoreBtn').addEventListener('click', ignoreSelected);
$('clearSelBtn').addEventListener('click', () => { selected.clear(); for (const el of document.querySelectorAll('.row-sel, #selAll')) el.checked = false; updateActionBar(); });
$('refreshGroupsBtn')?.addEventListener('click', loadGroups);
$('toggleRetired')?.addEventListener('change', loadGroups);
$('groupsBox').addEventListener('click', (e) => { const b = e.target.closest('button[data-action]'); if (!b) return; doGroupAction(b.dataset.action, b.dataset.group, b.dataset.lead); });
$('closeDrawer').addEventListener('click', closeDrawer); $('backdrop').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDrawer(); closeAiExtract(); closeAiAsk(); } });
$('logoutBtn').addEventListener('click', async () => { try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin', redirect: 'error', headers: { Origin: location.origin } }); } finally { location.assign('/'); } });
$('openAiExtract').addEventListener('click', openAiExtract);
$('headAiExtract').addEventListener('click', openAiExtract);
$('aiExtractClose').addEventListener('click', closeAiExtract);
$('aiExtractBackdrop').addEventListener('click', closeAiExtract);
$('aiExtractAnalyze').addEventListener('click', aiAnalyze);
$('aiExtractSubmit').addEventListener('click', aiSubmit);
$('openAiAsk').addEventListener('click', openAiAsk);
$('headAiAsk').addEventListener('click', openAiAsk);
$('aiAskClose').addEventListener('click', closeAiAsk);
$('aiAskBackdrop').addEventListener('click', closeAiAsk);
$('aiAskSend').addEventListener('click', aiAsk);
$('aiAskInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); aiAsk(); } });
document.querySelectorAll('.nav[data-go]').forEach((b) => b.addEventListener('click', () => $(b.dataset.go).scrollIntoView({ behavior: 'smooth' })));

detectSession().then(load);
