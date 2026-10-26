# WBS Trade Fair Assistant — Owner GO Checklist (P-DEPLOY-01)

**Status: PREPARATION GO / PRODUCTION EXECUTION HOLD.**

Owner initials + UTC timestamp required on every line before the next
line is eligible to run. No line is self-approving. Reference packet:
`docs/WBS_TF_PRODUCTION_EXECUTION_PACKET.md`.

**Variables (filled in during execution, never committed):**
```
TF_ROLLOUT_TS=YYYYMMDDTHHMMSSZ
TF_GATEWAY_IMAGE=sha256:…                 # from packet step 4.1
TF_WF07_ID=                               # from packet step 3.2
TF_WF08_ID=                               # from packet step 3.2
TF_OPENAI_CRED_ID=                        # from packet step 3.1
TF_AI_CTX_CRED_ID=                        # from packet step 3.1
```

## Preparation complete (set once before Owner initials begin)

- [ ] Checkout at `3421a5d2bb842461c2c12c0f565f53249eeeee05`; working
      tree clean; `shasum -a 256` of every file in packet §0 matches.
- [ ] Full regression suite re-run locally: `tests 108 pass 108`.
- [ ] Preparation branch `prep/wbs-tf-p-deploy-01` pushed; this
      checklist, the packet and the release acceptance report are all
      visible on PR #27 or its ancestor PR.

## G1 — Codex RC3.3 independent re-review

- [x] Codex verdict PASS on `3421a5d` recorded on PR #27
      (https://github.com/klareki-lab/wbs-trade-fair-assistant/pull/27#issuecomment-6426321107
      — "Codex final independent RC3.3 review — PASS — CODE READY").
      Codex noted: CODE READY grants no deployment permission; the
      operator-packet corrections in P-DEPLOY-02 must be in place
      before Owner GO proceeds. All seven deployment findings addressed
      in the packet §0.5 mapping table.
      ___________ (Owner acknowledges Codex verdict + UTC)

## G2 — Neon production branch identity

- [ ] Owner-side out-of-band confirmation per packet §2 Owner Gate 2.1
      ran against the production Neon branch.
- [ ] `current_user=neondb_owner`, `current_database=neondb`.
- [ ] `trade_fair` schema owner = `neondb_owner`.
- [ ] `neon.timeline_id` is **not** `a171e976ae189ef43d7ca803d826354e`
      (that is staging).
- [ ] `dashboard_snapshot` function count = 0 (not yet migrated).
- [ ] Roles `trade_fair_dashboard`, `trade_fair_ai_context` and the
      Owner-chosen LOGIN role (`trade_fair_ai_login` by convention) do
      NOT exist. (Correct names per packet §2 — not `wbs_tf_ai_context`.)
- [ ] Timeline id captured in deployment log (secrets-folder only).
      ___________ (Owner initials + UTC)

If any check disagrees → STOP; the Owner is pointed at the wrong branch.

## G3 — SQL migrations

- [ ] Backup taken immediately before migration — TWO files per packet §5.1:
      `pre-rc33-trade_fair.sql` (schema + data) AND `pre-rc33-roles.sql`
      (role definitions + grants via `pg_dumpall --roles-only
      --no-role-passwords`). Both sha256s recorded; mode 0600; data dump > 10 KB;
      roles dump contains CREATE ROLE for `trade_fair_dashboard` and
      `trade_fair_ai_context` (post-migration this will also include the
      LOGIN role, but at this preflight the roles don't exist yet so only
      pre-existing roles appear).
- [ ] Dumps restored into a disposable PG16 target (packet §5.2);
      table counts match the production counts Owner captured just
      before the dump; `ai_can_exec = t` on target (role ACL recoverable).
- [ ] `sql/production/dashboard_role_production.sql` executed under
      `-v production_branch_confirmed=on`; in-script assertions PASS.
- [ ] `sql/production/dashboard_crm_v1_up.sql` executed under
      `-v production_branch_confirmed=on`. This creates
      `trade_fair_ai_context` NOLOGIN automatically (not a separate step).
- [ ] LOGIN role `trade_fair_ai_login` provisioned per packet §2.4;
      all `DO $$ … $$` assertions PASS (schema USAGE via membership,
      no CREATE, EXECUTE on `ai_lead_context(jsonb)` only, no direct table
      SELECT, no CRM mutate privileges).
      ___________ (Owner initials + UTC)

If any step fails → execute the matching rollback script and STOP.

## G4 — n8n credentials and workflows

All operations use `/rest/*` with a cookie session from
`POST /rest/login` (NOT `X-N8N-API-KEY`). The committed operator
scripts under `ops/n8n/` handle the login flow internally.

- [ ] n8n credential `WBS Trade Fair — OpenAI RC3` created (type
      `openAiApi`); API key same value as existing
      `UUprjEp0Re6kPUFN`; cred id recorded as `TF_OPENAI_CRED_ID`.
- [ ] n8n credential `WBS Trade Fair — AI context` created (type
      `postgres`); points at production Neon host as role
      `trade_fair_ai_login` (from §G3); cred id recorded as
      `TF_AI_CTX_CRED_ID`.
- [ ] WF-07 imported via `ops/n8n/import_wf_rc3.sh workflows/wf-07-messe-hub-ai-extract.adapted.json`;
      stdout id captured as `TF_WF07_ID`; GET confirms `active:false`.
- [ ] WF-08 imported via the same script; stdout id captured as
      `TF_WF08_ID`; GET confirms `active:false`.
- [ ] Retention + timeout settings on both imported workflows match
      packet §3.5 (PATCH applied if the import response showed
      different values).
- [ ] WF-07 activated via `WORKFLOW_ID=$TF_WF07_ID ops/n8n/activate_wf.sh`;
      script's own check confirms `active:true` and
      `versionId==activeVersionId`.
- [ ] WF-08 activated via the same script; same assertions.
- [ ] `curl http://127.0.0.1:3000/webhook/messe-hub/ai-extract`
      (no auth header) → HTTP 403.
- [ ] `curl http://127.0.0.1:3000/webhook/messe-hub/ai-ask`
      (no auth header) → HTTP 403.
- [ ] RC3.3 read-only verifier run (packet §3.4) exits **0** via
      `WF07_ID=$TF_WF07_ID WF08_ID=$TF_WF08_ID
       node ops/n8n/verify_published_production.mjs
       > /opt/wbs-trade-fair/secrets/backups/${TF_ROLLOUT_TS}/verify-published.json`.
      Output has `verdict: "PASS"` for both workflows. The verifier
      issues exactly one POST (`/rest/login`) and no other non-GET
      call (grep-auditable in-source).
- [ ] `integration/n8n-live-01/finalize.mjs` was NOT invoked against
      production (isolated-use only; patches `settings`).
      ___________ (Owner initials + UTC)

If any step fails → deactivate + delete workflows and credentials;
STOP.

## G5 — Gateway image, swap, nginx, HTTPS

- [ ] Gateway image built from pinned checkout via
      `Dockerfile.dashboard-staging`; digest recorded as
      `TF_GATEWAY_IMAGE`; `docker inspect` reports zero mounts and zero binds.
- [ ] Baseline capture completed (packet §4.3 step 1);
      `inspect.json`, `image.json`, `env.pre`, `nginx-pre.conf` saved
      under `/opt/wbs-trade-fair/secrets/backups/${TF_ROLLOUT_TS}/`.
- [ ] Current Gateway container renamed to
      `wbs-trade-fair-gateway.saved-${TF_ROLLOUT_TS}`.
- [ ] New Gateway container started with `--env-file
      /opt/wbs-trade-fair/secrets/gateway.rc33.env`, image
      `TF_GATEWAY_IMAGE`, `--restart unless-stopped`.
- [ ] `curl -fsS http://127.0.0.1:3000/healthz` → HTTP 200.
- [ ] Candidate container renamed to `wbs-trade-fair-gateway`.
- [ ] nginx bootstrap vhost installed (packet §4.4 step 1); `nginx -t`
      PASS before `nginx -s reload`.
- [ ] `certbot --nginx -d messe.klare-ki.de --redirect --agree-tos
      -m <owner-email> --no-eff-email` succeeded; cert path logged.
- [ ] nginx HTTPS holding vhost installed (packet §4.4 step 3); `nginx -t`
      PASS; `curl -o /dev/null -w '%{http_code}' https://messe.klare-ki.de/`
      → 503.
- [ ] nginx final vhost installed (packet §4.4 step 5); `nginx -t` PASS.
- [ ] Loopback acceptance per packet §4.5 (healthz 200; both webhooks
      403 unauth).
- [ ] External HTTPS acceptance per packet §4.5 (healthz 200; both
      webhooks 403 unauth).
- [ ] Staged HSTS: start at `max-age=300`; promote to `max-age=31536000`
      after T+1h canary PASS.
      ___________ (Owner initials + UTC)

If any step fails → execute Rollback 2 (packet §6.3) and STOP.

## G6 — Bounded-budget real-OpenAI smoke test

This is the FIRST exercise of the exact RC3.3 canonical WF-07/08 against
real OpenAI. Prior real-OpenAI gateway-e2e evidence (pinned at
`6b64f70d…`) is historical and does NOT substitute for this step
(acceptance report §3.5 corrected).

- [ ] OpenAI organization monthly spend cap confirmed; daily budget
      ≤ $5 for the first 7 days configured in the OpenAI console.
- [ ] Fresh Dashboard session cookie obtained via
      `POST /api/login` with the production `DASHBOARD_ACCESS_KEY`
      (session cookie file mode 0600, cleared at end of smoke test).
- [ ] AI extract smoke call `POST /api/dashboard/ai/extract` returns
      200 with `success:true` for a synthetic lead; token usage ≤ 2500
      input + 500 output; response saved to secrets backups folder.
- [ ] AI ask smoke call `POST /api/dashboard/ai/ask` for the saved
      synthetic lead returns 200 with cited `lead_id` exactly matching
      request; no PII pattern
      `/Mila|Integrationswerk|private.*synthetic/i` in the answer;
      token usage within budget.
- [ ] `trade_fair.lead_submissions` has exactly one new row with the
      synthetic submission_id; `dashboard_snapshot` returns it.
      ___________ (Owner initials + UTC)

If any step fails → Rollback 1 (deactivate WF-07/08) and STOP.

## G7 — Canary promotion

- [ ] T+15m window: 0 errors on the two smoke calls; Gateway + n8n
      journals clean; canary evidence saved.
- [ ] T+1h window: 5xx rate ≤ 2% / 5 min on messe.klare-ki.de;
      OpenAI tokens/min within budget; no `PUBLISHED_PROVENANCE_FAILED`.
- [ ] T+24h window: OpenAI daily spend ≤ $5; execution-audit anomalies
      zero.
- [ ] T+7d window: WF-08 grounding-gate canary — refusal is observed
      under a forced-ungrounded test; standard monitoring thresholds
      applied.
- [ ] Owner GO logged for standard-monitoring promotion.
      ___________ (Owner initials + UTC)

Any threshold breach → execute the matching rollback (packet §6.3) and
STOP.

## G8 — Documentation and audit close

- [ ] Deployment log stored at
      `/opt/wbs-trade-fair/secrets/backups/${TF_ROLLOUT_TS}/deploy-log.md`
      with every initialed line of this checklist, every recorded id
      (TF_WF07_ID, TF_WF08_ID, TF_OPENAI_CRED_ID, TF_AI_CTX_CRED_ID,
      TF_GATEWAY_IMAGE), every evidence file sha256, canary results,
      and timestamps.
- [ ] PR #27 updated with a "Executed on <date>" comment linking the
      deployment log location (path only, never contents).
- [ ] PR #27 merged (or closed as draft record per the F3B R3 §13
      integration pattern — Owner choice).
- [ ] This checklist and the packet moved from
      `prep/wbs-tf-p-deploy-01` into `main` as read-only history.
      ___________ (Owner initials + UTC)

## HOLD lines (never GO without a new, scoped Owner authorization)

The following are **explicitly out of scope** of P-DEPLOY-01:

- [ ] Any edit to WF-A, WF-B, WF-C, WF-D in production n8n.
- [ ] Any rotation of a shared credential
      (`DIm6w5CcndY0D3RJ`, `UUprjEp0Re6kPUFN`, `tjqSy2V0odocljw6`,
      `HvE5Js2qo8BxvrSs`, `A4Xm6WZ9d6SsMkfs`).
- [ ] Deployment of the Dashboard Yuri UI rework
      (`feature/dashboard-yuri-ui`).
- [ ] Any watchtower policy or Docker image policy change.
- [ ] Any production data mutation outside the Owner-approved SQL
      migrations above.
