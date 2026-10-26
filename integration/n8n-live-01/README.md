# WBS-TF-N8N-LIVE-01 — actual isolated n8n integration

This package runs actual n8n 2.41.7 Webhook → LLM/parser/Code/Postgres → RespondToWebhook
nodes. It does not start `n8n_equivalent_proxy.mjs` or replace workflow responses.
The Gateway uses real HTTP for AI, WF-A capture and WF-D status. WF-B/C are not imported.

Source RC: `6b64f70d340c1bd9fcdefdfadcd27c35d566fd30`.
Black CC UI fixes incorporated unchanged: `a9460564c54ebdc0359b65eae1f72d46111746e7`.
This branch adds only the integration package/report relative to that Black commit.
Source `workflows/`, `gateway/`, and `sql/` files are unchanged.

## Important source findings

The unmodified WF-07/08 nodes have no `webhookId`. In actual 2.41.7 this yielded UI
Published + active=true but HTTP 404. `adapt-workflows.mjs` adds deployment webhook IDs.
Publication then registers the actual production-mode `/webhook/` routes, proven by
403 without the header and 200 with real model execution, not database active flags.

Unmodified real-model WF-07 also produced malformed JSON and German enum values;
Black's a946056 coercion lives in the proxy, not the workflow JSON. The separate
integration candidate uses native OpenAI strict JSON schema through the **actual n8n
LLM node**, declares canonical enums, retains exact evidence checks, and conservatively
nulls explicit missing budget/follow-up statements. WF-08 uses native strict schema
and its existing exact-claim validation, with at most 20 claims. No autofix or retries.
These adaptations are **new runtime candidate changes**, not an independent approval
of the original RC. Black CC must incorporate/review them and obtain fresh review.

## Current local environment

- n8n: `http://127.0.0.1:15679`, container `wbs-live01-n8n`, volume `wbs-live01-n8n-data`.
- Gateway: `http://127.0.0.1:3117/dashboard`.
- Dedicated PG container/ephemeral loopback port: see `evidence/manifest.json`.
- Generated header and encryption key: private runtime files/isolated encrypted store,
  never committed. Owner-designated OpenAI key imported without printing; plaintext
  credential import removed after successful bootstrap.
- Local-only synthetic n8n account: `n8n-live-01@example.test`, password
  `IsolatedLive01Only!2026`. This is disposable local test auth, not a production secret.
- Local-only Gateway admin key: `live01-admin-local-only`.
- Do not expose these services, credentials, or test control port publicly.

## Reproduce on an isolated developer host

Prerequisites: local Docker, Node >=22, Chrome for manual UI, an explicit Owner-approved
staging key env file outside Git containing OPENAI_API_KEY. Never use production env.
The bootstrap's early-return path validates an already-running local environment
without reimporting or altering it. Inspect a stopped/partial setup before recreation.

```sh
npm ci --prefix gateway
STAGING_KEY_FILE=/absolute/private/owner-staging.env node integration/n8n-live-01/start.mjs
```

`start.mjs` starts a new synthetic PG16 fixture and new n8n volume, imports credentials
and four **inactive isolated** workflow copies, then waits for `/rest/settings` before
owner setup. `/healthz` alone becomes ready before setup routes and previously caused
a transient 404. It does not use the pre-existing wbs-n8n lab or shared demo PG.
The capture/status fixture functions come verbatim from Yuri's supplied local package,
with their own provenance comments; they are NOT production migrations or Neon exports.

Open n8n UI, sign in, and for each imported workflow: **Publish → name version → Publish**.
Wait for Published. Do not use SQLite edits, active=true, CLI execute, or `/webhook-test/`
as proof. Check missing/wrong header returns 403, not unregistered 404. Current published
IDs/versions are recorded in `evidence/manifest.json`; IDs in a new instance can differ.

For sanitized synthetic execution evidence, temporarily enable saving execution data
on the isolated workflows through their Settings UI. Never enable it on shared n8n.
The completed session used temporary all/all retention only for synthetic diagnostics;
`finalize.mjs` restored none/none/manual=false/progress=false. Existing diagnostic rows
remain privately in the isolated volume for handoff; no real PII was used.

```sh
# A long-running isolated Gateway; source runtime has no AI/capture mock fallback.
node integration/n8n-live-01/gateway.mjs
# Another terminal:
node integration/n8n-live-01/check-real.mjs
```

`check-real.mjs` calls the paid API via actual n8n. It uses three synthetic German notes,
including Yuri UC-21 (`ist_testdatensatz=true`). No automatic retry, fallback or model
stub is used. `--ask-only` reuses previously checked WF-07 results and reruns changed
WF-08 assertions; use full mode for a clean-session run.

## Human-confirmation and lost-receipt UI test

1. Open Gateway Dashboard and sign in with the local admin key above.
2. AI capture note:
   `Auf der fiktiven Messe spricht Mila Muster von Integrationswerk LIVE01 GmbH über
   KI-Automatisierung. Das Budget ist bereits freigegeben. Bitte innerhalb einer Woche
   nachfassen. E-Mail: mila-live01@example.test. Telefon und Website wurden nicht genannt.`
3. Consent to synthetic provider processing; Analyze. Before confirming, the DB must
   still contain only the eight fixture leads. Check every populated field separately.
4. Before submitting, arm this local **transport fault**, which drops a successful
   receipt only AFTER the actual n8n capture returns from PostgreSQL:

   ```sh
   curl --fail -X POST http://127.0.0.1:3118/fault/drop-next-capture-receipt
   ```

5. Submit. UI must show unknown outcome and retain body/ID; DB must already have one row.
   Retry: actual WF-A returns idempotent HTTP 200, same lead, no second row. Modal closes.
6. Refresh, filter `Integrationswerk LIVE01`, and ask Score/Budget. Score stays unknown;
   budget is approved. UI currently uses the first 20 **displayed** leads, not selection;
   filtering controls its context. The API tests explicitly request the single saved ID.

```sh
node integration/n8n-live-01/check-e2e.mjs
node --test integration/n8n-live-01/test-adaptations.mjs tests/integration/workflow_contracts.mjs
npm test --prefix gateway
# Export sanitized evidence/import-safe payloads and restore no-retention settings:
node integration/n8n-live-01/finalize.mjs
```

E2E additionally tests concurrent same-ID capture, 409 on changed body, real WF-A 422
field details, actual WF-D pending status, DB-scoped AI login, actual model-input PII
minimization, unauthorized contexts, and zero outbox/results rows. The fault control is
loopback-only test infrastructure; it is not part of production Gateway and must not ship.

## Handoff and rollback

`published/wf07.json` and `wf08.json` are **inactive, import-safe integration payloads**,
not production-ready credentials. `manifest.json` separately records actual published
versions and successful registration evidence. `execution-audit.json` contains sanitized
statuses/token counts, not request headers, credentials or raw execution data.

Rollback local integration: UI **Unpublish** only the four LIVE01 copies; stop the
LIVE01 Gateway process and its own n8n/PG containers after preserving evidence. Keep
volume/private encryption-key custody until handoff completes. Do not stop wbs-n8n,
wbs-n8n-runner, demo proxy/Gateway, or production containers. Stopping the disposable
PG uses its `--rm` lifecycle and deletes its synthetic data, so review evidence first.

Future production activation requires separate Owner GO, fresh review, real Neon
preflight/scoped bindings, HTTPS/auth, backup/restore and canary/app rollback gates.
Use production-specific credential IDs, never local IDs or test passwords. App rollback
must clear BOTH AI URLs and disable CRM/restore previous image without dropping CRM/audit.
