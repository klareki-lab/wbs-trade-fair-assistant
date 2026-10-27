# Workflow guide

Read this alongside the [architecture](ARCHITECTURE.md) and [reproduction guide](REPRODUCE_IT_YOURSELF.md). Names, active flags, and credential references inside an export are not proof that a matching workflow is currently deployed.

## Three workflow families

| Family | Files | Intended use and important differences |
| --- | --- | --- |
| Production baseline | `workflows/wf-a-lead-capture.json`, `wf-b-lead-processing.json`, `wf-c-sales-email-delivery.json`, `wf-d-lead-status.json` | Historical exports of the running pipeline. Study its validation, database contracts, queue leases, evidence checks, and delivery state handling. Do not replace an existing deployment by importing copies. |
| Adapted RC3.3 | `workflows/wf-07-messe-hub-ai-extract.adapted.json`, `wf-08-messe-hub-ai-ask.adapted.json` | Same-origin gateway integration, explicit human confirmation, scoped context reads, bounded/validated claims. RC3.1 fixes incomplete coverage and adaptation idempotency; RC3.2 verifies published snapshots; RC3.3 verifies executable node properties too. Production acceptance remains separate. |
| Yuriy's references | `dashboard/reference-workflows/yuri-01…04`, `05…08` | Original alternative credential wiring and dashboard/chat/group design. WF-05 feeds the reference dashboard; WF-06 manages grouping through n8n/Data Tables; WF-07/08 provide original chat experiences. RC CRM instead uses PostgreSQL functions through the gateway. |
| Historical isolated exports | `integration/n8n-live-01/published/` | Sanitized exports from a particular integration run, with synthetic credential IDs. Not the current canonical import source and never production WF-A/D replacements. |

The [original manifest](WORKFLOW_MANIFEST.md) records October 24 IDs and versions. [Yuriy's original instructions](../dashboard/ANLEITUNG.md) describe his environment and test claims; they do not establish deployment or verification of the adapted RC3.3 implementation. Credentials differ by node type: Header Auth, Tavily API, native OpenAI API, and PostgreSQL references are not interchangeable.

## WF-A: capture

Webhook → server UUID → normalize → validate → `capture_lead(jsonb)` → build receipt → Respond to Webhook.

The gateway forces the capture source and does not trust browser verification flags. The database must enforce `(source, submission_id)` idempotency: new persisted capture returns 201; identical replay returns 200 with the same lead ID; changed payload returns 409. Invalid input must not produce a success receipt. Duplicate candidates and uncertain contacts require review, not automatic identity assertions.

## WF-B: research, extraction, scoring, reporting

The scheduled worker runs every minute and claims one eligible lead through `claim_processing`. Its configuration Code node contains shared deterministic helpers copied into relevant Code nodes and configuration for the model and report addresses.

1. **Research:** query Tavily using company name and an optional website domain. Contact names, email, phone, and meeting notes are excluded from this search request. Validate response shape, public URLs, and bounded snippets. `domain_match`, `unverified`, and `not_found` communicate evidence strength; a domain match is not proof of company identity.
2. **Extraction:** when notes exist, call the configured model with structured-output JSON schema, no tools, `store:false`, and instructions treating notes as untrusted data. Supported output includes summary, topics, participant count, timeframe, language, and training/budget/follow-up categories. Non-null fields require exact note evidence. Validate the returned structure, enums, quotes, and bounds. An empty-note branch skips AI.
3. **Score:** calculate from captured inputs using `scoreLead`, not the research ranking or model-generated assessment. Retain the version and point breakdown.
4. **Report:** prepare an internal plain-text sales report with captured details, extraction, evidence, source links/snippets, scoring reasons, original notes, and review flags. `finish_processing` must persist the result and outbox contract safely; `fail_processing` records failure/retry state using the current lease.

Scoring version 1.0, as implemented in WF-B:

| Input | Points |
| --- | --- |
| Training interest | 25 for a specific supported category; 15 for `other`; 0 if missing |
| Budget | approved 25; planned 15; unknown/not disclosed 5; no budget/missing 0 |
| Follow-up | within one week 20; two weeks 15; one month 10; otherwise 0. `on_date` uses days from capture: ≤7/≤14/≤30 gives 20/15/10, later 5 |
| Contactability | supplied email or phone 15; name only 5; otherwise 0; this does not verify contact details |
| Notes | 10 for at least ten characters |
| Website | 5 when provided; this does not verify ownership |

HOT ≥70, WARM ≥40, otherwise COLD. The scoring is deterministic but the quality of captured inputs still matters. AI-assisted capture can indirectly affect a score once a human confirms those structured inputs. See `Processing Configuration` and `Score and Build Sales Report` in the JSON for exact behavior, including date edge cases.

## WF-C and WF-D

WF-C: scheduled claim → `begin_email_send` fence → prepare → Resend → validate outcome → `finish_email_send` / `fail_email_send`. The outbox carries an idempotency key. Definite retryable failure, permanent rejection, and uncertain acceptance are distinct. Do not encourage blind resend after a timeout. The report goes to the configured internal recipient, not automatically to the lead. Historical `delivered` UI state means provider acceptance.

WF-D: authenticated webhook → validate lead/submission identifiers → `get_lead_status` → sanitized response. The gateway exposes only allowed status fields, never arbitrary database rows.

## Adapted WF-07: AI-assisted capture

Admin UI permission → gateway `/api/dashboard/ai/extract` → authenticated webhook → input check → native LLM structured extraction → evidence/enum validation → response → per-field human confirmation → ordinary `/api/leads` capture.

Notes are 10–10,000 characters and may contain personal data. Extraction has no tools or automatic capture side effect. Missing facts remain null; unsupported or forged values are rejected/removed. The raw original note remains the capture basis; a generated summary does not replace it. Unknown submission outcomes retain the ID for reconciliation; a retry must not silently create another lead.

## Adapted WF-08: grounded Lead Assistant

Admin UI explicit context → gateway `/api/dashboard/ai/ask` → authenticated webhook → local intent parsing → parameterized `ai_lead_context($1::jsonb)` → filtered categorical facts → native LLM → deterministic claim validation and answer → gateway citation allowlist → UI.

The UI uses selected leads, falling back to up to the first 20 visible leads when nothing is selected. The workflow limits context to 1–20 unique explicit IDs and supports only permitted topics. The model proposes up to 20 `{lead_id, field, value}` claims. Each claim must match the supplied facts and requested fields; foreign citations or invented values fail validation. Unsupported questions cannot invoke arbitrary SQL or tools. Names, contact details, notes, research, and the raw question are excluded from model context.

Requested coverage is the distinct set of requested lead/field pairs, not merely the number of claims. Duplicate claims cannot hide missing values. RC3.1 adds the German `Ergebnis unvollständig` warning when coverage is incomplete, including below the 20-claim cap. The gateway preserves the warning and the UI displays it. An answer can still be incomplete or unhelpful even when every emitted claim is grounded.

## Publication and evidence

An imported JSON is not automatically an active webhook. Use your own n8n instance's supported import/publish procedure, rebind credentials, and verify actual route registration and header authentication. RC3.3's `verify-published.mjs` compares the published executable fingerprint and graph to canonical source; a matching draft with a stale published version must fail.

[RC3.1 operator notes](RC3_1_OPERATOR.md), [LIVE-01 report](WBS_TF_N8N_LIVE_01_REPORT.md), and [RC3.3 evidence](../integration/n8n-live-01/evidence/rc33-live-run.txt) cover different revisions and scopes. Proxy simulation, direct Code execution, real n8n with a mock provider, and real-provider calls are distinct forms of evidence. See the [status matrix](PROJECT_STATUS.md).
