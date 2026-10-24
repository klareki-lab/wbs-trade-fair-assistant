# Handover — WBS-TF-BASELINE-01

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
