# Architecture

Observed on 2026-10-24 from the running system. All facts in this document come
from the live VPS (`n5n.klare-ki.de`), the live n8n instance, or the Neon
schema `trade_fair`.

## Components

```
Browser ──HTTPS──► nginx (VPS) ──127.0.0.1:3000──► wbs-trade-fair-gateway (Node 22)
                                                        │
                                                        │ (server-side fetch)
                                                        │   X-Trade-Fair-Key: <N8N_HEADER_KEY>
                                                        ▼
                                              n8n-n8n-1  (Docker, 2.41.7)
                                                        │
                                   ┌────────────────────┼───────────────────────┐
                                   │                    │                       │
                              WF-A (webhook)      WF-B (schedule)        WF-C/D (schedule+webhook)
                                   │                    │                       │
                                   └──────► Neon PostgreSQL  schema `trade_fair`
                                                   │
                                             (role `trade_fair_app`)
```

## Live container inventory

| Container | Role | Image | Mounts | Networking |
| --- | --- | --- | --- | --- |
| `wbs-trade-fair-gateway` | Node gateway (`node server.mjs`) | `node:22-alpine` | `/opt/wbs-trade-fair/trade_fair_assistant/{gateway,web}` → `/app/{gateway,web}` (ro) | Not host-published; reachable only on the Docker network / via nginx. |
| `n8n-n8n-1` | n8n orchestrator | n8n 2.41.7 | `/root/n8n/n8n_data` → `/home/node/.n8n`; `/srv/pam-state`, `/opt/pam/runtime/wfa` (used by *other* workflows on this instance) | Per n8n stack. |

The gateway container is **not** orchestrated by docker-compose on this VPS;
it was launched with `docker run`. See `DEPLOYMENT.md`.

## Gateway

Runnable Node app with **no npm dependencies**. All HTTP, crypto and fetch are
from Node's built-ins. Entry point `gateway/server.mjs`. Browser routes and the
trust model are documented in `gateway/README.md` (that file was copied
verbatim from the live VPS).

Key points, in brief:

- Session cookie: HMAC-signed, HttpOnly, SameSite=Strict, 8h TTL.
- Origin check: every mutating request must have `Origin` exactly equal to
  `APP_ORIGIN`. No wildcard CORS.
- Rate limits: in-memory, single-process. `/healthz` is a liveness probe only.
- The gateway does **not** connect to Neon. All DB access is through n8n.
- `source` is overwritten server-side (`internal_form` / `public_form`).

## n8n workflows

Four live workflows together implement the capture → processing → delivery
pipeline. Full IDs and versions in `docs/WORKFLOW_MANIFEST.md`.

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| WF-A Lead Capture | HTTP webhook (from gateway) | Validate input, call `trade_fair.capture_lead(...)` on Neon, return receipt. |
| WF-B Lead Processing | Schedule | Claim queued leads (`claim_processing`), enrich via Tavily + OpenAI (via Requesty), finalize via `finish_processing` / `fail_processing`. |
| WF-C Sales Email Delivery | Schedule | Claim `email_outbox` rows (`claim_email`), send via Resend, update via `finish_email_send` / `fail_email_send`. |
| WF-D Lead Status | HTTP webhook (from gateway) | Server-to-server read of `get_lead_status` for the authenticated UI poll. |

All four workflows reference the same Postgres credential (**WBS Trade Fair —
Neon PostgreSQL**, id `DIm6w5CcndY0D3RJ`) and the same Gateway Auth credential
where applicable.

## Data

Schema `trade_fair` in Neon database `neondb`.

Base tables (confirmed via `information_schema` and `pg_indexes` as role
`trade_fair_app`):

- `companies` — company master.
- `contacts` — people linked to a company; unique-when-verified on `(company_id, email)`.
- `lead_submissions` — queue + ledger; lease-based processing (`processing_lease_token`, `processing_lease_expires_at`); idempotency on `(source, submission_id)`.
- `processing_results` — one row per completed lead; `completion_token` unique.
- `email_outbox` — queue for outbound sales email; lease-based (`lease_expires_at`).
- `job_events` — audit trail per lead / email.
- `schema_migrations` — Postgres migration ledger (role `trade_fair_app` has no SELECT on this one).

Logical relationships (no declared FKs — enforced in SQL functions):

```
companies.company_id   ◄── contacts.company_id
companies.company_id   ◄── lead_submissions.company_id
contacts.contact_id    ◄── lead_submissions.contact_id (optional)
lead_submissions.lead_id ◄── processing_results.lead_id
lead_submissions.lead_id ◄── email_outbox.lead_id
lead_submissions.lead_id ◄── job_events.lead_id
email_outbox.outbox_id   ◄── job_events.outbox_id
```

Stored procedures (SECURITY DEFINER — role `trade_fair_app` can only
read/write via these, not by direct `INSERT/UPDATE` to the tables that are
not SELECT-able to it):

`capture_lead`, `claim_processing`, `finish_processing`, `fail_processing`,
`claim_email`, `begin_email_send`, `finish_email_send`, `fail_email_send`,
`get_lead_status`.

See `sql/trade_fair_schema.txt` for the full inventory.

## Trust boundaries

- Browser never sees n8n webhook URLs or the `X-Trade-Fair-Key`.
- Gateway sees the access key for a session cookie; after login it sees only
  the session HMAC. Upstream calls carry only the configured
  `X-Trade-Fair-Key`; cookies and `X-Forwarded-For` are **not** forwarded.
- n8n holds the Neon credential. The gateway cannot query Neon directly.
- Neon enforces least privilege through the `trade_fair_app` role + SECURITY
  DEFINER functions.

## Not in this baseline

- nginx vhost config (lives on the VPS; untouched by this task).
- The companion "Messe-Hub" dashboard workflows (05–08) and Yuriy's
  `Messe-Admin-Hub.html` dashboard — present as **reference only** under
  `dashboard/` and `dashboard/reference-workflows/`. They are **not** imported
  into the live n8n.
