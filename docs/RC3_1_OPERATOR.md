# RC3.1 operator gate — isolated real n8n (not the proxy)

**Release status: HOLD / Production NO-GO.** Source branch `fix/wbs-tf-rc3-1-astra` must be based on exact `91a6e8901bf4d71bf4c10b93d932b9ecab9328d3`; publish a new immutable SHA only after fixes and focused tests.

## Separate transport paths

- `demo/real-ai/start.sh` launches `demo/real-ai/n8n_equivalent_proxy.mjs`. Proxy smoke is **not** canonical n8n evidence.
- `demo/real-ai/server-real-ai.mjs` has legacy routing and must **not** be advertised as release capture E2E.
- `integration/n8n-live-01/start.mjs` bootstraps a disposable n8n 2.41.7 and synthetic PostgreSQL fixture with the **raw committed canonical WF-07/08 node parameters**, changing only isolated instance metadata and credential references. It requires an explicitly Owner-approved staging key. No production target is authorized.
- `integration/n8n-live-01/gateway.mjs` routes to actual WF-A/D and canonical WF-07/08 webhooks; no equivalent proxy. Historical LIVE-01 `published/` and `evidence/` artifacts are not fresh RC3.1 acceptance.

## Focused checks before requesting re-review

```sh
npm ci --prefix gateway --ignore-scripts --no-audit --no-fund
node --test tests/integration/rc31_regression.mjs integration/n8n-live-01/test-adaptations.mjs tests/integration/workflow_contracts.mjs tests/test_gateway_dashboard.mjs
node integration/n8n-live-01/_apply_to_canonical.mjs
# Must print no-op for both canonical files; git diff must remain unchanged.
git diff --exit-code -- workflows/wf-07-messe-hub-ai-extract.adapted.json workflows/wf-08-messe-hub-ai-ask.adapted.json
```

Then execute in an **approved isolated** actual n8n 2.41.7 environment with disposable PostgreSQL and a synthetic provider/model fixture. Import WF-07 and WF-08 **directly from committed canonical JSON**. Publish both and wait for actual `/webhook/` route registration. Check unauthenticated calls return 403, not 404. Call the actual Gateway → scoped `trade_fair.ai_lead_context` → canonical WF-08 nodes → RespondToWebhook path with nine synthetic leads and the supported Score + Budget question (three locally requested fields: `score_band`, `score_total`, `budget_status`). Configure a grounded model fixture to supply 20 distinct, valid cells out of the 27 requested. The correct response is HTTP 200 with an `answer` beginning `⚠ Ergebnis unvollständig (20 von 27 angefragten Werten)` and seven cited IDs. Confirm the same marker survives Gateway allowlisting and is visibly rendered in Dashboard. Also test complete coverage, repeated claims, fewer-than-20 partial claims, unsupported intent, forged values, and full context isolation. Capture actual execution ID, canonical source SHA, published workflow version, test commands and sanitized responses. Do not label Node Code simulation or mock-upstream Gateway tests as actual n8n execution.

**Current RC3.1 canonical webhook/Gateway execution gate: PENDING.** It requires separate execution on an actual isolated n8n instance and fresh independent review. No production deployment, credential changes or database migration are permitted by this packet. All infrastructure gates from PR #26 independent review still apply, including Neon scoped ACL, preflight, backup/restore, HTTPS, resource/canary/rollback readiness and explicit Owner GO.
