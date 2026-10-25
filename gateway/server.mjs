import http from 'node:http';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
// WBS-TF-02 DASHBOARD
import { createDashboardDb } from './dashboard-db.mjs';
import { parseDashboardQuery } from './dashboard-api.mjs';

const WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url));
const MAX_BODY = 32 * 1024;
const SESSION_SECONDS = 8 * 60 * 60;
const LEAD_ID = /^FAIR-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SUBMISSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const DUPLICATE_STATES = new Set(['NEW', 'POSSIBLE_DUPLICATE', 'EXISTING_CONTACT']);
const PROCESSING_STATES = new Set(['pending', 'processing', 'completed', 'failed']);
const EMAIL_STATES = new Set(['pending', 'leased', 'sending', 'delivered', 'uncertain', 'failed']);
const FIELDS = new Set(['body', 'source', 'company_name', 'contact_name', 'email', 'phone', 'website', 'training_interest', 'budget_status', 'follow_up', 'follow_up_date', 'notes', 'submission_id', 'contact_or_notes']);
const DETAIL_CODES = new Set(['REQUIRED', 'INVALID_TYPE', 'TOO_LONG', 'NORMALIZED_TOO_LONG', 'INVALID_UNICODE', 'CONTROL_CHARACTER', 'INVALID_NAME', 'INVALID_VALUE', 'INVALID_EMAIL', 'INVALID_PHONE', 'INVALID_WEBSITE', 'INVALID_IDEMPOTENCY_KEY', 'INVALID_DATE', 'UNEXPECTED_DATE', 'INSUFFICIENT_CONTEXT', 'UNKNOWN_FIELD', 'SOURCE_POLICY_LIMIT']);
const API_MESSAGES = {
  AUTH_REQUIRED: 'Sign in to continue.',
  INVALID_ACCESS_KEY: 'The access key was not accepted.',
  SAME_ORIGIN_REQUIRED: 'Use this application from its configured origin.',
  INVALID_JSON: 'Send a valid JSON object.',
  UNSUPPORTED_MEDIA_TYPE: 'Send application/json.',
  PAYLOAD_TOO_LARGE: 'The request must not exceed 32768 bytes.',
  VALIDATION_FAILED: 'Correct the indicated fields and submit again.',
  REQUEST_REJECTED: 'This request could not be accepted.',
  RATE_LIMITED: 'Too many requests. Wait before trying again.',
  IDEMPOTENCY_CONFLICT: 'This submission_id was already used for different content.',
  STORAGE_UNAVAILABLE: 'Persistence could not be confirmed. Keep your draft and retry with the same submission_id.',
  STATUS_UNAVAILABLE: 'The current processing status is temporarily unavailable.',
  CONFIGURATION_ERROR: 'The service is not configured. Contact the operator.',
  NOT_FOUND: 'Lead not found.',
};

export function loadConfig(env = process.env) {
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
  const originUrl = new URL(env.APP_ORIGIN || `http://127.0.0.1:${port}`);
  if (!['http:', 'https:'].includes(originUrl.protocol) || originUrl.username || originUrl.password ||
      originUrl.pathname !== '/' || originUrl.search || originUrl.hash) throw new Error('APP_ORIGIN must contain only an http(s) scheme and host/port.');
  const accessKey = env.TRADE_FAIR_ACCESS_KEY || '';
  const sessionSecret = env.SESSION_SECRET || '';
  const headerKey = env.N8N_HEADER_KEY || '';
  if (accessKey.length < 16) throw new Error('Set TRADE_FAIR_ACCESS_KEY to at least 16 characters.');
  if (sessionSecret.length < 32) throw new Error('Set SESSION_SECRET to at least 32 characters.');
  if (!headerKey) throw new Error('Set N8N_HEADER_KEY to the n8n Header Auth credential value.');
  const readUrl = (name) => {
    if (!env[name]) throw new Error(`Set ${name} to the exact n8n production webhook URL.`);
    const value = new URL(env[name]);
    if (!['http:', 'https:'].includes(value.protocol) || value.username || value.password || value.hash) {
      throw new Error(`${name} must be an http(s) URL without embedded credentials or a fragment.`);
    }
    return value.href;
  };
  const secureCookies = originUrl.protocol === 'https:';
  // WBS-TF-02 DASHBOARD: optional, fail-closed. Disabled by default.
  if (env.DASHBOARD_ENABLED && !['true', 'false'].includes(env.DASHBOARD_ENABLED)) {
    throw new Error('DASHBOARD_ENABLED must be true or false.');
  }
  const dashboardEnabled = env.DASHBOARD_ENABLED === 'true';
  const dashboardDatabaseUrl = dashboardEnabled ? (env.DASHBOARD_DATABASE_URL || '') : null;
  const dashboardAccessKey = dashboardEnabled ? (env.DASHBOARD_ACCESS_KEY || '') : null;
  if (dashboardEnabled && !/^postgres(?:ql)?:\/\//.test(dashboardDatabaseUrl)) {
    throw new Error('DASHBOARD_DATABASE_URL is required when DASHBOARD_ENABLED=true.');
  }
  if (dashboardEnabled && (dashboardAccessKey.length < 16 || constantTimeTextEqual(dashboardAccessKey, accessKey))) {
    throw new Error('DASHBOARD_ACCESS_KEY must be distinct from TRADE_FAIR_ACCESS_KEY and at least 16 characters.');
  }
  return {
    host: env.HOST || '127.0.0.1', port, origin: originUrl.origin,
    accessKey, sessionSecret, headerKey,
    captureUrl: readUrl('N8N_CAPTURE_URL'), statusUrl: readUrl('N8N_STATUS_URL'),
    publicEnabled: env.PUBLIC_FORM_ENABLED === 'true', secureCookies,
    dashboardEnabled, dashboardDatabaseUrl, dashboardAccessKey,
    upstreamTimeoutMs: 20000,
    limits: {
      login: { count: 8, windowMs: 15 * 60 * 1000 },
      internal: { count: 30, windowMs: 60 * 1000 },
      public: { count: 5, windowMs: 10 * 60 * 1000 },
      status: { count: 80, windowMs: 60 * 1000 },
      globalCapture: { count: 120, windowMs: 60 * 1000 },
      globalPublic: { count: 20, windowMs: 10 * 60 * 1000 },
    },
    rateLimitCapacity: 10000,
  };
}

class RequestError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

function securityHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}

function sendJson(res, status, body, headers = {}) {
  if (res.headersSent || res.destroyed) return;
  securityHeaders(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

function failure(res, status, code, { details = [], retryable = false, persistence = 'not_stored', headers = {} } = {}) {
  sendJson(res, status, {
    success: false,
    error: { code, message: API_MESSAGES[code] || 'The request could not be completed.', details },
    retryable,
    persistence_status: persistence,
  }, headers);
}

function readJson(req, maximum = MAX_BODY) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json(?:\s*;|\s*$)/i.test(String(req.headers['content-type'] || ''))) {
      req.resume(); reject(new RequestError(415, 'UNSUPPORTED_MEDIA_TYPE')); return;
    }
    if (Number(req.headers['content-length']) > maximum) {
      req.resume(); reject(new RequestError(413, 'PAYLOAD_TOO_LARGE')); return;
    }
    let size = 0;
    let rejected = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > maximum) {
        rejected = true; chunks.length = 0;
        reject(new RequestError(413, 'PAYLOAD_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      try {
        const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('object required');
        resolve(body);
      } catch { reject(new RequestError(400, 'INVALID_JSON')); }
    });
    req.on('aborted', () => reject(new RequestError(400, 'INVALID_JSON')));
    req.on('error', () => reject(new RequestError(400, 'INVALID_JSON')));
  });
}

function constantTimeTextEqual(left, right) {
  const a = createHash('sha256').update(String(left)).digest();
  const b = createHash('sha256').update(String(right)).digest();
  return timingSafeEqual(a, b);
}

function signSession(config, now, scope = 'form') {
  const issued = Math.floor(now() / 1000);
  const payload = Buffer.from(JSON.stringify({ v: 1, iat: issued, exp: issued + SESSION_SECONDS, scope, nonce: randomBytes(16).toString('hex') })).toString('base64url');
  const signature = createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function readSession(req, config, now) {
  const cookies = String(req.headers.cookie || '').split(';');
  const value = cookies.find((part) => part.trim().startsWith('trade_fair_session='))?.trim().slice('trade_fair_session='.length);
  if (!value || value.length > 2048) return null;
  const parts = value.split('.');
  if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return null;
  const signature = createHmac('sha256', config.sessionSecret).update(parts[0]).digest('base64url');
  if (!constantTimeTextEqual(parts[1], signature)) return null;
  try {
    const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const current = Math.floor(now() / 1000);
    return data.v === 1 && Number.isInteger(data.iat) && Number.isInteger(data.exp) &&
      data.iat <= current + 30 && data.exp > current && data.exp - data.iat === SESSION_SECONDS &&
      (data.scope === undefined || data.scope === 'form' || data.scope === 'dashboard') ? data : null;
  } catch { return null; }
}
function validSession(req, config, now) { return readSession(req, config, now) !== null; }
function validDashboardSession(req, config, now) { return readSession(req, config, now)?.scope === 'dashboard'; }

function sessionCookie(token, config, maxAge = SESSION_SECONDS) {
  return `trade_fair_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.secureCookies ? '; Secure' : ''}`;
}

function safeCaptureReceipt(body, status) {
  if (![200, 201].includes(status) || body?.success !== true || body.persisted !== true ||
      !LEAD_ID.test(body.lead_id || '') || !DUPLICATE_STATES.has(body.status) ||
      body.processing_status !== 'pending' || typeof body.idempotent_replay !== 'boolean' ||
      typeof body.review_required !== 'boolean' || (status === 200) !== body.idempotent_replay) return null;
  return {
    success: true, persisted: true, lead_id: body.lead_id, status: body.status,
    message: 'Lead received successfully', processing_status: 'pending',
    idempotent_replay: body.idempotent_replay, review_required: body.review_required,
  };
}

function safeStatus(body, leadId) {
  const date = (value) => value === null || (typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)));
  if (body?.success !== true || body.lead_id !== leadId || !PROCESSING_STATES.has(body.processing_status) ||
      !Number.isInteger(body.processing_attempts) || body.processing_attempts < 0 ||
      typeof body.review_required !== 'boolean' ||
      !(body.score_band === null || ['HOT', 'WARM', 'COLD'].includes(body.score_band)) ||
      !(body.score_total === null || (Number.isInteger(body.score_total) && body.score_total >= 0 && body.score_total <= 100)) ||
      !(body.email_status === null || EMAIL_STATES.has(body.email_status)) ||
      !date(body.next_retry_at) || !date(body.email_next_retry_at) || !date(body.updated_at)) return null;
  return {
    success: true, lead_id: body.lead_id, processing_status: body.processing_status,
    processing_attempts: body.processing_attempts, next_retry_at: body.next_retry_at,
    last_error_code: typeof body.last_error_code === 'string' && /^[A-Z0-9_]{1,64}$/.test(body.last_error_code) ? body.last_error_code : null,
    review_required: body.review_required, score_band: body.score_band, score_total: body.score_total,
    email_status: body.email_status, email_next_retry_at: body.email_next_retry_at, updated_at: body.updated_at,
  };
}

async function readUpstreamJson(response) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') || '')) throw new Error('unexpected response');
  if (Number(response.headers.get('content-length')) > 65536) throw new Error('oversized response');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('empty response');
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 65536) { await reader.cancel(); throw new Error('oversized response'); }
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createGateway(config, { fetchImpl = globalThis.fetch, now = Date.now, dashboardStore = null } = {}) {
  const dashboard = config.dashboardEnabled
    ? (dashboardStore || createDashboardDb({ connectionString: config.dashboardDatabaseUrl }))
    : null;
  const rateBuckets = new Map();
  const globalBuckets = new Map(); // Two fixed buckets cannot be evicted by new IPs.
  const applyRate = (req, res, kind) => {
    const rule = config.limits[kind];
    const current = now();
    const global = kind === 'globalCapture' || kind === 'globalPublic';
    const buckets = global ? globalBuckets : rateBuckets;
    // The socket peer is authoritative. X-Forwarded-For is deliberately ignored.
    const address = req.socket.remoteAddress || 'unknown';
    const key = global ? kind : `${kind}:${address}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.until <= current) {
      if (!global && buckets.size >= config.rateLimitCapacity) {
        for (const [entry, value] of buckets) {
          if (value.until <= current) buckets.delete(entry);
        }
        if (buckets.size >= config.rateLimitCapacity) buckets.delete(buckets.keys().next().value);
      }
      bucket = { count: 0, until: current + rule.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count <= rule.count) return true;
    const wait = Math.max(1, Math.ceil((bucket.until - current) / 1000));
    req.resume();
    failure(res, 429, 'RATE_LIMITED', { retryable: true, headers: { 'Retry-After': String(wait) } });
    return false;
  };
  const requireOrigin = (req, res) => {
    if (req.headers.origin === config.origin) return true;
    req.resume(); failure(res, 403, 'SAME_ORIGIN_REQUIRED'); return false;
  };
  const requireSession = (req, res) => {
    if (validSession(req, config, now)) return true;
    req.resume(); failure(res, 401, 'AUTH_REQUIRED'); return false;
  };
  const requireDashboardSession = (req, res) => {
    if (validDashboardSession(req, config, now)) return true;
    req.resume(); failure(res, 401, 'AUTH_REQUIRED'); return false;
  };
  const callUpstream = async (url, payload) => {
    const response = await fetchImpl(url, {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Trade-Fair-Key': config.headerKey },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(config.upstreamTimeoutMs),
    });
    return { response, body: await readUpstreamJson(response) };
  };
  const handleCapture = async (req, res, isPublic) => {
    if (!requireOrigin(req, res)) return;
    if (!isPublic && !requireSession(req, res)) return;
    if (!applyRate(req, res, isPublic ? 'public' : 'internal')) return;
    if (!applyRate(req, res, 'globalCapture') || (isPublic && !applyRate(req, res, 'globalPublic'))) return;
    const payload = await readJson(req);
    if ('company_fax' in payload && payload.company_fax !== '' && payload.company_fax !== null) {
      failure(res, 422, 'REQUEST_REJECTED'); return;
    }
    delete payload.company_fax;
    // A browser-supplied source never grants identity or privilege.
    payload.source = isPublic ? 'public_form' : 'internal_form';
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_BODY) {
      failure(res, 413, 'PAYLOAD_TOO_LARGE'); return;
    }
    try {
      const { response, body } = await callUpstream(config.captureUrl, payload);
      const receipt = safeCaptureReceipt(body, response.status);
      if (receipt) { sendJson(res, response.status, receipt); return; }
      if (response.status === 409 && body?.error?.code === 'IDEMPOTENCY_CONFLICT') {
        failure(res, 409, 'IDEMPOTENCY_CONFLICT'); return;
      }
      if (response.status === 422 && body?.error?.code === 'VALIDATION_FAILED') {
        const details = (Array.isArray(body.error.details) ? body.error.details : [])
          .filter((item) => FIELDS.has(item?.field) && DETAIL_CODES.has(item?.code))
          .slice(0, 20).map((item) => ({ field: item.field, code: item.code, message: 'Check this field.' }));
        failure(res, 422, 'VALIDATION_FAILED', { details }); return;
      }
      if ([400, 413, 415].includes(response.status)) {
        const code = response.status === 413 ? 'PAYLOAD_TOO_LARGE' : response.status === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : 'INVALID_JSON';
        failure(res, response.status, code); return;
      }
      // A broken upstream response, timeout or 5xx never becomes a persistence acknowledgement.
      failure(res, 503, 'STORAGE_UNAVAILABLE', { retryable: true, persistence: 'unknown' });
    } catch {
      failure(res, 503, 'STORAGE_UNAVAILABLE', { retryable: true, persistence: 'unknown' });
    }
  };

  const handler = async (req, res) => {
    securityHeaders(res);
    try {
      if (!req.url?.startsWith('/')) { failure(res, 400, 'INVALID_JSON'); return; }
      const url = new URL(req.url, config.origin);
      const route = url.pathname;
      if (req.method === 'GET' && route === '/healthz') {
        sendJson(res, 200, { success: true, service: 'trade-fair-gateway' }); return;
      }
      if (req.method === 'GET' && route === '/api/session') {
        sendJson(res, 200, { success: true, authenticated: validSession(req, config, now), dashboard_authenticated: config.dashboardEnabled && validDashboardSession(req, config, now), public_form_enabled: config.publicEnabled }); return;
      }
      if (req.method === 'POST' && route === '/api/login') {
        if (!requireOrigin(req, res) || !applyRate(req, res, 'login')) return;
        const body = await readJson(req);
        const accessKey = typeof body.access_key === 'string' ? body.access_key : '';
        const formMatch = constantTimeTextEqual(accessKey, config.accessKey);
        const dashboardMatch = config.dashboardEnabled && constantTimeTextEqual(accessKey, config.dashboardAccessKey);
        if (!formMatch && !dashboardMatch) { failure(res, 401, 'INVALID_ACCESS_KEY'); return; }
        sendJson(res, 200, { success: true, authenticated: true }, { 'Set-Cookie': sessionCookie(signSession(config, now, dashboardMatch ? 'dashboard' : 'form'), config) }); return;
      }
      if (req.method === 'POST' && route === '/api/logout') {
        if (!requireOrigin(req, res)) return;
        req.resume();
        sendJson(res, 200, { success: true }, { 'Set-Cookie': sessionCookie('', config, 0) }); return;
      }
      if (req.method === 'POST' && route === '/api/leads') {
        await handleCapture(req, res, false); return;
      }
      if (req.method === 'POST' && route === '/api/public/leads' && config.publicEnabled) {
        await handleCapture(req, res, true); return;
      }
      const match = /^\/api\/leads\/(FAIR-[0-9a-f-]+)$/.exec(route);
      if (req.method === 'GET' && match) {
        if (!requireSession(req, res) || !applyRate(req, res, 'status')) return;
        const leadId = match[1];
        const submissionId = url.searchParams.get('submission_id') || '';
        if (!LEAD_ID.test(leadId) || !SUBMISSION_ID.test(submissionId) || url.searchParams.getAll('submission_id').length !== 1) {
          failure(res, 400, 'INVALID_JSON'); return;
        }
        try {
          const { response, body } = await callUpstream(config.statusUrl, { lead_id: leadId, submission_id: submissionId });
          const status = response.status === 200 ? safeStatus(body, leadId) : null;
          if (status) { sendJson(res, 200, status); return; }
          if (response.status === 404 && body?.error?.code === 'NOT_FOUND') { failure(res, 404, 'NOT_FOUND'); return; }
          failure(res, 503, 'STATUS_UNAVAILABLE', { retryable: true, persistence: 'unknown' });
        } catch { failure(res, 503, 'STATUS_UNAVAILABLE', { retryable: true, persistence: 'unknown' }); }
        return;
      }
      // WBS-TF-04 DASHBOARD: admin-scoped Gateway session and rate limiter protect every read.
      // When disabled, these paths fall through to the generic 404 handler below.
      if (config.dashboardEnabled && route === '/api/dashboard') {
        if (req.method !== 'GET') { req.resume(); failure(res, 405, 'REQUEST_REJECTED'); return; }
        if (!requireDashboardSession(req, res) || !applyRate(req, res, 'status')) return;
        let opts;
        try { opts = parseDashboardQuery(url.searchParams); }
        catch { failure(res, 400, 'INVALID_JSON'); return; }
        try { sendJson(res, 200, await dashboard.query(opts)); }
        catch { failure(res, 503, 'STATUS_UNAVAILABLE', { retryable: true, persistence: 'unknown' }); }
        return;
      }
      if (config.dashboardEnabled && route === '/dashboard-login.js') {
        if (!['GET', 'HEAD'].includes(req.method)) { req.resume(); failure(res, 405, 'REQUEST_REJECTED'); return; }
        req.resume();
        const content = await readFile(path.join(WEB_ROOT, 'dashboard-login.js'));
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': content.length });
        res.end(req.method === 'HEAD' ? undefined : content);
        return;
      }
      if (config.dashboardEnabled && ['/dashboard', '/dashboard.js', '/dashboard.css'].includes(route)) {
        if (!['GET', 'HEAD'].includes(req.method)) { req.resume(); failure(res, 405, 'REQUEST_REJECTED'); return; }
        const dashboardAuthed = validDashboardSession(req, config, now);
        if (!dashboardAuthed) {
          // Serve the German login page only when a browser is asking for /dashboard.
          // /dashboard.js and /dashboard.css stay strictly session-protected.
          const acceptsHtml = (req.headers.accept || '').toLowerCase().includes('text/html');
          if (route === '/dashboard' && acceptsHtml) {
            req.resume();
            const content = await readFile(path.join(WEB_ROOT, 'dashboard-login.html'));
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': content.length });
            res.end(req.method === 'HEAD' ? undefined : content);
            return;
          }
          req.resume(); failure(res, 401, 'AUTH_REQUIRED'); return;
        }
        const filename = route === '/dashboard' ? 'Messe-Admin-Hub.html'
          : route === '/dashboard.js' ? 'dashboard.js' : 'dashboard.css';
        const type = route === '/dashboard' ? 'text/html; charset=utf-8'
          : route === '/dashboard.js' ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8';
        const content = await readFile(path.join(WEB_ROOT, filename));
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': content.length });
        res.end(req.method === 'HEAD' ? undefined : content);
        return;
      }
      const staticRoutes = new Map([
        ['/', ['index.html', 'text/html; charset=utf-8']],
        ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
        ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
        ['/berater', ['berater.html', 'text/html; charset=utf-8']],
        ['/berater-adapter.js', ['berater-adapter.js', 'text/javascript; charset=utf-8']],
      ]);
      if (config.publicEnabled) staticRoutes.set('/public', ['index.html', 'text/html; charset=utf-8']);
      if ((req.method === 'GET' || req.method === 'HEAD') && staticRoutes.has(route)) {
        const [filename, type] = staticRoutes.get(route);
        const content = await readFile(path.join(WEB_ROOT, filename));
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': content.length });
        res.end(req.method === 'HEAD' ? undefined : content); return;
      }
      req.resume();
      if (['/api/login', '/api/logout', '/api/leads', '/api/public/leads'].includes(route)) {
        failure(res, route === '/api/public/leads' && !config.publicEnabled ? 404 : 405, 'REQUEST_REJECTED'); return;
      }
      if (config.dashboardEnabled && route === '/api/dashboard') {
        failure(res, 405, 'REQUEST_REJECTED'); return;
      }
      failure(res, 404, 'NOT_FOUND');
    } catch (error) {
      if (error instanceof RequestError) { failure(res, error.status, error.code); return; }
      failure(res, 500, 'CONFIGURATION_ERROR', { retryable: true, persistence: 'unknown' });
    }
  };

  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 30000, headersTimeout: 10000 }, handler);
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const config = loadConfig();
    const server = createGateway(config);
    server.listen(config.port, config.host, () => {
      // Never log request bodies, query tokens, keys, cookies or upstream URLs.
      process.stdout.write(`Trade Fair Assistant listening on ${config.origin}\n`);
    });
    const stop = () => server.close(() => process.exit(0));
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  } catch (error) {
    process.stderr.write(`Startup configuration error: ${error.message}\n`);
    process.exitCode = 1;
  }
}
