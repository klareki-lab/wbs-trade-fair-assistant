/* Integration of Yuri's Berater-Formular with the existing same-origin gateway.
   No credentials here; the gateway owns X-Trade-Fair-Key. */
(() => {
  'use strict';
  const storeKey = 'trade-fair:berater:pending:v1';
  const receiptKey = 'trade-fair:berater:receipt:v1';
  const msg = document.getElementById('integrationStatus');
  const send = document.getElementById('sendLead');
  const retry = document.getElementById('retryLead');
  const check = document.getElementById('checkLead');
  const fields = document.getElementById('leadForm');
  const maxNotes = 10000;
  let pending = restore(storeKey);
  let receipt = restore(receiptKey);
  let busy = false;
  const text = (s) => String(s || '').trim();
  const val = (o, k) => text(o[k]);
  function restore(key) { try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { return null; } }
  function save(key, obj) { sessionStorage.setItem(key, JSON.stringify(obj)); }
  function say(message) { msg.textContent = message; }
  function lock(locked) { fields.querySelectorAll('input,select,textarea').forEach((el) => { el.disabled = locked; }); }
  function update() {
    retry.hidden = !pending;
    send.disabled = !!pending || busy;
    check.hidden = !receipt;
    lock(!!pending || busy);
  }
  function topic(v) {
    const t = v.toLowerCase();
    if (!t) return null;
    if (/\bki\b|\bai\b|künstliche intelligenz|automatis/.test(t)) return 'ai_automation';
    if (/führung|leadership|management von mitarbeit/.test(t)) return 'leadership';
    if (/kommunikation|gespräch|rhetorik/.test(t)) return 'communication';
    if (/verkauf|vertrieb|sales/.test(t)) return 'sales';
    if (/projektmanagement|projektleitung/.test(t)) return 'project_management';
    if (/digital|software|computer/.test(t)) return 'digital_skills';
    return 'other';
  }
  function budget(v) {
    if (!v) return null;
    if (/^Genehmigt/.test(v)) return 'approved';
    if (/^Beantragt|^Reserviert|^Unverbindliche/.test(v)) return 'planned';
    if (/^Abgelehnt/.test(v)) return 'no_budget';
    if (/^Nicht besprochen/.test(v)) return 'not_disclosed';
    return 'unknown';
  }
  function followUp(v) {
    if (!v) return null;
    if (/Keine weitere Kontaktaufnahme/.test(v)) return 'no_follow_up';
    return 'not_decided'; // Never invent a calendar deadline from free text.
  }
  function prepare() {
    const d = getData(); // Original Yuri export contract, kept intact.
    const v = d.strukturierte_daten;
    if (!val(v,'firma')) throw Error('Für WF-A bitte „Unternehmen“ ausfüllen. Der JSON-Export funktioniert weiterhin ohne Firmennamen.');
    let email = val(v,'kontakt_email');
    // Uncertain/raw contacts belong in the original note, not validated canonical fields.
    if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /\?|unsicher|unbekannt/i.test(email))) email = '';
    let phone = val(v,'kontakt_telefon');
    if (phone && (!/^\+?[0-9() .\/-]+$/.test(phone) || phone.replace(/\D/g,'').length < 7 || phone.replace(/\D/g,'').length > 20)) phone = '';
    let website = val(v,'website');
    if (website && !/^https?:\/\//i.test(website)) website = '';
    // Yuri's complete original export is represented in the notes, including all raw values.
    // Keep the header; it associates the transformed lead with the local form export.
    const notes = `Berater-Formular / Erfassungs-ID: ${d.erfassung_id}\n${d.notiz}`;
    if ([...notes].length > maxNotes) throw Error('Die Gesprächsnotizen überschreiten 10.000 Zeichen. Bitte kürzen und vorher JSON exportieren.');
    const payload = {
      company_name: val(v,'firma'), contact_name: val(v,'kontakt_name') || null,
      email: email || null, phone: phone || null, website: website || null,
      training_interest: topic(val(v,'themen')), budget_status: budget(val(v,'budgetstatus')),
      follow_up: followUp(val(v,'kontaktwunsch')),
      follow_up_date: null, notes,
      // reuse one ID through retries, never mint a new ID for an ambiguous request
      submission_id: `berater-${d.erfassung_id}`, source: 'internal_form'
    };
    if (!payload.contact_name && !payload.email && !payload.phone && (!val(v,'originalnotiz') || val(v,'originalnotiz').length < 10)) {
      throw Error('Bitte Kontaktinformationen oder eine aussagekräftige Gesprächsnotiz eingeben.');
    }
    const body = JSON.stringify(payload);
    if (new TextEncoder().encode(body).length > 32768) throw Error('Anfrage überschreitet die Gateway-Grenze von 32 KiB.');
    return body;
  }
  async function request(url, options = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await fetch(url, { ...options, credentials: 'same-origin', cache: 'no-store', signal: ctrl.signal });
      let data = null;
      try { data = await res.json(); } catch { /* unexpected content is failure */ }
      return { res, data };
    } finally { clearTimeout(timer); }
  }
  async function submit() {
    if (busy) return;
    if (!pending) {
      try { pending = { body: prepare() }; save(storeKey, pending); }
      catch (e) { say(e.message); return; }
    }
    busy = true; update(); say('Übermittlung läuft …');
    try {
      const auth = await request('/api/session');
      if (auth.data?.authenticated !== true) {
        say('Bitte zuerst über die Startseite anmelden. Deine ungesendeten Daten bleiben in diesem Tab erhalten.');
        return;
      }
      const {res, data} = await request('/api/leads', {
        method: 'POST', headers: {'Content-Type':'application/json'}, body: pending.body,
      });
      const supplied = JSON.parse(pending.body);
      if ((res.status === 201 || res.status === 200) && data?.success === true && data?.persisted === true &&
          typeof data.lead_id === 'string' && /^FAIR-[0-9a-f-]{36}$/.test(data.lead_id) &&
          typeof data.idempotent_replay === 'boolean' && ((res.status === 200) === data.idempotent_replay)) {
        receipt = { lead_id: data.lead_id, submission_id: supplied.submission_id };
        save(receiptKey, receipt);
        pending = null; sessionStorage.removeItem(storeKey);
        say(`Gespeichert: ${data.lead_id}. Du kannst den Bearbeitungsstatus prüfen.`);
      } else if (res.status === 409) {
        say('Konflikt (409): dieselbe Erfassungs-ID wurde mit anderen Daten verwendet. Kein neuer Lead gespeichert. Bitte JSON sichern und einen neuen Vorgang beginnen.');
      } else if ([400, 413, 415, 422].includes(res.status) && data?.persistence_status === 'not_stored') {
        pending = null; sessionStorage.removeItem(storeKey);
        const details = (data?.error?.details || []).map(x => x.field).filter(Boolean).join(', ');
        say(`Eingaben nicht akzeptiert (${res.status}). ${data?.error?.message || ''}${details ? ' Felder: ' + details : ''} Bitte korrigieren.`);
      } else {
        say(`Speicherung nicht bestätigt (${res.status}). Bitte exakt dieselbe Übermittlung erneut versuchen.`);
      }
    } catch {
      say('Netzwerkfehler oder Timeout. Speicherung unklar. Bitte exakt dieselbe Übermittlung erneut versuchen.');
    } finally { busy = false; update(); }
  }
  async function getStatus() {
    if (!receipt) return;
    try {
      const url = `/api/leads/${encodeURIComponent(receipt.lead_id)}?submission_id=${encodeURIComponent(receipt.submission_id)}`;
      const {res, data} = await request(url);
      if (res.status === 200 && data?.success === true && data?.lead_id === receipt.lead_id) {
        say(`Lead ${receipt.lead_id}: ${data.processing_status || 'Status unbekannt'}, Score: ${data.lead_score ?? '–'}, E-Mail: ${data.email_status || '–'}`);
      } else say(`Status momentan nicht verfügbar (${res.status}).`);
    } catch { say('Status derzeit nicht erreichbar.'); }
  }
  send.addEventListener('click', submit);
  retry.addEventListener('click', submit);
  check.addEventListener('click', getStatus);
  document.getElementById('resetForm').addEventListener('click', (event) => {
    if (pending) { event.stopImmediatePropagation(); event.preventDefault(); say('Offene Übermittlung bleibt gesperrt. Zuerst denselben Request erneut prüfen.'); }
    else { receipt = null; sessionStorage.removeItem(receiptKey); update(); }
  }, true);
  if (pending) say('Eine unbestätigte Übermittlung wurde wiederhergestellt. Nur dieselben Daten erneut senden.');
  update();
})();
