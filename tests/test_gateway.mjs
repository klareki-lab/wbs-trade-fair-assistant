// WBS Trade Fair Assistant — gateway tests (V1 adds dashboard).
// Node --test. Deterministic. No real network, no real n8n, no real Neon.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createGateway, loadConfig } from '../gateway/server.mjs';

const BASE_ENV = {
  HOST: '127.0.0.1', PORT: '3000', APP_ORIGIN: 'http://app.test',
  TRADE_FAIR_ACCESS_KEY: 'fake-access-key-for-tests-abcdef',
  SESSION_SECRET: 'fake-session-secret-for-tests-at-least-32-chars',
  N8N_HEADER_KEY: 'fake-n8n-key',
  N8N_CAPTURE_URL: 'http://upstream.test/capture',
  N8N_STATUS_URL: 'http://upstream.test/status',
  PUBLIC_FORM_ENABLED: 'false',
};
const DASHBOARD_ENV = {
  ...BASE_ENV,
  N8N_DASHBOARD_URL: 'http://upstream.test/dashboard-leads',
  N8N_DASHBOARD_HEADER_KEY: 'fake-dashboard-only-key',
};

const LEAD = 'FAIR-00000000-0000-4000-8000-000000000001';
function sampleUpstream(overrides = {}, { total = 1, leads = [sampleLead()] } = {}) {
  return { success: true, total, page: 1, limit: 25, leads, ...overrides };
}
function sampleLead(overrides = {}) {
  return {
    lead_id: LEAD, created_at: '2026-10-25T08:00:00Z',
    company_name: 'Test GmbH', contact_name: 'Ada Example',
    processing_status: 'completed', score_band: 'HOT',
    duplicate_status: 'NEW', review_required: false,
    ...overrides,
  };
}
function jsonResponse(status, body, headers = {}) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  return new Response(buf, { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(buf.length), ...headers } });
}
async function start(env = DASHBOARD_ENV, { upstream } = {}) {
  const fetchImpl = async (url, init) => {
    if (typeof upstream === 'function') return upstream(String(url), init);
    throw new Error('UPSTREAM_UNCONFIGURED');
  };
  const config = loadConfig(env);
  const server = createGateway(config, { fetchImpl });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = `http://127.0.0.1:${server.address().port}`;
  const close = async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); };
  return { address, close, config };
}
async function signIn(address) {
  const r = await fetch(address + '/api/login', {
    method: 'POST',
    headers: { Origin: 'http://app.test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_key: BASE_ENV.TRADE_FAIR_ACCESS_KEY }),
  });
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie').split(';')[0];
}

// -------- Baseline regression (unchanged behavior) --------
test('existing login/session/capture/status/public form routes still behave', async () => {
  let captureCalled = false;
  const { address, close } = await start(DASHBOARD_ENV, {
    upstream: async (url) => {
      if (url.endsWith('/capture')) { captureCalled = true; return jsonResponse(201, { success: true, persisted: true, lead_id: LEAD, status: 'NEW', processing_status: 'pending', idempotent_replay: false, review_required: false }); }
      if (url.endsWith('/status')) return jsonResponse(200, { success: true, lead_id: LEAD, processing_status: 'completed', processing_attempts: 1, next_retry_at: null, last_error_code: null, review_required: false, score_band: 'HOT', score_total: 90, email_status: 'delivered', email_next_retry_at: null, updated_at: '2026-10-25T08:00:00Z' });
      return jsonResponse(500, { error: 'unexpected' });
    },
  });
  try {
    assert.equal((await fetch(address + '/healthz')).status, 200);
    assert.equal((await fetch(address + '/')).status, 200);
    assert.equal((await fetch(address + '/app.js')).status, 200);
    const sess = await fetch(address + '/api/session');
    const body = await sess.json();
    assert.equal(body.success, true);
    assert.equal(body.authenticated, false);
    assert.equal(body.dashboard_enabled, true);
    // Wrong key
    const bad = await fetch(address + '/api/login', { method: 'POST', headers: { Origin: 'http://app.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ access_key: 'nope' }) });
    assert.equal(bad.status, 401);
    assert.equal(bad.headers.get('set-cookie'), null);
    const cookie = await signIn(address);
    // Capture requires origin; wrong origin → 403, no session + correct origin → 401.
    assert.equal((await fetch(address + '/api/leads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await fetch(address + '/api/leads', { method: 'POST', headers: { Origin: 'http://app.test', 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    const good = await fetch(address + '/api/leads', { method: 'POST', headers: { Cookie: cookie, Origin: 'http://app.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ company_name: 'Test', submission_id: 'abcdefghijklmnop' }) });
    assert.equal(good.status, 201);
    assert.equal(captureCalled, true);
    // Status happy path
    const sr = await fetch(address + '/api/leads/' + LEAD + '?submission_id=abcdefghijklmnop', { headers: { Cookie: cookie } });
    assert.equal(sr.status, 200);
    const sb = await sr.json();
    assert.equal(sb.processing_status, 'completed');
  } finally { await close(); }
});

// -------- Dashboard configuration gate --------
test('dashboard config is optional and fails closed when half-configured', () => {
  // Unset: enabled=false; routes 404 by handler fall-through (tested elsewhere).
  const noDash = loadConfig(BASE_ENV);
  assert.equal(noDash.dashboardEnabled, false);
  // Partial env: throws so misconfigured deploys stop at startup.
  assert.throws(() => loadConfig({ ...BASE_ENV, N8N_DASHBOARD_URL: 'http://x/leads' }), /N8N_DASHBOARD_HEADER_KEY/);
  assert.throws(() => loadConfig({ ...BASE_ENV, N8N_DASHBOARD_HEADER_KEY: 'k' }), /N8N_DASHBOARD_URL/);
  // Both set, URL must be valid.
  assert.throws(() => loadConfig({ ...BASE_ENV, N8N_DASHBOARD_URL: 'ws://x', N8N_DASHBOARD_HEADER_KEY: 'k' }), /N8N_DASHBOARD_URL/);
  assert.throws(() => loadConfig({ ...BASE_ENV, N8N_DASHBOARD_URL: 'http://u:p@x/leads', N8N_DASHBOARD_HEADER_KEY: 'k' }), /credentials/);
});

test('with dashboard disabled, /dashboard and /api/dashboard/leads are 404', async () => {
  const { address, close } = await start(BASE_ENV);
  try {
    for (const u of ['/dashboard', '/dashboard.css', '/dashboard.js', '/api/dashboard/leads']) {
      const r = await fetch(address + u);
      assert.equal(r.status, 404, u);
    }
  } finally { await close(); }
});

// -------- /dashboard access control --------
test('anonymous GET /dashboard redirects to /; HEAD likewise; API returns 401 JSON', async () => {
  const { address, close } = await start();
  try {
    const r = await fetch(address + '/dashboard', { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/');
    const h = await fetch(address + '/dashboard', { method: 'HEAD', redirect: 'manual' });
    assert.equal(h.status, 302);
    const api = await fetch(address + '/api/dashboard/leads');
    assert.equal(api.status, 401);
    assert.match(api.headers.get('content-type') || '', /application\/json/);
    const body = await api.json();
    assert.equal(body.error.code, 'AUTH_REQUIRED');
  } finally { await close(); }
});

test('/dashboard, /dashboard.css, /dashboard.js require a session; HTML has no secrets or Basic Auth', async () => {
  const { address, close } = await start();
  try {
    for (const u of ['/dashboard.css', '/dashboard.js']) assert.equal((await fetch(address + u)).status, 401, u);
    const cookie = await signIn(address);
    const html = await fetch(address + '/dashboard', { headers: { Cookie: cookie } });
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-type') || '', /text\/html/);
    assert.match(html.headers.get('cache-control') || '', /no-store/);
    const text = await html.text();
    for (const forbidden of ['CONFIG.benutzer', 'CONFIG.passwort', 'basic', 'Basic ', 'Authorization: Basic', 'n8n.poljanzew.app', DASHBOARD_ENV.N8N_DASHBOARD_HEADER_KEY, DASHBOARD_ENV.N8N_HEADER_KEY, DASHBOARD_ENV.SESSION_SECRET, DASHBOARD_ENV.TRADE_FAIR_ACCESS_KEY]) {
      assert.ok(!text.includes(forbidden), 'HTML contains forbidden string: ' + forbidden);
    }
    // Chat/Merge/Split must be disabled, not actionable
    assert.match(text, /V1 nicht verfügbar/);
    const js = await fetch(address + '/dashboard.js', { headers: { Cookie: cookie } });
    assert.equal(js.status, 200);
    const jsText = await js.text();
    for (const forbidden of ['n8n.poljanzew.app', DASHBOARD_ENV.N8N_DASHBOARD_HEADER_KEY, DASHBOARD_ENV.SESSION_SECRET, DASHBOARD_ENV.TRADE_FAIR_ACCESS_KEY, 'Authorization: Basic']) {
      assert.ok(!jsText.includes(forbidden), 'JS contains forbidden string: ' + forbidden);
    }
    // CSP preserved
    assert.match(js.headers.get('content-security-policy') || '', /script-src 'self'/);
  } finally { await close(); }
});

test('logout invalidates the session for /api/dashboard/leads', async () => {
  const { address, close } = await start(DASHBOARD_ENV, { upstream: async () => jsonResponse(200, sampleUpstream()) });
  try {
    const cookie = await signIn(address);
    const ok = await fetch(address + '/api/dashboard/leads', { headers: { Cookie: cookie } });
    assert.equal(ok.status, 200);
    const out = await fetch(address + '/api/logout', { method: 'POST', headers: { Cookie: cookie, Origin: 'http://app.test' } });
    const cleared = out.headers.get('set-cookie').split(';')[0];
    const stale = await fetch(address + '/api/dashboard/leads', { headers: { Cookie: cleared } });
    assert.equal(stale.status, 401);
  } finally { await close(); }
});

// -------- Dashboard API semantics --------
test('authenticated GET /api/dashboard/leads returns allowlisted bounded JSON', async () => {
  let captured;
  const { address, close } = await start(DASHBOARD_ENV, {
    upstream: async (url, init) => {
      captured = { url: String(url), init };
      return jsonResponse(200, sampleUpstream({ total: 2, page: 1, limit: 25 }, { total: 2, leads: [
        sampleLead(),
        sampleLead({ lead_id: 'FAIR-00000000-0000-4000-8000-000000000002', score_band: 'WARM', duplicate_status: 'POSSIBLE_DUPLICATE' }),
      ] }));
    },
  });
  try {
    const cookie = await signIn(address);
    const r = await fetch(address + '/api/dashboard/leads?page=1&limit=25', { headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('cache-control') || '', /no-store/);
    const body = await r.json();
    assert.equal(body.success, true);
    assert.equal(body.read_only, true);
    assert.equal(body.page, 1);
    assert.equal(body.limit, 25);
    assert.equal(body.total, 2);
    assert.equal(body.leads.length, 2);
    for (const lead of body.leads) {
      assert.deepEqual(Object.keys(lead).sort(), ['company_name', 'contact_name', 'created_at', 'duplicate_status', 'lead_id', 'processing_status', 'review_required', 'score_band']);
    }
    // Upstream was reached server-to-server with the dashboard-only header
    assert.equal(captured.url, 'http://upstream.test/dashboard-leads');
    assert.equal(captured.init.method, 'POST');
    assert.equal(captured.init.headers['X-Trade-Fair-Key'], DASHBOARD_ENV.N8N_DASHBOARD_HEADER_KEY);
    const sentBody = JSON.parse(captured.init.body);
    assert.equal(sentBody.page, 1);
    assert.equal(sentBody.limit, 25);
    assert.equal(sentBody.offset, 0);
  } finally { await close(); }
});

test('pagination is clamped and unknown query parameters are rejected', async () => {
  let seen;
  const { address, close } = await start(DASHBOARD_ENV, {
    upstream: async (_u, init) => { seen = JSON.parse(init.body); return jsonResponse(200, sampleUpstream({ page: seen.page, limit: seen.limit }, { leads: [sampleLead()] })); },
  });
  try {
    const cookie = await signIn(address);
    for (const bad of ['page=0', 'page=99999', 'limit=0', 'limit=51', 'limit=abc', 'page=-1', 'drop=1', 'page=1&limit=25&extra=1']) {
      const r = await fetch(address + '/api/dashboard/leads?' + bad, { headers: { Cookie: cookie } });
      assert.equal(r.status, 400, bad);
    }
    const r2 = await fetch(address + '/api/dashboard/leads?page=3&limit=10', { headers: { Cookie: cookie } });
    assert.equal(r2.status, 200);
    assert.equal(seen.page, 3);
    assert.equal(seen.limit, 10);
    assert.equal(seen.offset, 20);
  } finally { await close(); }
});

test('empty, single, many leads all pass; malformed rows are silently dropped', async () => {
  let fixture = sampleUpstream({ total: 0 }, { total: 0, leads: [] });
  const { address, close } = await start(DASHBOARD_ENV, { upstream: async () => jsonResponse(200, fixture) });
  try {
    const cookie = await signIn(address);
    const empty = await (await fetch(address + '/api/dashboard/leads', { headers: { Cookie: cookie } })).json();
    assert.equal(empty.leads.length, 0);
    assert.equal(empty.total, 0);
    fixture = sampleUpstream({ total: 1 }, { total: 1, leads: [sampleLead()] });
    const one = await (await fetch(address + '/api/dashboard/leads', { headers: { Cookie: cookie } })).json();
    assert.equal(one.leads.length, 1);
    const many = Array.from({ length: 25 }, (_, i) => sampleLead({ lead_id: 'FAIR-00000000-0000-4000-8000-' + String(i).padStart(12, '0') }));
    fixture = sampleUpstream({ total: 25 }, { total: 25, leads: many });
    const mr = await (await fetch(address + '/api/dashboard/leads', { headers: { Cookie: cookie } })).json();
    assert.equal(mr.leads.length, 25);
    fixture = sampleUpstream({ total: 3 }, { total: 3, leads: [sampleLead(), { lead_id: 'not-a-fair-id' }, sampleLead({ processing_status: 'exploded' })] });
    const dr = await (await fetch(address + '/api/dashboard/leads', { headers: { Cookie: cookie } })).json();
    assert.equal(dr.leads.length, 1, 'malformed rows dropped by allowlist');
  } finally { await close(); }
});

test('XSS strings pass through as plain text and never into HTML', async () => {
  const xss = '"<script>alert(1)</script><img src=x onerror=alert(2)>';
  const { address, close } = await start(DASHBOARD_ENV, {
    upstream: async () => jsonResponse(200, sampleUpstream({ total: 1 }, { total: 1, leads: [sampleLead({ company_name: xss, contact_name: xss })] })),
  });
  try {
    const cookie = await signIn(address);
    const r = await fetch(address + '/api/dashboard/leads', { headers: { Cookie: cookie } });
    const body = await r.text();
    // Server returns JSON; the literal string is JSON-escaped and never emitted as HTML.
    assert.match(r.headers.get('content-type') || '', /application\/json/);
    const data = JSON.parse(body);
    assert.equal(data.leads[0].company_name, xss, 'string preserved for client-side textContent rendering');
    // No HTML execution context in the response bytes.
    assert.ok(!/<script>alert\(1\)/.test(body) || body.indexOf('\\"') !== -1, 'if present, must be JSON-escaped not raw HTML');
    assert.doesNotMatch(body, /<\/html>/);
    // Dashboard JS uses textContent exclusively; verify in the served asset.
    const js = await (await fetch(address + '/dashboard.js', { headers: { Cookie: cookie } })).text();
    assert.ok(js.includes('createTextNode') || js.includes('textContent'), 'dashboard.js uses textContent-only renderer');
    assert.ok(!/\.innerHTML\s*=/.test(js), 'dashboard.js must not assign to innerHTML');
  } finally { await close(); }
});

// -------- Fail-closed upstream behavior --------
test('upstream HTTP 500 → 503 fail-closed, no internal URL/SQL leaked', async () => {
  const { address, close } = await start(DASHBOARD_ENV, { upstream: async () => jsonResponse(500, { error: 'detail', sql: 'SELECT * FROM trade_fair.lead_submissions' }) });
  try {
    const cookie = await signIn(address);
    const r = await fetch(address + '/api/dashboard/leads', { headers: { Cookie: cookie } });
    assert.equal(r.status, 503);
    const text = await r.text();
    assert.doesNotMatch(text, /upstream\.test/);
    assert.doesNotMatch(text, /trade_fair\./);
    assert.doesNotMatch(text, /SELECT/);
    assert.doesNotMatch(text, /DASHBOARD_HEADER_KEY/);
    assert.ok(!text.includes(DASHBOARD_ENV.N8N_DASHBOARD_HEADER_KEY));
  } finally { await close(); }
});

test('upstream network failure / timeout → 503 fail-closed', async () => {
  const { address, close } = await start(DASHBOARD_ENV, { upstream: async () => { throw Object.assign(new Error('ECONNREFUSED upstream.test:80 secret-token: ' + DASHBOARD_ENV.N8N_DASHBOARD_HEADER_KEY), { code: 'ECONNREFUSED' }); } });
  try {
    const cookie = await signIn(address);
    const r = await fetch(address + '/api/dashboard/leads', { headers: { Cookie: cookie } });
    assert.equal(r.status, 503);
    const text = await r.text();
    assert.doesNotMatch(text, /upstream\.test/);
    assert.doesNotMatch(text, /ECONNREFUSED/);
    assert.ok(!text.includes(DASHBOARD_ENV.N8N_DASHBOARD_HEADER_KEY));
  } finally { await close(); }
});

test('upstream oversized payload is rejected before parsing', async () => {
  const huge = Array.from({ length: 1000 }, () => sampleLead());
  const bigResponse = jsonResponse(200, sampleUpstream({ total: 1000 }, { total: 1000, leads: huge }), { 'Content-Length': String(200000) });
  const { address, close } = await start(DASHBOARD_ENV, { upstream: async () => bigResponse });
  try {
    const cookie = await signIn(address);
    const r = await fetch(address + '/api/dashboard/leads?page=1&limit=25', { headers: { Cookie: cookie } });
    assert.equal(r.status, 503);
  } finally { await close(); }
});

test('upstream non-JSON content-type is rejected', async () => {
  const { address, close } = await start(DASHBOARD_ENV, { upstream: async () => new Response('<!doctype html><title>n8n error</title>', { status: 200, headers: { 'Content-Type': 'text/html' } }) });
  try {
    const cookie = await signIn(address);
    const r = await fetch(address + '/api/dashboard/leads', { headers: { Cookie: cookie } });
    assert.equal(r.status, 503);
  } finally { await close(); }
});

// -------- Method, Origin and extra guards --------
test('POST /api/dashboard/leads is 405; writes never reach upstream', async () => {
  let touched = false;
  const { address, close } = await start(DASHBOARD_ENV, { upstream: async () => { touched = true; return jsonResponse(200, sampleUpstream()); } });
  try {
    const cookie = await signIn(address);
    const post = await fetch(address + '/api/dashboard/leads', { method: 'POST', headers: { Cookie: cookie, Origin: 'http://app.test', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(post.status, 405);
    const del = await fetch(address + '/api/dashboard/leads', { method: 'DELETE', headers: { Cookie: cookie } });
    assert.equal(del.status, 405);
    assert.equal(touched, false);
  } finally { await close(); }
});

test('upstream never sees session cookie or TRADE_FAIR_ACCESS_KEY', async () => {
  let seen;
  const { address, close } = await start(DASHBOARD_ENV, { upstream: async (_u, init) => { seen = init; return jsonResponse(200, sampleUpstream()); } });
  try {
    const cookie = await signIn(address);
    await fetch(address + '/api/dashboard/leads', { headers: { Cookie: cookie } });
    const headers = seen.headers || {};
    assert.ok(!('Cookie' in headers));
    assert.ok(!('cookie' in headers));
    assert.ok(!('Authorization' in headers));
    const body = String(seen.body || '');
    assert.ok(!body.includes(DASHBOARD_ENV.TRADE_FAIR_ACCESS_KEY));
    assert.ok(!body.includes(DASHBOARD_ENV.SESSION_SECRET));
  } finally { await close(); }
});
