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
- Before A5, the Owner authorizes one production test submission and
  any automatic WF-C delivery it may trigger. Use an Owner-controlled
  test mailbox, never a customer address, and a unique marker in
  `company_name` and `notes` (for example `WBS-TF-08-ACC`). Record
  the marker privately. If delivery is not authorized, **do not run
  A5**; mark A5, B1–B4 and test-lead-dependent checks DEFERRED together.
- Capture a read-only WF-A–D role/ACL baseline on the confirmed
  production Neon branch before migration step 5.9; C9 compares with
  this record. A missing baseline is a STOP for C9.

## A. Form, session, submission (web + Gateway, no external email)

| # | Test | Expected | Rollback on fail |
| --- | --- | --- | --- |
| A1 | **Mobile web form reachable.** On a mobile user-agent, `GET https://messe.klare-ki.de/` returns 200 with the form HTML. All static assets served over HTTPS, no mixed content or cross-origin requests. Check CSP, X-Frame-Options, Referrer-Policy and X-Content-Type-Options. | 200; security headers per F3B §7, **no HSTS yet**; fields and submit button visible. Check staged HSTS separately after 5.18. | L1 (container) if 5xx; L2 (nginx) if headers missing. |
| A2 | **Login, same-origin, correct form key.** `POST /api/login` with `Origin: https://messe.klare-ki.de` and the current `TRADE_FAIR_ACCESS_KEY`. | 200 Set-Cookie session, same-origin, HttpOnly, Secure, SameSite=Strict. | L1. |
| A3 | **Login refuses wrong origin.** Same as A2 but `Origin: https://other.example`. | Rejected (4xx) with no session cookie. | L1. |
| A4 | **Login refuses wrong key.** `POST /api/login` with correct Origin but wrong key. | Rejected (4xx) with no session cookie. | L1. |
| A5 | **Owner-authorized test lead submission.** Authenticated A2 session submits a complete form with the marker and one Owner-controlled recipient, after the precondition above is met. | Fresh capture returns **201** with `success=true`, `persisted=true`, a `FAIR-…` lead ID and `processing_status=pending`; an exact idempotent replay returns 200. Record the lead ID and submission ID privately. | L1. |
| A6 | **Logout.** `POST /api/logout`. | Session cookie cleared; subsequent `GET /api/dashboard` returns 401. | L1. |
| A7 | **Public form routes disabled.** `GET /public` and `POST /api/public/leads` while `PUBLIC_FORM_ENABLED=false`. | 404 for both. | L1. |

## B. Workflow pipeline (WF-A → WF-B → WF-C → WF-D)

Use the lead submitted in A5. WF-C runs on a schedule and may send
without a manual B3 action. Never submit A5 until the Owner authorizes
the resulting test delivery. If authorization is declined, defer the
whole live-lead pipeline as stated above; do not assume B3 alone can
be skipped safely.

| # | Test | Expected | Rollback on fail |
| --- | --- | --- | --- |
| B1 | **WF-A Lead Capture.** The execution for `d5uO1lnwjOirJ5Xf` triggered by A5 succeeds; the marker appears once in `trade_fair.lead_submissions` joined to `trade_fair.companies`. | WF-A success; `lead_id`, `submission_id` and marker match the A5 receipt. | L1 if Gateway misrouted; otherwise investigate without changing workflows. |
| B2 | **WF-B Lead Processing.** `dr05aJRh8Lu6VpSA` completes for that lead. | `trade_fair.processing_results.score_total`, `score_band` and `result_payload` exist; `lead_submissions.processing_status` reaches the expected state. | Investigate; do not toggle workflow. |
| B3 | **WF-C Sales Email Delivery.** Check the scheduled `bRkCsVxZXU85yqLI` run for the authorized test recipient. | One `trade_fair.email_outbox` row reaches the expected delivery state; provider result is recorded. | Investigate; do not toggle workflow. |
| B4 | **WF-D Lead Status.** Authenticated `GET /api/leads/<lead_id>?submission_id=<submission_id>` invokes read-only WF-D `THulrTbNEZ2FrgJ3`. | HTTP 200 status JSON matches the lead's processing and email states; WF-D execution succeeds. WF-D does **not** update a status column. | Investigate. |

## C. PostgreSQL data consistency (production Neon, read-only)

Run as `neondb_owner` on the production branch (`br-proud-moon-bapf67qs`).
These checks are read-only; no DDL, no inserts beyond the test lead(s).

| # | Query | Expected | Rollback on fail |
| --- | --- | --- | --- |
| C1 | `SELECT current_database(), current_user, inet_server_addr();` plus the authenticated Neon branch/endpoint metadata check from release packet §3. | `neondb`, `neondb_owner`; branch ID and endpoint match production metadata. The server IP alone does not prove branch identity. | STOP (identity drift); do not continue acceptance. |
| C2 | `SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname='trade_fair';` | `neondb_owner`. | STOP. |
| C3 | `SELECT setting FROM pg_settings WHERE name='neon.timeline_id';` | **not** `a171e976ae189ef43d7ca803d826354e`. | STOP (staging drift). |
| C4 | `SELECT prosecdef, provolatile, proowner::regrole::text, proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='trade_fair' AND p.proname='dashboard_snapshot';` | `t`, `s`, `neondb_owner`, `{search_path=pg_catalog, trade_fair, pg_temp}`. | L4 (role/function rollback), investigate SQL. |
| C5 | `SELECT has_function_privilege('trade_fair_dashboard', 'trade_fair.dashboard_snapshot(integer,integer,text,text,text,text,text,text,text)', 'EXECUTE'), has_function_privilege('public', 'trade_fair.dashboard_snapshot(integer,integer,text,text,text,text,text,text,text)', 'EXECUTE');` | `t`, `f`. | L4. |
| C6 | `SELECT has_schema_privilege('trade_fair_dashboard', 'trade_fair', 'USAGE'), has_schema_privilege('trade_fair_dashboard', 'trade_fair', 'CREATE');` | `t`, `f`. | L4. |
| C7 | `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='trade_fair' AND c.relkind IN ('r','p','v','m','f') AND has_table_privilege('trade_fair_dashboard',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');` | zero rows. | L4. |
| C8 | Audit of other `trade_fair.*` functions: ensure `trade_fair_dashboard` has `has_function_privilege(…, 'EXECUTE') = false` for every function other than `dashboard_snapshot`. | all `f`. | L4. |
| C9 | Compare WF-A–D role membership and required function/table ACLs with the **pre-migration read-only catalog snapshot** captured before step 5.9. | Identical. If no snapshot exists, STOP; do not claim preservation from current state alone. | Investigate catalog diff before any retry. |
| C10 | Count `trade_fair.lead_submissions` rows for the A5 `lead_id` and `submission_id`; join `trade_fair.companies` on `company_id` to verify the marker. | Exactly one submission with the expected company marker. | Investigate WF-A duplication logic; do not retry workflow. |

## D. Dashboard (list, metrics, filters)

Run as a Dashboard-authenticated session (`DASHBOARD_ACCESS_KEY`),
same-origin, over HTTPS to `https://messe.klare-ki.de/`.

| # | Test | Expected | Rollback on fail |
| --- | --- | --- | --- |
| D1 | **Anonymous rejection.** `GET /api/dashboard`, `/dashboard`, `/dashboard.js` and `/dashboard.css` without a session. | 401 each. GET is session-gated; do not expect an Origin-header check on GET. | L1. |
| D2 | **Form-key cannot read Dashboard.** A session established via `TRADE_FAIR_ACCESS_KEY` cannot access the API or Dashboard assets. | 401 each. | L1. |
| D3 | **Dashboard login.** `POST /api/login` with `Origin: https://messe.klare-ki.de` and `DASHBOARD_ACCESS_KEY`. | 200, Secure HttpOnly SameSite=Strict dashboard-scoped session cookie. | L1. |
| D4 | **Dashboard list.** `GET /api/dashboard?page=1&limit=50` with the Dashboard session. | 200, `success=true`, `read_only=true`, `page=1`, `limit=50`, bounded `leads[]`. The test lead may be on another page; D7 searches for it. Do not require a particular score band. | L1 for malformed response; L4 for a function error. |
| D5 | **Dashboard metrics.** Inspect `stats` in the **same** `GET /api/dashboard` response. | Aggregate fields are present and consistent with the returned data; if A5 ran, the total reflects it. There is no separate metrics route. | Investigate. |
| D6 | **Filter: processing.** `GET /api/dashboard?processing=<expected_state>&page=1&limit=50`. | 200 with valid filtered payload; if A5 ran and its processing state matches, the lead appears. | Investigate. |
| D7 | **Search.** `GET /api/dashboard?search=<encoded_company_marker>&page=1&limit=50`. | 200 and, if A5 ran, the test lead appears. Date-range filters are not part of the API. | Investigate. |
| D8 | **Invalid parameter.** `GET /api/dashboard?limit=abc` with a Dashboard session. | 400 with `INVALID_JSON`; no 500 or fabricated empty 200. | L1. |
| D9 | **Write method rejected.** `POST /api/dashboard` with a Dashboard session. | 405 `REQUEST_REJECTED`; no state change. | L1. |
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

- Retain the uniquely marked test lead under the Owner's data policy.
  Any later deletion of its submission, processing result or email
  record requires a separately reviewed, Owner-approved cleanup; do
  not perform ad hoc production deletes during acceptance.
- Keep `wbs-trade-fair-gateway.saved-${TF_ROLLOUT_TS}` and the old
  image for the Owner-defined retention window.
- Rotate `TRADE_FAIR_ACCESS_KEY` / `DASHBOARD_ACCESS_KEY` only if the
  Owner's rotation policy requires it on go-live; otherwise leave for
  the next scheduled rotation.

## G. Known deferred (acceptable final state)

- IPv6 (AAAA) remains unpublished until F3B §8 external probes PASS.
  IPv4-only `https://messe.klare-ki.de/` is an acceptable production state.
- A5 and its dependent live-lead checks MAY be marked DEFERRED together
  if Owner declines the production test submission or resulting WF-C
  email. D10 (DB outage) MAY be deferred to an isolated staging rerun.
  Record each deferral and the Owner's acceptance decision; neither
  deferral is evidence of a live production pass.
