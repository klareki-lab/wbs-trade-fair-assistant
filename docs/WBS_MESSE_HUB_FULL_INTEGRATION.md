# WBS Messe-Hub FULL — integration note (issue #19)

Companion to issue #19 and to `docs/WBS_TF_10_HANDOVER.md`. Delivers full CRM
grouping + two AI endpoints on top of the existing TF-04..TF-12 production
dashboard. **No deployment, no VPS access, no changes to WF-A..D, Neon
schema or secrets** performed by this PR.

Base commit: `main` at `5fb6348db8954d233fcee5c8c782542e18f2ec90` (TF-12 head).
Working branch: `feat/messe-hub-full-integration`.

## 1. What this PR contains

| Path | Purpose |
| --- | --- |
| `sql/production/dashboard_crm_v1_up.sql` | Owner-authorized Neon migration adding `trade_fair.lead_groups`, `lead_group_members`, `lead_group_audit`, and SECURITY DEFINER functions `crm_group_merge/split/extract/ignore/revert/snapshot`. Extends existing `trade_fair_dashboard` EXECUTE grants. **Not applied by this PR**. |
| `sql/production/dashboard_crm_v1_down.sql` | Reversible rollback. Drops only the new tables/functions. |
| `gateway/dashboard-crm.mjs` | PostgreSQL adapter (same pattern as `dashboard-db.mjs`) that invokes the SECURITY DEFINER functions via a read-only pool. Server-side allowlist on return. |
| `gateway/server.mjs` | Six new routes (`/api/dashboard/groups` {GET,POST}, `.../split`, `.../extract`, `.../ignore`, `.../revert`, `/api/dashboard/ai/extract`, `/api/dashboard/ai/ask`). All session-protected via existing `requireDashboardSession`. CSRF via existing `requireOrigin`. Rate-limited via existing `internal`/`status` buckets. AI proxies use existing `N8N_HEADER_KEY`. |
| `web/Messe-Admin-Hub.html` | Adds multi-select action bar, CRM-Gruppen panel, two modal dialogs (Lead erfassen · AI, Lead-Assistent). No decorative fake buttons: every control is wired. |
| `web/dashboard.js` | textContent-only rendering throughout. CRM mutations, groups panel, AI modals (two-step: extract → confirm → submit to existing WF-A). |
| `web/dashboard.css` | Styles for new widgets. |
| `workflows/wf-07-messe-hub-ai-extract.adapted.json` | Adapted WF-07 (HTTP webhook + header auth; no chat trigger; no auto-submit). `active: false`. Not imported. |
| `workflows/wf-08-messe-hub-ai-ask.adapted.json` | Adapted WF-08 (HTTP webhook + grounded answer schema; cites only context_lead_ids; no write tools). `active: false`. Not imported. |
| `workflows/README.md` | Credential provisioning + import gate for Owner. |
| `tests/test_gateway_dashboard.mjs` | 63/63 PASS (48 baseline + **15 new TF-19 tests**). |

Nothing in `web/index.html`, `web/app.js`, form login flow, WF-A/B/C/D exports,
production SQL migrations (PR #9 blobs), or existing TF-04..TF-12 behaviour
changes.

## 2. Preserved admin UX and credentials

- Existing admin login (`DASHBOARD_ACCESS_KEY`), signed dashboard-scope cookie
  (HttpOnly, Secure, SameSite=Strict), `GET /api/dashboard` + `trade_fair.dashboard_snapshot`,
  and the `/dashboard` + `/dashboard-login` pages are unchanged.
- CRM endpoints reuse the same session scope. No new keys, no new passwords.
- AI endpoints reuse `N8N_HEADER_KEY` and the `WBS Trade Fair — Gateway Auth`
  credential — the same one WF-A/B/C/D already use. No new credentials unless
  Owner later chooses to split LLM billing per feature.

## 3. Required environment variables (names only, no values)

Existing (unchanged): `TRADE_FAIR_ACCESS_KEY`, `SESSION_SECRET`, `N8N_HEADER_KEY`,
`N8N_CAPTURE_URL`, `N8N_STATUS_URL`, `DASHBOARD_ENABLED`, `DASHBOARD_DATABASE_URL`,
`DASHBOARD_ACCESS_KEY`, `APP_ORIGIN`, `PORT`, `HOST`, `PUBLIC_FORM_ENABLED`.

New (optional; both set together or both unset):

| Name | Purpose |
| --- | --- |
| `N8N_AI_EXTRACT_URL` | HTTPS webhook URL for WF-07 (`messe-hub/ai-extract`). |
| `N8N_AI_ASK_URL` | HTTPS webhook URL for WF-08 (`messe-hub/ai-ask`). |

Partial AI config refuses to start. If unset: CRM remains fully functional;
AI modals open and display *"nicht konfiguriert"* instead of silently failing.

## 4. Yuriy Messe-Hub acceptance matrix

| Yuriy control / feature | V1 implementation | File |
| --- | --- | --- |
| Login (Basic Auth to n8n webhook) | **Replaced** by existing `DASHBOARD_ACCESS_KEY` + signed cookie. No Basic Auth anywhere. | `gateway/server.mjs`, `web/dashboard-login.html` |
| Dashboard total + category + duplicates + today + score average | **Already in `dashboard_snapshot`**, rendered in KPI cards. | `web/dashboard.js :: renderStats` |
| Lead-Datenbank table (searchable, filterable, sortable, paginated) | **Preserved from TF-12**: search, band, processing, email, duplicate, sort, pagination. | `web/dashboard.js :: load/renderTable` |
| Lead details card (contact, notes, research, AI, score, email status) | **Preserved** in the drawer; all 32 fields from `dashboard_snapshot`. | `web/dashboard.js :: showDetail` |
| **Merge duplicates** | Multi-select → "Zusammenführen" → prompts for label → `POST /api/dashboard/groups` → `trade_fair.crm_group_merge`. Reversible via audit. | `dashboard-crm.mjs`, `sql/.../dashboard_crm_v1_up.sql` |
| **Split a group** | "Trennen" button on an active group → `POST /api/dashboard/groups/split` → group retired + members removed. Reversible. | `dashboard-crm.mjs` |
| **Extract one lead from a group** | "Herauslösen" per member → `POST /api/dashboard/groups/extract` → new single-member group. Reversible. | `dashboard-crm.mjs` |
| **Ignore duplicate suggestion** | "Als Duplikate ignorieren" from action bar → `POST /api/dashboard/groups/ignore` → group with `status='ignored'`. | `dashboard-crm.mjs` |
| **Revert any CRM action** | Each mutation returns an `audit_id`; "Rückgängig" on retired/ignored groups → `POST /api/dashboard/groups/revert` → re-activates the previous state. | `dashboard-crm.mjs` |
| CRM audit history | `trade_fair.lead_group_audit` persists every action with actor, timestamp, affected `lead_ids`, note, reversal link. Visible in the UI as retired/ignored groups when "Historie einblenden" is toggled. | SQL migration + UI toggle |
| User attribution | Actor = `dashboard-admin:<session_nonce_8>` derived from the signed cookie. Distinguishes per-login session without multi-user accounts. V2 can hook a real user id. | `gateway/server.mjs :: auditActor` |
| **AI capture: notes → extracted fields → confirm → submit** | "Neuer Lead (AI)" → paste notes → "Analysieren" calls WF-07 via Gateway → fields + confidence + uncertainty flags displayed → user edits/confirms → "An WF-A senden" POSTs `/api/leads` with the confirmed payload. **No auto-submit**; score-significant fields are never silently promoted. | `web/dashboard.js :: openAiExtract/aiAnalyze/aiSubmit` |
| **AI assistant chat** | "Assistent fragen" → `POST /api/dashboard/ai/ask` with the question + current page's lead IDs as context → WF-08 returns grounded answer + cited lead IDs. Answers capped at 8 KiB, 50 000 combined tokens. Only valid FAIR ids are shown as citations. | `web/dashboard.js :: openAiAsk/aiAsk`, `workflows/wf-08-...json` |
| Gruppen-Verlauf (n8n DataTable) | **Deferred.** CRM data lives in Neon (durable, backed up) instead. Retention of Yuriy's reference JSON for traceability only. | — |
| Chat routes (`/webhook/.../chat`) | **Removed from HTML.** No path from browser to n8n. All AI calls go via Gateway. | — |
| n8n.poljanzew.app URL | **Removed.** All upstreams point at this account's n8n via Gateway. | — |
| Basic Auth construction (`CONFIG.benutzer`, `CONFIG.passwort`) | **Removed.** No HTML/JS carries the admin password; session cookie is set by `/api/login` only. | — |

Every Yuriy affordance either works, is reimplemented more safely, or is
explicitly deferred with a visible "nicht in V1" indicator.

## 5. Security posture (preserved)

- CSP unchanged (`script-src 'self'`, no inline scripts, no `unsafe-inline`).
- All private responses carry `Cache-Control: no-store` via existing `securityHeaders`.
- `requireOrigin` + signed-cookie session on every mutation.
- Rate limits reused: `status` (80/min) for reads, `internal` (30/min) for CRM writes.
- Allowlist validators on every CRM upstream row and every AI response (confidence keys, uncertainty flag regex, citation regex, token caps).
- Upstream never receives the session cookie or `TRADE_FAIR_ACCESS_KEY`; only `X-Trade-Fair-Key: $N8N_HEADER_KEY`.
- Dashboard-reader role (`trade_fair_dashboard`) gains EXECUTE on 5 SECURITY DEFINER functions and the read-only `crm_groups_snapshot`. **No new table SELECT/INSERT/UPDATE/DELETE grants.** No access to raw `lead_submissions`, `companies`, `contacts`, `processing_results`, `email_outbox` beyond what `dashboard_snapshot` already allowed.
- Admin audit actor is session-nonced; raw session content is never exposed.

## 6. Test results

```
$ npm test --prefix gateway
tests 63  pass 63  fail 0  duration_ms ~230
```

New (TF-19) tests cover:

- CRM `/api/dashboard/groups`: anon 401, form-user 401, cross-origin POST 403, happy-path merge with session-nonced audit actor.
- CRM input validation: too few lead_ids (<2), non-FAIR id (SQL-injection string shape), oversize label, empty label, unknown payload keys — all 400/422.
- CRM reversibility: revert of a merge returns `reversed_audit_id`.
- CRM method guards: GET on write endpoints returns 405; cross-origin 403.
- AI 503 fail-closed when `N8N_AI_*` unset.
- AI extract allowlist: unknown fields in `extracted`/`confidence` dropped; uncertainty flags filtered by `/^[a-z_]{1,64}$/`.
- AI extract input validation: notes < 10 chars → 422; control characters → 422; upstream not called.
- AI ask grounding: citations outside allowlist dropped; invalid upstream envelope → 503.
- AI upstream HTTP 500: 503 fail-closed, no `upstream.test` / SQL / secret leaked.
- XSS strings from upstream: preserved as JSON string (not HTML), content-type stays `application/json`.
- `/api/session` advertises `crm_enabled` and `ai_enabled`.
- Partial AI env refuses to start.
- `/dashboard.js` contains CRM/AI wiring strings and **no `innerHTML` assignment**.
- `/dashboard` HTML contains CRM/AI controls and **no Yuriy Basic Auth / n8n.poljanzew.app / `CONFIG.benutzer` / `CONFIG.passwort`**.

All 48 baseline (TF-04..TF-12) regression tests still green.

## 7. SQL migration — Owner-authorized apply and rollback

Same gate as TF-07/PR #9: `-v production_branch_confirmed=on`, `neondb_owner` on
the production branch, one transaction. The migration refuses to run if the
tables already exist or if `trade_fair_dashboard` is missing.

```
# Apply (Owner only, out of band, on branch br-proud-moon-bapf67qs):
psql -X -v ON_ERROR_STOP=1 -v production_branch_confirmed=on \
     -f sql/production/dashboard_crm_v1_up.sql

# Rollback (also Owner only):
psql -X -v ON_ERROR_STOP=1 -v production_branch_confirmed=on \
     -f sql/production/dashboard_crm_v1_down.sql
```

The rollback drops only the new tables and functions. WF-A/B/C/D data remains untouched regardless of apply/rollback outcome.

## 8. Reversible staged cutover (Owner-approved only)

1. Independent Codex review of this PR.
2. Owner authorizes the SQL migration on **staging first** (if one exists) or
   directly on production with the Codex-reviewed script.
3. Owner provisions AI env values and credential bindings for WF-07 and WF-08
   on staging n8n (Owner side; this PR carries only names).
4. Owner activates WF-07 and WF-08 on **staging** and smoke-tests via Gateway
   loopback.
5. Build an immutable Gateway image from this PR's merged `main` using
   `Dockerfile.dashboard-staging` (TF-08 pattern).
6. Reversible container swap: new container `wbs-trade-fair-gateway.candidate`
   → preflight assertions per `docs/WBS_TF_08_RELEASE_PACKET.md §5.13` →
   stop/rename/start under a new `TF_ROLLOUT_TS`. L1 rollback via the saved
   container; L4 rollback via `dashboard_crm_v1_down.sql`.
7. Reconcile the PAM n8n canary baseline for the new container if n8n
   restarts (same procedure as OPS-N8N-F1).
8. External HTTPS acceptance: anon `/dashboard` → login page; dashboard-key
   login → table + stats; CRM merge of two leads returns 200 + audit id; CRM
   revert returns `reversed_audit_id`; AI extract (if WF-07 active) returns
   `{success, extracted, confidence, uncertainty_flags}`; AI ask (if WF-08
   active) returns `{success, answer, cited_lead_ids}`.

## 9. Release blockers / explicit missing items

1. **Independent Codex review** of the SQL migration (new tables + 6 SECURITY DEFINER functions touching trade_fair schema).
2. **Owner provisioning** of n8n WF-07/WF-08 (import the adapted JSONs; bind credentials; activate on staging).
3. **LLM provider credential** — Owner provisions the OpenAI (or Requesty) credential bound to WF-07 and WF-08's agent nodes. Not a Gateway concern.
4. **Chat threading persistence** — session-level only in V1. V2 can add server-side threads keyed by `session_id` if Owner wants shareable transcripts.
5. **Per-user attribution** — V1 uses session-nonced actor labels. Multi-user admin accounts are a V2 concern.
6. **PR #18** (feat/dashboard-v1-black) **supersedes-but-not-merge**: this PR builds on `main` (TF-12) and reuses useful tests from #18 without pulling in its older baseline. #18 should be closed as design-only once this PR lands.

## 10. Non-goals

- No WF-A/B/C/D definition changes.
- No new secrets in Git/chat/PR body/logs.
- No `main` writes (this is a draft branch; Owner reviews/merges separately).
- No deployment, VPS access, Neon schema writes, or n8n activation performed by this PR.
