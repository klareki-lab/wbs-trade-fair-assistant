(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const publicMode = window.location.pathname === '/public';
  const source = publicMode ? 'public_form' : 'internal_form';
  const fieldNames = ['company_name', 'contact_name', 'email', 'phone', 'website', 'training_interest', 'budget_status', 'follow_up', 'follow_up_date', 'notes'];
  const draftKey = `train-today:draft:v1:${source}`;
  const receiptKey = `train-today:receipt:v1:${source}`;
  const leadPattern = /^FAIR-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const keyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
  const detailText = {
    REQUIRED: 'Bitte geben Sie einen Firmennamen mit mindestens einem Buchstaben oder einer Ziffer ein.',
    INVALID_TYPE: 'Bitte verwenden Sie einen Textwert.',
    TOO_LONG: 'Diese Angabe ist zu lang. Bitte kürzen Sie den Text.',
    NORMALIZED_TOO_LONG: 'Diese Angabe ist nach der Vereinheitlichung zu lang. Bitte kürzen Sie den Text.',
    INVALID_UNICODE: 'Diese Angabe enthält ein ungültiges Textzeichen. Bitte geben Sie den betroffenen Text erneut ein.',
    CONTROL_CHARACTER: 'Bitte entfernen Sie nicht unterstützte Sonderzeichen.',
    INVALID_NAME: 'Der Name muss mindestens einen Buchstaben enthalten.',
    INVALID_VALUE: 'Bitte wählen Sie einen der angebotenen Werte.',
    INVALID_EMAIL: 'Bitte prüfen Sie die E-Mail-Adresse oder lassen Sie das Feld leer.',
    INVALID_PHONE: 'Bitte verwenden Sie 7–20 Ziffern. +, Leerzeichen, Klammern, Punkte, / und - sind erlaubt.',
    INVALID_WEBSITE: 'Bitte geben Sie eine Website mit https:// oder http:// und einem Domainnamen an.',
    INVALID_IDEMPOTENCY_KEY: 'Die Erfassungskennung ist ungültig. Bitte wenden Sie sich an das Team.',
    INVALID_DATE: 'Bitte wählen Sie ein gültiges Datum ab dem Jahr 1900.',
    UNEXPECTED_DATE: 'Bitte wählen Sie „An einem bestimmten Datum“, wenn Sie ein Datum angeben.',
    INSUFFICIENT_CONTEXT: 'Bitte ergänzen Sie einen Namen, eine erreichbare E-Mail/Telefonnummer oder aussagekräftige Notizen (mindestens 10 Zeichen und 5 Buchstaben/Ziffern).',
    UNKNOWN_FIELD: 'Eine übermittelte Angabe wird nicht unterstützt. Bitte laden Sie die Anwendung erneut.',
    SOURCE_POLICY_LIMIT: 'Die Notizen sind für diese Erfassung zu lang.',
  };
  let authenticated = false;
  let busy = false;
  let state;
  let receipt = null;
  let pollGeneration = 0;
  let pollTimer = null;
  let storageWarningShown = false;

  function newId() {
    if (typeof window.crypto?.randomUUID !== 'function') throw new Error('Secure browser UUID unavailable');
    return window.crypto.randomUUID();
  }
  function blankState() {
    return { values: Object.fromEntries(fieldNames.map((key) => [key, ''])), submission_id: newId(), pending_body: null, lock_reason: null, persist_opt_in: false };
  }
  function storageWarning() {
    if (storageWarningShown) return;
    storageWarningShown = true;
    $('storage-warning').hidden = false;
    $('storage-warning').textContent = 'Der Browser konnte den Entwurf nicht zwischenspeichern. Lassen Sie diesen Tab offen, bis die Speicherung bestätigt ist.';
  }
  function readStored(storageName, key) {
    try {
      const raw = window[storageName].getItem(key);
      return raw && raw.length < 150000 ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  function validReceipt(value) {
    return value && value.success === true && value.persisted === true && leadPattern.test(value.lead_id || '') &&
      ['NEW', 'POSSIBLE_DUPLICATE', 'EXISTING_CONTACT'].includes(value.status) &&
      value.processing_status === 'pending' && typeof value.idempotent_replay === 'boolean' &&
      typeof value.review_required === 'boolean' && keyPattern.test(value.submission_id || '');
  }
  function restore() {
    let saved = readStored('sessionStorage', draftKey);
    if (!saved) {
      const persistent = readStored('localStorage', draftKey);
      if (persistent?.persist_opt_in === true) saved = persistent;
    }
    state = blankState();
    if (saved && typeof saved === 'object' && keyPattern.test(saved.submission_id || '') && saved.values && typeof saved.values === 'object') {
      state.values = Object.fromEntries(fieldNames.map((key) => [key, typeof saved.values[key] === 'string' ? saved.values[key].slice(0, 12000) : '']));
      state.submission_id = saved.submission_id;
      state.persist_opt_in = saved.persist_opt_in === true;
      if (typeof saved.pending_body === 'string' && saved.pending_body.length < 70000) {
        try {
          const pending = JSON.parse(saved.pending_body);
          if (pending.submission_id === state.submission_id && pending.source === source) {
            state.pending_body = saved.pending_body;
            state.lock_reason = saved.lock_reason === 'conflict' ? 'conflict' : 'ambiguous';
          }
        } catch { /* A corrupt local draft never becomes a request. */ }
      }
    }
    const savedReceipt = readStored('sessionStorage', receiptKey);
    if (validReceipt(savedReceipt)) receipt = savedReceipt;
  }
  function persistDraft() {
    const serialized = JSON.stringify(state);
    try { window.sessionStorage.setItem(draftKey, serialized); } catch { storageWarning(); }
    try {
      if (state.persist_opt_in) window.localStorage.setItem(draftKey, serialized);
      else window.localStorage.removeItem(draftKey);
    } catch { if (state.persist_opt_in) storageWarning(); }
  }
  function preserveReceipt(value) {
    receipt = value;
    try { window.sessionStorage.setItem(receiptKey, JSON.stringify(value)); } catch { storageWarning(); }
    // This is the only automatic path that clears the draft: a strict persisted receipt.
    try { window.sessionStorage.removeItem(draftKey); } catch { /* Already held in memory. */ }
    try { window.localStorage.removeItem(draftKey); } catch { storageWarning(); }
    state = blankState();
  }
  function readValues() {
    return Object.fromEntries(fieldNames.map((key) => [key, $(key).value]));
  }
  function fillForm() {
    for (const key of fieldNames) $(key).value = state.values[key] || '';
    $('persist-draft').checked = state.persist_opt_in;
    $('follow-up-date-field').hidden = state.values.follow_up !== 'on_date';
    $('notes-count').textContent = `${[...$('notes').value].length.toLocaleString('de-DE')} / 10.000`;
    setControls();
  }
  function hidePanels() {
    for (const id of ['startup', 'login-panel', 'capture-panel', 'receipt-panel', 'unavailable-panel']) $(id).hidden = true;
  }
  function showLogin(message = '') {
    stopPolling();
    hidePanels();
    $('login-panel').hidden = false;
    $('logout-button').hidden = true;
    $('login-error').textContent = message;
    $('access-key').value = '';
    if (message) $('access-key').focus();
  }
  function showMain() {
    hidePanels();
    $('logout-button').hidden = publicMode || !authenticated;
    if (receipt) { showReceipt(); return; }
    $('capture-panel').hidden = false;
    fillForm();
    if (state.lock_reason === 'ambiguous') showAlert('Die letzte Übermittlung ist noch nicht bestätigt. Ihre Eingaben bleiben unverändert erhalten. Senden Sie denselben Entwurf erneut, um das Ergebnis sicher zu klären.', 'warning');
    if (state.lock_reason === 'conflict') showAlert('Diese Erfassungskennung wurde bereits für andere Angaben verwendet. Der vorhandene Eintrag wurde nicht geändert. Über „Als neue Erfassung bearbeiten“ können Sie bewusst einen neuen Eintrag beginnen.', 'warning');
  }
  function setControls() {
    const frozen = Boolean(state.pending_body);
    $('capture-fields').disabled = busy || frozen;
    $('capture-submit').disabled = busy || state.lock_reason === 'conflict';
    $('new-after-conflict').hidden = state.lock_reason !== 'conflict';
    $('new-after-conflict').disabled = busy;
    $('logout-button').disabled = busy;
    $('capture-submit').firstElementChild.textContent = busy ? 'Wird gespeichert …' : frozen ? 'Gleiche Übermittlung erneut senden' : 'Kontakt speichern';
    $('submit-hint').textContent = frozen ? 'Der unveränderte Entwurf behält seine Erfassungskennung.' : 'Gespeichert wird erst, wenn Sie absenden.';
    $('draft-state').lastElementChild.textContent = frozen ? 'Bestätigung ausstehend · Entwurf gesichert' : state.persist_opt_in ? 'Entwurf auf diesem Gerät' : 'Entwurf in diesem Tab';
  }
  function showAlert(message, type = '') {
    $('form-alert').hidden = false;
    $('form-alert').className = `notice ${type}`.trim();
    $('form-alert').textContent = message;
  }
  function clearErrors() {
    $('form-alert').hidden = true;
    for (const key of fieldNames) {
      $(key).removeAttribute('aria-invalid');
      $(`error-${key}`).textContent = '';
    }
  }
  function showFieldErrors(details) {
    let first = null;
    for (const detail of details) {
      const field = detail.field === 'contact_or_notes' ? 'notes' : detail.field;
      if (!fieldNames.includes(field)) continue;
      $(field).setAttribute('aria-invalid', 'true');
      $(`error-${field}`).textContent = detailText[detail.code] || 'Bitte prüfen Sie diese Angabe.';
      first ||= $(field);
    }
    showAlert('Bitte prüfen Sie die markierten Angaben. Ihre Eingaben sind erhalten geblieben.');
    (first || $('form-alert')).focus();
  }
  function localValidation(values) {
    const errors = [];
    const add = (field, code) => errors.push({ field, code });
    if (!/[\p{L}\p{N}]/u.test(values.company_name.trim())) add('company_name', 'REQUIRED');
    const name = values.contact_name.trim();
    if (name && !/\p{L}/u.test(name)) add('contact_name', 'INVALID_NAME');
    const email = values.email.trim();
    const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (email && !validEmail) add('email', 'INVALID_EMAIL');
    const phone = values.phone.trim();
    const digits = phone.replace(/\D/g, '').length;
    const validPhone = /^\+?[0-9() .\/-]+$/.test(phone) && digits >= 7 && digits <= 20;
    if (phone && !validPhone) add('phone', 'INVALID_PHONE');
    if (values.website.trim() && !/^https?:\/\/[^\s]+\.[^\s]+$/i.test(values.website.trim())) add('website', 'INVALID_WEBSITE');
    if (values.follow_up === 'on_date' && (!values.follow_up_date || values.follow_up_date < '1900-01-01')) add('follow_up_date', 'INVALID_DATE');
    const notes = values.notes.trim();
    const meaningfulNotes = [...notes].length >= 10 && (notes.match(/[\p{L}\p{N}]/gu) || []).length >= 5;
    if (!/\p{L}/u.test(name) && !validEmail && !validPhone && !meaningfulNotes) add('contact_or_notes', 'INSUFFICIENT_CONTEXT');
    return errors;
  }
  async function request(url, options = {}) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options, signal: controller.signal });
      const body = await response.json();
      return { response, body };
    } finally { window.clearTimeout(timeout); }
  }
  function isStrictSuccess(body, status) {
    return [200, 201].includes(status) && validReceipt({ ...body, submission_id: state.submission_id }) &&
      ((status === 200) === body.idempotent_replay);
  }
  function ambiguous() {
    state.lock_reason = 'ambiguous';
    persistDraft();
    showAlert('Die Speicherung konnte noch nicht bestätigt werden. Ihre Eingaben bleiben gesichert und gesperrt. Senden Sie dieselbe Übermittlung erneut; die gleiche Kennung verhindert einen versehentlichen zweiten Eintrag.', 'warning');
    $('form-alert').focus();
  }

  $('lead-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || state.lock_reason === 'conflict') return;
    clearErrors();
    if (!state.pending_body) {
      state.values = readValues();
      persistDraft();
      const errors = localValidation(state.values);
      if (errors.length) { showFieldErrors(errors); return; }
      const payload = Object.fromEntries(fieldNames.map((key) => [key, state.values[key] === '' ? null : state.values[key]]));
      payload.source = source;
      payload.submission_id = state.submission_id;
      payload.company_fax = $('company_fax').value;
      state.pending_body = JSON.stringify(payload);
    }
    state.lock_reason = 'sending';
    busy = true;
    persistDraft();
    setControls();
    try {
      const { response, body } = await request(publicMode ? '/api/public/leads' : '/api/leads', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: state.pending_body,
      });
      if (isStrictSuccess(body, response.status)) {
        preserveReceipt({ ...body, submission_id: state.submission_id });
        showReceipt();
      } else if (response.status === 409 && body?.error?.code === 'IDEMPOTENCY_CONFLICT') {
        state.lock_reason = 'conflict';
        persistDraft();
        showAlert('Diese Erfassungskennung gehört bereits zu anderen Angaben. Der gespeicherte Eintrag wurde nicht verändert. Wenn dies ein weiteres Gespräch ist, wählen Sie „Als neue Erfassung bearbeiten“.', 'warning');
        $('form-alert').focus();
      } else if (response.status === 401 && body?.error?.code === 'AUTH_REQUIRED' && !publicMode) {
        state.pending_body = null; state.lock_reason = null;
        persistDraft(); authenticated = false;
        showLogin('Ihre Anmeldung ist abgelaufen. Melden Sie sich erneut an; Ihr Entwurf ist erhalten.');
      } else if ([400, 413, 415, 422, 429, 403].includes(response.status) && body?.success === false && body.persistence_status === 'not_stored') {
        state.pending_body = null; state.lock_reason = null;
        persistDraft(); setControls();
        if (response.status === 422 && body.error?.code === 'VALIDATION_FAILED') {
          showFieldErrors(body.error.details || []);
        } else {
          const messages = {
            400: 'Die Übermittlung konnte nicht gelesen werden. Ihre Eingaben sind erhalten. Bitte versuchen Sie es erneut.',
            403: 'Bitte öffnen Sie die Anwendung über die vom Team bereitgestellte Adresse.',
            413: 'Die Übermittlung ist zu groß. Bitte kürzen Sie die Notizen.',
            415: 'Das Übermittlungsformat wurde nicht akzeptiert. Bitte laden Sie die Anwendung erneut.',
            422: 'Diese Anfrage konnte nicht angenommen werden. Bitte prüfen Sie Ihre Eingaben.',
            429: 'Zu viele Anfragen in kurzer Zeit. Bitte warten Sie etwas und senden Sie den erhaltenen Entwurf erneut.',
          };
          showAlert(messages[response.status], response.status === 429 ? 'warning' : '');
          $('form-alert').focus();
        }
      } else { ambiguous(); }
    } catch { ambiguous(); }
    finally { busy = false; setControls(); }
  });

  $('lead-form').addEventListener('input', (event) => {
    if (event.target.id === 'persist-draft' || state.pending_body) return;
    state.values = readValues();
    $('notes-count').textContent = `${[...state.values.notes].length.toLocaleString('de-DE')} / 10.000`;
    persistDraft();
  });
  $('follow_up').addEventListener('change', () => {
    const onDate = $('follow_up').value === 'on_date';
    $('follow-up-date-field').hidden = !onDate;
    if (!onDate) $('follow_up_date').value = '';
    state.values = readValues(); persistDraft();
  });
  $('persist-draft').addEventListener('change', () => {
    state.persist_opt_in = $('persist-draft').checked;
    persistDraft(); setControls();
  });
  $('new-after-conflict').addEventListener('click', () => {
    if (state.lock_reason !== 'conflict' || busy) return;
    state.pending_body = null; state.lock_reason = null; state.submission_id = newId();
    clearErrors(); persistDraft(); fillForm();
    showAlert('Neue Erfassung begonnen. Prüfen Sie die Angaben vor dem Speichern.', 'info');
    $('company_name').focus();
  });
  $('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const key = $('access-key').value;
    $('access-key').value = ''; // The key is never copied to storage or application state.
    $('login-error').textContent = '';
    $('login-submit').disabled = true;
    $('login-submit').firstElementChild.textContent = 'Wird angemeldet …';
    try {
      const { response, body } = await request('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ access_key: key }),
      });
      if (response.status === 200 && body.authenticated === true) { authenticated = true; showMain(); }
      else {
        $('login-error').textContent = response.status === 429 ? 'Zu viele Anmeldeversuche. Bitte warten Sie und versuchen Sie es später erneut.' : response.status === 403 ? 'Bitte verwenden Sie die vom Team bereitgestellte Adresse.' : 'Der Zugangsschlüssel wurde nicht akzeptiert. Bitte versuchen Sie es erneut.';
        $('access-key').focus();
      }
    } catch { $('login-error').textContent = 'Die Anmeldung ist gerade nicht erreichbar. Bitte versuchen Sie es erneut.'; }
    finally { $('access-key').value = ''; $('login-submit').disabled = false; $('login-submit').firstElementChild.textContent = 'Anmelden'; }
  });
  $('logout-button').addEventListener('click', async () => {
    if (busy) return;
    try {
      const { response, body } = await request('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (response.status === 200 && body.success === true) { authenticated = false; showLogin(); }
      else throw new Error('logout failed');
    } catch {
      const message = 'Die Abmeldung wurde nicht bestätigt. Bitte versuchen Sie es erneut.';
      if (receipt) $('status-note').textContent = message;
      else showAlert(message, 'warning');
    }
  });

  function stopPolling() {
    pollGeneration += 1;
    if (pollTimer) window.clearTimeout(pollTimer);
    pollTimer = null;
  }
  function showReceipt() {
    hidePanels();
    $('receipt-panel').hidden = false;
    $('receipt-id').textContent = receipt.lead_id;
    $('replay-note').hidden = !receipt.idempotent_replay;
    $('receipt-copy').textContent = publicMode ? 'Ihr Kontakt ist gespeichert. Das Team kümmert sich um die weitere Bearbeitung.' : 'Der Kontakt ist gespeichert. Die weitere Bearbeitung läuft unabhängig von diesem Fenster.';
    $('status-card').hidden = publicMode;
    $('refresh-status').hidden = true;
    $('logout-button').hidden = publicMode || !authenticated;
    $('receipt-title').focus();
    if (!publicMode) startPolling();
  }
  const formatDate = (value) => new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Berlin' }).format(new Date(value));
  function renderStatus(status) {
    const nextRetry = status.next_retry_at && Date.parse(status.next_retry_at) > Date.now();
    const descriptions = {
      pending: nextRetry ? ['Erneuter Versuch geplant', 'Der Kontakt bleibt gespeichert. Die Bearbeitung wird automatisch erneut versucht.'] : ['Bearbeitung wartet', 'Der Kontakt wartet auf die nächste Verarbeitung.'],
      processing: ['Bearbeitung läuft', 'Die Angaben werden verarbeitet. Sie können bereits den nächsten Kontakt erfassen.'],
      completed: ['Bearbeitung abgeschlossen', status.review_required ? 'Das Ergebnis liegt vor. Ein Abgleich durch das Team ist vorgesehen.' : 'Die Verarbeitung ist abgeschlossen.'],
      failed: ['Prüfung durch das Team nötig', 'Die automatische Bearbeitung konnte nicht abgeschlossen werden. Der ursprüngliche Kontakt bleibt gespeichert.'],
    };
    const [title, copy] = descriptions[status.processing_status];
    $('processing-title').textContent = title;
    $('processing-copy').textContent = copy;
    $('processing-dot').classList.toggle('pulse', ['pending', 'processing'].includes(status.processing_status));
    $('score-line').hidden = status.score_total === null || status.score_band === null;
    const bands = { HOT: 'Hot', WARM: 'Warm', COLD: 'Cold' };
    if (!$('score-line').hidden) $('score-line').textContent = `Einschätzung: ${bands[status.score_band]} · ${status.score_total}/100`;
    const emailLabels = {
      pending: 'Bericht wartet auf den Versand.',
      leased: 'Berichtsversand wird vorbereitet.',
      sending: 'Bericht wird an den Versanddienst übergeben.',
      delivered: 'Bericht an Versanddienst übergeben.',
      uncertain: 'Versandstatus unklar. Das Team muss prüfen, bevor erneut gesendet wird.',
      failed: 'Bericht konnte nicht versendet werden. Eine Prüfung durch das Team ist nötig.',
    };
    $('email-line').hidden = status.email_status === null;
    if (status.email_status) $('email-line').textContent = emailLabels[status.email_status];
    const retryParts = [];
    if (nextRetry) retryParts.push(`Nächster Verarbeitungsversuch: ${formatDate(status.next_retry_at)} (Berlin).`);
    if (status.email_next_retry_at && Date.parse(status.email_next_retry_at) > Date.now()) retryParts.push(`Nächster Versandversuch: ${formatDate(status.email_next_retry_at)} (Berlin).`);
    if (status.processing_attempts > 0) retryParts.push(`Verarbeitungsversuche: ${status.processing_attempts}.`);
    $('retry-line').hidden = retryParts.length === 0;
    $('retry-line').textContent = retryParts.join(' ');
    $('status-note').textContent = `Zuletzt geprüft: ${new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date())}.`;
    return status.processing_status === 'failed' || (status.processing_status === 'completed' && [null, 'delivered', 'uncertain', 'failed'].includes(status.email_status));
  }
  function startPolling() {
    stopPolling();
    if (publicMode || !receipt || !authenticated) return;
    const generation = pollGeneration;
    const deadline = Date.now() + 5 * 60 * 1000;
    $('refresh-status').hidden = true;
    $('status-note').textContent = 'Status wird abgerufen …';
    const poll = async () => {
      if (generation !== pollGeneration) return;
      if (Date.now() >= deadline) {
        $('status-note').textContent = 'Die automatische Statusabfrage ist nach fünf Minuten beendet. Die Bearbeitung läuft weiter; Sie können den Status erneut prüfen.';
        $('refresh-status').hidden = false;
        return;
      }
      let done = false;
      try {
        const { response, body } = await request(`/api/leads/${encodeURIComponent(receipt.lead_id)}?submission_id=${encodeURIComponent(receipt.submission_id)}`);
        if (generation !== pollGeneration) return;
        if (response.status === 200 && body.success === true && body.lead_id === receipt.lead_id && ['pending', 'processing', 'completed', 'failed'].includes(body.processing_status)) {
          done = renderStatus(body);
        } else if (response.status === 401) {
          authenticated = false;
          showLogin('Ihre Anmeldung ist abgelaufen. Nach der Anmeldung können Sie den gespeicherten Kontaktstatus weiter prüfen.');
          return;
        } else if (response.status === 404) {
          $('status-note').textContent = 'Der Status konnte dieser Referenz nicht zugeordnet werden. Bitte wenden Sie sich mit der Referenz an das Team.';
          done = true;
        } else {
          $('status-note').textContent = 'Status gerade nicht erreichbar. Der gespeicherte Kontakt bleibt erhalten; die Abfrage wird wiederholt.';
        }
      } catch {
        if (generation !== pollGeneration) return;
        $('status-note').textContent = 'Verbindung unterbrochen. Die Statusabfrage wird wiederholt.';
      }
      if (done) { $('refresh-status').hidden = false; return; }
      if (generation === pollGeneration) pollTimer = window.setTimeout(poll, 5000);
    };
    poll();
  }
  $('refresh-status').addEventListener('click', startPolling);
  $('new-lead-button').addEventListener('click', () => {
    stopPolling(); receipt = null;
    try { window.sessionStorage.removeItem(receiptKey); } catch { /* No contact draft is cleared here. */ }
    state = blankState(); clearErrors(); showMain(); $('company_name').focus();
  });
  $('reload-button').addEventListener('click', () => window.location.reload());
  window.addEventListener('beforeunload', (event) => {
    if (busy) { event.preventDefault(); event.returnValue = ''; }
  });

  async function initialize() {
    try {
      restore();
      if (publicMode) {
        $('mode-label').textContent = 'Kontaktformular';
        $('capture-eyebrow').textContent = 'SCHÖN, DASS WIR INS GESPRÄCH KOMMEN';
        $('capture-title').textContent = 'Ihr nächster Schritt beginnt hier.';
        $('capture-description').textContent = 'Teilen Sie uns mit, welche Weiterbildung Ihr Unternehmen bewegt.';
        $('new-lead-button').textContent = 'Weiteren Kontakt erfassen';
      }
      const { response, body } = await request('/api/session');
      if (response.status !== 200 || body.success !== true || (publicMode && body.public_form_enabled !== true)) throw new Error('unavailable');
      authenticated = body.authenticated === true;
      if (publicMode || authenticated) showMain();
      else showLogin();
    } catch { hidePanels(); $('unavailable-panel').hidden = false; }
  }
  initialize();
})();
