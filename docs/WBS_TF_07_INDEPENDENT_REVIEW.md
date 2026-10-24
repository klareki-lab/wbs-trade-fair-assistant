# WBS-TF-07 — independent production preflight review

Date: 2026-10-24. Reviewed Black's Draft PR #8 at
`81d8d29e8f24e3ffb7542a7d8ad45f103d54279d`.
Corrective Draft PR #9 is a separate branch at
`45e0d741e2d7bc25f3cce23e419a1ef4f5c78734`.
No production or completed Neon staging DDL, DNS, nginx, TLS, Gateway,
workflow, merge or deployment change was made.

## Verdict

| Gate | Verdict | Scope |
| --- | --- | --- |
| SQL migration on PR #8 | **CHANGES REQUIRED** | Nested transaction and post-commit assertion can leave a partial installation. |
| Transaction atomicity | **NOT VERIFIED on PR #8; VERIFIED for PR #9 candidate** | Isolated PostgreSQL 16 failure tests below. |
| Rollback | **FAIL for PR #8 atomic assertion design; PASS for PR #9 candidate** | Successful rollback and induced dependency failure both tested. |
| GitHub release chain | **PASS** | Exact ancestor chain and PR #8 base reproduced; merges remain pending. |
| Backup/Gateway readiness | **PASS (preparation only)** | Current runtime, private directory and local immutable-image recipe checked; live backup/candidate not yet created. |
| Production Neon branch identity | **BLOCKED** | No authorized production branch metadata available. Owner must verify ID, endpoint, timeline and role capability. |
| Overall preflight | **CHANGES REQUIRED** | PR #9 must be reviewed and incorporated before production DDL. |
| Production execution | **NO-GO** | SQL correction and branch identity gates remain open; Owner approvals and live acceptance are pending. |

## 1. Transaction defect independently reproduced

I ran PR #8's migration as `neondb_owner` with `CREATEROLE` against a
throwaway PostgreSQL 16 container holding the representative
`sql/dashboard_confirmed_ddl.sql` schema. From the repository root,
psql emitted `there is already a transaction in progress` at the
included file's `BEGIN` and `there is no transaction in progress` at
the outer `COMMIT`. The inner `COMMIT` had already persisted the role,
function and grants. I injected a failure into the post-install check:
psql stopped, while catalog counts remained **role=1, function=1**.
This directly disproves PR #8's one-transaction assertion.

Running the original script via an absolute `-f` from `/tmp` failed at
`\i sql/dashboard_snapshot.sql: No such file or directory`. In that
case the still-open transaction rolled back on connection exit and
catalog counts were role=0, function=0. The original rollback script
subsequently removed the installed role/function on its successful
path, but its final assertion also ran after `COMMIT`.

## 2. Corrective PR #9 independently exercised

PR #9 extracts the function definition without changing its SQL body
(byte-for-byte comparison passed) into
`sql/dashboard_snapshot_definition.sql`. The standalone staging wrapper
and production migration use `\ir` to resolve it relative to their own
files. Production prechecks, `CREATE ROLE`, `CREATE FUNCTION`, ACL changes
and all assertions now precede one `COMMIT`. Rollback likewise verifies
state before committing. The production preflight text also restores
backup-before-candidate order and requires owner `CREATEROLE`.

In the isolated container:

- Install launched from `/tmp` with absolute `-f`: **PASS**, no
  transaction warnings. Catalog: owner `neondb_owner`, `prosecdef=t`,
  `provolatile=s`, `proconfig={search_path=pg_catalog, trade_fair,
  pg_temp}`; PUBLIC EXECUTE=false, dashboard EXECUTE=true, schema
  USAGE=true/CREATE=false, direct table SELECT=false. Calling the
  function as `trade_fair_dashboard` returned a JSON object.
- Removed the representative `email_outbox` table to force function
  creation failure: psql stopped; **role=0, function=0**.
- Added an unrelated public-executable function to force the final
  privilege assertion to fail: psql stopped; **role=0, function=0**.
- Added a separate table grant to the role to force `DROP ROLE` failure
  during rollback: psql stopped; **role=1, function=1**. After removing
  that test dependency, rollback completed; **role=0, function=0**.
- Standalone staging role/function install, audit and rollback after
  the shared-definition refactor: **PASS**.
- Short password and missing confirmation guard: rejected before
  installation; role stayed absent.
- Gateway regression suite: **40/40 PASS**. `git diff --check`: PASS.

These are isolated PostgreSQL results, not a production migration or
Neon compatibility claim. The owner must still confirm production
branch identity and `neondb_owner` role-creation capability before DDL.

## 3. Other preflight evidence

- Git: `origin/main` → PR #1 `854f247` → PR #2 `413d8ad` → PR #3
  `e143d8f` passes `merge-base --is-ancestor`. PR #8 at `81d8d29`
  descends from PR #5 R3 `185c208`. Runtime PR #1, #2 and #3 still
  need deliberate integration in that order; documentation remains a
  separate chain.
- DNS: authoritative and public queries returned A `77.42.19.144`
  with no AAAA. AAAA stays unpublished until external IPv6 HTTPS tests.
- VPS read-only probes: Gateway `wbs-trade-fair-gateway` is running
  on host networking with `unless-stopped`, old image
  `sha256:fe4f6d74…` and read-only `/app/web` and `/app/gateway`
  mounts. Loopback `/healthz` returned HTTP 200 and the expected JSON.
  Local build of `Dockerfile.dashboard-staging` produced a candidate
  image; a created test container had zero mounts and zero binds.
- nginx 1.24 `nginx -t` passed; no active `messe.klare-ki.de`
  `server_name` and no messe certificate. The secrets directory is
  root-owned 0700 with 8.7 G free on its filesystem. No rollout
  timestamp record or candidate env exists yet; the F3B runbook must
  capture the original env before either is prepared.
- The four named WF-A–D were present in n8n's active-workflow list.
  Field-scoped Docker/nginx probes and catalog queries displayed no
  credential values. No workflow was modified.

## 4. Handover to Black CC and Owner

1. Review and integrate PR #9 into the WBS-TF-07 packet; retain PR #8
   as the implementation record. The original PR #8 migration must
   never be run. Re-run isolated SQL tests if the function definition,
   grants or transaction boundaries change.
2. Owner confirms production Neon project, branch ID, endpoint and
   timeline out of band; confirm it differs from staging
   `br-rapid-sun-bandpl0m` and that `neondb_owner` has `CREATEROLE`.
   Store the evidence in the private deployment log without exposing
   credentials. This is a hard STOP before migration.
3. Obtain separate Owner approval for the PR #1 → #2 → #3 release
   chain, production migration, original-env backup, private candidate
   secret, image build, nginx/Certbot and Gateway cutover, staged HSTS,
   and optional AAAA after external IPv6 checks. Execute the F3B
   holding-vhost and rollback sequence with live acceptance; no
   production GO follows from this offline review alone.
