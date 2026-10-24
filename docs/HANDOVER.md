# Handover

The baseline collection section (WBS-TF-BASELINE-01) is kept intact below
for history. The dashboard integration section (WBS-TF-03) was added by a
follow-up task on branch `feature/astra-dashboard`.

---

# WBS-TF-03 — Dashboard integration

**Branch:** `feature/astra-dashboard`
**Base:** `baseline/live-2026-10-24` at commit `854f247…`
**Date:** 2026-10-24

**Readiness summary**

| Gate | State | Why |
| --- | --- | --- |
| **CODE READY** | ✅ | Hand-written integration applied; 38/38 mock tests pass (`tests/test_gateway_baseline.mjs`, `tests/test_dashboard.mjs`, `tests/test_gateway_dashboard.mjs`). |
| **DB READY** | ⏳ | Blocked on Neon DDL review as a role with `SELECT` on `processing_results` and `email_outbox`. See `docs/DASHBOARD_DEPLOYMENT.md` §B. |
| **STAGING READY** | ⏳ | Blocked on DB READY **and** a Dockerfile/compose that installs `pg` inside the gateway image (the live container has no `node_modules`). See `docs/DASHBOARD_DEPLOYMENT.md` §D. |
| **PRODUCTION READY** | ⏳ | Blocked on STAGING READY + Owner sign-off + Gate F3B confirmation that nginx forwards `/dashboard*` and `/api/dashboard`. |

## Patcher outcome

Astra's `scripts/apply_dashboard.mjs` is **not committed**. Two of its five
anchors reference an older/different gateway variant and do not exist in
the real `854f247` baseline:

- `  const publicEnabled = env.PUBLIC_FORM_ENABLED === 'true';` as a
  standalone line — the baseline inlines it into the `return { … }` block.
- `publicEnabled, publicPrivacyNoticeUrl, secureCookies, clientIpMode,
  trustedProxyIps,` — the baseline has no `publicPrivacyNoticeUrl`,
  `clientIpMode`, or `trustedProxyIps`.

Running the patcher would have failed closed by design, so I did not
force it. The equivalent semantic change was applied by hand to
`gateway/server.mjs` with the same `WBS-TF-02 DASHBOARD` marker comments.
Astra's provenance docs are preserved under `ops/astra-package/` for
traceability.

## What was done

- Added `gateway/dashboard-{api,db}.mjs`, `web/dashboard.{js,css}`,
  `web/Messe-Admin-Hub.html`, `sql/dashboard_snapshot.sql`,
  `sql/PREFLIGHT_READ_ONLY.sql`.
- Patched `gateway/server.mjs` to extend `loadConfig()`
  (`DASHBOARD_ENABLED`, `DASHBOARD_DATABASE_URL`), `createGateway()`
  (`dashboardStore` option, lazy adapter instantiation) and the HTTP
  handler (new routes `/api/dashboard`, `/dashboard`, `/dashboard.js`,
  `/dashboard.css`).
- Added `pg@^8.16.3` to `gateway/package.json`; generated
  `gateway/package-lock.json` without downloading `node_modules` into the
  repo (`npm install --package-lock-only`).
- Added test suites:
  - `tests/test_gateway_baseline.mjs` — 8 new regression tests that cover
    `/healthz`, static assets, login/logout, capture, status, public form
    disabled, dashboard inert when disabled.
  - `tests/test_dashboard.mjs` — 25 Astra tests (pagination, filter
    validation, contract validation, SQL binding, read-only transaction,
    TLS verification, no mutating SQL in migration).
  - `tests/test_gateway_dashboard.mjs` — 5 Astra tests (fail-closed
    config, auth gating, assets served, 503 on store error, 405 on write).
  - `node --test tests/*.mjs` → **38 pass, 0 fail**.
- Wrote `docs/DASHBOARD_API.md`, `docs/DASHBOARD_DEPLOYMENT.md`,
  `docs/ROLLBACK.md`, `docs/SECURITY_REVIEW.md`.

## What was explicitly **not** touched

- `baseline/live-2026-10-24`, `main`.
- `/opt/wbs-trade-fair/` on the VPS, systemd, nginx, Docker containers.
- n8n workflows (no import, activation or execution).
- Neon schema or rows.

## Known gaps / blockers

1. **Partial DDL verification.** `dashboard_snapshot` reads columns on
   `processing_results` (`score_total`, `score_band`, `result_payload`,
   `created_at`) and `email_outbox` (`status`, `last_error_code`,
   `updated_at`) that the baseline's `trade_fair_app` role cannot
   `SELECT`. The index inventory already in `sql/trade_fair_schema.txt`
   confirms the key columns exist (`processing_results_pkey` on
   `lead_id`, `email_ready_queue` filtering on `status`, etc.), but
   non-key column *names* are still unverified. **Blocks DB READY.**

2. **`pg` not present in the live container.** The live container
   mounts the gateway dir read-only from the host. Adding a dependency
   requires either a thin Dockerfile that runs `npm ci --omit=dev` or an
   equivalent init strategy. **Blocks STAGING READY.**

3. **Dashboard role.** Should `trade_fair_app` be reused as
   `dashboard_role` (expanding its visibility) or should a dedicated
   least-privilege role be provisioned? Default recommendation in this
   repo is a dedicated role. **Decision needed before Neon migration.**

4. **nginx vhost** (Gate F3B). Needs to forward
   `/dashboard*` and `/api/dashboard` through the existing same-origin
   policy. Not in scope here. **Blocks PRODUCTION READY.**

## Black-side next steps (handover)

1. Pull `feature/astra-dashboard` locally.
2. Run `node --test tests/*.mjs` to confirm the 38/38 result on the
   reviewer's own machine.
3. Decide (with the Owner): reuse `trade_fair_app` as `dashboard_role` or
   provision a dedicated role? Record the decision in a new ADR before
   touching Neon.
4. On an isolated Neon branch, run `sql/PREFLIGHT_READ_ONLY.sql` and
   diff its column list against `docs/DASHBOARD_API.md`'s "Data
   provenance" expectations. If a column name differs, update
   `sql/dashboard_snapshot.sql` on this branch rather than deploying a
   mismatching function.
5. On the same isolated branch, run `sql/dashboard_snapshot.sql` with
   `-v dashboard_role=<approved>` and verify positive + negative smokes
   (`docs/DASHBOARD_DEPLOYMENT.md` §C).
6. Build a candidate gateway image with `pg` installed; deploy on
   staging with `DASHBOARD_ENABLED=true`. Run the staging acceptance in
   `docs/DASHBOARD_DEPLOYMENT.md` §E.
7. Only after Owner approval + Gate F3B confirmation, roll to
   production. Rollback plan in `docs/ROLLBACK.md`.

## Resuming this task if interrupted

- All completed safe work is committed on `feature/astra-dashboard`.
- The last commit SHA is the latest tip of that branch.
- The Draft PR targets `baseline/live-2026-10-24`, **not** `main`, so a
  merge is impossible without first merging the baseline PR.
- No external system is in an inconsistent state because none was
  modified.

---

# WBS-TF-BASELINE-01 (preserved history)

**Status:** PASS (with one documented data gap, see §Gaps below).

**Date:** 2026-10-24.

**Branch:** `baseline/live-2026-10-24` on `klareki-lab/wbs-trade-fair-assistant`.

## What was done

- Captured the four live n8n workflows from container `n8n-n8n-1` into
  `workflows/`, including the 2026-10-24 WF-B fix.
- Copied the live gateway (`server.mjs`, `README.md`, `package.json`) and web
  frontend (`index.html`, `styles.css`, `app.js`, `berater.html`,
  `berater-adapter.js`) from `/opt/wbs-trade-fair/trade_fair_assistant/` on
  the VPS. No node_modules, no `.env`, no `access-key.txt`.
- Extracted the Neon schema `trade_fair` metadata into
  `sql/trade_fair_schema.txt` using the live Postgres credential **in place**
  on the VPS; the decrypted credential was `shred`-ed before `ssh` disconnect.
- Unzipped Yuriy's `Messe-Hub-fuer-Sergii.zip` from
  `~/Downloads/Telegram Desktop/` and placed `Messe-Admin-Hub.html`,
  `ANLEITUNG.md`, and the 8 reference workflows under `dashboard/`.
- Wrote the baseline docs: `README.md`, `.gitignore`, `.env.example`,
  `docs/ARCHITECTURE.md`, `docs/LIVE_BASELINE.md`,
  `docs/WORKFLOW_MANIFEST.md`, `docs/DEPLOYMENT.md`, this file.
- Ran pattern + structural secret scans; zero hits in staged files.

## What was explicitly **not** touched

- `main` branch of this repository.
- VPS files, systemd units, nginx config, Docker containers.
- n8n workflows (no activation, no execution, no modification).
- Neon schema and rows.
- `/opt/wbs-trade-fair/secrets/`.

## Gaps / known limitations

1. **Partial column metadata for 4 of 7 tables in `trade_fair`.** The
   `trade_fair_app` role has no SELECT on `processing_results`,
   `email_outbox`, `job_events`, `schema_migrations`. The baseline captures
   indexes and procedure signatures for them, which is enough for a reviewer
   to understand their role in the pipeline, but not the full column list.
   To close: run `pg_dump --schema-only -n trade_fair` as a higher-privilege
   Neon role.

2. **`tests/` is empty.** The gateway's `package.json` references
   `tests/test_gateway.mjs`, but that file is not present on the live VPS.
   Either the live tests were never deployed, or they live in a workspace
   outside `/opt/wbs-trade-fair/`. To close: locate the authoritative test
   file (ask Yuriy or search operator laptops) and commit it on a
   separate PR.

3. **nginx vhost config** for the gateway is out of scope (Gate F3B).

4. **Workflow `active: false` in exports** is a known n8n CLI behavior and
   does **not** reflect the real activation state. The manifest explicitly
   notes this.

## Suggested next task (Astra)

**WBS-TF-01: Close the schema-metadata gap and publish a full migration
baseline.**

1. Request / provision read access to `trade_fair` on Neon with sufficient
   privilege to `pg_dump --schema-only -n trade_fair` cleanly (role
   `trade_fair_owner` or a superuser role that owns the four tables that
   `trade_fair_app` cannot SELECT today). Do **not** reuse the live
   `trade_fair_app` credential for this purpose.
2. Commit the resulting full-DDL dump as `sql/trade_fair_schema.sql` on a
   new branch; keep the current `sql/trade_fair_schema.txt` as the
   least-privilege reproducibility baseline.
3. In the same PR, write `sql/README.md` describing the semantics of each of
   the nine SECURITY DEFINER functions (`capture_lead`, `claim_processing`,
   `finish_processing`, `fail_processing`, `claim_email`, `begin_email_send`,
   `finish_email_send`, `fail_email_send`, `get_lead_status`), driven from
   their bodies.
4. Open as a Draft PR targeting `main`, link back to this baseline PR.

Lower-priority follow-ups (do only after WBS-TF-01):

- Recover or rewrite `tests/test_gateway.mjs` so `npm test` passes against
  the Node 22 gateway code shipped in this baseline.
- Decide whether `dashboard/` (Yuriy's HTML + reference workflows) belongs in
  this repository long-term or should move to its own.
- Add a `compose.yml` (or systemd unit) describing the gateway container.
  Today it is launched by `docker run`, which is an operational foot-gun on
  reboot.

## Resuming this task if interrupted

If this baseline run was interrupted mid-flight, the recovery procedure is:

1. The staged artefacts are already present in the repo tree. Re-running
   collection is **safe only** if no changes have been applied to the VPS or
   the workflows in the meantime.
2. The branch `baseline/live-2026-10-24` is the record. Open its Draft PR to
   see the exact SHA at which capture stopped.
3. Any step 1–5 of the dispatch can be re-run idempotently without touching
   `main`, Neon, n8n, or the VPS, except for the credential decryption step,
   which must be re-done inside the n8n container and the decrypted file
   `shred`-ed on the VPS before disconnecting.
