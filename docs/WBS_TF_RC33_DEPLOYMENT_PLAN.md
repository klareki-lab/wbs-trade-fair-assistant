# WBS Trade Fair Assistant — RC3.3 Deployment Plan

> **⚠ SUPERSEDED by `docs/WBS_TF_PRODUCTION_EXECUTION_PACKET.md`
> (P-DEPLOY-02).** This earlier document contains deployment-oriented
> inaccuracies that Codex flagged in the RC3.3 final review
> (https://github.com/klareki-lab/wbs-trade-fair-assistant/pull/27#issuecomment-6426321107):
> absent operator shell scripts; invented finalizer CLI flags; wrong
> `ai_lead_context` signature (`uuid[], text[]` instead of `jsonb`);
> wrong AI context role name (`wbs_tf_ai_context` instead of
> `trade_fair_ai_context` + Owner-provisioned LOGIN role); invalid
> Gateway env name (`GATEWAY_ALLOW_UPSTREAM_WEBHOOKS` instead of
> `N8N_AI_EXTRACT_URL` / `N8N_AI_ASK_URL`). Read-only historical
> record only. Do not use for execution. The authoritative packet is
> P-DEPLOY-02.

**Scope:** prepared, **not executed.** Nothing below has been run against
production. Every step requires explicit Owner GO at execution time.

**Candidate SHA:** `3421a5d2bb842461c2c12c0f565f53249eeeee05`
**Branch:** `fix/wbs-tf-rc3-1-astra` (PR #27)
**Baseline on production:** pre-RC3 WF-A/B/C/D (ids
`d5uO1lnwjOirJ5Xf / dr05aJRh8Lu6VpSA / bRkCsVxZXU85yqLI / THulrTbNEZ2FrgJ3`),
all active, versionId==activeVersionId, no RC3 nodes present.

This document is additive to the WBS-TF-06 F3B R3 packet and the
WBS-TF-07 production preflight. Those remain the authoritative sources
for Gateway/nginx/TLS and the Dashboard role migration. This plan only
layers the RC3 workflow (WF-07/08) and RC3.3 verifier bits on top.

## 1. What RC3.3 actually ships to production

Code-only. In production this expands to **two new n8n workflows** plus
the finalizer verifier used during their activation; it does **not**
modify WF-A–D, Gateway code, SQL migrations, nginx, TLS, or shared
credentials.

| Artifact | Source | Purpose |
|---|---|---|
| `workflows/wf-07-messe-hub-ai-extract.adapted.json` | repo canonical | AI extraction workflow (OpenAI structured) |
| `workflows/wf-08-messe-hub-ai-ask.adapted.json` | repo canonical | AI ask workflow (grounded, 20-claim cap, warning on incomplete coverage) |
| `integration/n8n-live-01/verify-published.mjs` | repo | finalizer verifier — compares published executable fingerprint vs canonical |
| `integration/n8n-live-01/finalize.mjs` | repo | finalizer entry point for isolated activation |

No gateway or UI changes are required for WF-07/08 to be reachable from
the existing Trade Fair Dashboard — the Dashboard "Lead-Assistent"
feature already targets these webhooks and currently fails closed when
the webhooks are absent.

## 2. Migrations (if required)

| Area | Required for RC3.3? | Source |
|---|---|---|
| Dashboard role + `dashboard_snapshot` function on Neon | **Yes if not already applied** | `sql/production/dashboard_role_production.sql` (reviewed under WBS-TF-07 §4) |
| trade_fair CRM v1 (`sql/production/dashboard_crm_v1_up.sql`) | **Yes if not already applied** | `sql/production/dashboard_crm_v1_up.sql` (guarded by `-v production_branch_confirmed=on`) |
| Any new schema for WF-07/08 | **No** | WF-07/08 use the existing scoped AI-context role and read-only `ai_lead_context()` function |

Both scripts refuse to run without `-v production_branch_confirmed=on`
and are transactionally reversible via the paired `*_rollback.sql`.

**Execution preconditions (owner-verified before `psql -f`):**
```sql
SELECT current_database(), current_user, inet_server_addr();
SELECT setting FROM pg_settings WHERE name='neon.timeline_id';
SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname='trade_fair';
```
Must return `neondb_owner`, `neondb`, schema owner `neondb_owner`, and a
timeline that is **not** the staging timeline
`a171e976ae189ef43d7ca803d826354e`.

## 3. Credential binding plan

Production n8n already carries these credentials (verified in Phase A
read-only audit):

| ID | Name | Type | Used by |
|---|---|---|---|
| `UUprjEp0Re6kPUFN` | WBS Trade Fair — OpenAI  19.10 | custom Bearer (httpRequest) | WF-B |
| `tjqSy2V0odocljw6` | WBS Trade Fair — Gateway Auth | httpHeaderAuth | WF-A, WF-D |
| `DIm6w5CcndY0D3RJ` | WBS Trade Fair — Neon PostgreSQL | postgres | WF-A, WF-B, WF-C, WF-D |

RC3 WF-07/08 require three bindings:
- `httpHeaderAuth` → **reuse** `tjqSy2V0odocljw6` (Gateway Auth).
- `openAiApi` (native n8n OpenAI node) → **new credential record required.**
  WF-B's existing OpenAI secret is bound as the custom Bearer-only
  `httpRequest` variant, not the `openAiApi` type. Create a new
  credential of type `openAiApi` using the SAME API key value. Store
  under name `WBS Trade Fair — OpenAI RC3`. Do not delete the existing
  Bearer binding — WF-B depends on it.
- `postgres` (scoped AI context role) → **new credential record required.**
  Owner provisions a dedicated login role `wbs_tf_ai_context` (schema
  USAGE only, EXECUTE on `trade_fair.ai_lead_context(uuid[], text[])`
  only, no table SELECT). Create credential `WBS Trade Fair — AI context`
  pointing at that role.

Rotation policy: these two new credentials rotate on the existing
WBS Trade Fair quarterly rotation calendar.

**Spending-limit check (before activation):** confirm the OpenAI
organization's monthly spend cap. The staging E2E observed less than
$0.02 across the 11-check gateway-e2e sweep; a budget-bounded canary
window of **≤ $5/day for the first 7 days** is proposed.

## 4. Workflow import, publication, and verification

Executed on the **existing production n8n container** (`n8n-n8n-1`),
not a new instance. No restart of the n8n container is required.

```bash
# Step 4.1 — pre-check: WF-07/08 must not already exist on production.
curl -sfH "X-N8N-API-KEY: ${N8N_API_KEY}" \
  https://127.0.0.1:5678/rest/workflows | \
  jq -r '.data[] | select(.name|test("WF-07|WF-08|messe-hub-ai"))'
# Expect: empty.

# Step 4.2 — import canonical workflows (REST POST).
#   Both files are rebound in-memory with the production credential IDs
#   (section 3) before POST. Do NOT edit the committed JSON on disk.
./ops/n8n/import_wf07_wf08.sh    # prepared script, writes temp JSON only

# Step 4.3 — activate (REST POST /workflows/<id>/activate), confirm
# active=true and versionId==activeVersionId.
./ops/n8n/activate_wf07_wf08.sh

# Step 4.4 — Finalizer verifier (RC3.3 verify-published.mjs).
#   Fetches the published snapshot via workflow-history REST, compares
#   full executable fingerprint vs committed canonical. Fails closed on
#   ANY divergence or missing published-snapshot endpoint.
STAGING_KEY_FILE=/opt/wbs-trade-fair/secrets/live01.env \
  node integration/n8n-live-01/finalize.mjs \
  --workflow-ids=<new-wf07-id>,<new-wf08-id> \
  --mode=production-verify-only

# Step 4.5 — register webhook paths in the Gateway allowlist, if the
# production Gateway image was built with a RC3-aware allowlist.
# NOTE: current prod Gateway image sha256:9f34e8b4fd54 predates WF-07/08.
# A Gateway image rebuild + swap (F3B §6 "Reversible swap") IS required
# before the webhooks will actually be reachable from the Dashboard.
```

**Blocker to flag at Owner GO time:** Gateway image rebuild. The
production Gateway container is `wbs-trade-fair-gateway` (image
`9f34e8b4fd54`, up 33 hours as of audit). It does not know about the
`/webhook/messe-hub/ai-extract` and `/webhook/messe-hub/ai-ask` paths.
The RC3.3 PR scope is intentionally code-only, so this plan surfaces
the Gateway swap step but does not execute it.

## 5. Gateway / nginx deployment procedure

Already prepared under WBS-TF-07 §5 (immutable image via
`Dockerfile.dashboard-staging`) and F3B R3 §6 ("Reversible swap"). RC3.3
layers a single additional allowlist entry on the Gateway's upstream
webhook list.

```
GATEWAY_ALLOW_UPSTREAM_WEBHOOKS=\
  /webhook/trade-fair/lead,\
  /webhook/trade-fair/status,\
  /webhook/messe-hub/ai-extract,\
  /webhook/messe-hub/ai-ask
```

The nginx vhost (`ops/nginx/messe.klare-ki.de.conf`) requires no edit —
it proxies `location /` to the Gateway, which handles path routing.

## 6. Resource and performance thresholds

Based on isolated E2E evidence (`gateway-e2e.json`, 11 PASS; disposable
PG16+n8n 2.41.7 identical to prod image). All values are per-request
budgets, enforced at the Gateway and in n8n workflow timeouts.

| Metric | Threshold | Enforcement |
|---|---|---|
| Gateway request timeout (user → WF-A) | 10 s | Gateway `fetch` AbortController |
| WF-A webhook timeout | 20 s | n8n `executionTimeout: 30` on workflow |
| WF-07 (AI extract) end-to-end | 30 s | n8n `executionTimeout: 30` |
| WF-08 (AI ask) end-to-end | 15 s | n8n `executionTimeout: 30`, OpenAI timeout 10 s |
| OpenAI tokens per WF-08 call | ≤ 2500 input + 500 output | request body cap |
| Dashboard snapshot query | ≤ 1 s typ, 5 s hard | `statement_timeout = 5000` on `trade_fair_dashboard` role |
| PostgreSQL pool (Gateway) | max 8 connections | pg.Pool.max |

Alert thresholds (watchtower / existing journal_read):
- Gateway container restart count > 1/hour → investigate
- WF-A webhook 5xx rate > 2% over 5 min → canary rollback
- WF-08 OpenAI 429 count > 10/hour → canary rollback
- Any PUBLISHED_PROVENANCE_FAILED on finalizer re-run → freeze; hard stop

## 7. Canary procedure

Both WF-07 and WF-08 are activated to the full prod traffic set (there
is no partial-traffic routing in n8n webhooks). Canary is therefore
**time-based** rather than traffic-slice-based.

| Window | Start | End | Owner action |
|---|---|---|---|
| T0 — final verifier re-run on live n8n | immediately before activation | 15 min after | tail Gateway + n8n journals |
| T+15m — first lead | ≤ 15 min post-activation | | manual synthetic Dashboard "Lead-Assistent" call with synthetic lead; confirm answer cites expected IDs; verify no PII in LLM input |
| T+1h — observation | T+15m | T+1h | monitor latency, OpenAI token budget vs limit, error rate |
| T+24h — soak | T+1h | T+24h | daily spend ≤ $5; zero PUBLISHED_PROVENANCE_FAILED |
| T+7d — stabilize | T+24h | T+7d | relax budget cap; promote to standard monitoring |

**Automatic rollback triggers:**
- Any PUBLISHED_PROVENANCE_FAILED on scheduled verifier re-run.
- Gateway 5xx rate > 2% for 5 min.
- WF-08 "ungrounded" refusal rate drops to 0 for ≥ 1 h with ≥ 10 calls
  (indicator the grounding gate is silently bypassed).
- OpenAI daily spend > $10.

## 8. Rollback commands and triggers

Rollback is per-layer and non-destructive. **Each layer rolls back
independently.** All commands are copy-paste ready for the Owner
operator; none should be run speculatively.

### 8.1 — Deactivate WF-07/08 (fastest, non-destructive)
```bash
# Takes 1-2 s. Dashboard "Lead-Assistent" immediately returns the
# existing fail-closed message. WF-A/B/C/D are UNAFFECTED.
curl -sf -XPOST -H "X-N8N-API-KEY: ${N8N_API_KEY}" \
  https://127.0.0.1:5678/rest/workflows/<new-wf07-id>/deactivate
curl -sf -XPOST -H "X-N8N-API-KEY: ${N8N_API_KEY}" \
  https://127.0.0.1:5678/rest/workflows/<new-wf08-id>/deactivate
```

### 8.2 — Delete WF-07/08 entirely
```bash
# After deactivation. Permanent. Preserves executions audit.
curl -sf -XDELETE -H "X-N8N-API-KEY: ${N8N_API_KEY}" \
  https://127.0.0.1:5678/rest/workflows/<new-wf07-id>
curl -sf -XDELETE -H "X-N8N-API-KEY: ${N8N_API_KEY}" \
  https://127.0.0.1:5678/rest/workflows/<new-wf08-id>
```

### 8.3 — Gateway image rollback (F3B R3 §9 three-layer)
Uses `TF_ROLLOUT_TS` captured in §6 "Baseline capture". Previous
Gateway container is renamed `.saved-${TF_ROLLOUT_TS}` and can be
started with `docker start`. Already proven on
`wbs-trade-fair-gateway.saved-20261025T084342Z` and
`.saved-20261025T075219Z` (both Exited (0), ready to restart).

### 8.4 — Credential removal
```bash
# Only after both workflows are deactivated and deleted.
curl -sf -XDELETE -H "X-N8N-API-KEY: ${N8N_API_KEY}" \
  https://127.0.0.1:5678/rest/credentials/<new-openai-rc3-id>
curl -sf -XDELETE -H "X-N8N-API-KEY: ${N8N_API_KEY}" \
  https://127.0.0.1:5678/rest/credentials/<new-ai-context-id>
```
The `wbs_tf_ai_context` role can remain on Neon (idle, no permissions
granted elsewhere) or be dropped via a short Owner SQL.

### 8.5 — SQL migration rollback (if applied)
```bash
psql -X -v ON_ERROR_STOP=1 -v production_branch_confirmed=on \
  -f sql/production/dashboard_role_production_rollback.sql
```
Reviewed under WBS-TF-07 §4. Reverses role, function, and grants in one
transaction; refuses to run without the guard variable.

### 8.6 — Rollback TRIGGERS
Any one of these is sufficient grounds to execute 8.1 immediately:
1. PUBLISHED_PROVENANCE_FAILED on finalizer re-run.
2. 5xx rate on `messe.klare-ki.de` > 2% over 5 min.
3. WF-08 answers in prod contain plaintext PII patterns matching
   `/Mila|Integrationswerk|private.*synthetic/i` (grounding
   gate failure canary).
4. OpenAI daily spend > $10, or any OpenAI 429 streak > 10 within 10 min.
5. Owner discretion.

## 9. Final production change checklist (Owner-signed)

Nothing below is self-approving. Each line requires Owner initial +
timestamp before the subsequent line may run.

- [ ] WBS-TF-07 §1 "Freeze — exact release SHAs" revalidated against
      current `main`. RC3.3 SHA `3421a5d` recorded as integration tip.
- [ ] Codex independent re-review PASS on `3421a5d` (R2.1b scope).
- [ ] Phase A read-only infra audit still valid (docker containers
      unchanged since 2026-10-26 17:42 UTC audit).
- [ ] Owner confirmed Neon production branch identity per WBS-TF-07 §4.
- [ ] `sql/production/dashboard_role_production.sql` executed under
      `production_branch_confirmed=on`; in-script assertions PASS.
- [ ] `sql/production/dashboard_crm_v1_up.sql` executed under
      `production_branch_confirmed=on`.
- [ ] `wbs_tf_ai_context` role provisioned on Neon; schema USAGE +
      function EXECUTE on `ai_lead_context` only; no table SELECT.
- [ ] New n8n credential `WBS Trade Fair — OpenAI RC3` (`openAiApi`
      type) created; API key same as existing Bearer binding.
- [ ] New n8n credential `WBS Trade Fair — AI context` (`postgres`
      type) created, bound to `wbs_tf_ai_context` role.
- [ ] WF-07/08 imported via REST POST /workflows with production
      credential IDs rebound; original canonical JSON unchanged on disk.
- [ ] WF-07/08 activated; `active=true`, `versionId==activeVersionId`
      recorded in deployment log.
- [ ] RC3.3 finalizer `verify-published.mjs` re-run against the live
      production n8n; PUBLISHED_PROVENANCE_FAILED NOT raised. Report
      saved to `/opt/wbs-trade-fair/secrets/backups/${TF_ROLLOUT_TS}/`.
- [ ] Gateway image rebuilt from `3421a5d` (plus merged PR #1, #2, #3)
      using `Dockerfile.dashboard-staging`; digest recorded.
- [ ] F3B R3 §6 "Reversible swap" executed; `.saved-${TF_ROLLOUT_TS}`
      container reachable; loopback acceptance PASS.
- [ ] F3B R3 §7 external HTTPS acceptance PASS.
- [ ] T+15 min canary: synthetic Dashboard "Lead-Assistent" call PASS
      with grounded answer and no PII in LLM input.
- [ ] T+1 h: observation window closed with no rollback triggers.
- [ ] T+24 h: soak window closed with OpenAI daily spend ≤ $5 and zero
      PUBLISHED_PROVENANCE_FAILED.
- [ ] Owner GO logged for standard-monitoring promotion.

## 10. Explicit NON-execution items

The following are intentionally **outside** this plan and would require
a separate review + Owner GO:

- Any change to WF-A, WF-B, WF-C, or WF-D (versionId or activeVersionId).
- Any shared credential rotation (`DIm6w5CcndY0D3RJ`,
  `UUprjEp0Re6kPUFN`, `tjqSy2V0odocljw6`, `HvE5Js2qo8BxvrSs`,
  `A4Xm6WZ9d6SsMkfs`).
- Any `/etc/nginx/sites-enabled/*` edit beyond the F3B R3 nginx recipe.
- Any Docker image swap beyond §4 Gateway rebuild.
- Any Watchtower config change.
- Any production data edit (companies, contacts, lead_submissions).

## 11. Evidence pointers

| Phase | Evidence file |
|---|---|
| CODE regression (108/108) | `tests/integration/rc33_executable_provenance.mjs`, `tests/integration/rc32_published_provenance.mjs`, `tests/integration/rc31_regression.mjs`, `tests/integration/workflow_contracts.mjs`, `tests/test_gateway_dashboard.mjs`, `tests/test_dashboard.mjs` |
| Live RC3.3 n8n ACCEPT/REJECT | `integration/n8n-live-01/evidence/rc33-live-run.txt` |
| LIVE-01 isolated E2E (11 PASS) | `integration/n8n-live-01/evidence/gateway-e2e.json` |
| LIVE-01 execution audit | `integration/n8n-live-01/evidence/execution-audit.json` |
| LIVE-01 manifest (SHA pin) | `integration/n8n-live-01/evidence/manifest.json` |
| Backup/restore drill | `integration/n8n-live-01/evidence/rc33-backup-restore.txt` |
| Production preflight (read-only) | `docs/WBS_TF_07_PRODUCTION_PREFLIGHT.md` |
| F3B R3 Gateway/TLS packet | `docs/WBS_TF_06_F3B_PREP.md` |
| Rollback runbook | `docs/ROLLBACK.md` + `docs/WBS_TF_06_F3B_PREP.md` §9 |
| SQL migrations | `sql/production/dashboard_role_production.sql`, `sql/production/dashboard_crm_v1_up.sql` + rollbacks |
