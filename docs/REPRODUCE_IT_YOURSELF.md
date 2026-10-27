# Reproduce It Yourself

This guide supports building a similar system on **your own infrastructure**. It is not a guaranteed deployment recipe. There is no one-command installation, complete environment provisioner, or complete production database bootstrap in this repository. Use synthetic data first and treat original domains, addresses, paths, workflow IDs, and credential IDs as historical context.

## 1. Choose a learning scope

You can inspect the architecture, workflow Code nodes, prompts, SQL, and tests without running external services. For execution, choose a staged scope: gateway tests; a disposable dashboard/CRM database; isolated real n8n with a mock model; then separately configured research/model/email integrations. Demos and mock proxies help study contracts but do not prove that n8n will execute imported workflows successfully.

Prerequisites: general n8n, Docker, JavaScript, and PostgreSQL knowledge; Git; Node.js 22+ and npm; Docker Engine/Compose for container tests; PostgreSQL 16 tooling for independent SQL work. Browser suites use Playwright and its Chromium browser. Integration evidence uses n8n 2.41.7; other versions require rechecking node versions, structured outputs, webhook registration, and publication behavior.

## 2. Plan independent infrastructure

| Resource | Decisions you must supply |
| --- | --- |
| n8n | Your own instance, persistent storage, encryption key, editor authentication, backups, retention, webhook access, and matching node packages |
| PostgreSQL | Own database/Neon project, TLS, schema/function implementation, role ownership/memberships, backup and tested restore |
| Gateway | Own Node process/container, private environment, exact origin, runtime binding/network paths, restart and log policy |
| Browser origin | Loopback for development; your own domain, HTTPS proxy/certificate, routing and abuse controls for hosting |
| Providers | Your own Tavily, model provider/project, optional Requesty, and Resend accounts; limits and data-processing choices |
| Email | Sender domain verified in your Resend account and a controlled internal test recipient |

The existing Compose file is an **isolated dashboard staging harness** with capture/status deliberately pointed at disabled local endpoints. It is not a complete application stack. The Dockerfile packages gateway/web assets; it does not install your database or workflows. Container loopback refers to that container, not another container or your host.

## 3. Understand and supply the SQL contracts

| Repository material | What it supplies / does not supply |
| --- | --- |
| `sql/trade_fair_schema.txt` | Older partial metadata inventory; not runnable bootstrap or complete schema |
| `sql/dashboard_confirmed_ddl.sql` | Five application tables with constraints/indexes; no complete pipeline function implementation |
| `sql/dashboard_snapshot.sql`, `dashboard_snapshot_definition.sql` | Dashboard snapshot function variants; inspect ownership, signature and caller assumptions before choosing one |
| `sql/production/dashboard_role_production.sql` | Incremental dashboard role/function installer; assumes an existing schema/owner and uses operator-specific guards |
| `sql/production/dashboard_crm_v1_up.sql` | Fresh-install-only CRM tables/functions and scoped AI-context role/function; expects the base tables and dashboard role |
| `tests/fixtures/dashboard_smoke_schema.sql` | Reduced synthetic dashboard fixture; not a queue/capture production database |
| `integration/n8n-live-01/fixtures/` | Synthetic capture/status functions used by integration; not the entire processing/delivery contract |
| `tests/helpers/pg16.mjs` | Executable example assembling disposable DDL, snapshot, CRM migration, roles, and synthetic rows |

For a complete independent pipeline, implement and test compatible contracts for `capture_lead`, `claim_processing`, `finish_processing`, `fail_processing`, `claim_email`, `begin_email_send`, `finish_email_send`, `fail_email_send`, and `get_lead_status`, with any supporting event/migration tables. Read each PostgreSQL node's query and query replacements for exact arguments, return envelopes, tokens, and transitions. Do not infer function signatures solely from their names.

For the dashboard/CRM learning slice, assemble a fresh disposable schema from the confirmed DDL and snapshot implementation, then review the CRM migration's prerequisites. It adds `crm_groups`, `crm_group_members`, `crm_group_audit`, and **`ai_lead_context(jsonb)`**. The AI role is NOLOGIN; provision your own restricted login/member binding. Check that it can execute only the narrow context function and cannot read tables, mutate CRM, or call the broad snapshot.

Original scripts check operator-specific database/owner names and require variables whose names mention production. Those guards do not identify the connected server. Inspect and adapt copies for your own isolated database; verify its identity before any execution. Never remove guards merely to make an unfamiliar target accept a script. If CRM already exists, design a forward migration; do not rerun the fresh installer or drop audit data. The CRM DOWN file is a data-preserving policy/no-op, not an uninstall procedure.

## 4. Create independent credentials and map each node

| Credential/configuration | Used by | Required setup |
| --- | --- | --- |
| PostgreSQL application login | WF-A–D | Your pipeline functions and reviewed least-privilege grants |
| Header Auth | WF-A/D and adapted WF-07/08 | Header name `X-Trade-Fair-Key`; independent value shared only between your gateway and n8n |
| Tavily Header Auth | Baseline WF-B | Your API authentication; Yuriy's alternative may require the Tavily community credential/package |
| Model Header Auth | Baseline WF-B HTTP node | Your provider bearer credential, matching endpoint/model/structured-output contract |
| Native `openAiApi` | Adapted WF-07/08 | Your provider key/base URL and node-compatible model; a WF-B Header Auth record is not interchangeable |
| Scoped PostgreSQL login | Adapted WF-08 | Membership scoped to `trade_fair_ai_context`; no broad application credential |
| Resend Header Auth | WF-C | Your API key, verified sender and controlled internal recipient |
| Gateway access/session secrets | Node gateway | Independent form key, separate admin key, signing secret; keep outside Git |

Inspect the JSON rather than resolving names automatically. An exported credential name can look like an existing account while refering to a different credential type. Rebind every credential-bearing node in your n8n instance. Requesty routing in Yuriy's material is a separate provider dependency, not a universal default. Review processing configuration sender/recipient values in WF-B and reference variants before any send; original addresses must not receive your test data.

## 5. Import only the family you intend to study

1. Create a fresh isolated n8n instance and database, using synthetic fixtures and a mock provider first. Keep scheduled workers inactive during setup.
2. Import selected WF-A–D files for the base pipeline. Bind your credentials and review each Code, HTTP, and PostgreSQL node. Confirm query signatures, sender/recipient, provider endpoint/model, and webhook paths.
3. For the adapted assistant, import the canonical `workflows/wf-07-messe-hub-ai-extract.adapted.json` and `wf-08-messe-hub-ai-ask.adapted.json`. Inspect the schema/evidence checks and bind native OpenAI, Header Auth, and scoped AI PostgreSQL credentials.
4. Publish using the procedure supported by your n8n version. Confirm registered webhook URLs, rejected unauthenticated requests, successful synthetic requests, response envelopes, and effective database permissions. An `active:false` export alone does not tell you the original live state.
5. Study Yuriy's WF-05/06/07/08 separately if desired. They expect different dashboard, Data Table/grouping, chat, and credential contracts. Do not substitute them into the RC gateway without adapting those contracts.
6. Before enabling schedules or real email, verify processing failures, lease expiry, replay/conflict handling, provider errors, and uncertain-send reconciliation in your environment.

`integration/n8n-live-01/verify-published.mjs` illustrates comparing the actual published executable graph to canonical source. The surrounding bootstrap/finalizer scripts are specialized isolated harnesses with fixed IDs/state and may import, publish, or update retention settings. Read them before use. The finalizer is **not a generic production read-only verifier**, and the archived deployment plan's suggested production CLI mode is not implemented there.

## 6. Configure your gateway

Use the root `.env.example` as a list of variable names. Store filled values in a private file outside the repository, restricted to your account. Node does not load that example automatically.

| Variables | Meaning |
| --- | --- |
| `HOST`, `PORT`, `APP_ORIGIN` | Runtime listener and exact browser origin; configure for your host/container topology |
| `TRADE_FAIR_ACCESS_KEY`, `SESSION_SECRET` | Form key (≥16 characters) and independent signing secret (≥32 characters) |
| `N8N_CAPTURE_URL`, `N8N_STATUS_URL`, `N8N_HEADER_KEY` | Your active webhook URLs and matching server-side header secret |
| `PUBLIC_FORM_ENABLED` | Disabled by default; review abuse controls before enabling anonymous capture |
| `DASHBOARD_ENABLED`, `DASHBOARD_ACCESS_KEY`, `DASHBOARD_DATABASE_URL` | Enable only after snapshot/grants exist; admin key ≥16 characters and distinct from form key; server-side database URL with verified TLS |
| `MESSE_CRM_ENABLED` | CRM enabled by default with dashboard; set false until your CRM contracts are ready |
| `N8N_AI_EXTRACT_URL`, `N8N_AI_ASK_URL` | Supply both or neither; leave empty until your AI workflows are verified |
| `N8N_AI_ALLOWED_ORIGIN` | Exact trusted upstream origin, defaulting to capture origin; external AI transport must meet gateway HTTPS/origin rules |

After independently preparing those dependencies, the gateway entry point is:

```sh
npm ci --prefix gateway --ignore-scripts --no-audit --no-fund
node --env-file=/absolute/private/your-trade-fair.env gateway/server.mjs
```

This starts the gateway only. `/healthz` proves process liveness, not database, workflow, provider, or email readiness. For local HTTP use a browser-recognized localhost/loopback context; configure the same exact origin in the browser and gateway. For hosting, configure your own HTTPS reverse proxy and check Secure cookies, Origin enforcement, routes, and logs. Shared-key sessions and single-process rate limits require further design for individual users or scale.

## 7. Verify in layers

The following checks do not call paid providers or production services:

```sh
npm test --prefix gateway
node --test tests/integration/rc31_regression.mjs tests/integration/rc32_published_provenance.mjs tests/integration/rc33_executable_provenance.mjs tests/integration/workflow_contracts.mjs integration/n8n-live-01/test-adaptations.mjs
```

With Docker and suitable local resources, inspect and run `npm run test:sql --prefix gateway`, `npm run test:workflows --prefix gateway`, and `npm run test:browser --prefix gateway`. Browser tests additionally need the Playwright Chromium installation. These create local fixtures/services; inspect port/container expectations first. They are not validation of your Neon branch or provider account.

Your independent acceptance should cover capture 201, identical replay 200, conflict 409, invalid input without persistence, lost-receipt reconciliation, status polling, lease/failure transitions, one controlled internal report, dashboard scope denial, CRM conflicts/undo/audit, and AI evidence/citation/incomplete-coverage behavior. Check that external model input excludes WF-08 personal fields, and verify actual logs/retention. Test backup restoration into a separate target and data-preserving application rollback.

See [project status](PROJECT_STATUS.md) for what has actually been verified in this repository and [security findings](PUBLIC_SECURITY_REVIEW.md) before using real data. Older operator plans remain historical evidence and require their own review; this guide authorizes no production action.
