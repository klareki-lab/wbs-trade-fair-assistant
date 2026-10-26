# Stage-0 packet validation — 2026-10-26

Scope: documentation and prepared SQL only. Release Preparation Engineer; not an
independent review of R2, not deployed staging acceptance.

- Source/current-main comparison: `git fetch origin main`, `git rev-parse origin/main`,
  `git diff --stat origin/main...HEAD`: main `5fb6348db8954d233fcee5c8c782542e18f2ec90`,
  source `d854721bbd440500605d03f984e1b73fa4d66490`, 26 files, +3511 / -125.
- All 17 runbook shell code blocks: `bash -n` passed. This checks syntax only;
  infrastructure/API/build commands were not executed.
- SQL syntax/fixture execution: two disposable local Docker containers, random names
  `wbs-stage0-doccheck-*` / `wbs-stage0-seedcheck-*`, image `postgres:16-alpine`,
  image ID `sha256:4e6e670bb069649261c9c18031f0aded7bb249a5b6664ddec29c013a89310d50`,
  actual PostgreSQL **16.13**, `--network none`, no published ports or mounted
  volumes, no user credentials. Synthetic trust authentication inside the isolated
  container only; both containers removed in finally.
- Fixture setup: neondb/neondb_owner, CREATE SCHEMA trade_fair, dedicated dashboard
  role, unchanged `sql/dashboard_confirmed_ddl.sql` +
  `sql/dashboard_snapshot_definition.sql`, snapshot PUBLIC revoke / dashboard grant.
  SQL sent to `docker exec -i <random-local-container> psql -X -U neondb_owner
  -d neondb -v ON_ERROR_STOP=1`; CRM UP with `-v production_branch_confirmed=on`.
- `neon-preflight.sql` ran successfully on baseline and migrated fixtures.
- Frozen `dashboard_crm_v1_up.sql` applied successfully, without edits.
- `neon-postflight.sql`: all five violation queries returned zero rows;
  expected unique partial index present, snapshot_ok=true, both empty and seeded CRM.
- `synthetic-seed.sql`: missing guard rejected, explicit guard inserted 8 leads,
  duplicate seed rejected; no outbox rows or external side effects.
- `data-fingerprints.sql`: generated SELECT queries executed on fixture tables;
  two unchanged synthetic snapshots produced identical output.
- Manifest file hashes, relative links, SHA256SUMS and docs-only diff checked before
  publication. Runtime files at source SHA unchanged.

No SSH, Neon connection, n8n import/activation, secret access, provider call,
registry push, deployment, merge, backup or restore against infrastructure occurred.
No complete R2 test suite was rerun. No live webhook/auth/provider/ACL/isolation claim
is made. Backup/restore commands and n8n API commands remain operator preparation;
actual target evidence and Owner approvals are still required.
