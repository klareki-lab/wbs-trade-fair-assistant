# Dashboard V1 — implementation note

Companion to `docs/DASHBOARD_V1_INTEGRATION.md` (the contract).
Issue: klareki-lab/wbs-trade-fair-assistant #16. Branch: `feat/dashboard-v1-black`
cut from `feature/messe-dashboard-v1` (which is itself cut from
`baseline/live-2026-10-24`). No deployment is performed by this change.

## Files changed

| Path | Purpose |
| --- | --- |
| `gateway/server.mjs` | New optional config, upstream call, allowlist validator, three routes, `/api/session` field. |
| `web/dashboard.html` | Sanitized visual layout (no secrets, no external URLs, no chat/merge/split). |
| `web/dashboard.css` | Extracted from Yuriy's inline `<style>`, plus five V1-specific additions. |
| `web/dashboard.js` | Same-origin fetch, textContent-only renderer, pagination, drawer, logout, no `innerHTML` assignments. |
| `tests/test_gateway.mjs` | 16 tests (16/16 PASS). |
| `workflows/wf-05-messe-hub-dashboard-data.adapted.json` | Adapted WF-05, `active:false`, not imported. |
| `workflows/README.md` | Import/activation gate for Owner. |

## Required environment variables (names only, no values)

Both must be set together, or both unset. Partial configuration refuses to start.

| Name | Purpose |
| --- | --- |
| `N8N_DASHBOARD_URL` | HTTPS URL of the WF-05 webhook `.../webhook/messe-hub/dashboard-leads`. Must be http(s), no embedded credentials, no fragment. |
| `N8N_DASHBOARD_HEADER_KEY` | Value of the n8n credential `WBS Trade Fair — Dashboard Auth` (header auth). **Must be distinct** from `N8N_HEADER_KEY` used by WF-A/B/C/D. |

Existing variables (`TRADE_FAIR_ACCESS_KEY`, `SESSION_SECRET`, `N8N_HEADER_KEY`, `N8N_CAPTURE_URL`, `N8N_STATUS_URL`, `APP_ORIGIN`, `PUBLIC_FORM_ENABLED`, `PORT`, `HOST`) are unchanged.

## Credential provisioning (by reference name only)

- **n8n credential `WBS Trade Fair — Dashboard Auth`** — type Header Auth, header name `X-Trade-Fair-Key`, value TBD by Owner, bound only to the WF-05 webhook. Must not be reused by WF-A/B/C/D or any other workflow.
- **n8n credential `WBS Trade Fair — Neon PostgreSQL (dashboard reader)`** — type Postgres, SELECT-only on `trade_fair.lead_submissions`, `trade_fair.companies`, `trade_fair.contacts`, `trade_fair.processing_results`. If the existing Neon role used by WF-A/B/C/D is already least-privilege for these tables, reuse the same credential object; otherwise provision a new scoped role out of band. **No new SQL grants are made as part of this PR.**

Neither credential value appears in Git, chat, PRs, or any shipped file. The adapted workflow JSON references credentials by name only, with no `id` field.

## HTTP contract

### `GET /dashboard` (private HTML)
Requires valid `trade_fair_session` cookie. Unauthenticated requests get HTTP **302 to `/`** (the existing login page). HTML is served with `Cache-Control: no-store`, strict CSP (`script-src 'self'`), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, no inline scripts, no inline event handlers.

### `GET /dashboard.css`, `GET /dashboard.js`
Also session-protected (401 for anonymous callers). CSS/JS carry the same security headers.

### `GET /api/dashboard/leads?page=&limit=`
Private JSON. Validation:
- `page` matches `/^[1-9][0-9]{0,4}$/`, 1..10000.
- `limit` matches `/^[1-9][0-9]{0,2}$/`, 1..50 (default 25).
- Any other query parameter → **400** `INVALID_JSON`.
- `requireSession` + `applyRate('status', 80/60s)`.

The handler calls `${N8N_DASHBOARD_URL}` server-to-server with `X-Trade-Fair-Key: ${N8N_DASHBOARD_HEADER_KEY}`, `Content-Type: application/json`, 20 s timeout, `redirect: 'error'`. Response is validated:
- Content-Type `application/json`.
- `Content-Length` and streaming total both ≤ 128 KiB (`dashboardMaxResponseBytes`).
- Envelope: `{success:true, total:int, leads:[]}` with `leads.length ≤ limit`.
- Each lead passes `safeDashboardLead`: `lead_id` matches the `FAIR-UUID` regex; `created_at` is a parseable ISO string ≤ 40 chars; `company_name` and `contact_name` are strings ≤ 200 chars (empty allowed); `processing_status ∈ {pending, processing, completed, failed}`; `score_band ∈ {HOT, WARM, COLD}` or null; `duplicate_status ∈ {NEW, POSSIBLE_DUPLICATE, EXISTING_CONTACT}`; `review_required` is boolean.

Rows that fail the allowlist are **silently dropped**; extra upstream fields never reach the client. On any failure (timeout, non-2xx, oversized, bad JSON, bad shape) the handler returns **503 `STATUS_UNAVAILABLE`** with no internal URL, SQL, or key bytes.

### `GET /api/session`
Adds one boolean field: `dashboard_enabled`. No other change.

## Allowlist shipped to the browser

```
{ success, read_only, page, limit, total, as_of, leads: [
  { lead_id, created_at, company_name, contact_name,
    processing_status, score_band, duplicate_status, review_required } ]}
```

**Not shipped**: `email`, `phone`, `website`, `notes`, `normalized_payload`, `uncertainty_flags`, `ai_extraction`, `company_research`, score integer, email_status, email_error, processing_attempts, processing_error, scored_at, submission_id. These remain in Neon and in the server-side workflow context only.

## Browser behaviour

- `web/dashboard.js` uses `textContent` and `document.createTextNode` exclusively; `innerHTML` is never assigned. The test suite asserts this on the served asset.
- CSP is `script-src 'self'` (no `'unsafe-inline'`); the login page redirect is server-side (302), not JavaScript.
- Session cookie is set by the existing `POST /api/login` only; the dashboard script never sees or stores credentials.

## Tests

16/16 pass under `node --test tests/test_gateway.mjs`:

```
tests 16  pass 16  fail 0  duration_ms 129
```

Coverage summary:

- Baseline regression (login/session/capture/status/public-form fields).
- Config fail-closed: unset → disabled 404; half-set → startup error; invalid URL → startup error.
- Access control: anon `/dashboard` → 302 to `/`; anon API → 401 JSON; HEAD matches GET; CSS/JS session-protected; logout invalidates subsequent API access.
- No-leak: HTML and JS contain no `CONFIG.benutzer`, `CONFIG.passwort`, `Authorization: Basic`, `n8n.poljanzew.app`, no env values, and preserve CSP.
- API: method guard (POST/DELETE → 405, no upstream call); allowlist shape; strict pagination clamp; unknown query params → 400; empty / single / many / malformed rows; XSS strings preserved as JSON string but never emitted as HTML; dashboard.js uses only `textContent`.
- Upstream fail-closed: HTTP 500, exception, oversized body, non-JSON content type — all become 503 with no internal URL/SQL/key in the response body.
- Isolation: upstream never receives the user's session cookie or `TRADE_FAIR_ACCESS_KEY`; only the dashboard-scoped header key is attached.

## Staging verification (operator checklist, not performed by this PR)

Owner-authorized staging run only. No production touch.

1. Create n8n credentials `WBS Trade Fair — Dashboard Auth` (header auth) and `WBS Trade Fair — Neon PostgreSQL (dashboard reader)` (Postgres, SELECT-only on the four tables listed above). Record the ids privately.
2. Import `workflows/wf-05-messe-hub-dashboard-data.adapted.json` to **staging n8n**; attach the two credentials by id; keep `active: false`.
3. Set gateway staging env: `N8N_DASHBOARD_URL=https://<staging-n8n>/webhook/messe-hub/dashboard-leads`, `N8N_DASHBOARD_HEADER_KEY=<cred value>`.
4. Activate WF-05 **on staging only**. Confirm `curl -X POST -H 'X-Trade-Fair-Key: <cred>' -H 'Content-Type: application/json' --data '{"page":1,"limit":10}' <staging n8n URL>` returns the expected envelope.
5. Deploy the Gateway candidate on staging per the standard reversible container-swap procedure. Confirm:
   - `curl https://<staging>/dashboard` with no cookie → 302 `/`.
   - Browser login via `/`, then `/dashboard` shows the UI; `/api/dashboard/leads?page=1&limit=10` returns the allowlisted JSON.
   - `curl https://<staging>/dashboard.css` and `/dashboard.js` without cookie → 401.
   - `curl -X POST https://<staging>/api/dashboard/leads` → 405.
6. Run `node --test tests/test_gateway.mjs` against this branch (16/16 PASS).
7. Decline to activate WF-05 or Dashboard in production until the Owner explicitly schedules it.

## Safe rollback

- Gateway: swap back to the previous container image using the standard L1 rollback machinery (`.saved-<TS>` → previous image). No DB or workflow changes to revert.
- n8n: deactivate WF-05 (`active: false`). The webhook stops accepting requests immediately; no in-flight writes to roll back (WF-05 is read-only).
- Credentials: if the dashboard header key is suspected compromised, rotate the Header Auth credential value in n8n and update `N8N_DASHBOARD_HEADER_KEY` in the Gateway env; the other n8n credentials are untouched.
- Compose/git: this PR does not modify `main`; closing the PR removes all deployment-relevant changes from history on the integration target.

## Release blockers / gaps

1. **Reconciliation with the TF-04..TF-12 production dashboard (on `main`).** Production currently serves a different Dashboard implementation (Neon `trade_fair.dashboard_snapshot` + distinct `DASHBOARD_ACCESS_KEY` scope) deployed to `https://messe.klare-ki.de/dashboard`. V1 is a parallel implementation off an older baseline. Owner must decide which path moves forward before V1 can land on production. Options: (a) merge V1 as a staging-only route, (b) retarget V1 against `main` (adds a Dashboard-role scope + login screen already present in `main`), (c) retire TF-12 in favor of V1.
2. **Dashboard-reader Neon credential.** The adapted WF-05 references `WBS Trade Fair — Neon PostgreSQL (dashboard reader)`. If the existing `trade_fair_app` role already has SELECT on `processing_results`, no new grant is needed; otherwise Owner must provision a scoped role before V1 goes live. No grant is applied by this PR.
3. **n8n webhook `path` collision.** The adapted path is `messe-hub/dashboard-leads` (distinct from Yuriy's `messe-hub/daten`). Confirm no live workflow already uses it before import.
4. **PAM n8n canary thresholds.** On the production VPS the `n8n-canary-monitor` enforces `executions_5m` STOP=60 (post-TF-F1). Enabling WF-05 adds no scheduler load (webhook-only) but the Owner should still re-baseline the canary when it goes active (`--planned-replacement --initialize-baseline --once`) if the n8n container is restarted. This PR does not touch the VPS or the canary.
5. **`gateway/package.json` test path.** The baseline `scripts.test` references `../tests/test_gateway.mjs` — now present. No change to the script.
6. **Default branch mismatch.** The repository's `defaultBranchRef` is `baseline/live-2026-10-24` (not `main`); PR base follows the Issue instruction.
7. **No pagination in search.** The current V1 search box filters only the currently-fetched page client-side. V2 should move search to the server with proper SQL.

## Explicit non-goals in V1

- No live editing, merging, splitting of leads.
- No AI chat, no Lead-Assistent chat.
- No email/phone/website display.
- No automatic polling (the UI loads once; Owner clicks refresh).
- No Gruppen-Verlauf (n8n DataTable).
