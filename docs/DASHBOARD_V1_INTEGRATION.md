# Messe Dashboard V1 — integration contract

Status: implementation pending; this file is a design contract, **not** evidence of a deployed feature.
Baseline: `baseline/live-2026-10-24`. Target working branch: `feature/messe-dashboard-v1`.

## Scope
Replace the display layer at `/dashboard` using Yuriy's `dashboard/Messe-Admin-Hub.html` as visual reference. V1 is **read-only**; WF-A/B/C/D, production database and email delivery stay unchanged. Do not deploy the raw Yuriy HTML.

## Authentication / trust
- Reuse gateway signed, HttpOnly, SameSite=Strict cookie established by `POST /api/login`. No Basic Auth passwords or n8n URLs in HTML/JS.
- Restrict `GET /dashboard` and `GET /api/dashboard/leads` to `validSession`; unauthenticated requests receive 401 or a deliberate login redirect. For HEAD and GET, implement consistent guards.
- Same-origin browser fetch with cookies. Gateway talks to n8n server-to-server, with header auth credentials loaded from VPS secret env file, never sent to the client.
- Existing `/api/leads` and `/api/leads/:id` behavior must not change. Never expose raw `normalized_payload`, unbounded notes, full n8n response bodies, or credentials to the browser.
- Add strict allowlist serialization for dashboard data: lead_id, created_at, company_name, contact_name, status, score/category if confirmed. Decide precisely which PII fields may be shown for authorized users; avoid sending everything by default.
- Set `Cache-Control: no-store` on private HTML and all private API responses. Avoid storing credentials or sensitive lead data in localStorage/sessionStorage.
- Use a configured dashboard upstream URL (`N8N_DASHBOARD_URL`) from private gateway env and the existing `N8N_HEADER_KEY` or a **distinct scoped credential** for WF-05. Never hardcode `n8n.poljanzew.app`.
- Proxy calls must be time-bounded and check status/content-type/JSON envelope, cap response size, reject redirects, and fail closed.
- Only the gateway and trusted server-side workflow may fetch Neon data. n8n webhook itself must enforce its own auth.

## Workflow 05
- Adapt Yuriy's `dashboard/reference-workflows/05-Messe-Hub-Daten-fuers-Dashboard.json`; do not re-import 01–04.
- No wildcard CORS; no direct browser access to n8n webhooks.
- Query through existing least-privilege Neon role and validated functions. Do **not** expand `trade_fair_app` grants blindly.
- Paginate/filter server-side and cap returned records; original implementation loads all rows every 30 seconds.
- V1 does not require `Messe-Hub Gruppen-Verlauf` or `processing_results`; defer those features. A separate read-only, narrowed SQL view/function may be required.
- Preserve status semantics: email provider acceptance is not proof of inbox delivery; AI confidence must not be silently promoted to verified data.

## UI changes
- Copy/adapt Yuriy's visual layout into `web/dashboard.html` under same-origin gateway routing; preserve original reference in `dashboard/`.
- Remove inline `CONFIG.benutzer`, `CONFIG.passwort`, Basic authorization construction, foreign n8n base URL and hardcoded chat paths.
- Disable/hide Merge/Split, AI Capture, Chat Assistant and any write controls in V1; do not display misleading working controls.
- Display explicit loading/empty/error/no-permission states and last-refresh status.

## Tests required before PR approval
1. Unauthenticated `/dashboard` and `/api/dashboard/leads` reject access; authenticated requests work; logout invalidates subsequent access.
2. Existing login, lead capture, status and public form regression tests pass unchanged.
3. No secret or Basic Auth credential appears in browser sources, network responses or repository.
4. Rejected/slow/unreachable n8n upstream fails closed without leaking internal URLs or SQL.
5. Test response size, filtering, 0/1/many leads, database privilege failure, 401 and malicious strings (XSS escaping).
6. Dashboard data are read-only and no workflow A–D / schema / live queue / email addresses are modified.
7. Stage locally, then canary deployment with backup and rollback of gateway + web mounts. No production deployment without Owner approval.

## Open implementation questions
- The live gateway exposes only `/api/session`, capture and status routes; dashboard data API does not exist yet.
- `tests/test_gateway.mjs` referenced by gateway/package.json is absent from baseline.
- Confirm actual gateway container connectivity to dedicated n8n webhook and nginx `/dashboard` forwarding before release.
- Verify that site-specific personal-data handling is adequate for any external model calls. V1 should not invoke AI.

## Release gate
Code diff + automated test report + credential mapping by **names only** + deployment/rollback scripts + independent Codex review. No activation or import into live n8n; no VPS mutation prior to explicit Owner go/no-go.
