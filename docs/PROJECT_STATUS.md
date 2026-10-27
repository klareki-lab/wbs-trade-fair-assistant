# Project status and evidence matrix

Assessment date: **2026-10-27**. Documentation base: RC3.3 source `49693b330ef6f0340205e84c06f7924b688212bb` (runtime candidate `3421a5d`). This page distinguishes source availability, test evidence, and production observations. It is not deployment approval.

**Production verification below is historical only.** No VPS, database, deployed workflow, or provider account was accessed during this task. A recorded active flag is not proof of successful end-to-end processing. “Not established” means the repository evidence does not justify that claim, not that the feature is necessarily broken.

| Capability | Implemented in code | Verified in tests | Verified in production | Not yet verified / limits |
| --- | --- | --- | --- | --- |
| Form gateway, scoped sessions, Origin checks | Yes: `gateway/server.mjs`, capture assets | Gateway regression reproduced in this task | Historical baseline/handover records describe running service | Current host state, individual staff authorization, scaling |
| Capture validation, receipt, replay/conflict | Yes: WF-A and client adapters | Gateway mocks; historical LIVE-01 actual n8n + synthetic capture fixture | WF-A historically active; full current production behavior not reverified | Independent target SQL/ACL; complete failure matrix |
| Status polling | Yes: WF-D, gateway and UI | Gateway mocks; historical LIVE-01 synthetic DB/n8n | WF-D historically active | Current production schema/identifier access and availability |
| Research, evidence extraction, score, report generation | Yes: WF-B Code/HTTP/SQL nodes | Source available; historical workflow evidence, not rerun against providers here | WF-B historically active; reference instructions report some completed cases in Yuriy's environment | Current canonical pipeline E2E, quotas, live research/model behavior |
| Email outbox, send fence, outcome handling | Yes: WF-C | Code review and historical operational records; no send performed here | Later handover records report WF-C active; inbox delivery not established | Controlled provider E2E and ambiguous-send recovery on your target |
| Dashboard filters, KPI, detail view | Yes: snapshot/adapter/UI | Gateway contract tests reproduced; R2 SQL/browser evidence retained | Earlier dashboard release recorded in TF-10 handover | RC3.3 dashboard on production; current effective grants/data |
| CRM merge/split/extract/ignore/audit/undo | Yes: adapter/UI and CRM SQL | Historical R2 real PG16/concurrency/browser evidence | Not established for RC3.3 | Target drift, migration/ACL review, production acceptance and throughput |
| WF-07 confirmed AI capture | Yes: adapted workflow + UI | Deterministic checks reproduced; historical LIVE-01 actual n8n + real model synthetic-data run | Not established | Full current-candidate HTTPS/provider/credential/PII-policy acceptance |
| WF-08 bounded grounded assistant | Yes: scoped SQL, adapted workflow and UI | Contracts reproduced; historical LIVE-01 real model; RC3.1 isolated n8n mock-provider acceptance | Not established | Current target scoped login, real-data policy, answer usefulness/coverage |
| Incomplete-coverage warning | Yes: canonical WF-08, gateway allowlist and UI | RC3.1 deterministic and gateway checks reproduced; isolated n8n evidence retained | Not established | Current deployed UI/webhook behavior |
| Published executable provenance | Yes: RC3.2/3.3 verifier | Focused checks reproduced; RC3.3 isolated actual-n8n ACCEPT/REJECT evidence retained | Not established | Production publication and version compatibility |
| Backup/restore | Local drill harness | Retained RC3.3 disposable PG16 row/hash/ACL evidence | Production recovery not established | Your target restore, RPO/RTO, full CRM audit and operational recovery |
| Complete independent installation | Partial components and examples | Individual slices only | Not applicable | Full base queue/function bootstrap, infrastructure, credentials and integration remain reader work |
| Privacy, staff identities, tenancy, load/SLO | Some minimization and shared-key controls | Selected security contracts only | No comprehensive verification | Real-data policy, per-person access, tenant isolation, capacity and monitoring |

## Verification performed for this documentation change

On local Node.js **v24.15.0**, after `npm ci --prefix gateway --ignore-scripts --no-audit --no-fund`:

- `npm test --prefix gateway`: **68 passed, 0 failed**. Includes gateway/adapter contracts using fake upstreams/stores; does not prove a deployed database or workflow.
- `node --test tests/integration/rc31_regression.mjs tests/integration/rc32_published_provenance.mjs tests/integration/rc33_executable_provenance.mjs tests/integration/workflow_contracts.mjs integration/n8n-live-01/test-adaptations.mjs`: **48 passed, 0 failed**. Deterministic canonical workflow/adapter/provenance tests; no actual n8n or paid provider started.
- Documentation links, JSON parseability, preserved-file equality, and diff scope checked locally.

Docker database, browser, live-n8n, real-provider, email-send, and production checks were **not rerun** for this documentation task. Node 22 compatibility is supported by earlier evidence, not newly reproduced here. Numbers in older reports belong to their own source revisions and cannot be summed into a fresh full-release acceptance total.

## Evidence and remaining gates

- [Baseline capture](LIVE_BASELINE.md), [TF-10 handover](WBS_TF_10_HANDOVER.md): historical production inventory and earlier dashboard release.
- [R2 report](R2_TEST_REPORT.md): local PostgreSQL, ACL/concurrency, browser and n8n/mock-provider evidence.
- [LIVE-01 report](WBS_TF_N8N_LIVE_01_REPORT.md), [manifest](../integration/n8n-live-01/evidence/manifest.json): isolated real-provider integration on its recorded SHA; later RC revisions are separate.
- [RC3.1 operator gate](RC3_1_OPERATOR.md): historical release blockers and transport distinctions.
- [RC3.3 actual-n8n provenance evidence](../integration/n8n-live-01/evidence/rc33-live-run.txt), [restore drill](../integration/n8n-live-01/evidence/rc33-backup-restore.txt): isolated fixtures, not production acceptance.

Before any future production release, independently confirm the target catalog/ACL and credential bindings, provider/PII policy, reviewed migration path, tested backup restoration, actual published workflows, HTTPS/session/header-auth behavior, failure/rollback behavior, monitoring and canary thresholds, then obtain Owner approval. The archived [deployment plan](WBS_TF_RC33_DEPLOYMENT_PLAN.md) has unresolved instructions described in the [security review](PUBLIC_SECURITY_REVIEW.md); do not execute it as a student setup guide.
