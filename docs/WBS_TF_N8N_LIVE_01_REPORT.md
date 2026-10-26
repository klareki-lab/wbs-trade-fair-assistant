# WBS-TF-N8N-LIVE-01 — real n8n integration report

2026-10-26. **ISOLATED INTEGRATION PASS; PRODUCTION HOLD.**

Actual n8n **2.41.7** executes WF-07 and WF-08 via registered `/webhook/` routes with
Owner-designated staging OpenAI credentials. A separate Gateway completed real capture
through an isolated WF-A into PostgreSQL, human field confirmation, lost-receipt retry,
idempotent persistence, Dashboard refresh, actual WF-D status and WF-08 saved-lead query.
No n8n-equivalent proxy is used in this path.

The original RC alone did NOT pass real n8n acceptance. This package includes a separate
integration candidate with explicit workflow adaptations. Source workflow/Gateway/SQL
files were not edited. Black CC's working checkout and production were not modified.
This is integration-author evidence, not independent sign-off on Codex's adaptations.

## Source and exact artifact identity

- Requested RC: `6b64f70d340c1bd9fcdefdfadcd27c35d566fd30`.
- Black CC fixes incorporated unchanged from `a9460564c54ebdc0359b65eae1f72d46111746e7`.
- Branch: `codex/n8n-live-01`; exact integration SHA is the Git commit containing this
  report and manifest, supplied in the delivery message. No merge or deploy performed.
- [Frozen manifest](../integration/n8n-live-01/evidence/manifest.json),
  [actual inactive import payloads](../integration/n8n-live-01/published),
  [operator/reproduction instructions](../integration/n8n-live-01/README.md).

## Actual environment and publication

Fresh instance was chosen because existing `wbs-n8n` is a different lab with runner and
workflows; it was left unchanged. New instance has its own SQLite, Docker volume,
encryption key, credential IDs, workflow IDs and loopback port **15679**. Dedicated
local PostgreSQL has synthetic data only; neither shared demo PG nor Neon is used.
Gateway listens on **127.0.0.1:3117**, with local-only fault control on 3118.
No WF-B/C, Resend credential, or email scheduler was imported.

All four isolated workflows were published using n8n's UI Publish dialog. Neither
SQLite active flag edits nor CLI/manual execution were used as registration evidence.

| Workflow | Actual ID | Published version | Actual route |
| --- | --- | --- | --- |
| WF-07 | `live01-wf07` | `caf68ca6-48bf-40b4-9fa4-c9a95aa4d77b` | `/webhook/messe-hub/ai-extract` |
| WF-08 | `live01-wf08` | `4f380f13-8e34-49ef-b0bc-058d5fb99ba3` | `/webhook/messe-hub/ai-ask` |
| Isolated WF-A | `live01-wfa` | `2926ba4b-fe34-4483-aad7-a84136805079` | `/webhook/trade-fair/lead` |
| Isolated WF-D | `9vp2hqXADW2rlNsl` | `e459b39e-3d95-44c1-b5ce-0da16e853ab2` | `/webhook/trade-fair/status` |

Without Header Auth the registered routes return **403**; successful authenticated AI
requests return **200 JSON** through RespondToWebhook. Actual capture returns **201**,
replay **200**. No route success was inferred from active=true.

## Diagnosed blockers in the original source and integration-only changes

1. **Webhook registration:** original WF-07/08 lack node `webhookId`. Reproduced UI
   Published/active=true followed by real HTTP 404. Installed 2.41.7
   `dist/webhooks/webhook.service.js:getStaticWebhookKeys` skips nodes without it.
   Adding IDs in deployment copies and republishing through UI yielded real auth 403
   and authenticated executions. Source workflow files remain unchanged.
2. **Model JSON:** original real-model WF-07 failed 2/3 German-note tests. A saved model
   response contained an extra closing brace; Structured Output Parser correctly failed.
   The separate candidate supplies native strict `response_format: json_schema` via
   actual n8n OpenAI node `extraBody`, using parser 1.3's output wrapper and store:false.
   WF-08 also uses native schema, preserving its exact-claim validation and 20-claim cap.
3. **Canonical enums/missing facts:** original schema had free strings for enum fields;
   Black's normalization changes only affect the equivalent proxy. Candidate schema
   declares canonical enums, prompt requires shortest verbatim evidence/ISO dates, and
   a conservative Code guard prevents explicit missing budget/follow-up discussion
   becoming `no_budget`/`no_follow_up`. The original evidence checker remains in place.
4. **Bootstrap readiness:** `/healthz` became ready before `/rest/owner/setup`; setup
   initially returned 404. Bootstrap now waits for `/rest/settings` before owner setup.

All candidate adaptations are in
[`adapt-workflows.mjs`](../integration/n8n-live-01/adapt-workflows.mjs), separately
reviewable by Black CC. They must be incorporated and reviewed before production.
The missing-fact guard is conservative and narrow; these tests do not establish
universal semantic correctness for arbitrary German notes.

## Evidence and necessary checks

| Check | Result |
| --- | --- |
| Three distinct real German note executions, including Yuri UC-21 | **3/3 HTTP 200**, complete structured envelopes |
| Live AI assertions: schema/enums/missing values/date/grounding/auth | **9 PASS** |
| Real Gateway/n8n/PG E2E assertions | **11 PASS** |
| New Code safety + original workflow contract tests | **5 PASS / 0 FAIL** |
| Gateway/baseline regression, `npm test --prefix gateway` | **67 PASS / 0 FAIL**, Node 24.15.0 |
| Full R2 suite | Not rerun; runtime Gateway/SQL source unchanged |
| Production acceptance/deployment | **NOT RUN / NOT AUTHORIZED** |

- [Final real webhook results](../integration/n8n-live-01/evidence/real-webhooks.json).
- [Original source real failures](../integration/n8n-live-01/evidence/rc-unmodified-real-webhooks.json),
  [intermediate candidate failures](../integration/n8n-live-01/evidence/intermediate-schema-failure.json).
- [Sanitized execution audit: IDs, actual versions, status, token usage](../integration/n8n-live-01/evidence/execution-audit.json).
- [Gateway E2E, DB counts, response/body hashes](../integration/n8n-live-01/evidence/gateway-e2e.json).

Final extraction checks: UC-21 does not assert budget approval and normalizes the
explicit follow-up date to 2026-11-06; DE-02 returns ai_automation / approved /
within_one_week; DE-03 keeps missing budget, follow-up, email, phone and website null.
Original notes are retained locally by the Code postprocessor rather than generated.

WF-08 used the actual scoped PostgreSQL function and real model. Different Score,
Budget and Training questions produced different answers; unscored means unknown,
not an invented number. Citation IDs remained within requested context. Actual saved
LLM `inputOverride` was inspected: IDs/categories only, no contact/company names,
email/phone/notes or raw question. This audits model-node input, not provider retention.

Temporary all/all execution retention was enabled **only on synthetic isolated copies**
for diagnosis and evidence. Finalize restored none/none/manual=false/progress=false;
existing synthetic diagnostic rows remain private for handoff. Credential import file
containing the staging key was removed after encrypted import. No secret values are
in this package. Provider retention/PII decisions for real business data remain gates.

## Human confirmation, exactly-once and retry evidence

Before confirmation: eight fixture leads, zero outbox rows. UI extraction did not persist.
After confirming all populated fields, actual WF-A committed:

- Lead `FAIR-dca39b6f-76f0-467b-974d-c2cb4109d090`.
- Submission `ai-58e26b5d-765a-4ba5-977a-e5b3c48e759b`.
- A test-only transport fault consumed the actual successful n8n receipt **after commit**.
  Gateway returned unknown outcome; UI retained data/ID and stayed locked for retry.
- Retry sent identical request SHA-256
  `f2926216d33d988387441ca33437e166bb44c055059711b7a20c3517b82cf108`, same submission
  ID; actual WF-A returned 200 replay, modal closed, DB row count remained **1**.
- Browser refresh showed the persisted lead. Actual WF-D returned pending, score null,
  no fake delivered status. WF-08 queried the saved ID and returned unknown score plus
  budget approved. A second capture test sent two simultaneous identical requests:
  **201 + 200, same lead ID, one row**. Changed body gave 409; invalid email gave real
  WF-A 422 field details and no row. Outbox/results stayed empty.

This is evidence for exercised idempotency paths, not a claim of exactly-once external
email delivery or all distributed-system failure modes.

## Production boundary and credential mapping

Production was accessed only for a final read-only metadata observation at 10:22 UTC.
Gateway/n8n container IDs and start times match Stage-1; deployed server.mjs hash still
matches main. WF-A–D remain active on the same published versions; the three identified
PAM workflows retain their recorded versions and inactive state. No production workflow
was invoked. This is metadata comparison, not a full production regression run.
No production Neon data/roles, credentials, nginx, Gateway or shared n8n/PAM were changed.

Required future bindings, **names/types only**:

| Credential | Required mapping |
| --- | --- |
| Gateway Auth | httpHeaderAuth, exact X-Trade-Fair-Key, Owner-approved production binding |
| Model | openAiApi, approved provider/endpoint/project and real-data policy; existing WBS httpHeaderAuth is not interchangeable |
| AI Context | postgres, dedicated login scoped only to trade_fair_ai_context / ai_lead_context |
| Existing WF-A–D | retain current production workflow IDs, versions and credential references; do not replace with local copies |

Local credential IDs live01-* and synthetic login/passwords must never be deployed.

## Release blockers and activation/rollback plan

**Production HOLD.** Required next steps:

1. Black CC incorporates/reviews the separate integration changes and source workflow
   payloads; obtain fresh independent review on the resulting immutable integration SHA.
   Codex cannot independently approve its own candidate adaptations.
2. Resolve UX coverage: UI currently sends first 20 displayed IDs, ignoring selection.
   WF-08 can return at most 20 exact claims, so multi-field questions over many IDs can
   omit requested facts; this is not fabricated data but must be disclosed/fixed before
   promising complete cohort answers. Single saved-ID E2E passed.
3. Owner confirms production target, provider/PII/retention, scoped Neon credentials and
   catalog/ACL. Local fixture SQL is not a production schema migration.
4. Separate HTTPS/proxy/real credential acceptance, backup/restore rehearsal, canary,
   monitoring and data-preserving app rollback rehearsal from Stage-0 remain required.
5. Explicit Owner GO for any production import/activation/deploy; no merge/deploy here.

Activation: backup/export under separate approval; import reviewed WF-07/08 as new,
inactive production IDs, bind approved credentials, inspect UI and exact URLs; Publish
through supported UI, verify real 403/200 responses; only then point approved Gateway
canary URLs at them. Never reimport/activate local WF-A/D copies into production.

Rollback: remove canary exposure, clear BOTH AI URLs (CRM flag alone does not disable
AI), disable CRM or restore prior immutable app image/env as appropriate; UI Unpublish
only the two new AI workflow IDs after handling in-flight requests. Preserve CRM schema,
leads and audit; no DROP/DOWN purge. Shared n8n, WF-A–D and PAM stay running.
