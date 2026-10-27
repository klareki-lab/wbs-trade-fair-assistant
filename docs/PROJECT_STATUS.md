# Project status and evidence matrix

Assessment date: **2026-10-27**. Documentation base: RC3.3 source `49693b330ef6f0340205e84c06f7924b688212bb` (runtime candidate `3421a5d`). This page distinguishes implemented/tested source, production infrastructure and deployment verification, and functional acceptance. It is educational documentation, not an operational procedure.

**Production deployment is G5 PASS; functional G6 acceptance remains pending.** Production statements below use historical handover evidence, including the Owner's 2026-10-27 deployment report. Codex did not independently access the VPS, database, deployed workflows, or provider accounts during this documentation task. An active workflow, provenance PASS, or reachable page does not establish complete AI/CRM end-to-end behavior or Dashboard parity.

| Evidence layer | Status | Meaning |
| --- | --- | --- |
| Source implementation and tests | Implemented; local results recorded below | Code and exercised test contracts are available for study; test scope still matters |
| Production infrastructure and deployment | **G5 PASS — Owner-reported, 2026-10-27** | Workflow publication/activation/provenance, CRM migration, gateway deployment and page reachability verified by the Owner |
| AI/CRM end-to-end functionality | **G6 pending** | Not yet fully verified in production |
| Dashboard feature parity with Yuriy's reference | **Not yet accepted** | Deployment and local tests do not establish feature-parity acceptance |

## Owner deployment handover — 2026-10-27

Source: Owner-provided deployment evidence in the PR #28 review handover, supplied for this documentation correction. It records **G5 PASS**:

- WF-07 and WF-08: published, active, published provenance PASS.
- Production Neon CRM migration: applied.
- Gateway RC3.3: successfully deployed.
- Deployed image: `sha256:ce1708976bb3ea5953d97baa030a72f34db1b3dc11242ad182cf7e00db96c5d9`.
- Public form and Dashboard: reachable.

This is an attributed historical deployment record, not independent Codex production verification. **G6 functional acceptance remains pending:** AI/CRM end-to-end functionality is not yet fully verified, and Dashboard feature parity with Yuriy's reference is not yet accepted. The security findings and earlier records retain their original review scope and date.

## Capability matrix

“Not established” means the available evidence does not justify that claim, not that the feature is necessarily broken. Owner G5 statements refer to the handover above.

| Capability | Implemented in code | Verified in tests | Verified in production / evidence source | Not yet verified / limits |
| --- | --- | --- | --- | --- |
| Form gateway, scoped sessions, Origin checks | Yes: `gateway/server.mjs`, capture assets | Gateway regression reproduced in this task | Owner G5: RC3.3 gateway deployed; public form and Dashboard reachable | G5 reachability does not verify every session/Origin behavior; individual staff authorization and scaling remain unverified |
| Capture validation, receipt, replay/conflict | Yes: WF-A and client adapters | Gateway mocks; historical LIVE-01 actual n8n + synthetic capture fixture | WF-A historically active; full current production behavior not reverified | Independent target SQL/ACL; complete failure matrix |
| Status polling | Yes: WF-D, gateway and UI | Gateway mocks; historical LIVE-01 synthetic DB/n8n | WF-D historically active | Current production schema/identifier access and availability |
| Research, evidence extraction, score, report generation | Yes: WF-B Code/HTTP/SQL nodes | Source available; historical workflow evidence, not rerun against providers here | WF-B historically active; reference instructions report some completed cases in Yuriy's environment | Current canonical pipeline E2E, quotas, live research/model behavior |
| Email outbox, send fence, outcome handling | Yes: WF-C | Code review and historical operational records; no send performed here | Later handover records report WF-C active; inbox delivery not established | Controlled provider E2E and ambiguous-send recovery on your target |
| Dashboard filters, KPI, detail view | Yes: snapshot/adapter/UI | Gateway contract tests reproduced; R2 SQL/browser evidence retained | Owner G5: RC3.3 Dashboard reachable; earlier release in TF-10 handover | G6 functional acceptance pending; feature parity with Yuriy's reference not yet accepted |
| CRM merge/split/extract/ignore/audit/undo | Yes: adapter/UI and CRM SQL | Historical R2 real PG16/concurrency/browser evidence | Owner G5: production Neon CRM migration applied | G6: production CRM operations, undo/audit end-to-end behavior and throughput not yet fully verified |
| WF-07 confirmed AI capture | Yes: adapted workflow + UI | Deterministic checks reproduced; historical LIVE-01 actual n8n + real model synthetic-data run | Owner G5: WF-07 published, active, published provenance PASS | G6: full AI extraction → human confirmation → capture end-to-end functionality not yet fully verified |
| WF-08 bounded grounded assistant | Yes: scoped SQL, adapted workflow and UI | Contracts reproduced; historical LIVE-01 real model; RC3.1 isolated n8n mock-provider acceptance | Owner G5: WF-08 published, active, published provenance PASS | G6: full scoped-context/AI-answer end-to-end functionality and usefulness/coverage not yet fully verified |
| Incomplete-coverage warning | Yes: canonical WF-08, gateway allowlist and UI | RC3.1 deterministic and gateway checks reproduced; isolated n8n evidence retained | Owner G5 verifies deployment/publication, not this functional outcome | G6: deployed UI/webhook incomplete-coverage behavior not yet fully verified |
| Published executable provenance | Yes: RC3.2/3.3 verifier | Focused checks reproduced; RC3.3 isolated actual-n8n ACCEPT/REJECT evidence retained | Owner G5: WF-07 and WF-08 published provenance PASS | Provenance does not establish G6 functional acceptance or compatibility with other environments |
| Backup/restore | Local drill harness | Retained RC3.3 disposable PG16 row/hash/ACL evidence | Production recovery not established | Your target restore, RPO/RTO, full CRM audit and operational recovery |
| Complete independent installation | Partial components and examples | Individual slices only | Not applicable | Full base queue/function bootstrap, infrastructure, credentials and integration remain reader work |
| Privacy, staff identities, tenancy, load/SLO | Some minimization and shared-key controls | Selected security contracts only | No comprehensive verification | Real-data policy, per-person access, tenant isolation, capacity and monitoring |

## Local verification recorded for the original documentation change

On local Node.js **v24.15.0**, after `npm ci --prefix gateway --ignore-scripts --no-audit --no-fund`:

- `npm test --prefix gateway`: **68 passed, 0 failed**. Includes gateway/adapter contracts using fake upstreams/stores; does not prove a deployed database or workflow.
- `node --test tests/integration/rc31_regression.mjs tests/integration/rc32_published_provenance.mjs tests/integration/rc33_executable_provenance.mjs tests/integration/workflow_contracts.mjs integration/n8n-live-01/test-adaptations.mjs`: **48 passed, 0 failed**. Deterministic canonical workflow/adapter/provenance tests; no actual n8n or paid provider started.
- Documentation links, JSON parseability, preserved-file equality, and diff scope checked locally.

Docker database, browser, live-n8n, real-provider, email-send, and production checks were **not rerun** for this documentation task. Node 22 compatibility is supported by earlier evidence, not newly reproduced here. Numbers in older reports belong to their own source revisions and cannot be summed into a fresh full-release acceptance total.

## Evidence and remaining gates

- [Owner deployment handover](#owner-deployment-handover--2026-10-27): G5 production deployment PASS; G6 functionality and Dashboard parity remain pending as described above.

- [Baseline capture](LIVE_BASELINE.md), [TF-10 handover](WBS_TF_10_HANDOVER.md): historical production inventory and earlier dashboard release.
- [R2 report](R2_TEST_REPORT.md): local PostgreSQL, ACL/concurrency, browser and n8n/mock-provider evidence.
- [LIVE-01 report](WBS_TF_N8N_LIVE_01_REPORT.md), [manifest](../integration/n8n-live-01/evidence/manifest.json): isolated real-provider integration on its recorded SHA; later RC revisions are separate.
- [RC3.1 operator gate](RC3_1_OPERATOR.md): historical release blockers and transport distinctions.
- [RC3.3 actual-n8n provenance evidence](../integration/n8n-live-01/evidence/rc33-live-run.txt), [restore drill](../integration/n8n-live-01/evidence/rc33-backup-restore.txt): isolated fixtures, not production acceptance.

The remaining project acceptance concerns G6 AI/CRM end-to-end functionality and Dashboard feature parity with Yuriy's reference; G5 deployment is already recorded as PASS. Students reproducing the design must independently verify their own target catalog/ACL, credential bindings, provider/data policy, migration and restore behavior, published workflows, HTTPS/session/header-auth behavior, failure handling and monitoring. The archived [deployment plan](WBS_TF_RC33_DEPLOYMENT_PLAN.md) has unresolved instructions described in the [security review](PUBLIC_SECURITY_REVIEW.md); do not execute it as a student setup guide.
