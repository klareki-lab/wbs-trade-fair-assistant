# WBS Trade Fair Assistant — Production Execution Packet (P-DEPLOY-01)

**Status: PREPARATION GO / PRODUCTION EXECUTION HOLD.**

Nothing in this packet has been executed against production. Every step
requires explicit Owner GO at execution time (see
`docs/WBS_TF_OWNER_GO_CHECKLIST.md`).

## 0. Pinned release

### Code SHA
`3421a5d2bb842461c2c12c0f565f53249eeeee05` (RC3.3 verifier fix)

### Acceptance+packet SHA
`49693b330ef6f0340205e84c06f7924b688212bb` (release acceptance docs)
→ branched to `prep/wbs-tf-p-deploy-01` for this packet.

### Deployment file pins (sha256)
```
workflows/wf-07-messe-hub-ai-extract.adapted.json
  a7ce5de465fa624c5445730ed3c45f33f651c1da698cbd5ca26b8a0f32b3d604
workflows/wf-08-messe-hub-ai-ask.adapted.json
  c448ab58d77155c0c5dd19e2c62ba0aa04c920b30f15ab6d401e0e5703d8d63b
integration/n8n-live-01/verify-published.mjs
  7e951d1d94fafbcdfedb075b4a014ebc5b3903f737c1dd0ca1e2a371fec4848e
integration/n8n-live-01/finalize.mjs
  36145d817616fa618547f142ccef4fca04024772922da3c9703e02ee0756831f
Dockerfile.dashboard-staging
  2a3fb936a0dfc2efbdf9515f0d07ea01af09425b298b0a2a7b5c26cbd9fbb3ec
ops/nginx/messe.klare-ki.de.bootstrap.conf
  c940ad388c135f836b917c73697aea3c0f4e24ff4b570a1a63aca71564a33362
ops/nginx/messe.klare-ki.de.https-holding.conf
  6cd41d4a8baea767da0ce554dd3cd0fb1b6233e32715175242c3f43548cbc0e1
ops/nginx/messe.klare-ki.de.conf
  2858e98e492deea159137e889b1a1529ad9313804391fe799de919bde39954bd
sql/production/dashboard_role_production.sql
  617862b9b0817e11d5d9d6ceacb7c82e3264e299b1c3b201d60eda1847ade9fd
sql/production/dashboard_role_production_rollback.sql
  acdde949282ef258ad7ab7af0660752915884ebf57bcea64b2616c4d04a73452
sql/production/dashboard_crm_v1_up.sql
  85317d5810d0d4de3d25a989f81858146c8fe3a71c8ecbd13641a410a0ff0ac7
sql/production/dashboard_crm_v1_down.sql
  9c11b779d1cc9281ff49482b7d998f6a3bfc8da3d3e607c4ee4d02c3de395b1f
```

The Owner operator MUST re-compute each sha256 before executing the
corresponding step, and compare to this list.

## 1. Preflight (read-only, before any Owner GO)

**P1 — Code hashes match pin list (§0).**
```bash
cd <checkout>
shasum -a 256 workflows/wf-07-*.json workflows/wf-08-*.json \
  integration/n8n-live-01/verify-published.mjs \
  integration/n8n-live-01/finalize.mjs \
  Dockerfile.dashboard-staging \
  ops/nginx/messe.klare-ki.de*.conf \
  sql/production/*.sql
```
Expected: each hash matches §0. **FAIL action:** STOP; the local checkout
drifted from the pinned release.

**P2 — Regression suite re-run.**
```bash
node --test tests/integration/rc31_regression.mjs \
  tests/integration/rc32_published_provenance.mjs \
  tests/integration/rc33_executable_provenance.mjs \
  tests/integration/workflow_contracts.mjs \
  tests/test_gateway_dashboard.mjs tests/test_dashboard.mjs \
  integration/n8n-live-01/test-adaptations.mjs
```
Expected: `tests 108 pass 108 fail 0`.
**FAIL action:** STOP; investigate regression before any production step.

**P3 — Production n8n catalog unchanged.**
```bash
# via MCP pam_n8n_workflow_list (Owner-side) or n8n REST on 127.0.0.1:5678
# compare WF-A/B/C/D ids and activeVersionId with the Phase A snapshot:
#   WF-A d5uO1lnwjOirJ5Xf  activeVersionId=0c87ae2a-8199-4520-911d-d5869d17601b
#   WF-B dr05aJRh8Lu6VpSA  activeVersionId=c68f7272-56bb-4cd8-a777-f863f04e4697
#   WF-C bRkCsVxZXU85yqLI  activeVersionId=b2c08c88-10af-4bdd-b28c-76b0c750b171
#   WF-D THulrTbNEZ2FrgJ3  activeVersionId=a876cc62-f54e-432a-a779-a36be3d1dcbf
```
Expected: all four ids present, active=true, each versionId==activeVersionId,
and each activeVersionId equals the recorded value.
**FAIL action:** STOP; WF-A..D drift must be reviewed independently before
RC3.3 can proceed.

**P4 — No workflow collision for RC3 webhook paths.**
Expected: no existing workflow uses `messe-hub/ai-extract` or `messe-hub/ai-ask`.
**FAIL action:** STOP; investigate and rename or coordinate with the
responsible workflow owner.

**P5 — Gateway container currently running + a saved rollback snapshot present.**
```bash
docker ps --filter name=wbs-trade-fair-gateway --format '{{.Names}} {{.Status}}'
docker ps -a --filter 'name=wbs-trade-fair-gateway.saved-' --format '{{.Names}} {{.Status}}'
```
Expected: active container `Up …`; at least one `wbs-trade-fair-gateway.saved-*`
container in `Exited (0)` state ready for `docker start`.
**FAIL action:** STOP; create a baseline snapshot before any swap (F3B R3 §6).

**P6 — Private secrets directory present.**
```bash
stat -c '%a %U:%G' /opt/wbs-trade-fair/secrets
```
Expected: `700 root:root`. **FAIL action:** STOP; fix permissions before
placing any new secret file.

**P7 — Local nginx syntax check for the three RC3 vhosts.**
```bash
ops/nginx/check_vhosts.sh
```
Expected: `PASS messe.klare-ki.de.bootstrap.conf`,
`PASS messe.klare-ki.de.https-holding.conf`,
`PASS messe.klare-ki.de.conf` (confirmed locally today).
**FAIL action:** STOP; fix the config file before any `nginx -s reload`.

## 2. Neon production — migrations and roles

**Prerequisite before any step in §2: Owner Gate 2.1 CONFIRMED.** The
production Neon branch identity cannot be independently derived from the
repository or Phase A probes; it must be verified out-of-band.

### Owner Gate 2.1 — Production Neon branch identity
Owner-side verification (from a non-shared workstation, with production
Neon credentials never written to repo or chat):

```sql
-- Target: production branch of project wbs-trade-fair-assistant.
SELECT current_database(), current_user, inet_server_addr();
SELECT setting FROM pg_settings WHERE name='neon.timeline_id';
SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname='trade_fair';
SELECT count(*) FROM pg_proc p
  JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='trade_fair' AND p.proname='dashboard_snapshot';
SELECT rolname FROM pg_roles
  WHERE rolname IN ('trade_fair_dashboard','wbs_tf_ai_context');
```

Expected:
- `current_user=neondb_owner`, `current_database=neondb`
- `nspname='trade_fair'` schema exists and is owned by `neondb_owner`
- `neon.timeline_id` is **not** `a171e976ae189ef43d7ca803d826354e`
  (that is the staging timeline)
- `dashboard_snapshot` function **count = 0** (not yet migrated)
- `trade_fair_dashboard` and `wbs_tf_ai_context` roles **do not exist**

**FAIL action:** STOP. Any disagreement means the Owner is pointed at
staging or at a wrong branch. Do NOT proceed to §2.2 or §2.3.

### Step 2.2 — Dashboard role migration
```bash
export WBS_DASHBOARD_PROD_ROLE_PASSWORD='<owner-chosen; never in repo or chat>'
psql -X -v ON_ERROR_STOP=1 -v production_branch_confirmed=on \
  -f sql/production/dashboard_role_production.sql
unset WBS_DASHBOARD_PROD_ROLE_PASSWORD
```
Expected: script completes with its own in-script read-only assertions
PASS (prosecdef=true, provolatile='s', proowner=neondb_owner, no PUBLIC
EXECUTE, trade_fair_dashboard has EXECUTE + USAGE and no table SELECT,
no EXECUTE on other trade_fair.* functions).
**FAIL action:** `psql -X -v ON_ERROR_STOP=1 -v production_branch_confirmed=on
  -f sql/production/dashboard_role_production_rollback.sql`
and STOP.

### Step 2.3 — CRM v1 migration
```bash
psql -X -v ON_ERROR_STOP=1 -v production_branch_confirmed=on \
  -f sql/production/dashboard_crm_v1_up.sql
```
Expected: migration completes.
**FAIL action:** `psql -X -v ON_ERROR_STOP=1 -v production_branch_confirmed=on
  -f sql/production/dashboard_crm_v1_down.sql`
and STOP.

### Step 2.4 — Provision `wbs_tf_ai_context` role
RC3 WF-08 reads the context via a dedicated login role with EXECUTE on
`trade_fair.ai_lead_context(uuid[], text[])` only, no table SELECT.

```sql
-- Executed by neondb_owner on confirmed production branch.
BEGIN;
CREATE ROLE wbs_tf_ai_context LOGIN
  PASSWORD :'WBS_TF_AI_CONTEXT_PASSWORD'
  CONNECTION LIMIT 20;
GRANT USAGE ON SCHEMA trade_fair TO wbs_tf_ai_context;
REVOKE ALL ON FUNCTION trade_fair.ai_lead_context(uuid[], text[])
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trade_fair.ai_lead_context(uuid[], text[])
  TO wbs_tf_ai_context;
COMMIT;

-- Read-only post-conditions (same transaction fails if any assertion false).
DO $$ BEGIN
  ASSERT (SELECT has_schema_privilege('wbs_tf_ai_context','trade_fair','USAGE')),
    'USAGE on trade_fair missing';
  ASSERT (SELECT NOT has_schema_privilege('wbs_tf_ai_context','trade_fair','CREATE')),
    'CREATE must be denied';
  ASSERT (SELECT has_function_privilege(
    'wbs_tf_ai_context',
    'trade_fair.ai_lead_context(uuid[], text[])','EXECUTE')),
    'EXECUTE on ai_lead_context missing';
  -- No direct table privilege expected
  ASSERT (SELECT NOT bool_or(has_table_privilege(
    'wbs_tf_ai_context','trade_fair.'||table_name,'SELECT'))
    FROM information_schema.tables WHERE table_schema='trade_fair'),
    'Direct table SELECT must be denied for wbs_tf_ai_context';
END $$;
```

Expected: all assertions PASS.
**FAIL action:**
```sql
BEGIN;
REVOKE EXECUTE ON FUNCTION trade_fair.ai_lead_context(uuid[], text[])
  FROM wbs_tf_ai_context;
REVOKE USAGE ON SCHEMA trade_fair FROM wbs_tf_ai_context;
DROP ROLE wbs_tf_ai_context;
COMMIT;
```
and STOP.

## 3. n8n — WF-07 and WF-08

### Fixed facts
- **Workflow 7 webhook path:** `messe-hub/ai-extract`.
- **Workflow 8 webhook path:** `messe-hub/ai-ask`.
- Both webhooks are the only RC3 paths; neither collides with any
  existing production workflow (Phase A audit confirmed).
- Both workflows require three credential bindings per node:
  `httpHeaderAuth`, `openAiApi`, `postgres`.
- Finalizer verifier `verify-published.mjs` fails CLOSED unless
  `active=true`, `versionId==activeVersionId`, and the published
  snapshot's complete executable fingerprint equals canonical source
  (id, name, type, typeVersion, parameters, disabled, executeOnce,
  alwaysOutputData, retryOnFail, maxTries, waitBetweenTries,
  continueOnFail, onError).

### Step 3.1 — Credential inventory + mapping
Reused prod credentials (no change):
- `tjqSy2V0odocljw6` — `WBS Trade Fair — Gateway Auth` (httpHeaderAuth).
- Shared Neon postgres cred `DIm6w5CcndY0D3RJ` is NOT reused for
  WF-07/08; a dedicated binding is needed (step 3.2) to scope the AI
  context connection to the `wbs_tf_ai_context` role from §2.4.

Created for RC3 (Owner-executed; cred IDs filled in by n8n at create):
- NEW n8n credential `WBS Trade Fair — OpenAI RC3`, type `openAiApi`.
  API key value = same as existing `UUprjEp0Re6kPUFN` Bearer. Do not
  delete `UUprjEp0Re6kPUFN` (WF-B depends on it).
- NEW n8n credential `WBS Trade Fair — AI context`, type `postgres`.
  Points at the production Neon host, database `neondb`, user
  `wbs_tf_ai_context`, password = §2.4 value, SSL=require.

Expected after create (via REST GET /rest/credentials):
```
WBS Trade Fair — OpenAI RC3      type=openAiApi
WBS Trade Fair — AI context      type=postgres
```
**FAIL action:** DELETE the partially-created credential via
`DELETE /rest/credentials/<id>` and STOP.

### Step 3.2 — Import WF-07 / WF-08
Executed from the Owner workstation against production n8n REST
(`http://127.0.0.1:5678/rest/`). Workflows are **imported with
`active:false`**; activation is a later step.

Pseudo-script (actual script `ops/n8n/import_wf07_wf08.sh` to be
prepared under this packet in a separate commit if Owner authorises
execution). The script MUST:

1. Read canonical JSON from the pinned path.
2. Rewrite each node's credentials map in memory to the new credential
   IDs from §3.1 (plus the existing `tjqSy2V0odocljw6`). Do not edit
   the committed JSON.
3. Assign `webhookId` for any webhook node that lacks one.
4. POST `/rest/workflows` with `active:false`.

Expected: two new workflows appear in `GET /rest/workflows`, each
`active=false`, each with a server-assigned id (record both ids in
the deployment log).
**FAIL action:** DELETE both via `DELETE /rest/workflows/<id>` and STOP.

### Step 3.3 — Activate WF-07 / WF-08
```bash
curl -sf -XPOST -H "X-N8N-API-KEY: $N8N_API_KEY" \
  http://127.0.0.1:5678/rest/workflows/<wf07-id>/activate \
  -H 'Content-Type: application/json' \
  -d "{\"versionId\":\"$(curl ... | jq -r .data.versionId)\"}"
# repeat for wf08
```

Expected: each `GET /rest/workflows/<id>` returns `active:true`,
`versionId==activeVersionId`, and `GET /webhook/messe-hub/ai-extract`
(no auth header) returns HTTP **403** (auth gate working).
**FAIL action:** `POST /rest/workflows/<id>/deactivate`, then
`DELETE /rest/workflows/<id>`, and STOP.

### Step 3.4 — RC3.3 finalizer provenance verification against live prod
```bash
cd <checkout at 3421a5d>
N8N_URL=http://127.0.0.1:5678 N8N_API_KEY=... \
  node integration/n8n-live-01/finalize.mjs \
  --workflow-ids=<wf07-id>,<wf08-id> \
  --mode=production-verify-only \
  > /opt/wbs-trade-fair/secrets/backups/${TF_ROLLOUT_TS}/finalize.json
```
Expected: process exits 0; captured JSON shows `ok:true` for both
workflows with `publishedVersionId==activeVersionId` and no
`PUBLISHED_PROVENANCE_FAILED`.
**FAIL action:** immediately `POST /rest/workflows/<id>/deactivate` for
both, inspect the diff, STOP.

### Step 3.5 — Execution retention + error handling settings
Each WF-07/WF-08 record MUST have these settings persisted:
```
executionOrder: 'v1'
saveDataErrorExecution: 'none'
saveDataSuccessExecution: 'none'
saveManualExecutions: false
saveExecutionProgress: false
executionTimeout: 30
```
These match the LIVE-01 isolated manifest exactly (committed in
`integration/n8n-live-01/evidence/manifest.json`).

Expected: `GET /rest/workflows/<id>` → `.data.settings` equals the above.
**FAIL action:** PATCH `/rest/workflows/<id>` with the correct settings,
then re-run step 3.4.

## 4. Gateway + HTTPS

### Step 4.1 — Build the production Gateway image
```bash
cd <checkout at 3421a5d>  # or merged main containing PR #27 scope
docker build -f Dockerfile.dashboard-staging \
  -t wbs-trade-fair-gateway:rc33-${TF_ROLLOUT_TS} .
docker inspect wbs-trade-fair-gateway:rc33-${TF_ROLLOUT_TS} \
  --format '{{len .Config.Env}} {{.Config.Cmd}} {{.Config.User}}'
docker create --name probe-rc33 \
  wbs-trade-fair-gateway:rc33-${TF_ROLLOUT_TS}
docker inspect probe-rc33 --format '{{len .Mounts}} {{len .HostConfig.Binds}}'
docker rm probe-rc33
```
Expected:
- `User = node`, `Cmd = [node server.mjs]`.
- `len .Mounts = 0` and `len .HostConfig.Binds = 0` (image bakes
  gateway/*.mjs + web/, no bind mounts — this is the WBS-TF-07 §5
  invariant).
**FAIL action:** STOP; the Dockerfile has drifted or the build context
leaked a mount.

### Step 4.2 — RC3-aware webhook allowlist in Gateway env
Owner-maintained private env file (e.g.
`/opt/wbs-trade-fair/secrets/gateway.rc33.env`, mode 0600 root):
```
GATEWAY_ALLOW_UPSTREAM_WEBHOOKS=\
  /webhook/trade-fair/lead,\
  /webhook/trade-fair/status,\
  /webhook/messe-hub/ai-extract,\
  /webhook/messe-hub/ai-ask
```
Expected: new file exists, mode 0600, root-owned, not world-readable,
not committed to Git. **FAIL action:** `chmod 0600; chown root:root`;
re-check; STOP if the file ever had looser permissions.

### Step 4.3 — F3B R3 §6 "Reversible swap" (Gateway swap)
Documented in `docs/WBS_TF_06_F3B_PREP.md` §6. Summary:

1. Capture baseline: `docker inspect wbs-trade-fair-gateway` →
   `/opt/wbs-trade-fair/secrets/backups/${TF_ROLLOUT_TS}/inspect.json`.
2. Rename current container to `wbs-trade-fair-gateway.saved-${TF_ROLLOUT_TS}`.
3. `docker run -d --name wbs-trade-fair-gateway.candidate ...` with
   `--env-file /opt/wbs-trade-fair/secrets/gateway.rc33.env`,
   `--restart unless-stopped`, image from step 4.1.
4. `curl -fsS http://127.0.0.1:3000/healthz` → 200 OK on candidate.
5. If healthy, rename candidate to `wbs-trade-fair-gateway` and leave
   `.saved-${TF_ROLLOUT_TS}` as the rollback target.

Expected: new container Up, healthz=200. `docker ps` shows exactly one
`wbs-trade-fair-gateway` running and at least one `.saved-${TF_ROLLOUT_TS}`
in `Exited (0)`.
**FAIL action:** immediately `docker start wbs-trade-fair-gateway.saved-${TF_ROLLOUT_TS}`
with the original name (per F3B R3 §9), stop the candidate, STOP.

### Step 4.4 — nginx bootstrap vhost
Document `docs/WBS_TF_06_F3B_PREP.md` §10 steps 3-5 cover this exactly.
Summary of the three static-verified vhosts in order of install:

1. `ops/nginx/messe.klare-ki.de.bootstrap.conf`
   (sha256 `c940ad38…`) — HTTP-only bootstrap for Let's Encrypt HTTP-01.
2. After `certbot --nginx -d messe.klare-ki.de --redirect --agree-tos
    -m <owner-email> --no-eff-email` succeeds, swap to:
3. `ops/nginx/messe.klare-ki.de.https-holding.conf`
   (sha256 `6cd41d4a…`) — HTTPS 503 holding page.
4. After loopback acceptance passes, swap to:
5. `ops/nginx/messe.klare-ki.de.conf`
   (sha256 `2858e98e…`) — final reverse proxy to Gateway, staged HSTS.

All three vhosts PASSED local nginx static syntax
(`ops/nginx/check_vhosts.sh` today).
Expected: `nginx -t` PASS before each `nginx -s reload`.
**FAIL action:** keep the previous conf in place; `nginx -s reload`
only after `nginx -t` PASS; STOP.

### Step 4.5 — Loopback and external HTTPS acceptance
Reused F3B R3 §7.1 (loopback) and §7.2 (external). Specific RC3
additions to those acceptance checks:

```bash
# Loopback
curl -fsS -X POST http://127.0.0.1:3000/webhook/messe-hub/ai-extract \
  -H 'Content-Type: application/json' -d '{}' -o /dev/null -w '%{http_code}\n'
# Expected: 403 (auth gate — never 404, never 500)

curl -fsS -X POST http://127.0.0.1:3000/webhook/messe-hub/ai-ask \
  -H 'Content-Type: application/json' -d '{}' -o /dev/null -w '%{http_code}\n'
# Expected: 403

# External HTTPS
curl -fsS -X POST https://messe.klare-ki.de/webhook/messe-hub/ai-extract \
  -H 'Content-Type: application/json' -d '{}' -o /dev/null -w '%{http_code}\n'
# Expected: 403

curl -fsS https://messe.klare-ki.de/healthz -o /dev/null -w '%{http_code}\n'
# Expected: 200
```

**FAIL action:** rollback Gateway (step 4.3 rollback) + nginx (restore
previous conf), STOP.

## 5. Backup and restore

### Step 5.1 — Backup immediately before migration
Owner-side, from a non-shared workstation, with production Neon
credentials provided through the environment (never written to repo):

```bash
mkdir -p /opt/wbs-trade-fair/secrets/backups/${TF_ROLLOUT_TS}
pg_dump -h <prod-neon-host> -U neondb_owner -d neondb \
  --schema=trade_fair --no-owner --no-privileges \
  > /opt/wbs-trade-fair/secrets/backups/${TF_ROLLOUT_TS}/pre-rc33-trade_fair.sql
chmod 0600 /opt/wbs-trade-fair/secrets/backups/${TF_ROLLOUT_TS}/pre-rc33-trade_fair.sql
sha256sum /opt/wbs-trade-fair/secrets/backups/${TF_ROLLOUT_TS}/pre-rc33-trade_fair.sql \
  | tee /opt/wbs-trade-fair/secrets/backups/${TF_ROLLOUT_TS}/pre-rc33-trade_fair.sha256
```

Expected: dump size > 10 KB (sanity minimum for a non-empty
`trade_fair` schema with lead data); sha256 recorded.
**FAIL action:** STOP; investigate why pg_dump failed before any
migration runs. The migration must have a dump to restore from.

### Step 5.2 — Restore into disposable target and verify
```bash
docker run -d --rm --name wbs-rc33-restore-$(date +%s) \
  -e POSTGRES_USER=neondb_owner \
  -e POSTGRES_PASSWORD=restore-only \
  -e POSTGRES_DB=neondb \
  -p 127.0.0.1:0:5432 postgres:16-alpine
# wait for pg_isready, then:
docker exec -i <container> psql -X -U neondb_owner -d neondb \
  < /opt/wbs-trade-fair/secrets/backups/${TF_ROLLOUT_TS}/pre-rc33-trade_fair.sql

docker exec <container> psql -X -U neondb_owner -d neondb -c "
  SELECT
    (SELECT count(*) FROM trade_fair.companies) AS companies,
    (SELECT count(*) FROM trade_fair.contacts) AS contacts,
    (SELECT count(*) FROM trade_fair.lead_submissions) AS submissions;
"
```
Expected: table counts > 0 and consistent with the prod observation
Owner captured out-of-band.
Compare restore row counts to the counts recorded against production
BEFORE the dump (Owner-captured separately).
**FAIL action:** STOP; dump is not restorable. Do NOT run §2 migrations
until the dump is proven restorable.

Reference: the synthetic PG16 round-trip in
`integration/n8n-live-01/_rc33_backup_restore_drill.mjs` already proved
the same procedure returns bit-equal data + ACL for the committed
schema (evidence: `evidence/rc33-backup-restore.txt`). The step above
is the real-Neon analogue.

### Step 5.3 — Rollback plan if RC3 breaks WF-A..D in practice
WF-A..D never touch the new RC3 role or new RC3 workflows. The only
plausible mechanism for an RC3 deployment to affect WF-A..D is:

- SQL migration applied to the wrong Neon branch → see §2 Owner Gate.
- Gateway image regression affecting `/webhook/trade-fair/lead` or
  `/webhook/trade-fair/status` → §4.3 rollback restores the saved
  Gateway container; takes ≤ 30 s.
- Shared credential rotated by mistake → NOT in this packet (see §7
  explicit non-execution).

If a regression is detected post-cutover:
1. Deactivate WF-07/08 (§6.3 rollback 1 below). This cannot affect
   WF-A..D directly; it only removes the Dashboard "Lead-Assistent".
2. If regression persists, swap Gateway back (§6.3 rollback 2).
3. If regression traces to SQL, run the rollback script (§6.3 rollback 3).
4. If data loss is suspected, restore from §5.1 pg_dump to the
   production branch (Owner-approved; this is a destructive restore
   and requires a separate GO).

## 6. End-to-end smoke tests + canary monitoring

### Step 6.1 — Post-cutover bounded-budget smoke test
OpenAI monthly spend cap confirmed before run.
Daily budget cap: **≤ $5** for the first 7 days.
Per-request body token cap: ≤ 2500 input + ≤ 500 output.

Smoke calls (synthetic payloads, synthetic company and contact):
```bash
# 1. AI capture (WF-07 upstream of WF-A)
curl -fsS -X POST https://messe.klare-ki.de/api/ai/extract \
  -H 'Content-Type: application/json' \
  --data '{ "note": "Alice von RC33 Synthetic GmbH, Score 85, warm", ... }' \
  -o /opt/wbs-trade-fair/secrets/backups/${TF_ROLLOUT_TS}/smoke-extract.json \
  -w '%{http_code}\n'
# Expected: 200 + {"success":true, …}

# 2. Lead-Assistent (WF-08) — grounded answer about saved lead
curl -fsS -X POST https://messe.klare-ki.de/api/ai/ask \
  -H 'Content-Type: application/json' \
  --data '{ "lead_ids":["FAIR-…"], "question": "Welcher Score und Budget?" }' \
  -o /opt/wbs-trade-fair/secrets/backups/${TF_ROLLOUT_TS}/smoke-ask.json \
  -w '%{http_code}\n'
# Expected: 200 + answer cites the exact lead_id; no PII; no non-requested leads
```

PASS criteria:
- Both calls return 200.
- WF-08 answer cites the requested lead_id only.
- No PII pattern in WF-08 answer
  (`/Mila|Integrationswerk|private.*synthetic/i` not found).
- OpenAI token usage per call ≤ 2500 input + 500 output.

**FAIL action:** rollback per §6.3; STOP.

### Step 6.2 — Canary windows
| Window | What to monitor | Threshold | Rollback trigger |
|---|---|---|---|
| T+15m | Gateway + n8n journals; one synthetic WF-07 + one WF-08 call | 0 errors | any 5xx on the two calls |
| T+1h  | 5xx rate on messe.klare-ki.de; OpenAI tokens/min | 5xx ≤ 2% / 5 min | 5xx > 2% for 5 min |
| T+24h | OpenAI daily spend; execution-audit anomalies | ≤ $5/day | > $10/day or any PUBLISHED_PROVENANCE_FAILED |
| T+7d  | Standard monitoring thresholds; grounding-gate canary | WF-08 "ungrounded" refusals occur under forced-ungrounded test | WF-08 refusal rate falls to 0 over ≥ 1 h with ≥ 10 real calls |

Execution evidence from each window: Owner saves to
`/opt/wbs-trade-fair/secrets/backups/${TF_ROLLOUT_TS}/canary-{T15m,T1h,T24h,T7d}.json`.

### Step 6.3 — Rollback commands (ready to copy-paste)

**Rollback 1 — Deactivate WF-07/08 (fastest; ~1 s).**
```bash
curl -sf -XPOST -H "X-N8N-API-KEY: $N8N_API_KEY" \
  http://127.0.0.1:5678/rest/workflows/<wf07-id>/deactivate
curl -sf -XPOST -H "X-N8N-API-KEY: $N8N_API_KEY" \
  http://127.0.0.1:5678/rest/workflows/<wf08-id>/deactivate
```
Effect: Dashboard "Lead-Assistent" immediately fails closed (existing
UI behaviour). WF-A/B/C/D UNAFFECTED.

**Rollback 2 — Gateway swap back (≤ 30 s).**
```bash
docker stop wbs-trade-fair-gateway
docker rename wbs-trade-fair-gateway wbs-trade-fair-gateway.rc33-rolled-back
docker rename wbs-trade-fair-gateway.saved-${TF_ROLLOUT_TS} \
  wbs-trade-fair-gateway
docker start wbs-trade-fair-gateway
curl -fsS http://127.0.0.1:3000/healthz
```

**Rollback 3 — SQL migrations.**
```bash
psql -X -v ON_ERROR_STOP=1 -v production_branch_confirmed=on \
  -f sql/production/dashboard_crm_v1_down.sql
psql -X -v ON_ERROR_STOP=1 -v production_branch_confirmed=on \
  -f sql/production/dashboard_role_production_rollback.sql
```

**Rollback 4 — Drop RC3 role + credentials.**
```sql
BEGIN;
REVOKE EXECUTE ON FUNCTION trade_fair.ai_lead_context(uuid[], text[])
  FROM wbs_tf_ai_context;
REVOKE USAGE ON SCHEMA trade_fair FROM wbs_tf_ai_context;
DROP ROLE wbs_tf_ai_context;
COMMIT;
```
```bash
curl -sf -XDELETE -H "X-N8N-API-KEY: $N8N_API_KEY" \
  http://127.0.0.1:5678/rest/credentials/<new-openai-rc3-id>
curl -sf -XDELETE -H "X-N8N-API-KEY: $N8N_API_KEY" \
  http://127.0.0.1:5678/rest/credentials/<new-ai-context-id>
```

### Rollback TRIGGERS (any one → execute Rollback 1 immediately)
1. `PUBLISHED_PROVENANCE_FAILED` on finalizer re-run.
2. 5xx rate on `messe.klare-ki.de` > 2% over 5 min.
3. WF-08 answer in prod contains plaintext PII pattern
   `/Mila|Integrationswerk|private.*synthetic/i`.
4. OpenAI daily spend > $10 OR OpenAI 429 streak > 10 in 10 min.
5. Owner discretion.

## 7. Explicit NON-execution items

The following are intentionally **outside** this packet:

- Any change to WF-A, WF-B, WF-C, or WF-D in production n8n.
- Any shared credential rotation
  (`DIm6w5CcndY0D3RJ`, `UUprjEp0Re6kPUFN`, `tjqSy2V0odocljw6`,
  `HvE5Js2qo8BxvrSs`, `A4Xm6WZ9d6SsMkfs`).
- Dashboard Yuri UI rework (`feature/dashboard-yuri-ui` — separate
  track; must NOT be deployed as part of RC3.3).
- Any `/etc/nginx/sites-enabled/*` change beyond the three staged
  vhost swaps in §4.4.
- Any watchtower or Docker image policy change.
- Any production data edit outside the Owner-approved SQL migrations.
- Access to or publication of secret file contents in logs.
- Merge of PR #27 (the acceptance+plan branch) and/or
  `prep/wbs-tf-p-deploy-01`.

## 8. Owner GO sequence (overview)

See `docs/WBS_TF_OWNER_GO_CHECKLIST.md` for the detailed, initial-by-line
checklist. The ordered gates are:

G1. Codex RC3.3 independent re-review PASS on `3421a5d`.
G2. Owner Gate 2.1 (Neon branch identity) CONFIRMED.
G3. Owner GO for §2 (migrations + role).
G4. Owner GO for §3 (credentials + workflow import + activation +
    finalizer verification).
G5. Owner GO for §4 (Gateway image + swap + nginx + HTTPS).
G6. Owner GO for §6.1 (bounded-budget smoke test).
G7. Owner GO at each canary window promotion
    (T+15m → T+1h → T+24h → T+7d → standard monitoring).

Any one gate failure moves the system to the matching rollback step
and HOLDS pending Owner review.
