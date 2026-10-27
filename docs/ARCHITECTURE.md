# Architecture overview

This guide describes RC3.3 repository source at `49693b3`, not a new observation of production. The original October 24 architecture is preserved in [history](history/ARCHITECTURE_LIVE_BASELINE.md). Consult the [status matrix](PROJECT_STATUS.md) before treating a component as deployed.

## Components and boundaries

| Component | Responsibility | Main source |
| --- | --- | --- |
| Capture UI | Structured entry, stable retry identity, receipt and polling | `web/index.html`, `app.js`, `berater.html`, `berater-adapter.js` |
| Admin UI | Dashboard, groups/history, confirmed AI capture, bounded assistant | `web/Messe-Admin-Hub.html`, `dashboard.js`, `dashboard.css` |
| Gateway | Static routes, scoped login/session, Origin checks, input limits, webhook forwarding | `gateway/server.mjs` |
| Snapshot adapter | Validated filters, fixed parameterized function call, read-only transaction | `gateway/dashboard-api.mjs`, `dashboard-db.mjs` |
| CRM adapter | Validated mutations, audit actor, fixed database function calls | `gateway/dashboard-crm.mjs` |
| n8n | Capture/status webhooks, scheduled processing/delivery, optional AI endpoints | `workflows/` |
| PostgreSQL | Submission ledger, leased queues, results/outbox, virtual groups and audit | `sql/` |
| External providers | Research, inference, internal report transport | WF-B/C and adapted WF-07/08 |

A reverse proxy terminates HTTPS in the original infrastructure. Proxy/Docker files under `ops/` describe that environment; they are examples and history for independent readers, not infrastructure provisioners.

## End-to-end capture and processing

```mermaid
sequenceDiagram
  participant U as Browser
  participant G as Gateway
  participant A as WF-A
  participant P as PostgreSQL
  participant B as Scheduled WF-B
  participant C as Scheduled WF-C
  participant E as Resend
  U->>G: Login; submit stable submission_id
  G->>A: Validated payload + server header auth
  A->>P: capture_lead(payload)
  P-->>A: Persisted receipt / replay / conflict
  A-->>G: Capture outcome
  G-->>U: Receipt
  B->>P: Claim processing lease
  Note over B: Research; evidence-checked extraction; deterministic score
  B->>P: Finish result and prepare outbox
  C->>P: Claim and fence send
  C->>E: Internal report with idempotency key
  C->>P: Accepted / failed / uncertain
  U->>G: Status read with lead/submission pair
  Note over G,P: Gateway calls WF-D, which calls get_lead_status
```

The synchronous receipt proves capture, not successful research or email delivery. A browser timeout may occur after commit: retry must preserve the submission ID and exact payload. A 409 is a reconciliation problem, not permission to silently create another submission.

Workers use lease tokens and database transitions to reject stale work. An outbox separates processing completion from sending. Ambiguous provider outcomes require attention; local evidence does not establish exactly-once delivery across the database/provider boundary.

## Data model and SQL availability

`companies` and `contacts` represent normalized identities. `lead_submissions` holds raw/normalized capture data, receipts, idempotency keys, duplicate indicators, and processing state. `processing_results` holds extraction/research/score/report payloads; `email_outbox` holds delivery state. Historical inventory also describes `job_events` and a migration ledger.

RC CRM adds `lead_groups`, `lead_group_members`, and `lead_group_audit`. Grouping changes virtual membership, not original capture records. A partial unique index permits at most one current membership per lead, including ignored groups. Writes take an advisory lock before reading CRM state and lock affected leads in stable order. Undo restores recorded state only while no later overlapping event invalidates it. Audit actors identify a shared-key session, not a verified employee.

The repository contains table DDL and incremental dashboard/CRM SQL, but **does not contain a complete production processing schema/function bootstrap**. The older schema inventory is partial and must not be treated as a full migration. [Reproduction guidance](REPRODUCE_IT_YOURSELF.md) identifies missing contracts.

## Admin and AI paths

Dashboard GET → gateway → `dashboard_snapshot(...)` uses a read-only transaction and verified PostgreSQL TLS. CRM POST → gateway → named mutation functions uses a separate write path. The current gateway therefore has a `pg` dependency and direct database access; the baseline claim that all database traffic flows through n8n no longer describes this source.

WF-07 receives a note after the user permits provider analysis. Structured output is checked against exact evidence and enums; missing facts become null. The user confirms proposed fields before a separate WF-A submission. The summary does not replace original notes.

WF-08 receives explicit IDs and a question, derives supported topics locally, and reads `trade_fair.ai_lead_context(jsonb)` using a dedicated scoped login. The model receives permitted categories and pseudonymous IDs; company/contact names, emails, phone numbers, notes, research, and the raw question are excluded from its context. Claims must match delivered facts and requested fields. The answer is built from validated claims, with citations and an incomplete-coverage warning. Pseudonymous IDs remain linkable data.

RC3.3's verifier compares the actual published n8n snapshot against canonical executable node properties and connections. Checking a draft alone could approve code different from what a webhook executes. Credential rebinding and selected metadata are allowed; executable deviations fail closed. This validates provenance, not the truth of database facts or effective credential permissions.

## Trust and operating limits

- Browser → gateway: HMAC-signed HttpOnly/SameSite=Strict sessions; HTTPS origin enables Secure cookies; exact Origin checks for mutations. Form and dashboard scopes are separate.
- Gateway → n8n: configured upstreams, server-side `X-Trade-Fair-Key`, no browser cookie forwarding, bounded responses, no redirects. AI upstream origins/transports are constrained.
- Gateway/n8n → database: parameterized calls and role boundaries. Review effective grants, memberships, PUBLIC privileges, function ownership and `search_path` on your database.
- n8n → providers: research, notes, and reports expose different data. Workflow `store:false`/execution settings do not control all provider, proxy, or instance logs.
- Shared keys provide no per-person authorization. Rate limits are in-memory and tied to socket peers; proxy traffic may share a bucket. Horizontal scaling, tenancy, throughput, and comprehensive monitoring are not established by local tests.

See [security findings](PUBLIC_SECURITY_REVIEW.md) and [workflow contracts](WORKFLOW_GUIDE.md).
