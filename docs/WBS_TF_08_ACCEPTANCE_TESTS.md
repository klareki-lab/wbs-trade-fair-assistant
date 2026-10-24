# WBS-TF-08 — Product acceptance tests

Scope: end-to-end tests performed during step 5.17 of
`docs/WBS_TF_08_RELEASE_PACKET.md`, after loopback acceptance (§5.14)
and external HTTPS acceptance (§5.16) PASS. **No test on this page
may be executed before step 5.17.** Each row is pass/fail; any FAIL
is a STOP that triggers the §6 rollback layer indicated in the row.

Preconditions for all tests:

- `release/wbs-tf-08` runtime deployed as the immutable image behind
  `https://messe.klare-ki.de/`.
- Production Neon branch `br-proud-moon-bapf67qs` migration completed
  with PR #9's SQL; `trade_fair_dashboard` role present with
  function-only EXECUTE.
- `DASHBOARD_ENABLED=true` in `gateway.dashboard.env`;
  `TRADE_FAIR_ACCESS_KEY` and `DASHBOARD_ACCESS_KEY` set to distinct
  values.
- WF-A..D unchanged and active in n8n.
- At least one Owner-approved **test lead identity** chosen with a
  `test+<token>@` recipient address (not a real customer address) and
  obvious marker fields in `company`, `last_name` and `notes`
  (e.g. `WBS-TF-08-ACC`). Record the chosen marker in the private
  deployment log for later cleanup.

## A. Form, session, submission (web + Gateway, no external email)

| # | Test | Expected | Rollback on fail |
| --- | --- | --- | --- |
| A1 | **Mobile web form reachable.** On a mobile user-agent, `GET https://messe.klare-ki.de/` returns 200 with the form HTML. All static assets served over HTTPS, no mixed content, no cross-origin requests. CSP, X-Frame-Options, Referrer-Policy, X-Content-Type-Options and HSTS (post-5.18) headers present. | 200; headers per F3B §7; render passes visual sanity (fields visible, submit button active). | L1 (container) if 5xx; L2 (nginx) if headers missing. |
| A2 | **Login, same-origin, correct form key.** `POST /api/login` with `Origin: https://messe.klare-ki.de` and the current `TRADE_FAIR_ACCESS_KEY`. | 200 Set-Cookie session, same-origin, HttpOnly, Secure, SameSite=Strict. | L1. |
| A3 | **Login refuses wrong origin.** Same as A2 but `Origin: https://other.example`. | Rejected (4xx) with no session cookie. | L1. |
| A4 | **Login refuses wrong key.** `POST /api/login` with correct Origin but wrong key. | Rejected (4xx) with no session cookie. | L1. |
| A5 | **Lead submission (test lead #1).** Authenticated A2 session submits a complete form with the test-lead marker. | 200/202 with the retryable success contract; capture upstream reached. | L1. |
| A6 | **Logout.** `POST /api/logout`. | Session cookie cleared; subsequent `GET /api/dashboard` returns 401. | L1. |
| A7 | **Public form routes 404 while `PUBLIC_FORM_ENABLED=false`.** `GET /public/form` and `POST /public/capture`. | 404. | L1. |

## B. Workflow pipeline (WF-A → WF-B → WF-C → WF-D)

Use the lead submitted in A5. **Do not** run WF-C against a real
external domain without explicit Owner authorization; the test lead's
address must be the Owner-approved `test+<token>@` recipient. If
Owner declines email, mark B3 as **DEFERRED** rather than FAIL and
proceed; WF-C delivery is tested separately out of band.

| # | Test | Expected | Rollback on fail |
| --- | --- | --- | --- |
| B1 | **WF-A Lead Capture.** In n8n UI (owner credential), the execution for `d5uO1lnwjOirJ5Xf` triggered by A5 completes success; the lead row appears in production Neon `trade_fair.leads` (identified by the marker). | WF-A execution success; row present with expected fields. | L1 (if Gateway misrouting), else investigate; do not touch workflows. |
| B2 | **WF-B Lead Processing (enrichment + scoring).** `dr05aJRh8Lu6VpSA` execution completes success for the new lead; score and enrichment fields populated per schema. | WF-B success; `score`, `enriched_at`, enrichment payload present; status moves to the next expected state. | Investigate; do not toggle workflow. |
| B3 | **WF-C Sales Email Delivery.** Owner-authorized only. `bRkCsVxZXU85yqLI` execution success; one email sent to the Owner-approved test recipient; delivery provider acknowledges 2xx. **If Owner declines, mark DEFERRED and proceed.** | WF-C success or DEFERRED. | Investigate; do not toggle workflow. |
| B4 | **WF-D Lead Status.** `THulrTbNEZ2FrgJ3` execution success; lead status updated to the expected post-email state (or post-B2 state if B3 is DEFERRED). | WF-D success; status column reflects downstream state. | Investigate. |

## C. PostgreSQL data consistency (production Neon, read-only)

Run as `neondb_owner` on the production branch (`br-proud-moon-bapf67qs`).
These checks are read-only; no DDL, no inserts beyond the test lead(s).

| # | Query | Expected | Rollback on fail |
| --- | --- | --- | --- |
| C1 | `SELECT current_database(), current_user, inet_server_addr();` | `neondb`, `neondb_owner`, non-staging endpoint. | STOP (identity drift); do not continue acceptance. |
| C2 | `SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname='trade_fair';` | `neondb_owner`. | STOP. |
| C3 | `SELECT setting FROM pg_settings WHERE name='neon.timeline_id';` | **not** `a171e976ae189ef43d7ca803d826354e`. | STOP (staging drift). |
| C4 | `SELECT prosecdef, provolatile, proowner::regrole::text, proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='trade_fair' AND p.proname='dashboard_snapshot';` | `t`, `s`, `neondb_owner`, `{search_path=pg_catalog, trade_fair, pg_temp}`. | L4 (role/function rollback), investigate SQL. |
| C5 | `SELECT has_function_privilege('trade_fair_dashboard', 'trade_fair.dashboard_snapshot(…)', 'EXECUTE'), has_function_privilege('PUBLIC', 'trade_fair.dashboard_snapshot(…)', 'EXECUTE');` | `t`, `f`. | L4. |
| C6 | `SELECT has_schema_privilege('trade_fair_dashboard', 'trade_fair', 'USAGE'), has_schema_privilege('trade_fair_dashboard', 'trade_fair', 'CREATE');` | `t`, `f`. | L4. |
| C7 | For each base table `t` in `trade_fair`: `SELECT has_table_privilege('trade_fair_dashboard', 'trade_fair.' || t, 'SELECT');` | all `f`. | L4. |
| C8 | Audit of other `trade_fair.*` functions: ensure `trade_fair_dashboard` has `has_function_privilege(…, 'EXECUTE') = false` for every function other than `dashboard_snapshot`. | all `f`. | L4. |
| C9 | WF-A..D grants unchanged vs. baseline: compare `pg_roles.rolname`, `pg_auth_members` membership and `has_*_privilege` for the n8n workflow role against the pre-migration baseline capture. | identical. | L4; investigate catalog diff. |
| C10 | Verify the test-lead row exists exactly once (by marker). | `count=1`. | Investigate WF-A duplication logic; do not retry workflow. |

## D. Dashboard (list, metrics, filters)

Run as a Dashboard-authenticated session (`DASHBOARD_ACCESS_KEY`),
same-origin, over HTTPS to `https://messe.klare-ki.de/`.

| # | Test | Expected | Rollback on fail |
| --- | --- | --- | --- |
| D1 | **Anonymous rejection.** `GET /api/dashboard` with no cookie or wrong origin. | 401. | L1. |
| D2 | **Form-key cannot read Dashboard.** Session established via `TRADE_FAIR_ACCESS_KEY` cannot access `/api/dashboard` nor Dashboard assets. | 401 or 403 (same contract as Gateway test suite). | L1. |
| D3 | **Dashboard login.** `POST /api/dashboard/login` same-origin with `DASHBOARD_ACCESS_KEY`. | 200, Set-Cookie Dashboard session. | L1. |
| D4 | **Dashboard list.** `GET /api/dashboard/leads?limit=50&offset=0`. | 200, JSON list including the test lead; honours `limit` and `offset` bounds set by the function; `WARM` label present where expected. | L1 if upstream reachable but response malformed; L4 if function returns an error. |
| D5 | **Dashboard metrics.** `GET /api/dashboard/metrics`. | 200, aggregates include the new lead (counts increment by 1). | Investigate. |
| D6 | **Filter: by status.** `GET /api/dashboard/leads?status=<expected post-B4 status>`. | 200, test lead present. | Investigate. |
| D7 | **Filter: by date range.** `GET /api/dashboard/leads?from=<today>&to=<today>`. | 200, test lead present. | Investigate. |
| D8 | **Filter: invalid parameter.** `GET /api/dashboard/leads?limit=abc`. | 4xx with structured error; no 500, no 200 with empty list. | L1. |
| D9 | **Write methods rejected.** `POST /api/dashboard/leads` and `DELETE /api/dashboard/leads/<id>`. | 4xx; no state change. | L1. |
| D10 | **Database outage returns 503.** Temporarily simulate outage out of band (owner-controlled; e.g., toggle Neon branch pause OR flip `DASHBOARD_DATABASE_URL` to an invalid value in a *throwaway* candidate env against a staging copy, never prod). | 503 retryable contract; no 200 with empty statistics; no 500 leaking stack. If an owner-safe simulation path is unavailable, mark **DEFERRED to staging rerun**. | L1 if Gateway reports non-contract error. |

## E. Existing VPS services and the four workflow routes

Verify no regression in services the Gateway sits beside.

| # | Test | Expected | Rollback on fail |
| --- | --- | --- | --- |
| E1 | `nginx -t`, `systemctl is-active nginx`, four workflow routes active in n8n (IDs `d5uO1lnwjOirJ5Xf`, `dr05aJRh8Lu6VpSA`, `bRkCsVxZXU85yqLI`, `THulrTbNEZ2FrgJ3`). | all PASS. | L2 (nginx); do not touch workflows. |
| E2 | Known neighbor vhosts (bistro, delivery, herman, mcp, minio, console, n5n, review, default) remain reachable with their pre-cutover contracts. | all PASS. | L2. |
| E3 | n8n container `n8n-n8n-1` still running on `n8n_default`, `restart=no`, with no new environment file. | PASS. | Investigate. |
| E4 | Private secrets directory `/opt/wbs-trade-fair/secrets/` remains `drwx------ root`, `gateway.env` unchanged (bytewise equal to `env.pre`), `gateway.dashboard.env` present mode 0600. | PASS. | Investigate secret drift. |
| E5 | Container `wbs-trade-fair-gateway` has `len .Mounts = 0`, image equals the recorded `TF_GATEWAY_IMAGE` digest, `NetworkMode=host`, `RestartPolicy=unless-stopped`. | PASS. | L1. |

## F. Post-acceptance cleanup

After every row above is PASS (or explicitly DEFERRED with Owner
record), proceed to §5.18 (staged HSTS). Then:

- Delete the test lead row and any downstream WF-B/C/D artefacts, or
  mark them as test leads in the data store if the schema supports it.
  Record the deletion in the private deployment log.
- Keep `wbs-trade-fair-gateway.saved-${TF_ROLLOUT_TS}` and the old
  image for the Owner-defined retention window.
- Rotate `TRADE_FAIR_ACCESS_KEY` / `DASHBOARD_ACCESS_KEY` only if the
  Owner's rotation policy requires it on go-live; otherwise leave for
  the next scheduled rotation.

## G. Known deferred (acceptable final state)

- IPv6 (AAAA) remains unpublished until F3B §8 external probes PASS.
  IPv4-only `https://messe.klare-ki.de/` is an acceptable production state.
- B3 (WF-C email) and D10 (DB outage) MAY be marked DEFERRED to a
  staging rerun if Owner declines the live simulation; both are
  covered by Gateway unit tests (status/capture outage mapping,
  retryable 503, dashboard fail-closed) and by WF-C's own test
  evidence from WBS-TF-05.
