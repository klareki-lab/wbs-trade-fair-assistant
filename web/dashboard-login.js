(function () {
  'use strict';
  var form = document.getElementById('dashboard-login-form');
  var input = document.getElementById('access-key');
  var error = document.getElementById('login-error');
  if (!form || !input || !error) return;

  function showError(message) {
    error.textContent = message;
    error.hidden = false;
  }
  function clearError() {
    error.hidden = true;
    error.textContent = '';
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    clearError();
    var key = input.value;
    if (typeof key !== 'string' || key.length < 16) {
      showError('Zugangsschlüssel ist zu kurz.');
      return;
    }
    var button = form.querySelector('button[type="submit"]');
    if (button) button.disabled = true;

    fetch('/api/login', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ access_key: key })
    }).then(function (response) {
      // Clear the key from memory as soon as the request is in flight.
      input.value = '';
      key = '';
      if (response.status === 200) {
        return response.json().then(function (body) {
          if (body && body.authenticated === true) {
            window.location.replace('/dashboard');
            return;
          }
          showError('Anmeldung konnte nicht bestätigt werden.');
        });
      }
      if (response.status === 401) {
        showError('Zugangsschlüssel wurde nicht akzeptiert.');
        return;
      }
      if (response.status === 429) {
        showError('Zu viele Anmeldeversuche. Bitte später erneut versuchen.');
        return;
      }
      showError('Anmeldung fehlgeschlagen. Bitte erneut versuchen.');
    }).catch(function () {
      input.value = '';
      key = '';
      showError('Verbindungsfehler. Bitte erneut versuchen.');
    }).then(function () {
      if (button) button.disabled = false;
    });
  });
})();
