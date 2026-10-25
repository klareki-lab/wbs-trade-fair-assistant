# WBS-TF-10 — Final production handover

Date: 2026-10-25. Scope: close the WBS Trade Fair Assistant project after
the WBS-TF-09 full-E2E PASS. No credentials, URLs with passwords, or
private env files appear in this document.

## 1. System architecture

```
Mobile form   →  nginx :443 (Let's Encrypt)  →  wbs-trade-fair-gateway  →  n8n webhook (WF-A)
(messe form)      HSTS max-age=300             :3000 loopback, host net   /webhook/trade-fair/lead
                  final vhost + security hdrs  Dockerfile.dashboard-              │
                                               staging (immutable)              │
                                                                                 ▼
                                                                   Neon PostgreSQL (production branch)
                                                                   trade_fair schema (functions +
                                                                   lead_submissions, companies,
                                                                   contacts, processing_results,
                                                                   email_outbox)
                                                                                 │
                                                           ┌─────────────────────┼───────────────────┐
                                                           │                     │                   │
                                                        WF-B                   WF-D               WF-C
                                                     Lead Processing       Lead Status         Email Delivery
                                                     scheduler/min          webhook             scheduler/min
                                                     Tavily + OpenAI        read-only           Resend
                                                     write outbox pending   get_lead_status     to internal
                                                                                                mailbox only
```

- **Runtime SHA on production:** `main` = `b07984b3a9aa7b65fc29b31cd4c4942b43d8d728`, tree
  `4279f1f5b40c8320726a63dcde4793331c88e0d2` (PR #14 — Dashboard login
  — merged into TF-08 release at `91a126e / 4b1c8014…`).
- **Immutable image:** built from this SHA on the VPS using
  `Dockerfile.dashboard-staging`; image id
  `sha256:0f517bedff4b9de1b38d394aa80fbc4f27dc0e0963c79056571e54bcd60da516`,
  no host mounts, baked `/app/gateway` and `/app/web` (now including
  `dashboard-login.html` and `dashboard-login.js`).
- **Previous image for L1 rollback:** container
  `wbs-trade-fair-gateway.saved-20261025T075219Z` (Exited), image
  `sha256:9a656ebbf92f8a7bd544e00a35e24ce9494a83f7ef2f738b09b7d142c58aca58`
  (TF-08 build). An earlier `wbs-trade-fair-gateway.saved-20261024T223914Z`
  with image `sha256:fe4f6d74…` is retained as the pre-dashboard baseline.

## 2. Deployment locations and component responsibilities

| Component | Location | Responsibility |
| --- | --- | --- |
| DNS | A `messe.klare-ki.de` → `77.42.19.144`; AAAA empty | IPv4 production, IPv6 deferred |
| TLS | Let's Encrypt cert `/etc/letsencrypt/live/messe.klare-ki.de/*.pem` (expires 2027-01-22; certbot renew is scheduled) | HTTPS termination at nginx |
| nginx | `/etc/nginx/sites-enabled/messe.klare-ki.de` → `sites-available/messe.klare-ki.de.conf` (final proxy; HSTS max-age=300) | TLS, HTTP→HTTPS redirect, proxy to `127.0.0.1:3000` |
| Gateway | Docker container `wbs-trade-fair-gateway`, `NetworkMode=host`, env file `/opt/wbs-trade-fair/secrets/gateway.dashboard.env` (0600 root) | Form static assets, session cookies, same-origin, Dashboard admin session, outbound to WF-A/D webhooks on `127.0.0.1:5678` |
| n8n | Container `n8n-n8n-1`, image `n8nio/n8n:2.41.7`, published only on `127.0.0.1:5678`, UI at `https://n5n.klare-ki.de` | Four workflows WF-A..D; schedulers; external calls to Tavily/OpenAI/Resend |
| Neon | Project `wbs-trade-fair-assistant`, branch `production` (ID `br-proud-moon-bapf67qs`), endpoint `ep-soft-field-bad37quw.c-8.eu-central-1.aws.neon.tech`, database `neondb`, timeline `4bee522a644104283f5333a66364802d` | All lead/outbox/results data; `trade_fair.dashboard_snapshot` function for Dashboard reads |
| Backups | `/opt/wbs-trade-fair/secrets/backups/20261024T223914Z/` (`env.pre`, `inspect.json`, `image.json`, `nginx-pre.conf`) | L1/L2 rollback inputs |
| ACL baseline | `/opt/wbs-trade-fair/secrets/wbs-tf-08-pre-acl-baseline.tsv` (0600 root) | Reference pre-migration ACL state |

Secrets filesystem (`/opt/wbs-trade-fair/secrets/`, 0700 root): `gateway.env`
(original pre-dashboard), `gateway.dashboard.env` (live, with Dashboard
role URL), `access-key.txt`, `active-rollout-ts`, `active-image`,
retired staging files (`wbs-tf-04-*.env`, `neon-staging.env`).

## 3. Production configuration (no secrets)

The live Gateway env includes:

- `HOST=127.0.0.1`, `PORT=3000`, `NetworkMode=host`
- `APP_ORIGIN=https://messe.klare-ki.de`
- `TRADE_FAIR_ACCESS_KEY=<form admin key>` — preserved from pre-cutover
- `DASHBOARD_ACCESS_KEY=<fresh 192-bit hex>` — distinct from form key
- `DASHBOARD_ENABLED=true`
- `DASHBOARD_DATABASE_URL=<trade_fair_dashboard role on production Neon>` — read-only via `dashboard_snapshot`
- `SESSION_SECRET`, `N8N_HEADER_KEY` — preserved
- `N8N_CAPTURE_URL=http://127.0.0.1:5678/webhook/trade-fair/lead`
- `N8N_STATUS_URL=http://127.0.0.1:5678/webhook/trade-fair/status`
- `PUBLIC_FORM_ENABLED=false`

PostgreSQL role `trade_fair_dashboard`:
- `rolcanlogin=true, rolcreatedb=false, rolcreaterole=false, rolsuper=false, rolinherit=false`.
- `CONNECT` on `neondb`, `USAGE` on `trade_fair` (no `CREATE`).
- `EXECUTE` on `trade_fair.dashboard_snapshot` only; **no** direct table SELECT, **no** EXECUTE on any other `trade_fair.*` function.
- Function flags: `SECURITY DEFINER=true`, `provolatile=s`, `search_path=pg_catalog, trade_fair, pg_temp`.

PostgreSQL role `trade_fair_app` (n8n worker, pre-existing, unchanged):
- 9 `trade_fair.*` functions EXECUTE (begin_email_send, capture_lead,
  claim_email, claim_processing, fail_email_send, fail_processing,
  finish_email_send, finish_processing, get_lead_status).
- Schema USAGE on `trade_fair`.

## 4. Workflows — IDs, operational state, policy

| WF | ID | Current state | Trigger | External calls |
| --- | --- | --- | --- | --- |
| **WF-A** Lead Capture | `d5uO1lnwjOirJ5Xf` | **active=true** | Webhook `POST /webhook/trade-fair/lead` with `httpHeaderAuth` cred `tjqSy2V0odocljw6` (Gateway Auth) | — (DB only; `trade_fair.capture_lead`) |
| **WF-B** Lead Processing | `dr05aJRh8Lu6VpSA` | **active=true** | Schedule every 1 minute + manual trigger | Tavily (`A4Xm6WZ9d6SsMkfs`), OpenAI (`UUprjEp0Re6kPUFN`) |
| **WF-C** Email Delivery | `bRkCsVxZXU85yqLI` | **active=true** (permanent, Owner-approved 2026-10-25 under WBS-TF-11 after one TF-09 send) | Schedule every 1 minute + manual trigger | Resend (`HvE5Js2qo8BxvrSs`) |
| **WF-D** Lead Status | `THulrTbNEZ2FrgJ3` | **active=true** | Webhook `POST /webhook/trade-fair/status` with same Gateway Auth cred | — (DB only; `trade_fair.get_lead_status`) |

### 4.1 WF-C email policy (independently audited from n8n SQLite workflow definitions on 2026-10-25)

- **Recipient is static.** `WF-B/Processing Configuration` hardcodes `sales_report_recipient = sergii.automation.jobs@gmail.com` and `sales_report_sender = reports@klare-ki.de`. The lead-contact email is embedded in the report body as "E-Mail (nicht verifiziert)" for the sales team to see, but the Resend `to:` field is always the single internal mailbox.
- **No arbitrary lead address can ever receive an email.** The salesReport function throws `SALES_EMAIL_CONFIGURATION_REQUIRED` if either sender or recipient fails `emailAddress()` validation.
- **Idempotency:** `email_outbox` has `UNIQUE (lead_id)` and `UNIQUE (idempotency_key)` constraints. The Gateway capture is also idempotent per `(source, submission_id)`. WF-C sends an HTTP `Idempotency-Key` header to Resend for each attempt (so a duplicate request is server-side suppressed by Resend).
- **Retry policy:** `claim_email('n8n-email', 1, 180, 5)` — claim 1 at a time, 180-second lease, up to 5 attempts. `fail_email_send` records attempts; `email_outbox_attempts_check` constrains `0 ≤ attempts`, `email_outbox_max_attempts_check` constrains `1 ≤ max_attempts ≤ 20`.
- **Uncertain outcome:** on timeout/5xx/409/malformed success, the row transitions to `uncertain`. The `trade_fair.resolve_email_uncertain(outbox_id, action, operator_note)` function is the manual-reconciliation path.
- **Historical replay prevented:** `delivered`/`failed` rows are terminal; `claim_email` picks `pending` and expired `leased` only. The `UNIQUE (lead_id)` constraint prevents duplicate outbox rows for a given lead.

## 5. WBS-TF-09 acceptance evidence (end-to-end PASS)

Test marker `WBS-TF-09-ACC-001`. All executions on 2026-10-25.

| Phase | Workflow | Execution ID | Timing | Outcome |
| --- | --- | --- | --- | --- |
| Capture | WF-A | `13788432` | 06:35:30 → 06:35:30Z | success — persisted lead `FAIR-f8723334-607e-4682-ba1e-35b3c0237452` |
| Status (initial) | WF-D | `13788434` | 06:36:32Z | success — `processing_status=pending` |
| Processing | WF-B | `13788435` | 06:36:47 → 06:36:53Z (6.0 s) | success — Tavily + OpenAI + `finish_processing`; score 90 / HOT; outbox row created |
| Idle tick | WF-B | `13788436` | 06:37:47Z (0.4 s) | success — empty queue |
| Delivery | WF-C | `13788486` | 07:08:55.087 → 07:08:55.649Z (0.56 s) | success — Resend accepted single email; outbox transitioned `pending → delivered`; `email_error=null` |

Owner-side verification:
- Direct SQL on `trade_fair.email_outbox` (Owner): exactly one eligible row, `outbox_id=5adfbf09-68e1-44c4-8563-38533da05144`, `recipient=sergii.automation.jobs@gmail.com`.
- Owner-confirmed Gmail receipt.

Deltas: `total_leads 22 → 23`, `today 0 → 1`, `processing=completed 12 → 13`, `email=pending 0 → 1 → 0`, `email=delivered 12 → 13`. No duplicate acceptance, no concurrent manual trigger, no neighbor-service regression.

## 6. Dashboard capability inventory

Served at `https://messe.klare-ki.de/dashboard` from Gateway (`Messe-Admin-Hub.html` + `dashboard.js` + `dashboard.css`). Requires `DASHBOARD_ACCESS_KEY` login via same-origin.

### 6.0 Browser login flow (added in WBS-TF-11)

A first-time visitor to `https://messe.klare-ki.de/dashboard` now sees a small German login screen (`web/dashboard-login.html` + public `web/dashboard-login.js`):

1. Enter the Admin-Zugangsschlüssel (`DASHBOARD_ACCESS_KEY`, not the form key) and submit.
2. The page posts same-origin JSON to `/api/login`; on success the Gateway sets a dashboard-scope `trade_fair_session` cookie (HttpOnly, Secure, SameSite=Strict) and the client reloads `/dashboard`.
3. The authenticated `/dashboard` serves `Messe-Admin-Hub.html` with the full admin UI.
4. "Abmelden" (logout) via the Admin UI POSTs `/api/logout` with Origin header; subsequent `/dashboard` requests return the login page again.

API clients (that do not send `Accept: text/html`) continue to receive the strict 401 JSON `AUTH_REQUIRED` contract. `/dashboard.js` and `/dashboard.css` remain session-protected. A form-user session cannot read `/api/dashboard` nor the Dashboard HTML/JS/CSS. CSP remains `script-src 'self'` — the login script is served from the Gateway's own origin via `/dashboard-login.js`.

### Columns (lead list)
Erfasst (created_at) · Firma / Kontakt (company_name / contact_name) · Score (band + total) · Verarbeitung (processing_status) · E-Mail (email_status + verified flag) · Duplikat (duplicate_status) · Details button.

### Filters and controls
- **Search** (substring, ILIKE) across company_name, contact_name, email, lead_id, max 120 chars.
- **Band**: HOT / WARM / COLD / UNSCORED.
- **Processing**: pending / processing / completed / failed.
- **Email**: pending / leased / sending / delivered / uncertain / failed / none.
- **Duplicate**: yes / no.
- **Sort**: created / company / score / processing / email, asc/desc.
- **Pagination**: `page` (1–10000), `limit` (default 50, max 100). Server enforces strict integer parsing; invalid filters return 400.
- **Tabs**: `Alle Leads`, `Duplikate`.

### Stats panel
`total, hot, warm, cold, unscored, duplicates, failed, email_attention, scored_average, today, interests[]`. The `interests` object lists the top 20 training topics (from `normalized_payload.training_interest`) with counts.

### Lead details drawer
32 fields exposed via `trade_fair.dashboard_snapshot`:
`lead_id, company_id, contact_id, company, website, contact, email, phone, email_verified, source, created_at, processing_status, processing_attempts, processing_error, duplicate_status, review_required, uncertainty_flags[], possible_contact_ids[], training_interest, budget_status, follow_up, follow_up_date, notes, score_band, score_total, scored_at, company_research (Tavily sources), ai_extraction (OpenAI summary/evidence), ai_uncertainty (flags), email_status, email_error, email_updated_at`.

### Mobile usability
`<meta name="viewport" content="width=device-width, initial-scale=1">` present on form pages. Dashboard CSS uses CSS Grid with `width: min(560px, 100vw)` for the detail drawer, flex layouts for stats and filters, and sticky side column. Not fully phone-optimized for the data table (horizontal scroll on narrow screens) but usable.

### Export
**None.** No CSV/XLSX/JSON export button in the Dashboard UI. Operators needing an export can use the `/api/dashboard?page=...&limit=100` route from an authenticated same-origin shell.

### Verdict for WBS demonstration
**READY for the WBS demonstration.** Columns, filters, score band breakdown, AI extraction and company research visibility, and email delivery state are all exposed. Export is the only missing feature and is not required for a live demo. No new Dashboard development is justified by the WBS scope.

## 7. Known limitations

1. **AAAA deferred.** DNS A-only; IPv6 external probes not yet performed.
2. **HSTS short.** `max-age=300` only. Long-year HSTS and preload are deliberately not enabled.
3. **No CSV export** on the Dashboard.
4. **Dashboard table on narrow phones** scrolls horizontally; not a WBS-blocking issue.
5. **WF-B scheduler runs every minute** even when the queue is empty (~0.4 s idle tick, Postgres roundtrip). This is by design; it is observable in `n8n_executions` and does not consume external API quota because `claim_processing` returns no row.
6. **WF-C scheduler is currently inactive.** It is designed to run every minute when activated. The TF-09 test activated it once, let one tick fire, and deactivated it. Permanent activation is a one-switch Owner decision.
7. **`logout` requires `Origin` header.** Browser clients always send it; non-browser clients that omit it will see the session persist until expiry. Covered by Gateway tests; irrelevant for the WBS demo.
8. **Operator production Neon credential** is Owner-held (not on VPS filesystem). Any future migration or ACL change requires Owner-initiated out-of-band injection (TF-08 pattern).
9. **Housekeeping backlog.** `/opt/wbs-trade-fair/secrets/wbs-tf-04-dashboard-role.env` and `wbs-tf-04-staging.env` are residual staging artefacts; retention is an Owner decision.

## 8. Operator runbook

### 8.1 Health check

```bash
# From any host with internet
curl -4 -sS -o /dev/null -w '%{http_code}  %{http_version}\n' https://messe.klare-ki.de/
# Expected: 200  2

# From VPS as root
curl -4 -sS http://127.0.0.1:3000/healthz
# Expected: {"success":true,"service":"trade-fair-gateway"}

# Dashboard (same-origin, authenticated)
# via browser: https://messe.klare-ki.de/dashboard, login with DASHBOARD_ACCESS_KEY
```

### 8.2 Start / stop

- **Gateway container:**
  - Start: `docker start wbs-trade-fair-gateway`
  - Stop:  `docker stop wbs-trade-fair-gateway` (holds HTTPS at 503 only if nginx also swapped to holding; otherwise 502)
  - Restart: `docker restart wbs-trade-fair-gateway`

- **n8n workflows (via n8n UI at https://n5n.klare-ki.de or admin API):**
  - Activate: toggle `Active` in the workflow header.
  - The automation controller also exposes the n8n API; operators with Owner approval can POST to `/rest/workflows/<id>/activate`.

- **nginx:**
  - Test config: `nginx -t`
  - Reload: `systemctl reload nginx`
  - Status: `systemctl status nginx`

### 8.3 Monitoring

- Gateway `/healthz` as above.
- `docker ps --filter name=wbs-trade-fair-gateway --format '{{.Status}} {{.Image}}'` → `Up <time>  sha256:9a656ebb…` (should be sha256 of the current immutable image).
- Dashboard stats panel at `https://messe.klare-ki.de/dashboard` for live lead counts and email states.
- n8n Executions tab per workflow for throughput and errors.
- Resend sender dashboard (Owner-side) for provider-level delivery metrics.
- VPS alert channel (existing): if WF-C encounters authentication (401/403) or rate-limit (429) failures, the outbox row transitions to `failed`/`pending-retry`; the Dashboard `email_attention` stat and `email=uncertain|failed` filters surface these.

### 8.4 Immediate disable (per-workflow, no credential needed)

Via n8n UI as the Owner's n8n user:
1. Open workflow → toggle `Active` off.
2. Observe `active=false` and `triggerCount` drop in the workflow list.
3. For WF-C specifically: after disabling, verify `email_outbox` has no `leased|sending` rows; if any, let their 180 s lease expire or run `trade_fair.resolve_email_uncertain(outbox_id, 'cancel', 'operator reason')` as `neondb_owner`.

Via automation controller: `POST /rest/workflows/<id>` with `active=false`; same effect.

### 8.5 Troubleshooting matrix

| Symptom | Likely cause | First-line action |
| --- | --- | --- |
| `https://messe.klare-ki.de/` returns 502 | Gateway container down | `docker start wbs-trade-fair-gateway`; check `docker logs --tail 50` |
| 503 on `/` | nginx HTTPS holding vhost is active (expected only pre-cutover) | Swap back to `ops/nginx/messe.klare-ki.de.conf` and reload |
| Dashboard 401 for valid admin key | Session cookie not sent same-origin | Verify browser not blocking cross-site cookies; retry login |
| Form 422 | `budget_status` or `follow_up` enum mismatch; `training_interest` outside the allowed set | Correct values per `web/index.html` select options |
| Lead stuck `processing=pending` for >2 min | WF-B inactive, or Tavily/OpenAI quota exhausted, or `trade_fair_app` creds broken | Check WF-B `active=true`; check last WF-B execution error |
| `email=uncertain` | Resend accepted-with-uncertain state (timeout, 5xx, 409) | Run `trade_fair.resolve_email_uncertain` with `action='delivered'` or `cancel` as `neondb_owner`; do not blind-retry |
| Resend `email=failed` with `EMAIL_AUTH_ERROR` | Resend credential invalid | Rotate Resend API key in n8n credential `HvE5Js2qo8BxvrSs` |
| New certificate not issuing on renew | DNS, port 80, or filesystem permissions | `certbot renew --dry-run`; check `/var/log/letsencrypt/letsencrypt.log` |

### 8.6 Recovery and rollback

- **L1 — Gateway container:** stop current `wbs-trade-fair-gateway`, rename `.failed-<ts>`, restore `wbs-trade-fair-gateway.saved-20261024T223914Z`, start. Original env (pre-dashboard) is baked into the saved container.
- **L2 — nginx:** replace active vhost with `ops/nginx/messe.klare-ki.de.https-holding.conf` (committed), reload. Serves HTTPS 503 while Gateway is restored.
- **L3 — TLS/vhost:** certbot renewal is scheduled by the system. If a renewal breaks, `certbot renew --nginx` or re-issue via `certbot --nginx -d messe.klare-ki.de --redirect --agree-tos -m <owner-email> --no-eff-email`.
- **L4 — Neon role/function:** run `sql/production/dashboard_role_production_rollback.sql` (blob `22f5b402359a804c16d0cd38debc16ee6d5f0f4c` on `main`) as `neondb_owner` with `-v production_branch_confirmed=on`, only after Gateway `DASHBOARD_ENABLED=false` or stopped. Dependency errors roll the removal transaction back; WF-A..D grants untouched.
- **L5 — Documentation:** no action; history is on review PRs.

### 8.7 Resend sender configuration

- Current sender: `reports@klare-ki.de`. Owner must ensure the Resend domain is verified (SPF + DKIM + optional DMARC) for `klare-ki.de` to maintain deliverability.
- The sender is set in `WF-B / Processing Configuration` as `sales_report_sender`. Changing it is a workflow-definition change — out of scope here.

## 9. WBS demonstration checklist

- [ ] Open `https://messe.klare-ki.de/` on mobile; confirm HTTPS lock and form renders.
- [ ] Fill in a test lead through the mobile form (do not submit yet).
- [ ] Open a second tab to `https://messe.klare-ki.de/dashboard`; the login screen loads directly (German "Admin-Zugangsschlüssel"). Enter the Dashboard key; the Admin UI appears.
- [ ] Submit the form; show the 201 response in the mobile browser.
- [ ] In the Dashboard, hit refresh; show the lead appearing with `processing=pending`.
- [ ] After ~60 s refresh again; show transitions to `processing=completed`, score band populated, `email_status=pending → delivered` (WF-C now active — demo lead triggers an actual email to `sergii.automation.jobs@gmail.com`).
- [ ] Open the lead's Details drawer; show company research and AI extraction.
- [ ] Show the stats panel KPIs and filters (band / processing / email / duplicate; sort options).
- [ ] Open Gmail (`sergii.automation.jobs@gmail.com`) and show the `[Train Today] HOT | FAIR-…` email body with scoring breakdown.
- [ ] Explain the rollback path: `.saved-20261025T075219Z` container (TF-08 image preserved), HTTPS holding vhost at `ops/nginx/messe.klare-ki.de.https-holding.conf`, PR #9 rollback SQL (`sql/production/dashboard_role_production_rollback.sql`).

## 10. Project status

- **System state:** HTTPS live, Dashboard live with browser login UI, PR #9 atomic migration committed, 23 leads in Neon (22 historical + 1 TF-09 acceptance), one TF-09 email delivered.
- **Workflow activation (final):** WF-A active, WF-B active, **WF-C active (permanent, Owner-approved 2026-10-25)**, WF-D active. Each WF-A..D version pinned: WF-A `0c87ae2a-…`, WF-B `c68f7272-…`, WF-C `b2c08c88-…`, WF-D `a876cc62-…`. WF-C recipient hardcoded in `WF-B / Processing Configuration`: `sales_report_recipient = sergii.automation.jobs@gmail.com`, `sales_report_sender = reports@klare-ki.de`.
- **Independent audit chain:** PR #10 reviewed the atomic SQL; PR #12 corrected the TF-08 packet; PR #11 was superseded; PR #13 is this handover; PR #14 is the Dashboard-login fix (WBS-TF-11). `main` at `b07984b` is the production tree.
- **Credentials:** no production password or URL with password appears anywhere in this doc, in git, or in open logs. Operator credentials for migration-level actions remain Owner-held and are injected only during authorized windows (TF-08 pattern).

## 11. WBS-TF-11 — Dashboard login + WF-C activation record

- **Dashboard-login PR:** #14, merged to `main` at `b07984b`. Tree `4279f1f5…`. 6 new regression tests added on top of the 40 TF-08 tests (46/46 PASS; nginx 3/3 PASS). No change to `/api/dashboard`, `/dashboard.js`, `/dashboard.css`, session cookie, CSP, Neon privileges, or workflow definitions.
- **Deployment:** VPS reversible container swap on 2026-10-25 under `TF_ROLLOUT_TS=20261025T075219Z`. Backup under `/opt/wbs-trade-fair/secrets/backups/20261025T075219Z/` (`env.pre`, `inspect.json`, `image.json`, `nginx-pre.conf`, all 0600 root). New image `sha256:0f517bed…`; saved container `wbs-trade-fair-gateway.saved-20261025T075219Z` holds the previous TF-08 image `sha256:9a656ebb…`.
- **Live acceptance:** `GET /dashboard` with `Accept: text/html` → 200 HTML login (German label + external script); `Accept: application/json` → 401 JSON `AUTH_REQUIRED`; `/dashboard-login.js` → 200 public; `/dashboard.js` and `/dashboard.css` → 401 anon; form-user cookie → login page (no admin UI); Dashboard-key cookie → Admin UI + `/api/dashboard` 200; logout → login page. Public DNS GET `/dashboard` → 200. nginx 3/3.
- **WF-C permanent activation:** `n8n_activate(bRkCsVxZXU85yqLI, true)` at 2026-10-25T07:53:41Z. Version activated: `b2c08c88-10af-4bdd-b28c-76b0c750b171` (unchanged from TF-09). Two idle scheduler ticks observed: execution `13788559` (07:53:55Z, 62 ms, empty-queue no-op) and `13788561` (07:54:55Z, 64 ms, empty-queue no-op). Outbox state unchanged post-activation: `pending=0, leased=0, sending=0, uncertain=0, delivered=13, failed=0`. No email sent during activation.
- **Resend sender-domain verification (independent public-DNS check, 2026-10-25):**
  - **DKIM** — `resend._domainkey.klare-ki.de` TXT returns a non-empty public key → **PASS** (Resend DKIM published).
  - **SPF** — `klare-ki.de` TXT = `v=spf1 a mx mx:sendinblue.com ~all` → **LIMITATION:** SPF currently covers Brevo/Sendinblue, not Resend. Mail from Resend passes DKIM alignment but SPF alignment is not Resend-covered. The TF-09 test email was Owner-confirmed as received in Gmail (empirical deliverability), but spam-folder landing on strict MTAs is possible until SPF includes a Resend `include:` entry.
  - **DMARC** — `_dmarc.klare-ki.de` TXT = `v=DMARC1; p=none; rua=mailto:rua@dmarc.brevo.com` → monitor-only policy, no enforcement.
  - Owner follow-up (not blocking): optionally add `include:_spf.resend.com` (or whatever Resend documents) to the SPF record and migrate the DMARC `rua` away from Brevo if Brevo is no longer in use.
- **Immediate disable procedure** (preserved): `n8n_activate(bRkCsVxZXU85yqLI, false)` via the automation controller, or toggle `Active=false` in `https://n5n.klare-ki.de`. In-flight leases (180 s) expire back to `pending`.
