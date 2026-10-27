# Documentation map and engineering history

The learning entry point is the [README](../README.md), followed by [architecture](ARCHITECTURE.md), [workflows](WORKFLOW_GUIDE.md), [independent reproduction](REPRODUCE_IT_YOURSELF.md), [status](PROJECT_STATUS.md), and [public security review](PUBLIC_SECURITY_REVIEW.md).

## Preserved historical entry points

Original content is retained verbatim in these files. Their relative links and operational claims reflect the original location/date; use the repository paths and index below when navigating them.

- [Original baseline README](history/README_LIVE_BASELINE.md).
- [Original October 24 architecture](history/ARCHITECTURE_LIVE_BASELINE.md).
- [Original R2 workflow instructions](history/WORKFLOWS_R2.md).

No workflows, SQL, runtime source, credentials, evidence files, or Git history were changed by the educational documentation work. New navigation notes identify old guidance without changing its recorded engineering conclusions.

## Existing technical records

| Topic / period | Records and how to read them |
| --- | --- |
| October 24 inventory | [LIVE_BASELINE](LIVE_BASELINE.md), [workflow manifest](WORKFLOW_MANIFEST.md), [deployment inventory](DEPLOYMENT.md), [handover](HANDOVER.md). Point-in-time observations, not current RC installation instructions. |
| Original dashboard design | [Yuriy's instructions](../dashboard/ANLEITUNG.md), `dashboard/reference-workflows/`, `dashboard/Messe-Admin-Hub.html`. Different environment and trust model. |
| Astra dashboard integration | `ops/astra-package/`: overview, decision, handoff, report and checksums. Original package provenance. |
| Snapshot API and rollout | [API contract](DASHBOARD_API.md), [dashboard deployment](DASHBOARD_DEPLOYMENT.md), [original security review](SECURITY_REVIEW.md), [rollback](ROLLBACK.md). Read later corrections too. |
| WBS-TF-04/05 | [review report](WBS_TF_04_REPORT.md), [staging result](WBS_TF_04_STAGING_RESULT.md), [independent review](WBS_TF_05_INDEPENDENT_REVIEW.md). Code, database and staging gates have distinct scope. |
| WBS-TF-06/07/08 | [F3B preparation](WBS_TF_06_F3B_PREP.md), [preflight](WBS_TF_07_PRODUCTION_PREFLIGHT.md), [release packet](WBS_TF_08_RELEASE_PACKET.md), [acceptance tests](WBS_TF_08_ACCEPTANCE_TESTS.md). Original operator environment, approval gates and rollback history. |
| WBS-TF-10 | [handover](WBS_TF_10_HANDOVER.md). Later observations supersede selected older baseline deployment claims. |
| Full CRM R2 | [integration design](WBS_MESSE_HUB_FULL_INTEGRATION.md), [test report](R2_TEST_REPORT.md), `docs/evidence/r2/`. Decisions on serialized writes, safe undo, minimized AI context and non-destructive rollback. |
| Real n8n integration | [LIVE-01 report](WBS_TF_N8N_LIVE_01_REPORT.md), [harness README](../integration/n8n-live-01/README.md), `integration/n8n-live-01/evidence/`. Source SHA and synthetic fixture scope matter. |
| RC3.1–3.3 | [operator gate](RC3_1_OPERATOR.md), [RC3.3 deployment plan](WBS_TF_RC33_DEPLOYMENT_PLAN.md), focused tests in `tests/integration/`, `verify-published.mjs`. Historical plan contains code mismatches; see the public security review. |
| SQL and operational evidence | `sql/`, `sql/staging_evidence/`, `ops/nginx/`. DDL, incremental migrations, catalog/ACL outputs and syntax evidence; not a complete installation. |

The review/PR history preserves intermediate defects and superseded decisions. A “PASS” in one record proves only its stated checks, source SHA and environment. Prefer the executable contract plus newer correction evidence when records disagree; report unresolved discrepancies rather than silently treating a plan as executed.
