# WBS Trade Fair Assistant — Release Acceptance Report

**Candidate SHA:** `3421a5d2bb842461c2c12c0f565f53249eeeee05`
**PR:** https://github.com/klareki-lab/wbs-trade-fair-assistant/pull/27
**Report date (UTC):** 2026-10-26
**Owner decision in scope:** GO for read-only infra preflight + isolated staging acceptance; NOT GO for production deployment.

## Verdict at a glance

| Gate | Status |
|---|---|
| **CODE** | **PASS** |
| **INFRASTRUCTURE** | **PASS** (read-only; reused existing WBS-TF-07 preflight + today's probes) |
| **STAGING E2E** | **PASS** |
| **BACKUP & RESTORE** | **PASS** |
| **PRODUCTION READINESS** | **NO-GO** — Owner explicitly held production; execution blockers listed in §6 |

## 1. CODE — PASS

### What was validated
- RC3.3 verifier (`verify-published.mjs`) fingerprints the complete
  executable definition of every published n8n node — not just
  `parameters`/`type`/`connections` — closing the Codex R2.1b blocker
  where a published `Ausgabe prüfen.disabled=true` would silently bypass
  the grounding gate.
- Executable fields compared (with n8n 2.41.7 defaults normalized on
  both sides): `id, name, type, typeVersion, parameters, disabled,
  executeOnce, alwaysOutputData, retryOnFail, maxTries,
  waitBetweenTries, continueOnFail, onError`.
- Metadata-only fields ignored: `position, notes, notesInFlow,
  credentials, webhookId, disabledEdges`.
- Unknown node fields fail closed (`UNKNOWN_NODE_FIELD`), preventing a
  future n8n release from smuggling execution-affecting behavior past
  the verifier.

### Regression suites (local Node 24.15.0)
```
rc31_regression                       9/9
rc32_published_provenance            13/13
rc33_executable_provenance           21/21
workflow_contracts                    2/2
test_gateway_dashboard + dashboard   60/60
test-adaptations                      3/3
──────────────────────────────────  108/108
```

### Independent-reviewer re-request status
- RC3.3 PR comment posted at
  https://github.com/klareki-lab/wbs-trade-fair-assistant/pull/27#issuecomment-6423041427.
- Codex independent re-review on `3421a5d` **pending** at the time of
  this report. If Codex returns a new blocker, CODE flips to FAIL and
  §6 PRODUCTION READINESS stays NO-GO.

## 2. INFRASTRUCTURE — PASS (read-only)

Reused the WBS-TF-07 production preflight (dated 2026-10-24) and
verified nothing has drifted today via MCP probes.

### 2.1 — VPS and container state (2026-10-26 17:42 UTC)
```
docker_status: 13 containers
  wbs-trade-fair-gateway                       Up 33 h   image 9f34e8b4fd54
  n8n-n8n-1                                    Up 32 h   image n8nio/n8n:2.41.7
  n8n-postgres                                 Up 39 h (healthy) postgres:16-alpine
  qdrant, klare-ki-mcp, klare-ki-minio, watchtower — up for days/weeks (healthy)
  3 saved gateway rollback snapshots (Exited 0) available
```
Matches the WBS-TF-07 §5 "VPS baseline" except Gateway image id, which
has rolled forward during Dashboard work since 2026-10-24 (expected and
unrelated to RC3.3).

### 2.2 — Production n8n catalog (108 workflows, 15 active)
Independent summary from `pam_n8n_workflow_list` (full dump kept out of
report by sampling via subagent):

| Code | id | active | versionId == activeVersionId | nodes | updatedAt |
|---|---|---|---|---|---|
| WF-A | `d5uO1lnwjOirJ5Xf` | true | ✅ | 8 | 2026-10-23 |
| WF-B | `dr05aJRh8Lu6VpSA` | true | ✅ | 17 | 2026-10-24 |
| WF-C | `bRkCsVxZXU85yqLI` | true | ✅ | 13 | 2026-10-24 |
| WF-D | `THulrTbNEZ2FrgJ3` | true | ✅ | 6 | 2026-10-24 |

- **No RC3 nodes** (`Ausgabe prüfen`, `@n8n/n8n-nodes-langchain.*`, native
  `openAi`) are present in any of WF-A–D.
- **WF-07 and WF-08 do not exist** on production n8n (expected — RC3.3
  is code-only; no shared staging activation performed).
- No webhook-path collision between planned RC3 paths
  (`/webhook/messe-hub/ai-extract`, `/webhook/messe-hub/ai-ask`) and
  any existing workflow (including unrelated
  `ReviewPilot — Feedback API`).
- PAM: 3 named PAM workflows (all inactive, manual-only) + one
  unrelated active PAM Drive capture pipeline (`qweibPs0rcZjeho5`,
  distinct credentials). **No PAM conflict with RC3.3 scope.**
- Shared credentials used by WF-A/B/C/D (`DIm6w5CcndY0D3RJ`,
  `UUprjEp0Re6kPUFN`, `tjqSy2V0odocljw6`, `HvE5Js2qo8BxvrSs`,
  `A4Xm6WZ9d6SsMkfs`) are **not** used by any neighboring active
  workflow (DACH News, Pick Best Post, VAPI Maria, ReviewPilot, W1-δ,
  etc.) — RC3.3 cannot destabilize neighbors via credential rotation.

### 2.3 — Backup infrastructure
- `/opt/wbs-trade-fair/secrets/` exists `drwx------ root`.
- Free space 8.7 G on `/opt` (per WBS-TF-07; unchanged).
- Three saved Gateway rollback snapshots currently resident
  (`.saved-20261025T084342Z`, `.saved-20261025T075219Z`,
  `.saved-20261024T223914Z`), Exited (0), reachable via
  `docker start`.
- Residual stale secret files flagged in WBS-TF-07 §6 remain (housekeeping,
  not blocking).

### 2.4 — HTTPS / webhook / auth / Origin / cookie
- `messe.klare-ki.de` → `77.42.19.144` A record present; no AAAA.
- No TLS certificate issued yet for `messe.klare-ki.de`; nginx vhosts
  prepared under `ops/nginx/` but not installed (deferred to §4 of
  WBS-TF-07, under Owner HOLD).
- Gateway `/healthz` returns 200 on 127.0.0.1:3000.
- Isolated-E2E `gateway-e2e.json`: Origin check PASS, cookie check
  PASS, "Unknown context fails closed; duplicate IDs reject before
  upstream; absent session denied" PASS.

### 2.5 — OpenAI credentials (metadata only)
- `UUprjEp0Re6kPUFN` ("WBS Trade Fair — OpenAI  19.10") present on
  prod n8n, type `httpHeaderAuth` with Bearer custom header. Used by
  WF-B via `httpRequest` (pre-RC3 pattern). **Not** the native
  `openAiApi` credential type that WF-07/08 require.
- RC3 WF-07/08 need a **new** credential of type `openAiApi` referring
  to the same API key value; this is captured as a Phase C
  prerequisite, not a production change made today.
- Spending-limit confirmation deferred to Owner (budget plan in
  deployment plan §3 and §6).

## 3. STAGING E2E — PASS

All checks were performed on **disposable** containers (n8n 2.41.7 +
PG 16 + synthetic data) with real OpenAI reached under a bounded
budget. No production system was touched.

### 3.1 — Import + publish of pinned canonical WF-07 / WF-08
Live run `rc33-live-run.txt`:
```
PASS — canonical WF-07 published → ACCEPT (publishedVersionId=719e588a-…)
PASS — canonical WF-08 published → ACCEPT (publishedVersionId=760d31c0-…)
PASS — WF-08 Ausgabe prüfen.disabled=true published → REJECT
    rejection reason: PUBLISHED_PROVENANCE_FAILED: published node
      Ausgabe prüfen executable fingerprint diverges from canonical
      (fields: disabled). diff: {"disabled":{"canonical":false,"published":true}}
```

### 3.2 — RC3.3 finalizer provenance verification
Covered by `rc33_executable_provenance.mjs` (21/21) + live run above.
Verifier rejects: disabled, executeOnce, alwaysOutputData, retryOnFail,
onError, continueOnFail, name change, typeVersion bump, parameter
mutation, injected node, unknown node field, connection change, and
canonical-draft-over-older-published.

### 3.3 — Real webhook E2E (from `gateway-e2e.json`, 11 PASS)
- UI dropped-receipt + retry delivered identical body & submission id;
  n8n returned 201 then 200 replay.
- Dashboard SQL contains the saved lead after refresh.
- Actual WF-D returns `pending/unscored`, never a fake delivered state.
- Actual Gateway → WF-08 → scoped PG → real OpenAI queries the saved
  lead (grounded answer, cited IDs match request).
- Concurrent identical captures → one 201 + one 200 replay; exactly one PG row.
- Changed body + same submission id → 409; original row preserved.
- Invalid email → actual WF-A 422; no persistence.
- Unknown context, duplicate IDs, absent session → fail closed.
- Scoped credential has no table SELECT or CRM write; real context
  contains only the requested id.
- Actual WF-08 LLM input contains categories/ids only — no direct PII,
  no raw user question.
- No outbox messages, no fabricated scores.

### 3.4 — Error handling / safe responses
- WF-08 incomplete-coverage warning (RC3.1 R1 fix) survives the
  Gateway allowlist and reaches the UI (regression test
  "RC3.1: canonical WF-08 coverage warning survives Gateway allowlist and is visible to UI" PASS).
- Enum coercion rejections, Origin denials, 422 payload details all
  covered by `test_gateway_dashboard` + `workflow_contracts`.

### 3.5 — Scope note on real OpenAI (corrected per Codex RC3.3 finding #6)

The 11-PASS gateway E2E file `gateway-e2e.json` is pinned at
`6b64f70d…` on 2026-10-26 10:14 UTC. **It is NOT exact-current-canonical
real-OpenAI acceptance for RC3.3.** Between `6b64f70d…` and RC3.3
(`3421a5d…`) the WF-08 prompt text, structured-output
`response_format` and the output-check Code node (`Ausgabe prüfen`)
all changed as part of R1 (RC3.1) and the Ausgabe-prüfen rewrite that
RC3.3 locks down. The historical record therefore remains valuable as
documentation of persistence, idempotency, Origin and scoped-ACL
behaviour, but any claim that it certifies the exact RC3.3 OpenAI
prompt behaviour would be unsound.

A bounded-budget real-OpenAI acceptance of the exact RC3.3 canonical
workflows is a separate Owner-gated step (checklist §G6; packet §6.1).
This acceptance report records that step as **PENDING**, not as
pre-existing evidence.

The RC3.3 provenance verifier itself was re-run live against disposable
n8n 2.41.7 today without invoking any model; see `rc33-live-run.txt` and
the operator-script dry-run in `rc33-operator-dryrun.txt`.

## 4. BACKUP & RESTORE — PASS

Executed today on **two disposable PG 16 instances** via the committed
schema (`sql/dashboard_confirmed_ddl.sql` +
`sql/dashboard_snapshot_definition.sql` +
`sql/production/dashboard_crm_v1_up.sql`). Evidence:
`integration/n8n-live-01/evidence/rc33-backup-restore.txt`.

```
[rc33-backup] source snapshot: {"counts":{"companies":"2","contacts":"2","submissions":"5"},...}
PASS — pg_dump --schema=trade_fair produced 47263 bytes (sha256=c54189f6…)
[rc33-backup] target snapshot:  {"counts":{"companies":"2","contacts":"2","submissions":"5"},...}
PASS — row counts identical (companies=2, contacts=2, submissions=5)
PASS — dashboard_snapshot result sha256 identical (f4c6ae5aed96ee9e…)
PASS — trade_fair_dashboard ACL restored (USAGE + EXECUTE)
PASS — post-restore least-privilege preserved:
       trade_fair_dashboard SELECT on raw tables denied
```

The `dashboard_snapshot` hash was taken over the deterministic
`{total, stats, leads}` sub-object; `as_of` (per-call
`statement_timestamp()`) is intentionally excluded.

**Qualification per Codex RC3.3 finding #7:** this drill uses
`pg_dump --no-owner --no-privileges`; it does **not** demonstrate
automatic role/ACL recovery from the dump itself. The drill reapplies
GRANT statements explicitly from committed SQL after loading, which is
how the role surfaces on the target. Therefore the drill is a
**procedure confirmation**, not evidence that role recovery is
automatic from the dump artefact.

The production procedure in packet §5.1 corrects this by producing
TWO artefacts: the schema+data dump AND
`pg_dumpall --roles-only --no-role-passwords` so role definitions and
grants recover with the data. The real-Neon round-trip of both
artefacts is an Owner-executed step (checklist §G3) and is not
included in this acceptance report.

**Not covered by this drill:**
- A dump of the real production Neon branch into a disposable target.
  That requires Owner-approved temporary access to prod Neon
  credentials; it is executed under checklist §G3, not here.

## 5. Scope boundaries — what did NOT run today

Explicitly out of scope under Owner's "NOT GO for production
deployment":
- No change to WF-A–D (verified unchanged on prod).
- No new TLS issuance, no `/etc/nginx/sites-enabled/*` edit.
- No Gateway image push, build or swap.
- No production n8n credential create/edit/delete.
- No production Neon migration (`dashboard_role_production.sql` +
  `dashboard_crm_v1_up.sql` remain PREPARED, not executed).
- No PR #27 merge.
- No new paid OpenAI consumption beyond prior gate's budget.
- Three local demos (`127.0.0.1:3100/3101/3102`) remain HTTP 200;
  unaffected.

## 6. Remaining blockers before PRODUCTION GO

Not technical blockers — these are **Owner-gated steps** that the
report records explicitly so the deployment plan can be executed
without re-discovery:

1. **Codex independent re-review verdict on `3421a5d`** — **PASS**,
   CODE READY (recorded on PR #27 comment 6426321107). Codex noted that
   CODE READY grants no deployment permission; deployment-oriented
   corrections were separately required and are now consolidated in
   `docs/WBS_TF_PRODUCTION_EXECUTION_PACKET.md` (P-DEPLOY-02).
2. **Owner-verified Neon production branch identity** per packet
   Owner Gate 2.1. Branch ID, endpoint and `neon.timeline_id` captured
   out-of-band to the deployment log.
3. **`sql/production/dashboard_role_production.sql` execution** on
   confirmed production branch (guarded by
   `-v production_branch_confirmed=on`).
4. **`sql/production/dashboard_crm_v1_up.sql` execution** on confirmed
   production branch. This script itself creates
   `trade_fair_ai_context` (NOLOGIN) with narrow EXECUTE on
   `trade_fair.ai_lead_context(jsonb)`.
5. **Provision LOGIN role `trade_fair_ai_login`** (Owner-chosen name)
   with `GRANT trade_fair_ai_context TO <login-role>` per packet §2.4.
   (The earlier `wbs_tf_ai_context` naming has been corrected.)
6. **Create new n8n credentials** `WBS Trade Fair — OpenAI RC3`
   (`openAiApi`) and `WBS Trade Fair — AI context` (`postgres`
   pointing at `trade_fair_ai_login`). Packet §3.1.
7. **Gateway image rebuild + swap** per F3B R3 §6 "Reversible swap";
   env file must set `N8N_AI_EXTRACT_URL` and `N8N_AI_ASK_URL`
   (packet §4.2 — supersedes the earlier
   `GATEWAY_ALLOW_UPSTREAM_WEBHOOKS` reference).
8. **Loopback and external HTTPS acceptance** per packet §4.5 and
   F3B R3 §7.
9. **Read-only `verify_published_production.mjs` run against live
   production n8n** before activating end-user traffic. Packet §3.4.
   (The earlier reference to `finalize.mjs --workflow-ids
   --mode=production-verify-only` was invalid — those flags do not
   exist on the pinned finalizer and the finalizer PATCHes settings.)
10. **Bounded-budget RC3.3 real-OpenAI acceptance** (checklist §G6):
    first exercise of the exact RC3.3 canonical WF-07/08 against real
    OpenAI with ≤ $5/day cap.
11. **Canary windows T+15m / T+1h / T+24h / T+7d** per packet §6.2.

## 6b. Codex RC3.3 CODE verdict (added under P-DEPLOY-02)

**Codex final independent RC3.3 review — PASS — CODE READY** on
`3421a5d2bb842461c2c12c0f565f53249eeeee05` (comment
https://github.com/klareki-lab/wbs-trade-fair-assistant/pull/27#issuecomment-6426321107).

Scope of CODE READY: R1 / R2.1 / R2.1b closed; verifier compares full
executable fingerprint including `disabled`, `executeOnce`,
`alwaysOutputData`, `retryOnFail`, `maxTries`, `waitBetweenTries`,
`continueOnFail`, `onError`; unknown node fields reject. Independent
regressions 108/108. Independent full-finalizer run against disposable
n8n 2.41.7 PASSED all four cases (canonical ACCEPT, stale-published
REJECT, disabled-validator REJECT, restored-canonical ACCEPT).

Codex explicitly flagged seven deployment-oriented defects in the
operator packet; those are addressed in
`docs/WBS_TF_PRODUCTION_EXECUTION_PACKET.md` §0.5 mapping table under
P-DEPLOY-02. CODE READY grants no deployment permission.

## 7. Deployment plan reference

The consolidated, copy-paste ready deployment plan is in
`docs/WBS_TF_RC33_DEPLOYMENT_PLAN.md`. It layers RC3 workflow
activation on top of WBS-TF-06 F3B R3 and WBS-TF-07 production
preflight. Nothing in that plan has been executed.

## 8. Evidence index

| Area | File |
|---|---|
| Verifier source | `integration/n8n-live-01/verify-published.mjs` |
| In-memory R2.1b regression | `tests/integration/rc33_executable_provenance.mjs` |
| In-memory R2.1 regression | `tests/integration/rc32_published_provenance.mjs` |
| In-memory R1/R2 regression | `tests/integration/rc31_regression.mjs` |
| WF-07/08 contract tests | `tests/integration/workflow_contracts.mjs` |
| Gateway + Dashboard tests | `tests/test_gateway_dashboard.mjs`, `tests/test_dashboard.mjs` |
| Adapter idempotence | `integration/n8n-live-01/test-adaptations.mjs` |
| Live RC3.3 ACCEPT/REJECT run | `integration/n8n-live-01/evidence/rc33-live-run.txt` |
| Live Gateway E2E (11 PASS) | `integration/n8n-live-01/evidence/gateway-e2e.json` |
| Live LIVE-01 manifest | `integration/n8n-live-01/evidence/manifest.json` |
| Live LLM execution audit | `integration/n8n-live-01/evidence/execution-audit.json` |
| Backup/restore drill | `integration/n8n-live-01/evidence/rc33-backup-restore.txt` |
| Live RC3.3 live reproducer | `integration/n8n-live-01/_rc33_real_disabled_acceptance.mjs` |
| Backup/restore reproducer | `integration/n8n-live-01/_rc33_backup_restore_drill.mjs` |
| Production preflight (read-only) | `docs/WBS_TF_07_PRODUCTION_PREFLIGHT.md` |
| F3B R3 Gateway/TLS packet | `docs/WBS_TF_06_F3B_PREP.md` |
| Deployment plan (prepared) | `docs/WBS_TF_RC33_DEPLOYMENT_PLAN.md` |
| Rollback runbook | `docs/ROLLBACK.md` |
