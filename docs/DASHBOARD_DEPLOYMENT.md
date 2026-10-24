# Dashboard — Deployment

This document applies **in addition to** `docs/DEPLOYMENT.md` (which
describes the live gateway container that this PR does not change in
place). The dashboard is additive, off by default, and intentionally
decoupled from the n8n pipeline.

## A. GitHub workflow (what this PR already did)

```sh
git fetch origin baseline/live-2026-10-24
git switch -c feature/astra-dashboard 854f247546742fd69cc5c81385cf2b73657d440b
# server.mjs patched by hand (not via Astra's apply_dashboard.mjs — see
# docs/HANDOVER.md §Patcher outcome).
# gateway/dashboard-{api,db}.mjs, web/dashboard.{js,css,html},
# sql/{dashboard_snapshot,PREFLIGHT_READ_ONLY}.sql, tests/* added.
node --test tests/test_gateway_baseline.mjs \
             tests/test_dashboard.mjs \
             tests/test_gateway_dashboard.mjs
# → 38 pass, 0 fail (mock only).
```

No real Neon traffic was issued by this task. No workflow was imported,
activated or executed. No change to `/opt/wbs-trade-fair/`, nginx, systemd.

## B. Neon preflight — blocking approval gate

Only after the owner has nominated the exact Neon branch/database and
agreed which role will own `dashboard_snapshot`:

```sh
# Server/laptop with .pgpass or env; do NOT paste URIs into tickets.
psql -X -v ON_ERROR_STOP=1 -f sql/PREFLIGHT_READ_ONLY.sql
```

The preflight is strictly read-only (`BEGIN READ ONLY` + `ROLLBACK`). It
confirms:

- Current database + role + Postgres version.
- Column list for the five tables used by the function.
- Whether `trade_fair.dashboard_snapshot` already exists.
- Whether role `trade_fair_app` has `USAGE` on the schema.

Compare its column output against this list — this is the authoritative
column list for the function to accept:

```
companies(company_id, company_name, website)
contacts(contact_id, contact_name, email, phone, email_verified)
lead_submissions(lead_id, company_id, contact_id, source, created_at,
                 processing_status, processing_attempts, last_error_code,
                 duplicate_status, review_required, uncertainty_flags,
                 possible_contact_ids, normalized_payload)
processing_results(lead_id, score_total, score_band, result_payload,
                   created_at)
email_outbox(lead_id, status, last_error_code, updated_at)
```

If a column name differs: **do not guess**. Open a question on the Neon
owner and update `sql/dashboard_snapshot.sql` only after the real DDL is
visible.

## C. SECURITY DEFINER migration

Baseline captured only the metadata available to `trade_fair_app`. The
function `dashboard_snapshot`:

- Must be owned by a role that has `SELECT` on all five tables, since it
  is `SECURITY DEFINER`.
- Pins `search_path = pg_catalog, trade_fair, pg_temp`.
- Grants `EXECUTE` only to the named `dashboard_role` passed via `-v`.
- Revokes `ALL ON FUNCTION … FROM PUBLIC`.
- Does **not** grant `SELECT` on tables.

**Open question for the owner:** should `trade_fair_app` be reused as
`dashboard_role` (expanding its surface to include processing results and
outbox-level fields), or should a dedicated read-only identity be created
and its Neon URL plumbed as `DASHBOARD_DATABASE_URL`? Default answer in
this repo is "create a dedicated role" — reusing `trade_fair_app` would
also require WF-A/B/C/D credential review.

Deploy the function on an isolated Neon branch first:

```sh
psql -X -v ON_ERROR_STOP=1 \
  -v dashboard_role=EXISTING_APPROVED_ROLE \
  -f sql/dashboard_snapshot.sql

# Positive smoke:
SELECT trade_fair.dashboard_snapshot(50,0,'','','','','','created','desc');

# Negative smoke (connect as dashboard_role):
--  SELECT 1 FROM trade_fair.lead_submissions LIMIT 1;  -- expected: permission denied
--  INSERT / UPDATE / DELETE on any trade_fair table   -- expected: permission denied
```

## D. Gateway container (post-approval)

The live container `wbs-trade-fair-gateway` runs `node:22-alpine` and mounts
`/opt/wbs-trade-fair/trade_fair_assistant/{gateway,web}` **read-only**. For
the dashboard to work, two new things are needed:

1. `pg` must be present inside the container. The live container has no
   `node_modules`; it currently runs the gateway's pure-stdlib code. The
   deployment procedure that recreates the container must install
   dependencies, e.g. via a thin Dockerfile:

   ```dockerfile
   FROM node:22-alpine
   WORKDIR /app/gateway
   COPY gateway/package.json gateway/package-lock.json ./
   RUN npm ci --omit=dev
   # /app/gateway/node_modules now exists inside the image, independent of
   # the read-only mount from the host at runtime.
   ```

   Alternative: use a tmpfs for `/app/gateway/node_modules` and
   `npm ci --omit=dev` as a one-shot init-container. The read-only
   bind-mount of `/app/gateway` from the host must be preserved for the
   application source.

2. Two new env vars on the gateway container, from the server-side secret
   store (never from this repo):

   ```
   DASHBOARD_ENABLED=true
   DASHBOARD_DATABASE_URL=postgres://<approved-role>:<pw>@<neon-host>/neondb?sslmode=require
   ```

   The adapter forces `rejectUnauthorized=true`; it also strips any
   `sslmode / sslrootcert / sslcert / sslkey` from the URL to avoid a
   silent downgrade.

## E. Staging acceptance

1. Pre-change: capture `/healthz`, `/`, `/app.js`, `/styles.css`, login,
   capture and status smokes. Record the pre-deploy image ID.
2. Deploy candidate image on staging only.
3. Confirm existing routes unchanged. Confirm WF-A/B/C/D unchanged.
4. Without a session: `/dashboard`, `/dashboard.js`, `/dashboard.css`,
   `/api/dashboard` → `401`.
5. With a session: assets → `200`; `GET /api/dashboard` → `200` with
   `read_only:true`. POST → `405`. Invalid filter → `400`. Simulated DB
   outage → `503` (never a falsely empty `200`).
6. In real Neon, inspect `FAIR-797b1f1c-a657-4c7d-829f-1df50f5fc8b2` and
   verify its genuine score / email status; **do not hard-code** WARM 45.
7. Confirm nginx Gate F3B forwards the new paths through its existing
   same-origin policy. **No nginx change in this task.** If the paths are
   not forwarded, mark the step `NO-GO` and seek a separate approval.
8. Collect redacted evidence (no PII, no tokens).

## F. Readiness gates

| Gate | State |
| --- | --- |
| **CODE READY** | ✅ Integration applied, 38/38 mock tests pass. |
| **DB READY** | ⏳ Blocked on §B/C (owner-approved Neon DDL review + role decision). |
| **STAGING READY** | ⏳ Blocked on §B/C + a Dockerfile/compose that installs `pg` (§D). |
| **PRODUCTION READY** | ⏳ Blocked on §E + Owner approval + Gate F3B confirmation. |
