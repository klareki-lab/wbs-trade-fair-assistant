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

- [ ] Codex verdict PASS on `3421a5d` recorded on PR #27 (comment URL
      logged in deployment log). ___________ (Owner initials + UTC)

If Codex verdict is FAIL or CONDITIONAL PASS with remaining code
blockers, STOP here. Address the blocker, raise a new candidate SHA
and restart from this line.

## G2 — Neon production branch identity

- [ ] Owner-side out-of-band confirmation per packet §2 Owner Gate 2.1
      ran against the production Neon branch.
- [ ] `current_user=neondb_owner`, `current_database=neondb`.
- [ ] `trade_fair` schema owner = `neondb_owner`.
- [ ] `neon.timeline_id` is **not** `a171e976ae189ef43d7ca803d826354e`
      (that is staging).
- [ ] `dashboard_snapshot` function count = 0 (not yet migrated).
- [ ] Roles `trade_fair_dashboard` and `wbs_tf_ai_context` do NOT exist.
- [ ] Timeline id captured in deployment log (secrets-folder only).
      ___________ (Owner initials + UTC)

If any check disagrees → STOP; the Owner is pointed at the wrong branch.

## G3 — SQL migrations

- [ ] `pg_dump` taken immediately before migration (packet §5.1);
      sha256 recorded; file mode 0600; file size > 10 KB.
- [ ] Dump restored into a disposable PG16 container (packet §5.2);
      table counts match the production counts captured out-of-band
      just before the dump.
- [ ] `sql/production/dashboard_role_production.sql` executed under
      `-v production_branch_confirmed=on`; in-script assertions PASS.
- [ ] `sql/production/dashboard_crm_v1_up.sql` executed under
      `-v production_branch_confirmed=on`.
- [ ] `wbs_tf_ai_context` role created (packet §2.4); all `DO $$ … $$`
      assertions PASS.
      ___________ (Owner initials + UTC)

If any step fails → execute the matching rollback script and STOP.

## G4 — n8n credentials and workflows

- [ ] n8n credential `WBS Trade Fair — OpenAI RC3` created (type
      `openAiApi`); API key same value as existing
      `UUprjEp0Re6kPUFN`; cred id recorded as `TF_OPENAI_CRED_ID`.
- [ ] n8n credential `WBS Trade Fair — AI context` created (type
      `postgres`); points at production Neon host as role
      `wbs_tf_ai_context`; cred id recorded as `TF_AI_CTX_CRED_ID`.
- [ ] WF-07 imported with credentials rebound to
      `tjqSy2V0odocljw6` / `TF_OPENAI_CRED_ID` / `TF_AI_CTX_CRED_ID`;
      `active:false`; recorded id in `TF_WF07_ID`.
- [ ] WF-08 imported with same rebind; `active:false`; recorded id in
      `TF_WF08_ID`.
- [ ] WF-07 activated; `GET /rest/workflows/$TF_WF07_ID` →
      `active:true`, `versionId==activeVersionId`.
- [ ] WF-08 activated; same assertions.
- [ ] `curl http://127.0.0.1:3000/webhook/messe-hub/ai-extract`
      (no auth header) → HTTP 403.
- [ ] `curl http://127.0.0.1:3000/webhook/messe-hub/ai-ask`
      (no auth header) → HTTP 403.
- [ ] RC3.3 finalizer run (packet §3.4) exits 0; output saved under
      `/opt/wbs-trade-fair/secrets/backups/${TF_ROLLOUT_TS}/finalize.json`.
- [ ] Retention + timeout settings on both workflows match packet §3.5.
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

## G6 — Bounded-budget smoke test

- [ ] OpenAI organization monthly spend cap confirmed; daily budget
      ≤ $5 for the first 7 days configured in the OpenAI console.
- [ ] WF-07 (extract) smoke call returns 200 with success:true for a
      synthetic lead; token usage ≤ 2500 input + 500 output; response
      saved to secrets backups folder.
- [ ] WF-08 (ask) smoke call for the saved synthetic lead returns 200
      with cited lead_id exactly matching request; no PII pattern in
      answer; token usage within budget.
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
