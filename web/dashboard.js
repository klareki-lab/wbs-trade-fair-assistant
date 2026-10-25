// WBS Messe Hub V1 — same-origin, read-only, strictly escaped.
// Fetches /api/dashboard/leads with the gateway session cookie. No external URLs.
// Allowlisted fields only. No HTML interpolation; every text goes through textContent.
'use strict';

const $ = (id) => document.getElementById(id);

// textContent-only renderer so no upstream string can ever become HTML/JS.
function setText(el, value) {
  while (el.firstChild) el.removeChild(el.firstChild);
  el.appendChild(document.createTextNode(value == null || value === '' ? '–' : String(value)));
}
function elem(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.appendChild(document.createTextNode(String(text)));
  return n;
}
function pill(value) {
  const span = elem('span', 'pill ' + (
    /^(HOT|completed|NEW)$/.test(value) ? 'p-ok' :
    /^(WARM|POSSIBLE_DUPLICATE|processing)$/.test(value) ? 'p-warn' :
    /^(failed|EXISTING_CONTACT)$/.test(value) ? 'p-err' : 'p-n'
  ), value || 'unbekannt');
  return span;
}
function germanDate(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '–';
  return d.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
}

const state = { page: 1, limit: 25, total: 0, leads: [], asOf: null, filter: '' };
let liveReq = 0;

function setLive(message, status) {
  const el = $('liveText');
  if (el) setText(el, message);
  const pulse = $('pulse');
  if (pulse) pulse.classList.toggle('unavailable', status === 'error');
}

function renderStats() {
  const total = state.total;
  const hot = state.leads.filter((l) => l.score_band === 'HOT').length;
  const dup = state.leads.filter((l) => l.duplicate_status !== 'NEW').length;
  setText($('kGesamt'), total);
  setText($('kA'), hot);
  setText($('kASub'), 'auf dieser Seite');
  setText($('kDup'), dup);
}

function clientFilter(leads, filter) {
  if (!filter) return leads;
  const q = filter.toLowerCase();
  return leads.filter((l) =>
    (l.company_name || '').toLowerCase().includes(q) ||
    (l.contact_name || '').toLowerCase().includes(q) ||
    (l.lead_id || '').toLowerCase().includes(q),
  );
}

function renderTable() {
  const box = $('tableBox');
  while (box.firstChild) box.removeChild(box.firstChild);
  const visible = clientFilter(state.leads, state.filter);
  if (!visible.length) {
    box.appendChild(elem('div', 'empty', state.leads.length ? 'Keine Treffer für die Suche.' : 'Keine Leads vorhanden.'));
    return;
  }
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const h of ['Erfasst', 'Firma', 'Kontakt', 'Score', 'Verarbeitung', 'Duplikat', 'Prüfung']) headRow.appendChild(elem('th', null, h));
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const l of visible) {
    const tr = document.createElement('tr');
    tr.dataset.id = l.lead_id;
    tr.tabIndex = 0;
    tr.setAttribute('role', 'button');
    tr.setAttribute('aria-label', 'Details für ' + (l.company_name || l.lead_id) + ' öffnen');
    tr.appendChild(elem('td', null, germanDate(l.created_at)));
    tr.appendChild(elem('td', null, l.company_name || '–'));
    tr.appendChild(elem('td', null, l.contact_name || '–'));
    const scoreCell = document.createElement('td'); scoreCell.appendChild(pill(l.score_band || 'UNSCORED')); tr.appendChild(scoreCell);
    const procCell = document.createElement('td'); procCell.appendChild(pill(l.processing_status)); tr.appendChild(procCell);
    const dupCell = document.createElement('td'); dupCell.appendChild(pill(l.duplicate_status)); tr.appendChild(dupCell);
    tr.appendChild(elem('td', null, l.review_required ? 'Ja' : 'Nein'));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  box.appendChild(table);
  const info = $('pageInfo'); if (info) setText(info, 'Seite ' + state.page + ' · ' + state.total + ' Einträge gesamt');
  $('prev').disabled = state.page <= 1;
  $('next').disabled = state.page * state.limit >= state.total;
}

function showDetail(leadId) {
  const l = state.leads.find((x) => x.lead_id === leadId);
  if (!l) return;
  setText($('dTitle'), l.company_name || 'Unbekannte Firma');
  setText($('dSub'), l.lead_id);
  const msgs = $('msgs');
  while (msgs.firstChild) msgs.removeChild(msgs.firstChild);
  const dl = document.createElement('dl'); dl.className = 'kv';
  const kv = (label, value) => { dl.appendChild(elem('dt', null, label)); dl.appendChild(elem('dd', null, value == null || value === '' ? '–' : String(value))); };
  kv('Firma', l.company_name);
  kv('Kontakt', l.contact_name);
  kv('Erfasst', germanDate(l.created_at));
  kv('Score', l.score_band || 'Nicht bewertet');
  kv('Verarbeitung', l.processing_status);
  kv('Duplikat', l.duplicate_status);
  kv('Prüfung nötig', l.review_required ? 'Ja' : 'Nein');
  const panel = elem('div', 'panel'); panel.appendChild(elem('h3', null, 'Freigegebene Felder (V1)')); panel.appendChild(dl);
  const note = elem('div', 'panel');
  note.appendChild(elem('h3', null, 'Nicht in V1 enthalten'));
  note.appendChild(elem('p', 'muted', 'Rohnotizen, E-Mail, Telefon, KI-Auswertung und Firmenrecherche werden in V1 nicht an den Browser ausgeliefert.'));
  msgs.appendChild(panel);
  msgs.appendChild(note);
  $('drawer').hidden = false;
  $('backdrop').hidden = false;
  $('drawer').setAttribute('aria-hidden', 'false');
  $('drawer').classList.add('open');
  $('backdrop').classList.add('open');
}
function closeDetail() {
  $('drawer').classList.remove('open');
  $('backdrop').classList.remove('open');
  $('drawer').hidden = true;
  $('backdrop').hidden = true;
  $('drawer').setAttribute('aria-hidden', 'true');
}

async function load() {
  const id = ++liveReq;
  setLive('Lade Daten …');
  $('refreshBtn').disabled = true;
  const q = new URLSearchParams({ page: String(state.page), limit: String(state.limit) }).toString();
  try {
    const resp = await fetch('/api/dashboard/leads?' + q, {
      method: 'GET', credentials: 'same-origin', cache: 'no-store',
      redirect: 'error', headers: { Accept: 'application/json' },
    });
    if (resp.status === 401) { window.location.assign('/'); return; }
    if (resp.status === 503) { throw new Error('Daten vorübergehend nicht erreichbar.'); }
    if (!resp.ok) { throw new Error('Dashboard-API HTTP ' + resp.status); }
    const data = await resp.json();
    if (id !== liveReq) return;
    if (!data || data.success !== true || !Array.isArray(data.leads)) throw new Error('Ungültige Antwort.');
    state.total = Number.isInteger(data.total) ? data.total : 0;
    state.leads = data.leads;
    state.asOf = typeof data.as_of === 'string' ? data.as_of : null;
    renderStats();
    renderTable();
    setLive('Live · read-only', 'ok');
    setText($('pageSub'), 'Überblick über alle Messe-Leads · letzte Aktualisierung ' + germanDate(state.asOf));
  } catch (err) {
    if (id !== liveReq) return;
    setLive('Daten nicht verfügbar', 'error');
    const box = $('tableBox');
    while (box.firstChild) box.removeChild(box.firstChild);
    box.appendChild(elem('div', 'empty', 'Daten konnten nicht geladen werden. Bitte in einer Minute erneut versuchen.'));
    setText($('pageSub'), 'Letzte Aktualisierung fehlgeschlagen');
  } finally {
    if (id === liveReq) $('refreshBtn').disabled = false;
  }
}

let searchTimer;
$('search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.filter = String(e.target.value || '').slice(0, 120); renderTable(); }, 200);
});
$('refreshBtn').addEventListener('click', load);
$('prev').addEventListener('click', () => { if (state.page > 1) { state.page--; load(); } });
$('next').addEventListener('click', () => { if (state.page * state.limit < state.total) { state.page++; load(); } });
$('tableBox').addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-id]'); if (!row) return;
  showDetail(row.dataset.id);
});
$('tableBox').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('tr[data-id]'); if (!row) return;
  e.preventDefault(); showDetail(row.dataset.id);
});
$('closeDrawer').addEventListener('click', closeDetail);
$('backdrop').addEventListener('click', closeDetail);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });
$('logoutBtn').addEventListener('click', async () => {
  try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin', redirect: 'error', headers: { Accept: 'application/json' } }); } catch (_) {}
  window.location.assign('/');
});
document.querySelectorAll('.nav[data-go]').forEach((b) => b.addEventListener('click', () => {
  const target = document.getElementById(b.dataset.go);
  if (target) target.scrollIntoView({ behavior: 'smooth' });
}));

load();
