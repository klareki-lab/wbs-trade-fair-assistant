# WBS-TF-04 — Neon staging execution result

Resumed from PR #3 at commit `94116673f856431d3b701eed104b91d1649b101a`,
continued at `958eae606509a87960d7915e1243e1cbab22d604` and after owner
provided `NEON_STAGING_BRANCH_OWNER_URL`. Scope: staging-only. No production
Neon DDL/DML, no Gateway restart on prod, no nginx edit, no WF-A–D execution,
no email send, no merge.

## Updated gates

| Gate | Status | Evidence |
| --- | --- | --- |
| CODE READY | PASS | 40/40 Node tests pass (Node 24.15.0 locally; Node 22 inside the staging Compose image). Docker build, SQL compile, synthetic + real-Neon-reach + positive-data E2E all pass. |
| DB READY | PASS | Staging branch has schema byte-identical to committed production metadata. `neondb_owner` installed `trade_fair_dashboard` role and `dashboard_snapshot(...)` function. Role audit returned clean. Negative probes as the dashboard role confirmed `permission denied` on all five base tables and `EXECUTE=false` on all 14 other `trade_fair` functions; `EXECUTE=true` only on `dashboard_snapshot`. Rollback dropped the function and role; both verified absent. |
| STAGING READY | PASS | Isolated Compose up with `DASHBOARD_DATABASE_URL` pointing at the `trade_fair_dashboard` role on the real staging branch. Full HTTP matrix including positive-data 200 passed; synthetic row removed; container torn down; branch returned to 0 rows and no custom role/function. |
| PRODUCTION READY | PENDING | Requires owner sign-off and separate Gate F3B forwarding confirmation. |

## Independent staging-branch identity check

- `/opt/wbs-trade-fair/secrets/neon-staging.env` on the VPS exposes
  `NEON_STAGING_BRANCH_ID=br-rapid-sun-bandpl0m`, `NEON_STAGING_DATABASE=neondb`,
  `NEON_STAGING_OWNER_URL` (role `trade_fair_app`) and
  `NEON_STAGING_BRANCH_OWNER_URL` (role `neondb_owner`).
- Both URLs point to the same Neon compute endpoint
  `ep-lucky-king-bajlihua.c-8.eu-central-1.aws.neon.tech` and report the same
  Neon runtime markers
  (`neon.tenant_id=d52b42747bb71131e178a440ffb74789`,
  `neon.timeline_id=a171e976ae189ef43d7ca803d826354e`). The read-only
  preflight output from the `trade_fair_app` URL is byte-identical to the
  committed production-metadata evidence after stripping shell locale
  warnings — i.e. we are reading the same tenant/timeline from both URLs.
- Branch owner probe confirmed `current_user=neondb_owner`,
  `rolcreaterole=true`, `rolcreatedb=true`, `rolsuper=false`;
  schema `trade_fair` is owned by `neondb_owner` with `CREATE=true`.
- Branch was empty at start (0 rows across all 5 tables) and returned to
  empty after the synthetic lead was deleted; this is the expected
  disposable-staging posture.
- End-to-end verification by Neon branch name (`wbs-tf-dashboard-staging`)
  against the Neon API remains out of scope for this review. Owner has
  attested to the branch name; this review verified consistent tenant,
  timeline and endpoint with the committed metadata set.

## Install, audit, probe (completed)

- `sql/staging_evidence/role_install.txt` — `dashboard_role_staging.sql`
  with `-v isolated_branch_confirmed=on` and the role password only in the
  process environment; CREATE ROLE + GRANT CONNECT committed.
- `sql/staging_evidence/function_install.txt` — `dashboard_snapshot.sql`
  installed the `STABLE SECURITY DEFINER` function, revoked PUBLIC EXECUTE,
  granted USAGE on `trade_fair` and EXECUTE on the new function only to the
  dedicated role.
- `sql/staging_evidence/role_audit.txt` — `dashboard_role_audit.sql`
  returned clean (`DO` block completed; `ROLLBACK` because the audit is
  read-only).
- `sql/staging_evidence/role_probe.txt` — reconnected as
  `trade_fair_dashboard`, confirmed:
  - positive `dashboard_snapshot(50,…)` returns valid JSON (empty aggregates
    before seeding);
  - direct SELECT on `companies`, `contacts`, `lead_submissions`,
    `processing_results`, `email_outbox` all return `ERROR: permission denied`;
  - `has_function_privilege(current_user, …, 'EXECUTE')` is `false` for all
    14 other `trade_fair` functions and `true` only for `dashboard_snapshot`.

## Positive-data E2E (completed)

- `sql/staging_evidence/seed.txt` — owner inserted one synthetic
  WARM/45/delivered lead
  (`FAIR-2e063b26-bafa-4b4b-9404-2ca20a6d3459`, company `WBS Staging GmbH`).
- Private staging env at `/opt/wbs-trade-fair/secrets/wbs-tf-04-staging.env`
  (chmod 600, root-owned, outside Git) with fresh form/admin keys and session
  secret; `DASHBOARD_DATABASE_URL` set to the `trade_fair_dashboard` URL.
- Repository checked out at the PR head on the VPS;
  `docker compose -f compose.dashboard-staging.yaml up -d` restarted the
  staging container on `127.0.0.1:13080`. No workflow ran, no email sent.
- `sql/staging_evidence/e2e_positive.txt` records the HTTP matrix:
  - `healthz` 200;
  - anon `/api/dashboard` + `/dashboard` → 401;
  - form-key `/api/login` → 200, form-session `/api/dashboard` + `/dashboard` → 401;
  - admin-key `/api/login` → 200, admin `/dashboard{,.js,.css}` → 200;
  - admin `GET /api/dashboard?limit=10` → **200** with `total=1`,
    `stats.warm=1`, `stats.scored_average=45`, single lead row matching the
    seed (`WARM`, `score_total=45`, `email_status=delivered`,
    `processing_status=completed`, `duplicate_status=NEW`,
    `training_interest=automation`);
  - admin `GET /api/dashboard?band=WARM` → 200, `total=1`;
  - admin `GET /api/dashboard?band=HOT` → 200, `total=0`;
  - admin `GET /api/dashboard?score_band=HOT` (invalid filter) → **400**;
  - admin `POST /api/dashboard` → **405**.

## Rollback drill (completed)

- `docker compose down` removed the staging container and network;
  `127.0.0.1:13080` returned to free.
- `sql/staging_evidence/rows_rollback.txt` — deleted the synthetic row-set:
  `email_outbox` → `processing_results` → `lead_submissions` → `contacts` →
  `companies`. All five tables returned to 0 rows.
- `sql/staging_evidence/role_rollback.txt` —
  `dashboard_staging_rollback.sql` with `-v isolated_branch_confirmed=on`
  dropped the function and role. Post-rollback probe:
  `role_exists=false`, `fn_exists=false`.

## Branch secrets

- `/opt/wbs-trade-fair/secrets/wbs-tf-04-staging.env` — root 600; private
  staging env for the Compose stack (new form/admin keys, session secret,
  dummy `N8N_HEADER_KEY`, dashboard-role `DASHBOARD_DATABASE_URL`). Kept for
  Codex's follow-up unless the staging branch is destroyed.
- `/opt/wbs-trade-fair/secrets/wbs-tf-04-dashboard-role.env` — root 600; the
  48-char password used for `trade_fair_dashboard` during this run. The role
  was dropped at the end of the drill, so this value is now obsolete. Codex
  may delete this file or rotate it on the next install.

## Not executed (production boundary)

- No production Neon DDL/DML.
- No change to production Gateway image, container, systemd, or env.
- No nginx edit or Gate F3B confirmation.
- No change to n8n WF-A–D.
- No merge.

## Handover to Codex

1. Verify the Neon branch name (`wbs-tf-dashboard-staging`) matches
   `br-rapid-sun-bandpl0m` via the Neon console/API, as a residual
   out-of-band independent check; archive the attestation.
2. If this run is to be reproduced, (re)run in order:
   `sql/dashboard_role_staging.sql`, `sql/dashboard_snapshot.sql`,
   `sql/dashboard_role_audit.sql`, synthetic-row seed, Compose HTTP checks,
   row cleanup, `sql/dashboard_staging_rollback.sql`. All scripts are
   idempotent in the "clean branch → clean branch" sense proven here.
3. Owner-controlled: approve production Gateway recreate with the dedicated
   role and function installed under an approved production migration, plus
   nginx Gate F3B forwarding. No PR merge until both gates clear and PR #2
   lands.
4. Treat `/opt/wbs-trade-fair/secrets/wbs-tf-04-dashboard-role.env` as
   obsolete; the staging dashboard role no longer exists on the branch.
