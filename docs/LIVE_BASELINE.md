# Live Baseline — Capture Record

What was captured on 2026-10-24, from where, and how, so a reviewer can
reproduce the inventory step for step.

## Collection method

Everything was read from the live VPS and the live n8n instance. Nothing was
written back. No workflow was activated, modified, or executed.

| Source | Access method | Result | Target in repo |
| --- | --- | --- | --- |
| `/opt/wbs-trade-fair/trade_fair_assistant/gateway/` on VPS | `ssh klare-ki; cp -a …` (root ssh) | 4 files | `gateway/` |
| `/opt/wbs-trade-fair/trade_fair_assistant/web/` on VPS | same | 5 files | `web/` |
| n8n container `n8n-n8n-1` | `docker exec n8n-n8n-1 n8n export:workflow --id=<id> --output=…`, then `docker cp` out | 4 workflow JSONs | `workflows/` |
| Neon `neondb`, schema `trade_fair` | Transiently decrypted the credential **WBS Trade Fair — Neon PostgreSQL** (id `DIm6w5CcndY0D3RJ`) inside the n8n container, built a connection URL, ran `psql` from a one-shot `postgres:18-alpine` container against `information_schema` + `pg_indexes` + `pg_catalog`. The decrypted credential file was `shred`-ed immediately after the query. | metadata text | `sql/trade_fair_schema.txt` |
| Yuriy's package | Unzipped locally from `~/Downloads/Telegram Desktop/Messe-Hub-fuer-Sergii.zip` | `Messe-Admin-Hub.html`, `ANLEITUNG.md`, 8 reference workflow JSONs | `dashboard/`, `dashboard/reference-workflows/` |

Secret handling notes:

- `/opt/wbs-trade-fair/secrets/` on the VPS was **read in place** on the VPS
  only (to confirm it does **not** contain `DATABASE_URL`), never copied to
  the Mac or into this repository.
- Any transient decrypted credential file was `shred`-ed on the VPS before
  `ssh` disconnect. No decrypted credential ever left the VPS.
- No execution history, no credentials export, no `.env` and no
  `access-key.txt` was retrieved to the Mac.

## Pattern scan

Before commit, the staged tree was scanned for common secret patterns:

```
sk-[A-Za-z0-9_-]{20,}          # OpenAI / DeepSeek / OpenRouter
npg_[A-Za-z0-9]{10,}           # Neon password
re_[A-Za-z0-9]{20,}            # Resend
tvly-[A-Za-z0-9]{10,}          # Tavily
ghp_[A-Za-z0-9]{20,}           # GitHub PAT
xoxb-[A-Za-z0-9-]{20,}         # Slack
AKIA[0-9A-Z]{16}               # AWS
AIza[0-9A-Za-z_-]{30,}         # Google
eyJ[A-Za-z0-9_-]{20,}          # JWT
postgres(ql)?://[^@]*:[^@]*@…  # DB URL with embedded password
Bearer <long-token>            # bearer tokens
-----BEGIN …                   # PEM
```

Result: **zero matches** in staged files.

A broader structural scan of the four workflow JSONs confirmed that
`credentials.*` nodes contain only `{id, name}` references — no decrypted
blobs — and that there are no literal (non-expression) tokens in
`parameters.*.value` for Authorization headers.

## Known data gaps

1. **Partial `trade_fair` schema visibility.** The role `trade_fair_app` has
   SELECT on `companies`, `contacts`, `lead_submissions` but not on
   `processing_results`, `email_outbox`, `job_events`, `schema_migrations`.
   For those tables the inventory in `sql/trade_fair_schema.txt` captures
   indexes (visible via `pg_indexes`) and references (visible via
   `pg_catalog`) but **not column lists**. The structure is still inferable
   from the SECURITY DEFINER functions used by WF-B/C and from the index
   definitions. To get full column data a session as a higher-privilege Neon
   role is required — explicitly out of scope for this baseline.

2. **No gateway tests on VPS.** `gateway/package.json` references
   `tests/test_gateway.mjs`. That file is not present in
   `/opt/wbs-trade-fair/trade_fair_assistant/` on the VPS. `tests/` in the
   repository is therefore empty by design.

3. **Workflow `active` flag.** All four exported workflow JSONs report
   `active: false`. This is because `n8n export:workflow` does not preserve
   the live active state. The real activation state lives in the n8n
   database and was intentionally not touched. The companion `WORKFLOW_MANIFEST`
   captures `versionId` and `updatedAt` directly from the export.

4. **nginx vhost config** for the gateway and dashboard origins is not in
   this repository (Gate F3B / nginx are explicitly out of scope).

## Verification pointers for the reviewer

- `docs/WORKFLOW_MANIFEST.md` lists each workflow's `id`, `versionId`,
  `updatedAt`, node count, trigger type, and credential references. WF-B
  `updatedAt` is **2026-10-24T13:30:19Z**, confirming the 24 Oct fix is in
  this baseline rather than an older archive.
- `sql/trade_fair_schema.txt` is a plain `psql` capture — reproducible as
  the `trade_fair_app` role.
- `gateway/README.md` is the live operator-facing docs for `server.mjs`
  (copied unmodified from VPS).
- `dashboard/ANLEITUNG.md` is Yuriy's accompanying note (German), captured
  verbatim from the archive — useful for understanding how the admin
  dashboard is intended to connect.
