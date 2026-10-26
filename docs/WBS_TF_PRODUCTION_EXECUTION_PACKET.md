# WBS Trade Fair Assistant — Production Execution Packet (P-DEPLOY-02)

**Status: OPERATOR PACKET READY / PRODUCTION EXECUTION HOLD.**

Supersedes P-DEPLOY-01. Addresses the deployment-oriented findings in
the Codex RC3.3 final review
(https://github.com/klareki-lab/wbs-trade-fair-assistant/pull/27#issuecomment-6426321107).
Nothing in this packet has been executed against production. Every step
requires explicit Owner GO at execution time (see
`docs/WBS_TF_OWNER_GO_CHECKLIST.md`).

## 0. Pinned release

### Code SHA
`3421a5d2bb842461c2c12c0f565f53249eeeee05` (RC3.3 verifier fix; Codex
CODE READY)

### Deployment file pins (sha256; recompute before executing matching step)
```
workflows/wf-07-messe-hub-ai-extract.adapted.json
  a7ce5de465fa624c5445730ed3c45f33f651c1da698cbd5ca26b8a0f32b3d604
workflows/wf-08-messe-hub-ai-ask.adapted.json
  c448ab58d77155c0c5dd19e2c62ba0aa04c920b30f15ab6d401e0e5703d8d63b
integration/n8n-live-01/verify-published.mjs
  7e951d1d94fafbcdfedb075b4a014ebc5b3903f737c1dd0ca1e2a371fec4848e
Dockerfile.dashboard-staging
  2a3fb936a0dfc2efbdf9515f0d07ea01af09425b298b0a2a7b5c26cbd9fbb3ec
ops/nginx/messe.klare-ki.de.bootstrap.conf        c940ad38…
ops/nginx/messe.klare-ki.de.https-holding.conf    6cd41d4a…
ops/nginx/messe.klare-ki.de.conf                  2858e98e…
sql/production/dashboard_role_production.sql      617862b9…
sql/production/dashboard_role_production_rollback.sql
                                                   acdde949…
sql/production/dashboard_crm_v1_up.sql             85317d58…
sql/production/dashboard_crm_v1_down.sql           9c11b779…
ops/n8n/import_wf_rc3.sh
  d5498b4c69081de7d8f02656f658010e7a051021bdefeb12e46d7dfe9be02a35
ops/n8n/activate_wf.sh
  5de48e42fc67a0ae362febdfab24069c51a593d1a6ecd6a8e93d8ddc4c35a84c
ops/n8n/verify_published_production.mjs
  215a234c348b20970f957ba372d66e5d12d0993c51c046a2c63b6919caa66cb4
```

The Owner operator MUST re-compute each sha256 before executing the
corresponding step, and compare to this list.

## 0.5 Codex RC3.3 finding → correction mapping

| Codex finding | Correction in this packet |
|---|---|
| 1. "Deployment plan §4 references absent `ops/n8n/import_wf07_wf08.sh` and `activate_wf07_wf08.sh`." | §3.2 and §3.3 now reference the committed operator scripts `ops/n8n/import_wf_rc3.sh` and `ops/n8n/activate_wf.sh` (new in this packet). End-to-end validated against disposable n8n 2.41.7 in `integration/n8n-live-01/evidence/rc33-operator-dryrun.txt`. |
| 2. "Finalizer invocation supplies `--workflow-ids` / `--mode=production-verify-only` which the pinned finalizer does not parse: it still reads local `.runtime/state.json`, uses the isolated login/API target and can update retention settings." | §3.4 removes the invented CLI entirely. The genuinely read-only production verifier is a new separate tool `ops/n8n/verify_published_production.mjs`; it issues exactly one write (POST `/rest/login`) and no other non-GET call. Grep audit cited in-file; validated against disposable n8n with positive ACCEPT (exit 0) and `disabled=true` REJECT (exit 1) cases. The pinned `integration/n8n-live-01/finalize.mjs` is explicitly labelled **isolated-use only** — it PATCHes `settings` to normalize retention and MUST NOT be invoked against production. |
| 3. "Credential plan §3 cites `ai_lead_context(uuid[], text[])`; committed SQL defines `ai_lead_context(jsonb)`." | §2.4 and §3.1 use the correct `ai_lead_context(jsonb)` signature. The role name is also corrected: the committed CRM migration creates `trade_fair_ai_context` (NOLOGIN), not `wbs_tf_ai_context`. Owner provisions a dedicated LOGIN role, by convention `trade_fair_ai_login`, and `GRANT trade_fair_ai_context TO trade_fair_ai_login`. |
| 4. "The proposed `GATEWAY_ALLOW_UPSTREAM_WEBHOOKS` setting is not consumed by this Gateway; its actual configuration uses `N8N_AI_EXTRACT_URL` / `N8N_AI_ASK_URL` and origin validation." | §4.2 replaced with the real Gateway env schema derived from `gateway/server.mjs` (loadConfig): `N8N_AI_EXTRACT_URL`, `N8N_AI_ASK_URL`, `N8N_AI_ALLOWED_ORIGIN` (optional, defaults to the capture URL origin), plus existing baseline (`N8N_HEADER_KEY`, `N8N_CAPTURE_URL`, `N8N_STATUS_URL`, `DASHBOARD_*`). Both AI URLs must share the same origin and use HTTPS outside loopback. |
| 5. "REST `/rest` cookie authentication must also be distinguished from the public API key interface." | All `/rest/*` operations in this packet use `/rest/login` cookie session (produced by the operator scripts). The public API key header `X-N8N-API-KEY` targets `/api/v1/*` and is NOT used in this packet; prior references removed from both the packet and the Owner GO checklist. |
| 6. "Acceptance report §3.5 must not imply that old evidence is an exact-current-canonical real-OpenAI pass: WF-08 prompt, structured-output configuration and output-check code changed between that SHA and RC3.3." | `docs/WBS_TF_RELEASE_ACCEPTANCE.md` §3.5 updated. Historical `gateway-e2e.json` evidence (pinned at `6b64f70d…`) stays labelled historical. A new RC3.3 exact-candidate real-OpenAI acceptance is an Owner-authorised step before §G6 of the checklist; this packet does not consume paid API. |
| 7. "`rc33-backup-restore.txt`: dump uses `--no-owner --no-privileges`; the role and grants are recreated, not automatically recovered from the dump." | §5.1 now takes two artefacts: a schema+data dump (default committed procedure) PLUS `pg_dumpall --roles-only` for role/ACL recovery, OR explicit re-run of the committed migrations post-restore. §5.2 validates both. The synthetic drill in evidence is kept as a procedure confirmation, not role-recovery evidence. |

## 1. Preflight (read-only, before any Owner GO)

**P1 — Code hashes match pin list (§0).**
```bash
shasum -a 256 \
  workflows/wf-07-*.json workflows/wf-08-*.json \
  integration/n8n-live-01/verify-published.mjs \
  Dockerfile.dashboard-staging \
  ops/nginx/messe.klare-ki.de*.conf \
  sql/production/*.sql \
  ops/n8n/import_wf_rc3.sh ops/n8n/activate_wf.sh \
  ops/n8n/verify_published_production.mjs
```
Expected: each hash matches §0. **FAIL action:** STOP.

**P2 — Regression suite re-run.**
```bash
node --test tests/integration/rc31_regression.mjs \
  tests/integration/rc32_published_provenance.mjs \
  tests/integration/rc33_executable_provenance.mjs \
  tests/integration/workflow_contracts.mjs \
  tests/test_gateway_dashboard.mjs tests/test_dashboard.mjs \
  integration/n8n-live-01/test-adaptations.mjs
```
Expected: `tests 108 pass 108 fail 0`. **FAIL action:** STOP.

**P3 — Production n8n catalog unchanged.**
Compare WF-A/B/C/D ids and `activeVersionId` with the baseline recorded
in `docs/WBS_TF_RELEASE_ACCEPTANCE.md` §2.2.
Expected: all four ids present, `active=true`,
`versionId==activeVersionId`.
**FAIL action:** STOP.

**P4 — No workflow collision for RC3 webhook paths.**
```bash
curl -b "$CJ" "$N8N_BASE_URL/rest/workflows" | \
  jq -r '.data[] | select(.name|test("WF-07|WF-08|messe-hub-ai"))'
```
Expected: empty. **FAIL action:** STOP.

**P5 — Gateway container running + saved rollback snapshot present.**
```bash
docker ps --filter 'name=wbs-trade-fair-gateway' --format '{{.Names}} {{.Status}}'
docker ps -a --filter 'name=wbs-trade-fair-gateway.saved-' --format '{{.Names}} {{.Status}}'
```
Expected: active container `Up …`; at least one `.saved-*` container
`Exited (0)`. **FAIL action:** STOP; capture baseline first (F3B R3 §6).

**P6 — Secrets directory present.**
```bash
stat -c '%a %U:%G' /opt/wbs-trade-fair/secrets
```
Expected: `700 root:root`. **FAIL action:** STOP; fix permissions.

**P7 — Local nginx syntax check for the three RC3 vhosts.**
```bash
ops/nginx/check_vhosts.sh
```
Expected: 3× `PASS`. **FAIL action:** STOP.

## 2. Neon production — migrations and roles

**Prerequisite before any step in §2: Owner Gate 2.1 CONFIRMED.** The
production Neon branch identity cannot be independently derived from
this repository; it must be verified out-of-band.

### Owner Gate 2.1 — Production Neon branch identity

Owner-side verification against the production branch of the Neon
project `wbs-trade-fair-assistant`. Credentials never written to repo
or chat.

```sql
SELECT current_database(), current_user, inet_server_addr();
SELECT setting FROM pg_settings WHERE name='neon.timeline_id';
SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname='trade_fair';
SELECT count(*) FROM pg_proc p
  JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='trade_fair' AND p.proname='dashboard_snapshot';
SELECT rolname FROM pg_roles
  WHERE rolname IN ('trade_fair_dashboard','trade_fair_ai_context','trade_fair_ai_login');
```

Expected:
- `current_user=neondb_owner`, `current_database=neondb`.
- `trade_fair` schema owned by `neondb_owner`.
- `neon.timeline_id` is **not** `a171e976ae189ef43d7ca803d826354e`
  (that is staging).
- `dashboard_snapshot` function count = 0 (not yet migrated).
- Roles `trade_fair_dashboard`, `trade_fair_ai_context` and the
  Owner-chosen LOGIN role (`trade_fair_ai_login` by convention) all
  **do not exist**.

**FAIL action:** STOP. Do NOT proceed to §2.2–§2.4.

### Step 2.2 — Dashboard role migration
```bash
export WBS_DASHBOARD_PROD_ROLE_PASSWORD='<owner-chosen; never in repo or chat>'
psql -X -v ON_ERROR_STOP=1 -v production_branch_confirmed=on \
  -f sql/production/dashboard_role_production.sql
unset WBS_DASHBOARD_PROD_ROLE_PASSWORD
```
Expected: script's in-script read-only assertions PASS (prosecdef=true,
no PUBLIC EXECUTE, `trade_fair_dashboard` has EXECUTE+USAGE and no
table SELECT).
**FAIL action:** run the paired `dashboard_role_production_rollback.sql`
and STOP.

### Step 2.3 — CRM v1 migration
```bash
psql -X -v ON_ERROR_STOP=1 -v production_branch_confirmed=on \
  -f sql/production/dashboard_crm_v1_up.sql
```
This script itself creates the NOLOGIN role `trade_fair_ai_context`
with narrow EXECUTE on `trade_fair.ai_lead_context(jsonb)` and all CRM
tables/functions required by WF-08's Dashboard integration.
**FAIL action:** run `sql/production/dashboard_crm_v1_down.sql` and
STOP.

### Step 2.4 — Provision the LOGIN role for n8n AI context

The CRM migration (§2.3) created `trade_fair_ai_context NOLOGIN`.
n8n cannot log in with a NOLOGIN role, so Owner provisions a dedicated
LOGIN role and grants it membership. Convention name:
`trade_fair_ai_login` (Owner may choose a different LOGIN name as
long as it matches the n8n credential binding in §3.1).

```sql
-- Executed by neondb_owner on confirmed production branch.
BEGIN;
CREATE ROLE trade_fair_ai_login LOGIN
  PASSWORD :'TRADE_FAIR_AI_LOGIN_PASSWORD'
  CONNECTION LIMIT 20;
GRANT trade_fair_ai_context TO trade_fair_ai_login;
COMMIT;

-- Read-only post-conditions.
DO $$ BEGIN
  ASSERT (SELECT has_schema_privilege('trade_fair_ai_login','trade_fair','USAGE')),
    'USAGE on trade_fair missing (via trade_fair_ai_context membership)';
  ASSERT (SELECT NOT has_schema_privilege('trade_fair_ai_login','trade_fair','CREATE')),
    'CREATE must be denied';
  ASSERT (SELECT has_function_privilege(
    'trade_fair_ai_login',
    'trade_fair.ai_lead_context(jsonb)','EXECUTE')),
    'EXECUTE on ai_lead_context(jsonb) missing';
  ASSERT (SELECT NOT bool_or(has_table_privilege(
    'trade_fair_ai_login','trade_fair.'||table_name,'SELECT'))
    FROM information_schema.tables WHERE table_schema='trade_fair'),
    'Direct table SELECT must be denied for trade_fair_ai_login';
  ASSERT NOT (SELECT has_function_privilege(
    'trade_fair_ai_login',
    'trade_fair.crm_group_merge(jsonb,text,text,text)','EXECUTE')),
    'AI login must not have CRM mutate privileges';
END $$;
```

Expected: all assertions PASS.
**FAIL action:**
```sql
BEGIN;
REVOKE trade_fair_ai_context FROM trade_fair_ai_login;
DROP ROLE trade_fair_ai_login;
COMMIT;
```
and STOP.

## 3. n8n — WF-07 and WF-08

### Fixed facts
- **Workflow 7 webhook path:** `messe-hub/ai-extract`.
- **Workflow 8 webhook path:** `messe-hub/ai-ask`.
- Both webhooks are the only RC3 paths; neither collides with any
  existing production workflow (acceptance §2.2 catalog audit).
- WF-07 and WF-08 require three credential bindings:
  `httpHeaderAuth`, `openAiApi`, `postgres`.
- All `/rest/*` calls in this packet use `/rest/login` cookie session.
  The public API key `X-N8N-API-KEY` targets `/api/v1/*` and is NOT
  used by any step here.
- `integration/n8n-live-01/finalize.mjs` is **isolated-use only**. It
  reads `.runtime/state.json`, points at the isolated n8n origin, and
  PATCHes workflow `settings` to normalize retention. It MUST NOT be
  invoked as a production read-only verifier. Use
  `ops/n8n/verify_published_production.mjs` (§3.4).

### Step 3.1 — Credential inventory + mapping
Reused prod credential (no change):
- `tjqSy2V0odocljw6` — `WBS Trade Fair — Gateway Auth`
  (`httpHeaderAuth`). WF-07/08 bind to the SAME id.

Created for RC3 (Owner-executed; cred IDs recorded by n8n at create):
- NEW n8n credential `WBS Trade Fair — OpenAI RC3`, type **`openAiApi`**.
  API key value = same as existing `UUprjEp0Re6kPUFN` Bearer. Do NOT
  delete `UUprjEp0Re6kPUFN` (WF-B depends on it as a custom header
  auth).
- NEW n8n credential `WBS Trade Fair — AI context`, type **`postgres`**.
  Points at the production Neon host, database `neondb`, user
  `trade_fair_ai_login` (from §2.4), password = §2.4 value,
  SSL=`require`.

**Expected after create (session cookie from `/rest/login`):**
```bash
curl -sfS -b "$CJ" "$N8N_BASE_URL/rest/credentials" | \
  jq '.data[] | select(.name|test("WBS Trade Fair — (OpenAI RC3|AI context)"))'
```
Expected: both records with the right `type`.
**FAIL action:** `DELETE /rest/credentials/<id>` for any partial record
and STOP.

### Step 3.2 — Import WF-07 / WF-08 via `ops/n8n/import_wf_rc3.sh`

The script is **committed in this packet**. It reads canonical JSON
from the pinned path, rebinds credentials **in memory**, assigns a
`webhookId` if absent, POSTs `/rest/workflows` with `active:false`,
and prints the new workflow id to stdout.

Writes performed by this script (audited in-file):
- POST `/rest/login` (session cookie).
- POST `/rest/workflows` (create, active=false).

End-to-end validated against disposable n8n 2.41.7 in
`integration/n8n-live-01/evidence/rc33-operator-dryrun.txt` — including
proof that the committed canonical JSON files on disk were not modified.

```bash
export N8N_BASE_URL='http://127.0.0.1:5678'           # or the Owner-chosen prod base
export N8N_LOGIN_EMAIL='<owner-email>'
export N8N_LOGIN_PASSWORD='<owner-password>'
export HEADER_AUTH_CRED_ID='tjqSy2V0odocljw6'
export OPENAI_CRED_ID='<new-openai-rc3-id>'            # from §3.1
export PG_AI_CTX_CRED_ID='<new-ai-context-id>'         # from §3.1

TF_WF07_ID=$(ops/n8n/import_wf_rc3.sh workflows/wf-07-messe-hub-ai-extract.adapted.json)
TF_WF08_ID=$(ops/n8n/import_wf_rc3.sh workflows/wf-08-messe-hub-ai-ask.adapted.json)
```

Expected: two new workflow ids echoed to stdout; each
`GET /rest/workflows/<id>` returns `active:false`.
**FAIL action:** `DELETE /rest/workflows/<id>` for any created record,
STOP.

### Step 3.3 — Activate WF-07 / WF-08 via `ops/n8n/activate_wf.sh`

Writes performed:
- POST `/rest/login`.
- POST `/rest/workflows/<id>/activate` with the current `versionId`.

Refuses to activate a workflow that is already active (guard against
accidental re-run).

```bash
WORKFLOW_ID="$TF_WF07_ID" ops/n8n/activate_wf.sh
WORKFLOW_ID="$TF_WF08_ID" ops/n8n/activate_wf.sh
```

Expected: each run prints JSON with `active=true` and
`versionId==activeVersionId`.
Additionally:
```bash
curl -o /dev/null -w '%{http_code}\n' -X POST \
  http://127.0.0.1:3000/webhook/messe-hub/ai-extract \
  -H 'Content-Type: application/json' -d '{}'
# Expected: 403 (unauth; the webhook routes exist and are gated)
curl -o /dev/null -w '%{http_code}\n' -X POST \
  http://127.0.0.1:3000/webhook/messe-hub/ai-ask \
  -H 'Content-Type: application/json' -d '{}'
# Expected: 403
```

Note: Gateway `/api/dashboard/ai/{extract,ask}` only forwards to these
webhooks once Gateway is swapped to the RC3-aware image (§4). Until §4,
only the raw n8n webhook paths above are reachable (and only on
`127.0.0.1` or over the swapped Gateway proxy).

**FAIL action:** `POST /rest/workflows/<id>/deactivate` + `DELETE
/rest/workflows/<id>`, STOP.

### Step 3.4 — RC3.3 published-provenance verification against live prod

Use the production-safe verifier (committed in this packet):

```bash
export N8N_BASE_URL='http://127.0.0.1:5678'            # or Owner-chosen prod base
export N8N_LOGIN_EMAIL='<owner-email>'
export N8N_LOGIN_PASSWORD='<owner-password>'
export WF07_ID="$TF_WF07_ID"
export WF08_ID="$TF_WF08_ID"

node ops/n8n/verify_published_production.mjs \
  | tee /opt/wbs-trade-fair/secrets/backups/${TF_ROLLOUT_TS}/verify-published.json
```

Expected: process exits **0**. Both workflows report `verdict: "PASS"`
with `publishedVersionId==activeVersionId`. The script issues exactly
one write (POST `/rest/login`) and no PATCH / no activation / no
deactivation / no DELETE. The script performs retry with exponential
backoff on `/rest/login` HTTP 429 (n8n 2.41.7 throttle), confirmed
during disposable-instance validation.

**FAIL action:** immediately deactivate both workflows:
```bash
curl -sfS -b "$CJ" -X POST "$N8N_BASE_URL/rest/workflows/$TF_WF07_ID/deactivate"
curl -sfS -b "$CJ" -X POST "$N8N_BASE_URL/rest/workflows/$TF_WF08_ID/deactivate"
```
inspect the printed diff, and STOP.

### Step 3.5 — Execution retention and timeout settings
These settings MUST be present on both workflows AT ACTIVATION TIME:
```
executionOrder:              v1
saveDataErrorExecution:      none
saveDataSuccessExecution:    none
saveManualExecutions:        false
saveExecutionProgress:       false
executionTimeout:            30
```

**Important:** `verify_published_production.mjs` only REPORTS retention
warnings — it does not patch anything. Owner must ensure the canonical
JSON import includes these settings before activation. If the import
response shows different values, Owner-side PATCH is required BEFORE
step 3.3:
```bash
curl -sfS -b "$CJ" -X PATCH \
  "$N8N_BASE_URL/rest/workflows/$TF_WF07_ID" \
  -H 'Content-Type: application/json' \
  --data-binary "$(jq -n --arg v "$versionId" '{versionId:$v, settings:{executionOrder:"v1", saveDataErrorExecution:"none", saveDataSuccessExecution:"none", saveManualExecutions:false, saveExecutionProgress:false, executionTimeout:30}}')"
```
Re-GET and confirm. Then proceed to step 3.3.

Expected post-activation: `verify_published_production.mjs` reports no
`WARN — … retention not fully silenced …` lines.
**FAIL action:** repeat the retention PATCH above, re-verify.

## 4. Gateway + HTTPS

### Step 4.1 — Build the production Gateway image
```bash
docker build -f Dockerfile.dashboard-staging \
  -t wbs-trade-fair-gateway:rc33-${TF_ROLLOUT_TS} .
docker inspect wbs-trade-fair-gateway:rc33-${TF_ROLLOUT_TS} \
  --format '{{.Config.User}} {{.Config.Cmd}}'
docker create --name probe-rc33 \
  wbs-trade-fair-gateway:rc33-${TF_ROLLOUT_TS}
docker inspect probe-rc33 --format '{{len .Mounts}} {{len .HostConfig.Binds}}'
docker rm probe-rc33
```
Expected: `User=node`, `Cmd=[node server.mjs]`;
`len .Mounts = 0` and `len .HostConfig.Binds = 0`.
**FAIL action:** STOP; Dockerfile drifted or build context leaked.

### Step 4.2 — Gateway environment (real contract from `gateway/server.mjs`)

Owner-maintained private env file
(`/opt/wbs-trade-fair/secrets/gateway.rc33.env`, mode 0600 root):

```
# Baseline (unchanged from current prod)
PORT=3000
HOST=127.0.0.1
APP_ORIGIN=https://messe.klare-ki.de
TRADE_FAIR_ACCESS_KEY=<≥16 chars; existing>
SESSION_SECRET=<≥32 chars; existing>
N8N_HEADER_KEY=<same value as cred tjqSy2V0odocljw6>
N8N_CAPTURE_URL=https://messe.klare-ki.de/webhook/trade-fair/lead
N8N_STATUS_URL=https://messe.klare-ki.de/webhook/trade-fair/status
PUBLIC_FORM_ENABLED=true

# Dashboard (unchanged if already enabled)
DASHBOARD_ENABLED=true
DASHBOARD_DATABASE_URL=postgresql://trade_fair_dashboard:<pwd>@<neon-host>/neondb?sslmode=require
DASHBOARD_ACCESS_KEY=<≥16 chars; distinct from TRADE_FAIR_ACCESS_KEY>
MESSE_CRM_ENABLED=true

# RC3 (new — enable AI proxy routes /api/dashboard/ai/extract and /ai/ask)
N8N_AI_EXTRACT_URL=https://messe.klare-ki.de/webhook/messe-hub/ai-extract
N8N_AI_ASK_URL=https://messe.klare-ki.de/webhook/messe-hub/ai-ask
# Optional: narrows the allowed trusted upstream origin. If omitted,
# the Gateway derives it from N8N_CAPTURE_URL's origin. BOTH ai URLs
# MUST share this origin (gateway/server.mjs:92). HTTPS required
# outside loopback (gateway/server.mjs:95).
# N8N_AI_ALLOWED_ORIGIN=https://messe.klare-ki.de
```

Expected: file mode 0600 root:root; `node -e 'import("./gateway/server.mjs").then(m => m.loadConfig(JSON.parse(fs.readFileSync("/path/to/env.parsed.json"))))'` on a parsed copy returns a valid config object without throwing.
**FAIL action:** fix the specific config error reported by `loadConfig`,
re-check.

### Step 4.3 — F3B R3 §6 "Reversible swap"
Documented in `docs/WBS_TF_06_F3B_PREP.md` §6. Summary:
1. Capture baseline:
   `docker inspect wbs-trade-fair-gateway` →
   `/opt/wbs-trade-fair/secrets/backups/${TF_ROLLOUT_TS}/inspect.json`.
2. Rename current container to
   `wbs-trade-fair-gateway.saved-${TF_ROLLOUT_TS}` (do NOT stop first;
   `docker rename` is atomic).
3. `docker run -d --name wbs-trade-fair-gateway.candidate ...`
   with `--env-file /opt/wbs-trade-fair/secrets/gateway.rc33.env`,
   `--restart unless-stopped`, image from §4.1.
4. `curl -fsS http://127.0.0.1:3000/healthz` → 200 OK on candidate.
5. If healthy, rename candidate to `wbs-trade-fair-gateway`.

Expected: new container Up, healthz=200; `docker ps` shows one
`wbs-trade-fair-gateway` running and at least one
`.saved-${TF_ROLLOUT_TS}` in `Exited (0)`.
**FAIL action:** rename `.saved-${TF_ROLLOUT_TS}` back to
`wbs-trade-fair-gateway`, `docker start wbs-trade-fair-gateway`,
STOP.

### Step 4.4 — nginx vhost staging
Three static-verified vhosts (sha256 in §0), installed in order:
1. `ops/nginx/messe.klare-ki.de.bootstrap.conf` — HTTP-only, for ACME
   HTTP-01 challenge.
2. `certbot --nginx -d messe.klare-ki.de --redirect --agree-tos
    -m <owner-email> --no-eff-email` to obtain TLS.
3. `ops/nginx/messe.klare-ki.de.https-holding.conf` — HTTPS 503 holding
   page while Gateway swap settles.
4. `ops/nginx/messe.klare-ki.de.conf` — final reverse proxy to Gateway,
   staged HSTS.

Each swap: `cp` into `/etc/nginx/sites-enabled/`, `nginx -t`, then
`nginx -s reload`.
Expected: `nginx -t` PASS before each reload; local verification
PASSED today via `ops/nginx/check_vhosts.sh`.
**FAIL action:** keep previous conf; STOP.

### Step 4.5 — Loopback and external HTTPS acceptance
```bash
# Loopback: raw webhook (expects 403 without auth header)
curl -o /dev/null -w '%{http_code}\n' -X POST \
  http://127.0.0.1:3000/webhook/messe-hub/ai-extract \
  -H 'Content-Type: application/json' -d '{}'
curl -o /dev/null -w '%{http_code}\n' -X POST \
  http://127.0.0.1:3000/webhook/messe-hub/ai-ask \
  -H 'Content-Type: application/json' -d '{}'
# Loopback: Gateway healthz
curl -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/healthz
# External HTTPS
curl -o /dev/null -w '%{http_code}\n' https://messe.klare-ki.de/healthz
# External HTTPS: Dashboard AI proxy routes (expects session rejection
# without an authenticated Dashboard cookie, NOT 404 or 500)
curl -o /dev/null -w '%{http_code}\n' -X POST \
  https://messe.klare-ki.de/api/dashboard/ai/extract \
  -H 'Content-Type: application/json' -d '{}'
curl -o /dev/null -w '%{http_code}\n' -X POST \
  https://messe.klare-ki.de/api/dashboard/ai/ask \
  -H 'Content-Type: application/json' -d '{}'
```
Expected: all `curl -o /dev/null -w '%{http_code}\n'` return non-5xx;
unauth webhook returns 403; unauth Dashboard AI proxy returns 401 or
403 depending on origin/cookie checks; `/healthz` returns 200.
**FAIL action:** rollback §4.3 + §4.4, STOP.

## 5. Backup and restore

### Step 5.1 — Backup immediately before migration

Two artefacts (correcting Codex finding #7). Owner-side, from a
non-shared workstation, production Neon credentials provided through
the environment (never written to repo or chat).

```bash
mkdir -p /opt/wbs-trade-fair/secrets/backups/${TF_ROLLOUT_TS}
BK=/opt/wbs-trade-fair/secrets/backups/${TF_ROLLOUT_TS}

# a) Data + schema (no roles/ACL embedded; roles are rebuilt from committed SQL)
pg_dump -h <prod-neon-host> -U neondb_owner -d neondb \
  --schema=trade_fair --no-owner --no-privileges \
  > "$BK/pre-rc33-trade_fair.sql"

# b) Role definitions and grants (so recovery is complete without replaying
# committed migrations). Neon permits pg_dumpall --roles-only via neondb_owner.
pg_dumpall -h <prod-neon-host> -U neondb_owner --roles-only \
  --no-role-passwords \
  > "$BK/pre-rc33-roles.sql"

chmod 0600 "$BK"/*.sql
for f in "$BK"/*.sql; do sha256sum "$f" >> "$BK/pre-rc33.sha256"; done
```

Expected: both files written; `pre-rc33-trade_fair.sql` > 10 KB (sanity
minimum); `pre-rc33-roles.sql` contains `CREATE ROLE trade_fair_dashboard`
and `CREATE ROLE trade_fair_ai_context` (plus the LOGIN role if §2.4
has run). Note: `--no-role-passwords` is intentional so the dump does
not carry secret material; passwords must be reset after restore.

**FAIL action:** STOP; migration must have a complete recoverable
baseline before any schema change.

### Step 5.2 — Restore into a disposable target and verify

```bash
TARGET=wbs-rc33-restore-$(date +%s)
docker run -d --rm --name $TARGET \
  -e POSTGRES_USER=neondb_owner \
  -e POSTGRES_PASSWORD=restore-only \
  -e POSTGRES_DB=neondb \
  -p 127.0.0.1:0:5432 postgres:16-alpine
sleep 10
docker exec -i $TARGET psql -X -U neondb_owner -d neondb < "$BK/pre-rc33-roles.sql"
docker exec -i $TARGET psql -X -U neondb_owner -d neondb < "$BK/pre-rc33-trade_fair.sql"

# Verify roles were materialised + schema loaded + data counts match prod observation.
docker exec $TARGET psql -X -U neondb_owner -d neondb -c "
  SELECT rolname FROM pg_roles
    WHERE rolname IN ('trade_fair_dashboard','trade_fair_ai_context');
  SELECT
    (SELECT count(*) FROM trade_fair.companies) AS companies,
    (SELECT count(*) FROM trade_fair.contacts) AS contacts,
    (SELECT count(*) FROM trade_fair.lead_submissions) AS submissions;
  SELECT has_function_privilege('trade_fair_ai_context',
    'trade_fair.ai_lead_context(jsonb)','EXECUTE') AS ai_can_exec;
"
```

Expected:
- Both roles present on target.
- Counts match the production observation Owner captured just before
  the dump.
- `ai_can_exec = t` (role ACL preserved by the `--roles-only` dump).

**FAIL action:** STOP; dump is not completely restorable.

Reference: the committed synthetic drill in
`integration/n8n-live-01/_rc33_backup_restore_drill.mjs` proves the
dump/restore round-trip is byte-stable **for schema and data**, and
that ACLs are preserved WHEN they are also dumped. The drill itself
uses `--no-owner --no-privileges` and re-applies the ACL manually — it
does not establish real-Neon role recovery and is retained strictly as
procedure confirmation.

### Step 5.3 — Rollback plan if RC3 breaks WF-A..D

WF-A..D never touch the new RC3 role or the new RC3 workflows.
Plausible mechanisms by which an RC3 step could affect WF-A..D:
- SQL migration applied to the wrong Neon branch → see Owner Gate 2.1.
- Gateway image regression affecting `/webhook/trade-fair/lead` or
  `/webhook/trade-fair/status` → §4.3 reverse swap, ≤ 30 s.
- Shared credential rotated by mistake → NOT in this packet.

If a regression is detected post-cutover:
1. Deactivate WF-07/08 (§6.3 rollback 1). Does not affect WF-A..D.
2. If regression persists, swap Gateway back (§6.3 rollback 2).
3. If regression traces to SQL, run the matching rollback script
   (§6.3 rollback 3).
4. If data loss is suspected, restore from §5.1 to the production
   branch — requires a separate Owner GO (destructive).

## 6. End-to-end smoke tests + canary monitoring

### Step 6.1 — Post-cutover bounded-budget real-OpenAI smoke test

**New under P-DEPLOY-02:** this packet does not use historical
real-OpenAI evidence from `6b64f70d…` as current acceptance. The §G6
checklist entry below is the first bounded-budget real-OpenAI
exercise of the exact RC3.3 canonical workflows against prod.

OpenAI monthly spend cap confirmed before run.
Daily budget cap: **≤ $5** for the first 7 days.
Per-request body token cap: ≤ 2500 input + ≤ 500 output.

Smoke calls via the Gateway Dashboard AI proxy routes, with a fresh
Dashboard session cookie obtained through the normal
`POST /api/login` flow (NOT raw webhook paths):

```bash
# Session cookie (requires DASHBOARD_ACCESS_KEY, not committed)
curl -c "$DASH_CJ" -b "$DASH_CJ" -X POST \
  https://messe.klare-ki.de/api/login \
  -H 'Content-Type: application/json' \
  -d "{\"access_key\":\"$DASHBOARD_ACCESS_KEY\"}" \
  -o /dev/null -w '%{http_code}\n'
# Expected: 200

# AI extract
curl -b "$DASH_CJ" -X POST \
  https://messe.klare-ki.de/api/dashboard/ai/extract \
  -H 'Content-Type: application/json' \
  --data '{"notes":"Alice von RC33 Synthetic GmbH, Score 85, warm", "session_id":"rc33-smoke-1"}' \
  -o "$BK/smoke-extract.json" -w '%{http_code}\n'
# Expected: 200 + response contains {"success":true, ...}

# AI ask (synthetic lead_id must be a lead created in the smoke session
# via the capture path; this validates WF-08 grounded answering).
curl -b "$DASH_CJ" -X POST \
  https://messe.klare-ki.de/api/dashboard/ai/ask \
  -H 'Content-Type: application/json' \
  --data '{"question":"Welcher Score und Budget?","context_lead_ids":["FAIR-…"], "session_id":"rc33-smoke-1"}' \
  -o "$BK/smoke-ask.json" -w '%{http_code}\n'
# Expected: 200; cites only the requested lead; no PII pattern
#   /Mila|Integrationswerk|private.*synthetic/i.
```

PASS criteria:
- All three calls return 200.
- WF-08 answer cites exactly the requested lead_id.
- No PII pattern in WF-08 answer.
- OpenAI token usage per call within the per-request cap.

**FAIL action:** execute Rollback 1 (§6.3) and STOP.

### Step 6.2 — Canary windows
| Window | Monitor | Threshold | Trigger |
|---|---|---|---|
| T+15m | Gateway + n8n journals; one WF-07 + one WF-08 call | 0 errors | any 5xx |
| T+1h  | 5xx on messe.klare-ki.de; OpenAI tokens/min | 5xx ≤ 2% / 5 min | 5xx > 2% for 5 min |
| T+24h | OpenAI daily spend; execution-audit anomalies | ≤ $5/day | > $10/day or any `PUBLISHED_PROVENANCE_FAILED` |
| T+7d  | Standard thresholds; forced-ungrounded WF-08 test | refusal observed under forced-ungrounded | WF-08 refusal rate = 0 for ≥ 1 h with ≥ 10 real calls |

Save each window's evidence under
`/opt/wbs-trade-fair/secrets/backups/${TF_ROLLOUT_TS}/canary-{T15m,T1h,T24h,T7d}.json`.

### Step 6.3 — Rollback commands (ready to copy-paste)

**Rollback 1 — Deactivate WF-07/08** (fastest, ~1 s). Uses `/rest/*`
cookie session from `/rest/login`.
```bash
# Open session; the operator shell scripts already do this internally.
curl -sfS -c "$CJ" -X POST "$N8N_BASE_URL/rest/login" \
  -H 'Content-Type: application/json' \
  -d "{\"emailOrLdapLoginId\":\"$N8N_LOGIN_EMAIL\",\"password\":\"$N8N_LOGIN_PASSWORD\"}" \
  -o /dev/null
curl -sfS -b "$CJ" -X POST "$N8N_BASE_URL/rest/workflows/$TF_WF07_ID/deactivate"
curl -sfS -b "$CJ" -X POST "$N8N_BASE_URL/rest/workflows/$TF_WF08_ID/deactivate"
```
Effect: Dashboard "Lead-Assistent" immediately fails closed with the
existing UI message. WF-A..D UNAFFECTED.

**Rollback 2 — Gateway swap back** (≤ 30 s).
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

**Rollback 4 — Drop RC3 login role + credentials.**
```sql
BEGIN;
REVOKE trade_fair_ai_context FROM trade_fair_ai_login;
DROP ROLE trade_fair_ai_login;
COMMIT;
```
```bash
curl -sfS -b "$CJ" -X DELETE "$N8N_BASE_URL/rest/credentials/<new-openai-rc3-id>"
curl -sfS -b "$CJ" -X DELETE "$N8N_BASE_URL/rest/credentials/<new-ai-context-id>"
```

### Rollback TRIGGERS (any one → Rollback 1 immediately)
1. `PUBLISHED_PROVENANCE_FAILED` on `verify_published_production.mjs`
   re-run.
2. 5xx rate on `messe.klare-ki.de` > 2% over 5 min.
3. WF-08 answer contains PII pattern
   `/Mila|Integrationswerk|private.*synthetic/i`.
4. OpenAI daily spend > $10 OR OpenAI 429 streak > 10 in 10 min.
5. Owner discretion.

## 7. Explicit NON-execution items

- Any change to WF-A/B/C/D in production n8n.
- Any rotation of a shared credential
  (`DIm6w5CcndY0D3RJ`, `UUprjEp0Re6kPUFN`, `tjqSy2V0odocljw6`,
  `HvE5Js2qo8BxvrSs`, `A4Xm6WZ9d6SsMkfs`).
- Deployment of the Dashboard Yuri UI rework
  (`feature/dashboard-yuri-ui`).
- Any watchtower or Docker image policy change.
- Any production data mutation outside the Owner-approved SQL
  migrations above.
- Any secret value in logs, chat, or Git history.
- Any invocation of `integration/n8n-live-01/finalize.mjs` against
  production n8n (isolated-only; it PATCHes workflow `settings`).
- Merge of PR #27 or of `prep/wbs-tf-p-deploy-01`.

## 8. Owner GO sequence (overview)

See `docs/WBS_TF_OWNER_GO_CHECKLIST.md` for the detailed initial-by-line
checklist. Ordered gates:

G1. (Already met) Codex RC3.3 CODE READY on `3421a5d`.
G2. Owner Gate 2.1 (Neon branch identity) CONFIRMED.
G3. Owner GO for §2 (migrations + CRM role + LOGIN role).
G4. Owner GO for §3 (credentials + import + activate + verify).
G5. Owner GO for §4 (Gateway image + swap + nginx + HTTPS).
G6. Owner GO for §6.1 (bounded-budget real-OpenAI smoke test).
G7. Owner GO at each canary promotion.

## 9. Operator-script dry-run evidence

Validated against disposable n8n 2.41.7 (fresh container, synthetic
credentials); evidence file
`integration/n8n-live-01/evidence/rc33-operator-dryrun.txt`:

```
PASS — import_wf_rc3.sh WF-07 → <id> (active:false)
PASS — import_wf_rc3.sh WF-08 → <id> (active:false)
PASS — committed canonical JSON files unchanged on disk after import
PASS — activate_wf.sh WF-07 → {"active":true, versionId==activeVersionId}
PASS — activate_wf.sh WF-08 → {"active":true, versionId==activeVersionId}
PASS — verify_published_production.mjs PASS for both workflows against disposable n8n
PASS — verify_published_production.mjs REJECTED mutated WF-08 (exit=1), diff cites disabled

RC3.3 operator script dry-run: ALL CHECKS PASS
```
