# WBS-TF-04 — independent review and isolated staging handover

Reviewed commit: `413d8ad085fea93f424e22790de421ec15495e28` (PR #2).
All production access in this review was read-only metadata access. No production
Neon DDL/DML, Gateway restart, nginx edit, workflow execution, or email send.

## Gates

| Gate | Status | Evidence / remaining condition |
| --- | --- | --- |
| CODE READY | PASS | Node 22 tests, Docker build, SQL compile and synthetic E2E pass after the fixes below. |
| DB READY | BLOCKED | Production DDL is confirmed. No isolated Neon branch identifier or branch owner/connection was available, so the dedicated role and function were not installed or audited on Neon. |
| STAGING READY | BLOCKED | Isolated Compose and synthetic PostgreSQL E2E pass. Real Neon branch connection, data checks and branch rollback remain. |
| PRODUCTION READY | PENDING | Requires DB and STAGING gates, owner sign-off and separate Gate F3B forwarding confirmation. |

## Independent review and fixes

- At the input SHA, 38/38 tests passed on Node.js 22.23.4. After fixes, 40/40 pass.
- The original Dashboard accepted the ordinary form access key. That key now
  creates a form-scoped session; `DASHBOARD_ACCESS_KEY` creates an admin-scoped
  session. All Dashboard API and asset routes require the latter. Existing
  signed sessions without a scope remain valid only for form operations.
- An idle `pg.Pool` error on DB shutdown previously crashed Gateway. The pool
  now handles that event, leaving requests to return retryable HTTP 503.
- A direct function call with a `NULL` limit previously disabled the SQL
  `LIMIT`. The function now defaults to 50 and clamps to 100.
- SQL binds all nine user inputs; the adapter issues a fixed function SELECT
  inside `BEGIN READ ONLY` with a 5-second statement timeout and verified TLS.
- Dashboard is disabled by default. Invalid Dashboard configuration fails at
  startup. Existing capture/status routes and their tests remain intact.

## Production metadata only

`sql/PREFLIGHT_READ_ONLY.sql` ran against `neondb` as `trade_fair_app`, in a
read-only transaction. PostgreSQL reported 18.6. `information_schema` showed
only three tables because this role lacks direct SELECT on
`processing_results` and `email_outbox`. `pg_catalog` exposed the structural
metadata for all five: 71 columns, constraints, indexes, and no user triggers.

- `sql/dashboard_preflight_result.txt`: exact preflight output.
- `sql/dashboard_catalog_result.txt`: all five tables' columns, types, defaults,
  constraints, indexes and triggers.
- `sql/dashboard_confirmed_ddl.sql`: executable structural DDL generated only
  from catalog metadata; replayed successfully on local PostgreSQL 18, yielding
  71 columns. It contains no table rows or credentials.
- `sql/dashboard_function_acl_result.txt`: all 14 existing `trade_fair`
  functions have `PUBLIC EXECUTE=false`. The dedicated Dashboard role can
  therefore be limited to the new function without altering WF-A–D grants.

The Dashboard candidate references only columns confirmed in that DDL.
`processing_results.score_total` is `smallint`; `email_outbox.updated_at` is
`timestamptz`. The `processing_results` and `email_outbox` joins have unique
`lead_id` constraints, so they cannot multiply Dashboard rows.

An ordinary `pg_dump --schema-only` using `trade_fair_app` was refused when it
tried to lock `processing_results`. The catalog export was used instead. It is
structural DDL, without ownership or production ACL replay statements.

## PostgreSQL and staging smoke

- Local PostgreSQL 18: `dashboard_snapshot.sql` compiled against both a
  synthetic five-table fixture with one invented lead and the reconstructed
  71-column DDL. The dedicated role received CONNECT, schema USAGE and one
  function EXECUTE; direct SELECT on base tables and EXECUTE on another
  application function returned `permission denied`.
- The role audit script passed. The guarded role-creation script refused to
  run without isolated-branch confirmation. The rollback script dropped the
  function and role in a fresh local database; both were absent afterward.
- `Dockerfile.dashboard-staging` built successfully with Node 22 and `pg`.
  Compose validation and `up -d --build` passed. Only `127.0.0.1:13080` was
  published; the container ran as `node`, with a read-only filesystem and no
  added capabilities. Capture/status upstreams pointed to a disabled local
  endpoint; no workflow ran and no email was sent.
- Synthetic TLS PostgreSQL E2E: anonymous/form session → 401; admin API
  and three Dashboard assets → 200; invented WARM/45/delivered lead → correct
  JSON; invalid filter → 400; POST Dashboard → 405. During a DB outage,
  Dashboard → retryable 503 while `/healthz` stayed 200. After DB restart,
  Dashboard returned 200 without restarting Gateway. `docker compose down`
  removed the staging container and network.

These are local synthetic tests, not a Neon branch staging pass. No real lead
rows or personal data were copied.

## Isolated Neon branch procedure

1. Supply the isolated branch ID, branch endpoint and a branch owner connection
   through the approved secret store. Verify the endpoint in Neon before any
   DDL. Do not reuse the production connection string or role.
2. Run `sql/PREFLIGHT_READ_ONLY.sql` and
   `sql/DASHBOARD_DDL_READ_ONLY.sql` on that branch and compare the output to
   the committed metadata. Investigate any drift before continuing.
3. Set `WBS_DASHBOARD_STAGING_ROLE_PASSWORD` only in the operator process
   environment. Run `psql -X -v ON_ERROR_STOP=1 -v isolated_branch_confirmed=on
   -f sql/dashboard_role_staging.sql` as branch owner. Then run
   `psql -X -v ON_ERROR_STOP=1 -f sql/dashboard_snapshot.sql` as branch owner.
4. Run `sql/dashboard_role_audit.sql` as branch owner; connect as
   `trade_fair_dashboard` and repeat the positive function call and negative
   table/function probes. Use only synthetic rows on the branch.
5. Store a private staging env file outside Git containing the branch URL,
   separate form/admin keys, session secret and dummy n8n header key. Set
   `WBS_STAGING_ENV_FILE` to its path, then run
   `docker compose -f compose.dashboard-staging.yaml up -d --build`. Repeat
   the HTTP checks above at `127.0.0.1:13080`. No nginx route is needed.
6. Roll back the container with
   `docker compose -f compose.dashboard-staging.yaml down`. If the branch is
   disposable, delete the branch in Neon. Otherwise, after confirming the
   branch again, run `sql/dashboard_staging_rollback.sql` with
   `-v isolated_branch_confirmed=on`; verify the role/function are absent.

## Production deployment instruction (not executed)

After both blocked gates pass and the owner approves production: create the
same dedicated role under an approved production migration, audit its grants,
install the reviewed function, build an immutable Gateway image, record the
current production image/config, and deploy only the Gateway with private
`DASHBOARD_DATABASE_URL` and `DASHBOARD_ACCESS_KEY`. Verify existing routes,
Dashboard auth/data and Gate F3B forwarding before declaring readiness. Do not
touch WF-A–D. On failure, disable Dashboard via an approved Gateway recreate
or restore the recorded image/config; keep Neon cleanup separate from the
urgent Gateway rollback.

Owner-controlled prerequisites: isolated Neon branch access and branch owner
credentials; later, explicit production migration/deployment approval and any
nginx Gate F3B decision. No merge or production deployment was performed.
