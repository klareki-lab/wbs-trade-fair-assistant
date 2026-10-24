# WBS-TF-04 — Neon staging execution result

Resumed from PR #3 at commit `94116673f856431d3b701eed104b91d1649b101a`.
Scope: staging-only. No production Neon DDL/DML, no Gateway restart on prod,
no nginx edit, no WF-A–D execution, no email send, no merge.

## Updated gates

| Gate | Status | Evidence / remaining condition |
| --- | --- | --- |
| CODE READY | PASS | 40/40 Node tests pass on Node.js 24.15.0 (`node --test tests/*.mjs`). |
| DB READY | BLOCKED | Staging schema confirmed byte-identical to the committed production metadata. Dedicated role + function **not installed**: see §Blocker. |
| STAGING READY | BLOCKED | Isolated Compose + synthetic E2E pass against the real Neon staging endpoint. Fail-closed 503 path confirmed (function missing). Positive data path blocked on §Blocker. |
| PRODUCTION READY | PENDING | Requires DB + STAGING gates, owner sign-off and separate Gate F3B forwarding confirmation. |

## Independent staging-branch identity check

- `/opt/wbs-trade-fair/secrets/neon-staging.env` on the VPS exposes
  `NEON_STAGING_BRANCH_ID=br-rapid-sun-bandpl0m`, `NEON_STAGING_DATABASE=neondb`
  and a connection URL to
  `ep-lucky-king-bajlihua.c-8.eu-central-1.aws.neon.tech`.
- Connecting with that URL reports `current_user=trade_fair_app`,
  `current_database=neondb`, PostgreSQL `18.6 (fd34222)`.
- Neon GUCs on this compute: `neon.tenant_id=d52b42747bb71131e178a440ffb74789`,
  `neon.timeline_id=a171e976ae189ef43d7ca803d826354e`. The hostname differs
  from any production endpoint referenced in `trade_fair_assistant/gateway.env`,
  which contains no `DATABASE_URL`; n8n reaches Neon separately. Branch
  isolation vs. production could not be verified end-to-end without a
  Neon-API/owner query. Treat as **unverified staging** until the owner
  confirms by Neon branch name.
- The URL labelled `NEON_STAGING_OWNER_URL` is not actually a branch owner
  connection: `trade_fair_app` has `rolcreaterole=false`, `rolcreatedb=false`
  and `has_schema_privilege('trade_fair','CREATE')=false`.
- Schema `trade_fair` is owned by `neondb_owner`; that credential is not
  provided to this review.

## Blocker (DB READY)

- Owner credential for the staging branch (`neondb_owner`, or any role with
  `CREATE` on schema `trade_fair` and `CREATEROLE`) is not available in the
  approved secret store.
- Therefore `sql/dashboard_role_staging.sql`, `sql/dashboard_snapshot.sql`,
  `sql/dashboard_role_audit.sql` and `sql/dashboard_staging_rollback.sql`
  were **not** executed. The guarded role-creation script would have failed
  closed anyway without `-v isolated_branch_confirmed=on` *and* owner privilege.
- Fixing the blocker requires either (a) appending a second line
  `NEON_STAGING_BRANCH_OWNER_URL=…` with the `neondb_owner` password for this
  branch to `/opt/wbs-trade-fair/secrets/neon-staging.env`, or (b) having an
  authorised operator run those four scripts on the branch out of band and
  commit the sanitised audit output.

## Read-only preflight on staging (completed)

- `sql/preflight_staging_result.txt` — ran `sql/PREFLIGHT_READ_ONLY.sql`
  against the staging URL inside `BEGIN READ ONLY` with 5s statement timeout.
- `sql/catalog_staging_result.txt` — ran `sql/DASHBOARD_DDL_READ_ONLY.sql`
  under the same transaction options.
- After stripping shell locale warnings, both staging files are byte-identical
  to the already-committed production metadata files
  (`sql/dashboard_preflight_result.txt`, `sql/dashboard_catalog_result.txt`).
  No schema drift between the staging branch and the production review set.
- `dashboard_snapshot(…)` is confirmed **absent** on the branch (empty
  `pg_proc` match plus an explicit direct call reporting
  `ERROR: function trade_fair.dashboard_snapshot(…) does not exist`).

## Isolated Compose + E2E (completed, pointing at real Neon staging)

- Private staging env written to `/opt/wbs-trade-fair/secrets/wbs-tf-04-staging.env`
  (chmod 600, root-owned, outside Git). Values: fresh `TRADE_FAIR_ACCESS_KEY`,
  `DASHBOARD_ACCESS_KEY`, `SESSION_SECRET`, dummy `N8N_HEADER_KEY`;
  `DASHBOARD_DATABASE_URL` cloned from `NEON_STAGING_OWNER_URL`.
- Repository checked out at the PR head on the VPS;
  `docker compose -f compose.dashboard-staging.yaml up -d --build` built
  `wbs-trade-fair-dashboard-staging:local` (Node 22 alpine, `pg` installed,
  read-only FS, no added capabilities, `127.0.0.1:13080` only). No workflow ran.
- `sql/e2e_staging_result.txt` records the HTTP matrix:

  | Case | Expected | Observed |
  | --- | --- | --- |
  | `GET /healthz` | 200 | 200 |
  | `GET /` static | 200 | 200 |
  | anon `GET /api/dashboard` | 401 | 401 |
  | anon `GET /dashboard{,.js,.css}` | 401 | 401 |
  | form-key `POST /api/login` | 200 | 200 |
  | form-session `GET /api/dashboard` | 401 | 401 |
  | form-session `GET /dashboard` | 401 | 401 |
  | admin-key `POST /api/login` | 200 | 200 |
  | admin-session `GET /dashboard{,.js,.css}` | 200 | 200 |
  | admin-session `GET /api/dashboard` (function missing) | 503 retryable | 503 retryable |
  | admin-session `GET /api/dashboard?score_band=HOT` (invalid filter) | 400 | 400 |
  | admin-session `POST /api/dashboard` | 405 | 405 |

- The admin API returned the fail-closed JSON
  `{"error":{"code":"STATUS_UNAVAILABLE"},"retryable":true,…}` because the
  Gateway reached the real staging Neon branch and the branch replied
  "function does not exist". This confirms the review-time 503 path end-to-end
  without the function present.
- `docker compose down` removed the staging container and network cleanly;
  `127.0.0.1:13080` returned to free. No DB rollback was needed because no
  DDL ran on the branch.

## Not executed (owner-dependent)

- `sql/dashboard_role_staging.sql`, `sql/dashboard_snapshot.sql`,
  `sql/dashboard_role_audit.sql`, positive-data admin `GET /api/dashboard`
  on real staging rows, `sql/dashboard_staging_rollback.sql`.
- Any production action remains gated by owner approval and Gate F3B.

## Next action for Codex

1. Provision `NEON_STAGING_BRANCH_OWNER_URL` (role `neondb_owner`) for branch
   `br-rapid-sun-bandpl0m` and append it to
   `/opt/wbs-trade-fair/secrets/neon-staging.env` (chmod 600). Keep the
   existing `trade_fair_app` URL as the Dashboard runtime URL.
2. Confirm the branch name matches `wbs-tf-dashboard-staging` using the Neon
   console/API; archive that screenshot/output as evidence.
3. Run, as owner, in order and with the committed guard flags:
   `psql -X -v ON_ERROR_STOP=1 -v isolated_branch_confirmed=on
   -f sql/dashboard_role_staging.sql`,
   `psql -X -v ON_ERROR_STOP=1 -f sql/dashboard_snapshot.sql`,
   `psql -X -v ON_ERROR_STOP=1 -f sql/dashboard_role_audit.sql`.
4. Reconnect as `trade_fair_dashboard`, repeat the function call plus the
   base-table/other-function denial probes; capture sanitised output.
5. Insert a synthetic WARM/45/delivered lead row-set and re-run the staging
   Compose HTTP checks for the positive 200 case.
6. Execute `sql/dashboard_staging_rollback.sql` with
   `-v isolated_branch_confirmed=on`; verify role + function absent.
