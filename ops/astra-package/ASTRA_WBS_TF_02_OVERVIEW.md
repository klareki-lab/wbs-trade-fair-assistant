# WBS-TF-02 — Dashboard Integration (candidate, NOT deployed)

**Authoritative source:** `klareki-lab/wbs-trade-fair-assistant`, base commit `854f247546742fd69cc5c81385cf2b73657d440b` (`baseline/live-2026-10-24`), target branch `feature/astra-dashboard`.

**Important provenance limitation:** this sandbox could not clone the actual base commit from GitHub (DNS unavailable). The implementation was developed as an **overlay** with fail-closed patcher, and locally exercised against a *historical* 2.0.1 gateway archive strictly as a compatibility reference. Therefore the package is a tested integration candidate, **not a verified patch against the specified commit**. The PR/commit SHA are PENDING. No production changes occurred.

## Architecture

`Browser /dashboard -> existing Gateway authenticated session -> GET /api/dashboard -> read-only PostgreSQL transaction -> trade_fair.dashboard_snapshot(...) -> existing Neon tables`

Chosen over Yuri's WF 05: No additional n8n webhook, Basic Auth, CORS rules, n8n Data Table, or extra published workflow. WF-A, WF-B, WF-C and WF-D remain unchanged. Existing mobile form stays at `/`.

`pg` (Node postgres driver) is the sole proposed new server-side package; it is necessary because this read-only path does not use n8n and the baseline Gateway has no PostgreSQL driver. No new infrastructure service is added. Production enablement is opt-in (`DASHBOARD_ENABLED=true`) and never automatic.

## Scope

- `web/Messe-Admin-Hub.html`, `dashboard.css`, `dashboard.js`: Yuri's visual design retained (palette, cards, sidebar, drawer, responsive CSS), security-reworked. No browser secrets, external CDN, chats, merge/split/delete, direct Neon or n8n calls.
- `gateway/dashboard-api.mjs`: validated server-side query contract.
- `gateway/dashboard-db.mjs`: optional server-only PG read-only transaction and bounded pool.
- `sql/dashboard_snapshot.sql`: **optional reviewed** additive function + one EXECUTE grant to an approved existing role; never auto-applied.
- `sql/PREFLIGHT_READ_ONLY.sql`: database metadata inspection, read-only.
- `scripts/apply_dashboard.mjs`: patcher for `gateway/server.mjs` + `gateway/package.json`, verifying exact base SHA and new branch before changing code. Aborts if code anchors differ. Test-only override is explicitly named and must never be used for release.
- `tests/test_dashboard.mjs`, `tests/test_gateway_dashboard.mjs`: API/security and authenticated HTTP tests with fake backend.
- `DEPLOY.md`, `ROLLBACK.md`, `API_CONTRACT.md`, `TEST_REPORT.md`, `HANDOFF.md`.

## State / gates

Local **mock** PASS is not Neon or VPS E2E. DDL review and explicit database role approval are REQUIRED before running optional SQL. Actual commit alignment, npm installation, real Neon test, server path reachability and browser acceptance are PENDING. See `HANDOFF.md`.
