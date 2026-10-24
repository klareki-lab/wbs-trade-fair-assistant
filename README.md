# WBS Trade Fair Assistant — Live Baseline

Snapshot of the running Trade Fair Assistant as it exists on the production VPS on **2026-10-24**.

This repository is a **baseline / inventory**, not a build. It records the exact artefacts
powering the live system so that another engineer can inspect, review and plan the next
iteration without inferring state from screenshots or chat logs.

## Layout

| Path | Content |
| --- | --- |
| `gateway/` | Live Node.js gateway (`server.mjs`, `package.json`, `README.md`). Served by Docker container `wbs-trade-fair-gateway` on the VPS. |
| `web/` | Live frontend (`index.html`, `styles.css`, `app.js`, `berater.html`, `berater-adapter.js`). Mounted into the gateway container at `/app/web`. |
| `workflows/` | The four live n8n workflows exported directly from container `n8n-n8n-1` on 2026-10-24. Credential **references** only — no decrypted secrets. |
| `dashboard/` | Yuriy's "Messe-Hub" admin dashboard (`Messe-Admin-Hub.html` + `ANLEITUNG.md`) as delivered. |
| `dashboard/reference-workflows/` | The 4 workflow variants plus 4 companion workflows (05–08) from Yuriy's package. **Reference material**; not imported into live n8n. |
| `sql/` | Metadata of the Neon schema `trade_fair` (table / column / index inventory). No rows. |
| `tests/` | Reserved. The gateway's `package.json` points to `tests/test_gateway.mjs`, which does not exist on the live VPS (see HANDOVER). |
| `docs/` | Baseline documentation (see below). |
| `ops/` | Reserved for operational notes added by follow-up tasks. |

## Documentation

- `docs/ARCHITECTURE.md` — components, dataflow, trust boundaries.
- `docs/LIVE_BASELINE.md` — exactly what was captured, from where, and verification notes.
- `docs/WORKFLOW_MANIFEST.md` — workflow IDs, versions, trigger types, credential references.
- `docs/DEPLOYMENT.md` — observed container / mount / env configuration (no secrets).
- `docs/DASHBOARD_API.md` — read-only `/api/dashboard` contract (candidate, off by default).
- `docs/DASHBOARD_DEPLOYMENT.md` — historical WBS-TF-03 candidate procedure.
- `docs/WBS_TF_04_REPORT.md` — independent review, confirmed DDL, smoke tests, current gates and staging handover.
- `docs/SECURITY_REVIEW.md` — dashboard-specific security review and open decisions.
- `docs/ROLLBACK.md` — rollback phases for the dashboard rollout.
- `docs/HANDOVER.md` — baseline gaps + dashboard readiness summary (CODE/DB/STAGING/PRODUCTION).

Astra's WBS-TF-02 provenance (overview, decision record, test report,
SHA256SUMS) is preserved under `ops/astra-package/`.

## Safety

- The repository is **public**. No real secrets were committed.
- `.env` and secret bundles are explicitly ignored; see `.env.example` for the required gateway variables.
- Workflow exports contain credential **references** (`id` / `name`) only; the n8n encryption key is **not** in this repository.
- The Neon connection string, the gateway access key and the `X-Trade-Fair-Key` header value live only on the VPS, under `/opt/wbs-trade-fair/secrets/` and inside the n8n credential store.

## Source of truth

- Live gateway files: VPS `/opt/wbs-trade-fair/trade_fair_assistant/{gateway,web}/`
- Live workflows: Docker container `n8n-n8n-1`, exported via `n8n export:workflow --id=<id>`.
- Schema metadata: Neon database `neondb`, schema `trade_fair`, read as role `trade_fair_app`
  (which is the role the live n8n Postgres credential uses).

This baseline was collected without modifying the VPS, n8n, Neon, or any live workflow.
