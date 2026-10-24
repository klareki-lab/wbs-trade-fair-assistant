// Baseline regression: existing gateway routes keep their behavior after the
// WBS-TF-02 dashboard integration. All tests run with DASHBOARD_ENABLED=false
// so the dashboard code path is literally inert.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createGateway, loadConfig } from '../gateway/server.mjs';

const BASE_ENV = {
  HOST: '127.0.0.1',
  PORT: '3000',
  APP_ORIGIN: 'http://app.test',
  TRADE_FAIR_ACCESS_KEY: 'baseline-access-key-32-chars-abcd',
  SESSION_SECRET: 'baseline-session-secret-at-least-32-characters',
  N8N_HEADER_KEY: 'baseline-n8n-header',
  N8N_CAPTURE_URL: 'http://upstream.test/capture',
  N8N_STATUS_URL: 'http://upstream.test/status',
  PUBLIC_FORM_ENABLED: 'false',
};

async function start(envOverride = {}, fetchImpl) {
  const config = loadConfig({ ...BASE_ENV, ...envOverride });
  const server = createGateway(config, fetchImpl ? { fetchImpl } : {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  return { base, close };
}

test('healthz is public and always answers 200 with the service tag', async () => {
  const { base, close } = await start();
  try {
    const res = await fetch(base + '/healthz');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true, service: 'trade-fair-gateway' });
  } finally { await close(); }
});

test('session endpoint reports unauthenticated by default and reflects public form flag', async () => {
  const { base, close } = await start();
  try {
    const res = await fetch(base + '/api/session');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.authenticated, false);
    assert.equal(body.public_form_enabled, false);
  } finally { await close(); }
});

test('static form assets are served without a session', async () => {
  const { base, close } = await start();
  try {
    for (const [path, type] of [
      ['/', 'text/html'],
      ['/app.js', 'text/javascript'],
      ['/styles.css', 'text/css'],
      ['/berater', 'text/html'],
      ['/berater-adapter.js', 'text/javascript'],
    ]) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get('content-type'), new RegExp(type));
    }
  } finally { await close(); }
});

test('login requires same origin, correct key; logout clears cookie', async () => {
  const { base, close } = await start();
  try {
    const wrongOrigin = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { Origin: 'http://evil.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_key: BASE_ENV.TRADE_FAIR_ACCESS_KEY }),
    });
    assert.equal(wrongOrigin.status, 403);

    const wrongKey = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { Origin: BASE_ENV.APP_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_key: 'wrong' }),
    });
    assert.equal(wrongKey.status, 401);

    const ok = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { Origin: BASE_ENV.APP_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_key: BASE_ENV.TRADE_FAIR_ACCESS_KEY }),
    });
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie');
    assert.match(cookie, /^trade_fair_session=[A-Za-z0-9_.-]+/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);

    const logout = await fetch(base + '/api/logout', {
      method: 'POST',
      headers: { Origin: BASE_ENV.APP_ORIGIN },
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  } finally { await close(); }
});

test('capture requires session and same origin, upstream failure maps to STORAGE_UNAVAILABLE', async () => {
  const fetchImpl = async () => { throw new Error('upstream down'); };
  const { base, close } = await start({}, fetchImpl);
  try {
    const noSession = await fetch(base + '/api/leads', {
      method: 'POST',
      headers: { Origin: BASE_ENV.APP_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ company_name: 'X GmbH' }),
    });
    assert.equal(noSession.status, 401);

    const login = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { Origin: BASE_ENV.APP_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_key: BASE_ENV.TRADE_FAIR_ACCESS_KEY }),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];

    const upstreamDown = await fetch(base + '/api/leads', {
      method: 'POST',
      headers: {
        Origin: BASE_ENV.APP_ORIGIN,
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ company_name: 'X GmbH' }),
    });
    assert.equal(upstreamDown.status, 503);
    const body = await upstreamDown.json();
    assert.equal(body.error.code, 'STORAGE_UNAVAILABLE');
    assert.equal(body.retryable, true);
  } finally { await close(); }
});

test('public form routes are 404 while PUBLIC_FORM_ENABLED=false', async () => {
  const { base, close } = await start();
  try {
    assert.equal((await fetch(base + '/public')).status, 404);
    const post = await fetch(base + '/api/public/leads', {
      method: 'POST',
      headers: { Origin: BASE_ENV.APP_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ company_name: 'X GmbH' }),
    });
    assert.equal(post.status, 404);
  } finally { await close(); }
});

test('dashboard routes are inert when DASHBOARD_ENABLED is unset', async () => {
  const { base, close } = await start();
  try {
    for (const url of ['/dashboard', '/dashboard.js', '/dashboard.css', '/api/dashboard']) {
      assert.equal((await fetch(base + url)).status, 404, url);
    }
  } finally { await close(); }
});

test('status route enforces session + strict ID shape', async () => {
  const { base, close } = await start();
  try {
    const unauth = await fetch(base + '/api/leads/FAIR-00000000-0000-4000-8000-000000000000?submission_id=aaaaaaaaaaaaaaaa');
    assert.equal(unauth.status, 401);

    const login = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { Origin: BASE_ENV.APP_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_key: BASE_ENV.TRADE_FAIR_ACCESS_KEY }),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];

    const badId = await fetch(base + '/api/leads/FAIR-bad?submission_id=aaaaaaaaaaaaaaaa', { headers: { Cookie: cookie } });
    assert.equal(badId.status, 400);
  } finally { await close(); }
});
