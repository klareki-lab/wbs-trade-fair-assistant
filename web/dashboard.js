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
let groupPage = 1, auditPage = 1;
let crmBusy = false;

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
  if (!crmEnabled) { bar.hidden = true; return; }
  const n = selected.size;
  if (n > 0) { bar.hidden = false; setText($('auswahlText'), `${n} ausgewählt (maximal 20)`); $('mergeBtn').disabled = n < 2 || n > 20; $('ignoreBtn').disabled = n < 1 || n > 20; }
  else bar.hidden = true;
  renderAiAskContextBadge();
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

// Enum → readable German dictionaries. Unknown values fall back to the raw string
// so new backend enums are visible, never silently dropped.
const DE_TRAINING = { leadership: 'Führung', communication: 'Kommunikation', sales: 'Vertrieb', project_management: 'Projektmanagement', digital_skills: 'Digitale Kompetenzen', ai_automation: 'KI & Automatisierung', other: 'Sonstiges' };
const DE_BUDGET = { approved: 'Freigegeben', planned: 'Geplant', unknown: 'Unbekannt', not_disclosed: 'Nicht genannt', no_budget: 'Kein Budget' };
const DE_FOLLOW = { within_one_week: 'Innerhalb einer Woche', within_two_weeks: 'Innerhalb von zwei Wochen', within_one_month: 'Innerhalb eines Monats', on_date: 'An festem Datum', no_follow_up: 'Kein Follow-up', not_decided: 'Noch offen' };
const DE_UNCERT_FLAG = { email_missing: 'E-Mail-Adresse fehlt', phone_missing: 'Telefonnummer fehlt', ambiguous_training: 'Trainingswunsch mehrdeutig', ambiguous_budget: 'Budgetstatus mehrdeutig', low_confidence: 'Niedrige KI-Konfidenz', unclear_notes: 'Notizen unklar' };
const DE_FIELD = { company_name: 'Firmenname', contact_name: 'Name', email: 'E-Mail', phone: 'Telefon', website: 'Website', training_interest: 'Trainingswunsch', budget_status: 'Budget', follow_up: 'Follow-up', follow_up_date: 'Follow-up-Datum', notes: 'Notizen', summary: 'Zusammenfassung', confidence: 'Konfidenz' };
const DE_RESEARCH = { name: 'Firmenname', industry: 'Branche', size: 'Grösse', employees: 'Mitarbeitende', founded: 'Gegründet', revenue: 'Umsatz', website: 'Website', country: 'Land', city: 'Stadt', region: 'Region', description: 'Beschreibung', summary: 'Zusammenfassung', hq: 'Hauptsitz', legal_form: 'Rechtsform', vat_id: 'USt-IdNr.' };

function labelize(dict, v) { return v == null || v === '' ? '–' : (dict[v] || String(v)); }
function fieldLabel(k) { return DE_FIELD[k] || DE_RESEARCH[k] || k; }

function kvRow(dl, label, value) {
  dl.appendChild(elem('dt', null, label));
  dl.appendChild(elem('dd', null, value == null || value === '' ? '–' : String(value)));
}

function websiteDd(url) {
  const web = safeUrlDisplay(url);
  const dd = document.createElement('dd');
  if (!web) { dd.appendChild(document.createTextNode(url == null || url === '' ? '–' : String(url))); return dd; }
  const a = document.createElement('a'); a.target = '_blank'; a.rel = 'noopener noreferrer'; a.href = web;
  a.appendChild(document.createTextNode(web)); dd.appendChild(a); return dd;
}

function renderConfidence(conf) {
  if (!conf || typeof conf !== 'object' || Array.isArray(conf)) return null;
  const entries = Object.entries(conf).filter(([, v]) => typeof v === 'number' && Number.isFinite(v));
  if (!entries.length) return null;
  const dl = elem('dl', 'kv');
  for (const [k, v] of entries) kvRow(dl, fieldLabel(k), Math.max(0, Math.min(100, Math.round(v * 100))) + ' %');
  return dl;
}

function technicalDetails(label, value) {
  // Preserve information we don't yet know how to label without rendering raw HTML.
  const det = document.createElement('details'); det.className = 'tech-details';
  det.appendChild(elem('summary', null, label || 'Technische Details anzeigen'));
  det.appendChild(elem('pre', 'detailJson', JSON.stringify(value, null, 2)));
  return det;
}

function renderUncertaintyPanel(l) {
  const flags = Array.isArray(l.uncertainty_flags) ? l.uncertainty_flags.filter((x) => x != null) : [];
  const possible = Array.isArray(l.possible_contact_ids) ? l.possible_contact_ids.filter((x) => x != null) : [];
  const aiU = l.ai_uncertainty && typeof l.ai_uncertainty === 'object' && !Array.isArray(l.ai_uncertainty) ? l.ai_uncertainty : null;
  const aiUEntries = aiU ? Object.entries(aiU).filter(([, v]) => v != null && v !== '') : [];
  const box = elem('div');
  if (!flags.length && !possible.length && !aiUEntries.length) {
    box.appendChild(elem('p', 'muted', 'Keine zusätzlichen Hinweise vorhanden.'));
    return box;
  }
  if (flags.length) {
    box.appendChild(elem('h4', null, 'Hinweise'));
    const ul = document.createElement('ul'); ul.className = 'hint-list';
    for (const f of flags) ul.appendChild(elem('li', null, labelize(DE_UNCERT_FLAG, f)));
    box.appendChild(ul);
  }
  if (possible.length) {
    box.appendChild(elem('h4', null, `Mögliche Duplikat-Kontakte (${possible.length})`));
    const ul = document.createElement('ul'); ul.className = 'hint-list';
    for (const id of possible) ul.appendChild(elem('li', 'mono', String(id)));
    box.appendChild(ul);
  }
  if (aiU === null) {
    // Only emit this phrasing when the panel still has non-AI hints to show.
    if (flags.length || possible.length) box.appendChild(elem('p', 'muted', 'Keine KI-Bewertung vorhanden.'));
  } else if (aiUEntries.length) {
    box.appendChild(elem('h4', null, 'KI-Konfidenz je Feld'));
    const dl = elem('dl', 'kv');
    for (const [field, reason] of aiUEntries) {
      const value = typeof reason === 'number' && Number.isFinite(reason)
        ? Math.max(0, Math.min(100, Math.round(reason * 100))) + ' %'
        : String(reason);
      kvRow(dl, fieldLabel(field), value);
    }
    box.appendChild(dl);
  }
  return box;
}

function renderAiExtractionPanel(l) {
  const data = l.ai_extraction;
  if (data == null) return elem('p', 'muted', 'Keine KI-Bewertung vorhanden.');
  if (typeof data !== 'object' || Array.isArray(data)) {
    const box = elem('div');
    box.appendChild(elem('p', 'muted', 'Keine KI-Bewertung vorhanden.'));
    box.appendChild(technicalDetails('Unbekanntes Format anzeigen', data));
    return box;
  }
  const known = ['company_name', 'contact_name', 'email', 'phone', 'website', 'training_interest', 'budget_status', 'follow_up', 'follow_up_date', 'notes', 'summary'];
  const box = elem('div');
  const dl = elem('dl', 'kv'); let used = 0;
  for (const k of known) {
    const v = data[k];
    if (v == null || v === '') continue;
    used++;
    dl.appendChild(elem('dt', null, DE_FIELD[k] || k));
    if (k === 'website') dl.appendChild(websiteDd(v));
    else if (k === 'training_interest') dl.appendChild(elem('dd', null, labelize(DE_TRAINING, v)));
    else if (k === 'budget_status') dl.appendChild(elem('dd', null, labelize(DE_BUDGET, v)));
    else if (k === 'follow_up') dl.appendChild(elem('dd', null, labelize(DE_FOLLOW, v)));
    else if (k === 'notes' || k === 'summary') { const dd = document.createElement('dd'); dd.appendChild(elem('span', 'notiz-inline', String(v))); dl.appendChild(dd); }
    else dl.appendChild(elem('dd', null, String(v)));
  }
  if (used) box.appendChild(dl);
  const confDl = renderConfidence(data.confidence);
  if (confDl) { box.appendChild(elem('h4', null, 'Konfidenz')); box.appendChild(confDl); }
  const extra = Object.keys(data).filter((k) => !known.includes(k) && k !== 'confidence');
  if (extra.length) {
    const sub = Object.fromEntries(extra.map((k) => [k, data[k]]));
    box.appendChild(technicalDetails('Weitere KI-Felder anzeigen', sub));
  }
  if (!used && !confDl && !extra.length) {
    box.appendChild(elem('p', 'muted', 'Keine KI-Bewertung vorhanden.'));
  }
  return box;
}

function renderCompanyResearchPanel(l) {
  const data = l.company_research;
  if (data == null) return elem('p', 'muted', 'Keine Firmenrecherche vorhanden.');
  if (typeof data !== 'object' || Array.isArray(data)) {
    const box = elem('div');
    box.appendChild(elem('p', 'muted', 'Keine zusätzlichen Hinweise vorhanden.'));
    box.appendChild(technicalDetails('Rohdaten anzeigen', data));
    return box;
  }
  const known = Object.keys(DE_RESEARCH);
  const box = elem('div');
  const dl = elem('dl', 'kv'); let used = 0;
  for (const k of known) {
    const v = data[k];
    if (v == null || v === '') continue;
    if (typeof v === 'object') continue; // nested → collapsible below
    used++;
    dl.appendChild(elem('dt', null, DE_RESEARCH[k] || k));
    if (k === 'website') dl.appendChild(websiteDd(v));
    else dl.appendChild(elem('dd', null, String(v)));
  }
  if (used) box.appendChild(dl);
  const unknownKeys = Object.keys(data).filter((k) => !known.includes(k) || typeof data[k] === 'object');
  if (unknownKeys.length) {
    const sub = Object.fromEntries(unknownKeys.map((k) => [k, data[k]]));
    box.appendChild(technicalDetails('Technische Details anzeigen', sub));
  }
  if (!used && !unknownKeys.length) box.appendChild(elem('p', 'muted', 'Keine zusätzlichen Hinweise vorhanden.'));
  return box;
}

function showDetail(id) {
  const l = items.find((x) => x.lead_id === id); if (!l) return;
  setText($('dTitle'), l.company || 'Unbekannte Firma'); setText($('dSub'), l.lead_id);
  const msgs = $('msgs'); clear(msgs);
  const panel = (title) => { const p = elem('div', 'panel'); p.appendChild(elem('h3', null, title)); return p; };
  const p1 = panel('Score und Zustellung'); const dl1 = elem('dl', 'kv');
  kvRow(dl1, 'Score', l.score_total == null ? 'Nicht bewertet' : l.score_total + '/100');
  kvRow(dl1, 'Kategorie', l.score_band); kvRow(dl1, 'Verarbeitung', l.processing_status); kvRow(dl1, 'Fehler', l.processing_error);
  kvRow(dl1, 'E-Mail', l.email_status); kvRow(dl1, 'E-Mail-Fehler', l.email_error); kvRow(dl1, 'Versuche', l.processing_attempts);
  p1.appendChild(dl1); msgs.appendChild(p1);
  const p2 = panel('Kontakt'); const dl2 = elem('dl', 'kv');
  kvRow(dl2, 'Firma', l.company); kvRow(dl2, 'Name', l.contact); kvRow(dl2, 'E-Mail', l.email); kvRow(dl2, 'Telefon', l.phone);
  kvRow(dl2, 'E-Mail bestätigt', l.email_verified ? 'Ja' : 'Nein');
  const web = safeUrlDisplay(l.website);
  if (web) { dl2.appendChild(elem('dt', null, 'Website')); dl2.appendChild(websiteDd(l.website)); }
  kvRow(dl2, 'Erfasst', dateDE(l.created_at)); p2.appendChild(dl2); msgs.appendChild(p2);
  const p3 = panel('Angaben'); const dl3 = elem('dl', 'kv');
  kvRow(dl3, 'Trainingswunsch', labelize(DE_TRAINING, l.training_interest));
  kvRow(dl3, 'Budget', labelize(DE_BUDGET, l.budget_status));
  kvRow(dl3, 'Follow-up', labelize(DE_FOLLOW, l.follow_up));
  kvRow(dl3, 'Follow-up-Datum', l.follow_up_date);
  kvRow(dl3, 'Duplikat', l.duplicate_status); kvRow(dl3, 'Prüfung nötig', l.review_required ? 'Ja' : 'Nein');
  p3.appendChild(dl3); msgs.appendChild(p3);
  const p4 = panel('Notizen'); p4.appendChild(elem('pre', 'notiz', l.notes == null ? '–' : String(l.notes))); msgs.appendChild(p4);
  const p5 = panel('Unsicherheiten / Duplikat-Hinweise'); p5.appendChild(renderUncertaintyPanel(l)); msgs.appendChild(p5);
  const p6 = panel('KI-Auswertung'); p6.appendChild(renderAiExtractionPanel(l)); msgs.appendChild(p6);
  const p7 = panel('Firmenrecherche'); p7.appendChild(renderCompanyResearchPanel(l)); msgs.appendChild(p7);
  $('drawer').classList.add('open'); $('backdrop').classList.add('open'); $('drawer').setAttribute('aria-hidden', 'false');
}
const closeDrawer = () => { $('drawer').classList.remove('open'); $('backdrop').classList.remove('open'); $('drawer').setAttribute('aria-hidden', 'true'); };

// ---------- CRM groups ----------
async function loadGroups() {
  if (!crmEnabled) return;
  const q = new URLSearchParams(); q.set('page', String(groupPage)); q.set('audit_page', String(auditPage)); q.set('limit', '25');
  if ($('toggleRetired')?.checked) q.set('include_retired', 'true');
  try {
    const { status, body } = await fetchJson('/api/dashboard/groups?' + q.toString());
    if (status !== 200 || !body.success || !Array.isArray(body.groups)) throw new Error('CRM_UNAVAILABLE');
    groupsCache = body.groups;
    renderGroups(body.groups);
    renderAudit(body.audit || []);
    setText($('crmPageInfo'), `Gruppen: Seite ${groupPage} · ${body.total} · Audit: Seite ${auditPage} · ${body.audit_total}`);
    $('groupsPrev').disabled = groupPage <= 1; $('groupsNext').disabled = groupPage * 25 >= body.total;
    $('auditPrev').disabled = auditPage <= 1; $('auditNext').disabled = auditPage * 25 >= body.audit_total;
    $('crmError').hidden = true;
    setText($('navGroups'), body.groups.filter((g) => g.status !== 'retired').length || '');
  } catch { setText($('crmError'), 'CRM nicht erreichbar. Bestehende Anzeige bleibt erhalten; bitte erneut laden.'); $('crmError').hidden = false; }
}
function renderGroups(groups) {
  const box = $('groupsBox'); clear(box);
  if (!groups.length) { box.appendChild(elem('div', 'empty', 'Noch keine CRM-Gruppen angelegt.')); return; }
  for (const g of groups) {
    const card = elem('div', 'group-card'); const head = elem('div', 'group-head');
    head.appendChild(elem('strong', null, g.label || g.group_id.slice(0, 8)));
    head.appendChild(pill(g.status));
    head.appendChild(elem('span', 'muted', ' · ' + (g.members?.filter((m) => !m.removed_at).length || 0) + ' aktuelle Lead(s) · ' + dateDE(g.created_at) + ' · ' + (g.created_by || '–')));
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
    }
    card.appendChild(foot);
    box.appendChild(card);
  }
}

function renderAudit(entries) {
  const box = $('auditBox'); clear(box);
  if (!entries.length) { box.appendChild(elem('div', 'empty', 'Noch keine Aktionen.')); return; }
  for (const a of entries) {
    const row = elem('div', 'group-card'); row.dataset.audit = a.audit_id;
    row.appendChild(elem('strong', null, a.action + ' · ' + dateDE(a.at)));
    row.appendChild(elem('div', 'muted', a.by + ' · ' + a.lead_ids.length + ' betroffene Leads'));
    const affected = elem('details'); affected.appendChild(elem('summary', null, 'Betroffene Leads'));
    const list = elem('ul'); for (const id of a.lead_ids) list.appendChild(elem('li', null, id)); affected.appendChild(list); row.appendChild(affected);
    if (a.note) row.appendChild(elem('p', null, a.note));
    if (a.can_revert) { const b = elem('button', 'btn sm', 'Rückgängig'); b.type = 'button'; b.dataset.action = 'revert'; b.dataset.audit = a.audit_id; row.appendChild(b); }
    else row.appendChild(elem('span', 'muted', a.reverted_at ? 'Bereits rückgängig gemacht' : a.action === 'revert' ? 'Protokollierte Rücknahme' : 'Durch spätere Aktion gesperrt'));
    box.appendChild(row);
  }
}
async function crmPost(path, data) {
  if (crmBusy) return null;
  crmBusy = true;
  try {
    const result = await postJson(path, data);
    if (result.status !== 200 || !result.body.success) {
      const conflict = result.status === 409;
      setText($('crmError'), conflict ? 'Konflikt: Die Gruppierung wurde bereits geändert. Daten wurden neu geladen; bitte Aktion erneut auswählen.' : 'CRM-Aktion abgelehnt. Bitte Eingaben prüfen.');
      await loadGroups(); $('crmError').hidden = false;
      return null;
    }
    return result.body;
  } catch { setText($('crmError'), 'Ergebnis unklar. Gruppen und Audit neu laden, bevor du erneut handelst.'); $('crmError').hidden = false; return null; }
  finally { crmBusy = false; }
}

async function postJson(path, body) {
  const resp = await fetch(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30000), headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
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
  const body = await crmPost('/api/dashboard/groups', { lead_ids: ids, label });
  if (body) { selected.clear(); await loadGroups(); renderTable(); liveState('CRM-Gruppe erstellt'); }
  else liveState('CRM-Aktion abgelehnt', true);
}
async function ignoreSelected() {
  const ids = [...selected].filter((x) => LEAD_ID.test(x));
  if (!ids.length) return;
  const note = window.prompt('Begründung (optional):', '');
  if (note === null) return;
  const body = await crmPost('/api/dashboard/groups/ignore', { lead_ids: ids, label: 'Ignoriert ' + new Date().toISOString().slice(0, 10), note: note || null });
  if (body) { selected.clear(); await loadGroups(); renderTable(); liveState('Als Duplikate ignoriert'); }
  else liveState('CRM-Aktion abgelehnt', true);
}
async function doGroupAction(action, groupId, leadId, auditId) {
  if (action === 'split' && UUID.test(groupId)) { if (await crmPost('/api/dashboard/groups/split', { group_id: groupId })) await loadGroups(); }
  if (action === 'extract' && UUID.test(groupId) && LEAD_ID.test(leadId)) { if (await crmPost('/api/dashboard/groups/extract', { group_id: groupId, lead_id: leadId })) await loadGroups(); }
  if (action === 'revert' && UUID.test(auditId)) { if (await crmPost('/api/dashboard/groups/revert', { audit_id: auditId })) await loadGroups(); }
}

// ---------- AI capture (WF-07) ----------
const EXTRACT_FIELDS = ['company_name','contact_name','email','phone','website','training_interest','budget_status','follow_up','follow_up_date','notes'];
const CAPTURE_MAX = { company_name:200, contact_name:160, email:254, phone:40, website:2048, training_interest:64, budget_status:64, follow_up:64, follow_up_date:10, notes:10000 };
let aiPending = null, aiSubmitting = false;
// Persist only an opaque id, never notes or contact data. A lost response must not rotate it.
let aiSubmissionId = null;
try { aiSubmissionId = sessionStorage.getItem('messe:pending-submission-id'); } catch { /* Other dashboard tools remain available if storage is blocked. */ }
let aiExtractCurrent = null;
function openAiExtract() {
  if (aiPending) { $('aiExtractModal').hidden = false; $('aiExtractBackdrop').hidden = false; $('aiExtractModal').setAttribute('aria-hidden','false'); return; }
  $('aiExtractModal').hidden = false; $('aiExtractBackdrop').hidden = false; $('aiExtractModal').setAttribute('aria-hidden', 'false');
  $('aiPrivacyConsent').checked = false;
  $('aiExtractInput').value = ''; $('aiExtractPanel').hidden = true; $('aiExtractSubmit').disabled = true; $('aiExtractError').hidden = true; aiExtractCurrent = null;
  if (aiSubmissionId) { setText($('aiExtractError'), 'Eine frühere Übertragung ist ungeklärt. Derselbe Übertragungsschlüssel wird wiederverwendet; bei Konflikt muss der Eingang geprüft werden.'); $('aiExtractError').hidden = false; }
  if (!aiEnabled) { const err = $('aiExtractError'); setText(err, 'WF-07 (AI-Erfassung) ist nicht konfiguriert. Owner aktiviert N8N_AI_EXTRACT_URL.'); err.hidden = false; $('aiExtractAnalyze').disabled = true; }
  else $('aiExtractAnalyze').disabled = false;
}
function closeAiExtract() { $('aiExtractModal').hidden = true; $('aiExtractBackdrop').hidden = true; $('aiExtractModal').setAttribute('aria-hidden', 'true'); }
async function aiAnalyze() {
  if (aiPending || aiSubmitting) return;
  $('aiExtractPanel').hidden = true; $('aiExtractSubmit').disabled = true; aiExtractCurrent = null;
  const err = $('aiExtractError'); err.hidden = true; const btn = $('aiExtractAnalyze'); btn.disabled = true;
  try {
    if (!$('aiPrivacyConsent').checked) { setText(err, 'Bitte die Übertragung der freigegebenen Notiz an den KI-Anbieter bestätigen.'); err.hidden = false; return; }
    const notes = $('aiExtractInput').value.trim(); if (notes.length < 10) { setText(err, 'Notiz ist zu kurz (mind. 10 Zeichen).'); err.hidden = false; return; }
    const { status, body } = await postJson('/api/dashboard/ai/extract', { notes, session_id: sessionId });
    if (status !== 200 || !body.success) { setText(err, body?.error?.message || 'AI nicht erreichbar.'); err.hidden = false; return; }
    aiExtractCurrent = body;
    const panel = $('aiExtractPanel'); panel.hidden = false;
    setText($('aiExtractMeta'), body.assistant_message || '');
    const form = $('aiExtractForm'); clear(form);
    const EXTRACT_LABEL = { company_name: 'Firmenname', contact_name: 'Name', email: 'E-Mail', phone: 'Telefon', website: 'Website', training_interest: 'Trainingswunsch', budget_status: 'Budget', follow_up: 'Follow-up', follow_up_date: 'Follow-up-Datum', notes: 'Notizen' };
    const ENUM_OPTIONS = {
      training_interest: [['leadership','Führung'],['communication','Kommunikation'],['sales','Vertrieb'],['project_management','Projektmanagement'],['digital_skills','Digitale Kompetenzen'],['ai_automation','KI & Automatisierung'],['other','Sonstiges']],
      budget_status: [['approved','Freigegeben'],['planned','Geplant'],['unknown','Unbekannt'],['not_disclosed','Nicht genannt'],['no_budget','Kein Budget']],
      follow_up: [['within_one_week','Innerhalb einer Woche'],['within_two_weeks','Innerhalb von zwei Wochen'],['within_one_month','Innerhalb eines Monats'],['on_date','An festem Datum'],['no_follow_up','Kein Follow-up'],['not_decided','Noch offen']],
    };
    for (const k of EXTRACT_FIELDS) {
      const value = body.extracted[k] ?? '';
      const conf = typeof body.confidence?.[k] === 'number' ? Math.round(body.confidence[k] * 100) : null;
      const row = elem('div', 'field'); row.dataset.field = k;
      const lab = elem('label', null, (EXTRACT_LABEL[k] || k) + (conf !== null ? ' · Konfidenz ' + conf + '%' : ''));
      lab.setAttribute('for', 'aix_' + k);
      row.appendChild(lab);
      let inp;
      if (ENUM_OPTIONS[k]) {
        inp = document.createElement('select');
        const opt0 = document.createElement('option'); opt0.value = ''; opt0.textContent = '— bitte auswählen —'; inp.appendChild(opt0);
        for (const [val, label] of ENUM_OPTIONS[k]) { const o = document.createElement('option'); o.value = val; o.textContent = label; if (val === value) o.selected = true; inp.appendChild(o); }
      } else {
        inp = (k === 'notes' || k === 'summary') ? document.createElement('textarea') : document.createElement('input');
        if (inp.tagName === 'TEXTAREA') inp.rows = 3;
        inp.value = value || '';
        inp.setAttribute('maxlength', CAPTURE_MAX[k]);
      }
      inp.id = 'aix_' + k; inp.name = k;
      row.appendChild(inp);
      const confirmLabel = elem('label', 'confirm-field'); const confirmed = document.createElement('input'); confirmed.type = 'checkbox'; confirmed.className = 'field-confirm'; confirmed.dataset.field = k;
      confirmed.checked = !value; confirmLabel.appendChild(confirmed); confirmLabel.appendChild(document.createTextNode('Wert geprüft und bestätigt')); row.appendChild(confirmLabel);
      const fieldErr = elem('p', 'field-inline-error p-err'); fieldErr.hidden = true; fieldErr.dataset.errorFor = k; row.appendChild(fieldErr);
      const handler = () => { confirmed.checked = !(inp.value || '').toString().trim(); if (!fieldErr.hidden) { fieldErr.hidden = true; row.classList.remove('field-invalid'); } };
      inp.addEventListener('input', handler); inp.addEventListener('change', handler);
      form.appendChild(row);
    }
    const warnings = $('aiExtractWarnings'); clear(warnings);
    const DE_FLAG = { unsupported_training_interest: 'Trainingswunsch: Bitte Auswahl prüfen.', unsupported_budget_status: 'Budget: Bitte Auswahl prüfen.', unsupported_follow_up: 'Follow-up: Bitte Auswahl prüfen.', unsupported_company_name: 'Firmenname fehlt.', unsupported_contact_name: 'Name fehlt.', unsupported_email: 'E-Mail: Bitte prüfen.', unsupported_phone: 'Telefon: Bitte prüfen.', unsupported_website: 'Website: Bitte prüfen.' };
    for (const f of body.uncertainty_flags || []) { warnings.appendChild(elem('li', 'p-warn', DE_FLAG[f] || f)); }
    $('aiExtractSubmit').disabled = false;
  } catch (_) { setText(err, 'Verbindungsfehler.'); err.hidden = false; }
  finally { btn.disabled = aiEnabled ? false : true; }
}
async function aiSubmit() {
  if (aiSubmitting) return;
  const err = $('aiExtractError'); err.hidden = true;
  if (!aiPending) {
    if (!aiExtractCurrent) return;
    const form = $('aiExtractForm');
    if ([...form.querySelectorAll('.field-confirm')].some((c) => !c.checked)) { setText(err, 'Bitte jeden ausgefüllten Wert bestätigen, insbesondere Trainingsinteresse, Budget und Follow-up.'); err.hidden = false; return; }
    const payload = { source: 'internal_form', submission_id: aiSubmissionId || ('ai-' + crypto.randomUUID()) };
    for (const el of form.querySelectorAll('[name]')) if (el.value.trim()) payload[el.name] = el.value.trim();
    if (Object.keys(CAPTURE_MAX).some((k) => payload[k] && payload[k].length > CAPTURE_MAX[k])) { setText(err, 'Ein Feld überschreitet die zulässige Länge. Bitte kürzen.'); err.hidden = false; return; }
    if (!payload.company_name) { setText(err, 'Firmenname ist erforderlich.'); err.hidden = false; return; }
    aiSubmissionId = payload.submission_id;
    try { sessionStorage.setItem('messe:pending-submission-id', aiSubmissionId); } catch { setText(err, 'Der Browser kann den Übertragungsschlüssel nicht sichern. Bitte Sitzungsspeicher erlauben, bevor du sendest.'); err.hidden = false; return; }
    aiPending = payload;
  }
  aiSubmitting = true; $('aiExtractSubmit').disabled = true; $('aiExtractAnalyze').disabled = true;
  for (const el of $('aiExtractForm').querySelectorAll('input,textarea')) el.disabled = true;
  try {
    const { status, body } = await postJson('/api/leads', aiPending);
    if ([200,201].includes(status) && body.success && body.persisted) {
      try { sessionStorage.removeItem('messe:pending-submission-id'); } catch {} aiSubmissionId = null; aiPending = null; aiExtractCurrent = null;
      closeAiExtract(); liveState('Lead übernommen · ' + body.lead_id); load();
    } else if (status === 422 && body.persistence_status === 'not_stored') {
      aiPending = null;
      for (const el of $('aiExtractForm').querySelectorAll('input,textarea,select')) el.disabled = false;
      // Clear previous per-field errors.
      for (const n of $('aiExtractForm').querySelectorAll('.field-inline-error')) { n.hidden = true; n.textContent = ''; }
      for (const n of $('aiExtractForm').querySelectorAll('.field')) n.classList.remove('field-invalid');
      const details = Array.isArray(body.error?.details) ? body.error.details : [];
      const seen = [];
      const DE_CODE = { REQUIRED: 'Pflichtfeld', INVALID_VALUE: 'Wert nicht erlaubt', INVALID_EMAIL: 'E-Mail-Format falsch', INVALID_PHONE: 'Telefonnummer-Format falsch', INVALID_WEBSITE: 'Website-URL falsch', INVALID_DATE: 'Datum ungültig', TOO_LONG: 'Zu lang', INVALID_NAME: 'Name ungültig', INVALID_TYPE: 'Falscher Datentyp' };
      for (const d of details) {
        const row = $('aiExtractForm').querySelector('[data-field="' + d.field + '"]');
        if (row) {
          const node = row.querySelector('.field-inline-error');
          if (node) { node.textContent = (DE_CODE[d.code] || d.code) + '. Bitte korrigieren.'; node.hidden = false; }
          row.classList.add('field-invalid');
          seen.push(d.field);
        }
      }
      const summary = seen.length ? ('Nicht gespeichert. Bitte Felder korrigieren: ' + seen.join(', ')) : 'Nicht gespeichert. Bitte Angaben prüfen.';
      setText(err, summary); err.hidden = false;
      // Scroll the first invalid field into view so the Owner sees it immediately.
      const firstInvalid = $('aiExtractForm').querySelector('.field-invalid'); if (firstInvalid) firstInvalid.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } else {
      setText(err, status === 409 ? 'Übertragungskonflikt. Eingang prüfen lassen; kein neuer Schlüssel und kein weiterer Lead werden erzeugt.' : 'Ergebnis unklar. Erneut senden verwendet exakt dieselben Daten und denselben Schlüssel.'); err.hidden = false;
    }
  } catch { setText(err, 'Verbindungsfehler; derselbe Übertragungsschlüssel und dieselben Daten bleiben für den erneuten Versuch erhalten.'); err.hidden = false; }
  finally { aiSubmitting = false; $('aiExtractSubmit').disabled = !aiExtractCurrent; $('aiExtractAnalyze').disabled = !!aiPending || !aiEnabled; }
}
window.addEventListener('beforeunload', (e) => { if (aiPending) { e.preventDefault(); e.returnValue = ''; } });

// ---------- AI assistant (WF-08) ----------
function openAiAsk() {
  $('aiAskModal').hidden = false; $('aiAskBackdrop').hidden = false; $('aiAskModal').setAttribute('aria-hidden', 'false');
  clear($('aiAskThread')); $('aiAskError').hidden = true; $('aiAskInput').value = '';
  renderAiAskContextBadge();
  if (!aiEnabled) { const err = $('aiAskError'); setText(err, 'WF-08 (Lead-Assistent) ist nicht konfiguriert. Owner aktiviert N8N_AI_ASK_URL.'); err.hidden = false; $('aiAskSend').disabled = true; }
  else $('aiAskSend').disabled = false;
}
// Context the assistant will see: selected leads if any; otherwise the leads
// currently visible on screen. Capped at 20 (WF-08 / scoped ai_lead_context).
function aiAskContextIds() {
  const picked = [...selected].filter((x) => LEAD_ID.test(x));
  if (picked.length) return { ids: picked.slice(0, 20), source: 'selected', total: picked.length };
  const visible = items.slice(0, 20).map((l) => l.lead_id);
  return { ids: visible, source: 'visible', total: items.length };
}
function renderAiAskContextBadge() {
  const el = $('aiAskContextInfo'); if (!el) return;
  const { ids, source, total } = aiAskContextIds();
  const label = source === 'selected' ? 'Ausgewählte Leads' : 'Erste sichtbare Leads';
  const truncated = total > ids.length ? ` (von ${total} — nur die ersten ${ids.length} werden an die KI übergeben)` : '';
  setText(el, `${label}: ${ids.length}${truncated}`);
}
function closeAiAsk() { $('aiAskModal').hidden = true; $('aiAskBackdrop').hidden = true; $('aiAskModal').setAttribute('aria-hidden', 'true'); }
async function aiAsk() {
  const err = $('aiAskError'); err.hidden = true;
  const q = $('aiAskInput').value.trim(); if (q.length < 3) return;
  const thread = $('aiAskThread');
  const userMsg = elem('div', 'msg user'); userMsg.appendChild(elem('div', 'msg-head', 'Du')); userMsg.appendChild(elem('div', 'msg-body', q)); thread.appendChild(userMsg);
  $('aiAskInput').value = ''; $('aiAskSend').disabled = true;
  try {
    const { ids: ctx, source, total } = aiAskContextIds();
    if (!ctx.length) { setText(err, 'Keine Leads im Kontext. Bitte Leads auswählen oder laden.'); err.hidden = false; return; }
    const { status, body } = await postJson('/api/dashboard/ai/ask', { question: q, context_lead_ids: ctx, session_id: sessionId });
    if (status !== 200 || !body.success) { setText(err, body?.error?.message || 'AI nicht erreichbar.'); err.hidden = false; return; }
    // Transparent note so the Owner always sees which leads WF-08 saw.
    const contextInfo = source === 'selected'
      ? (total > ctx.length ? `Kontext: ${ctx.length} von ${total} ausgewählten Leads (Obergrenze 20).` : `Kontext: ${ctx.length} ausgewählte Lead(s).`)
      : (total > ctx.length ? `Kontext: erste ${ctx.length} sichtbare Leads (insgesamt ${total}; keine Auswahl getroffen).` : `Kontext: ${ctx.length} sichtbare Lead(s).`);
    const aiMsg = elem('div', 'msg assistant'); aiMsg.appendChild(elem('div', 'msg-head', 'Lead-Assistent'));
    aiMsg.appendChild(elem('div', 'msg-context', contextInfo));
    // Prefer the proxy's grouped summary when present; fall back to the raw answer.
    const summary = typeof body.answer_summary === 'string' && body.answer_summary.trim() ? body.answer_summary : body.answer;
    aiMsg.appendChild(elem('div', 'msg-body', summary));
    // The canonical WF-08 warning is preserved verbatim in Gateway body.answer.
    if (typeof body.answer === 'string' && /^\s*⚠\s*Ergebnis unvollständig\b/u.test(body.answer)) {
      aiMsg.appendChild(elem('div', 'msg-warn', 'Nicht alle angefragten Werte wurden geliefert. Bitte Kontext oder Felder eingrenzen.'));
    }
    const groups = Array.isArray(body.groups) ? body.groups : [];
    if (groups.length) {
      const det = document.createElement('details'); det.className = 'ai-groups'; det.appendChild(elem('summary', null, 'Details anzeigen (' + groups.reduce((n, g) => n + (g.count || 0), 0) + ')'));
      for (const g of groups) {
        const row = elem('div', 'ai-group');
        row.appendChild(elem('div', 'ai-group-head', (g.field_label || g.field) + ' = ' + (g.value == null ? 'unbekannt' : String(g.value)) + '  ·  ' + g.count + ' Lead(s)'));
        const ul = document.createElement('ul'); ul.className = 'ai-group-ids';
        for (const id of (g.lead_ids || [])) ul.appendChild(elem('li', 'mono', id));
        row.appendChild(ul); det.appendChild(row);
      }
      aiMsg.appendChild(det);
    } else if (Array.isArray(body.cited_lead_ids) && body.cited_lead_ids.length) {
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
    $('gruppen').hidden = !crmEnabled;
    const crmNav = document.querySelector('[data-go="gruppen"]'); if (crmNav) crmNav.hidden = !crmEnabled;
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
$('auditBox').addEventListener('click', (e) => { const b = e.target.closest('button[data-audit]'); if (b) doGroupAction('revert', null, null, b.dataset.audit); });
for (const [id, kind, delta] of [['groupsPrev','group',-1],['groupsNext','group',1],['auditPrev','audit',-1],['auditNext','audit',1]]) $(id).addEventListener('click', () => { if (kind === 'group') groupPage = Math.max(1,groupPage+delta); else auditPage = Math.max(1,auditPage+delta); loadGroups(); });
$('toggleRetired')?.addEventListener('change', () => { groupPage = 1; loadGroups(); });
$('groupsBox').addEventListener('click', (e) => { const b = e.target.closest('button[data-action]'); if (!b) return; doGroupAction(b.dataset.action, b.dataset.group, b.dataset.lead, b.dataset.audit); });
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

// Narrow test hook: UI regression tests inject a synthetic lead and open the
// drawer. Never used by product code, never exposes shared mutable state.
if (typeof window !== 'undefined') window.__wbsRenderLeadDetail = (lead) => { items = [lead]; showDetail(lead.lead_id); };
