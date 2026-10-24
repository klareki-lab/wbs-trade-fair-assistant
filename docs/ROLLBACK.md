# Rollback — WBS-TF-03 Dashboard

No production change is performed by this PR. The branch is a candidate for
Draft review, not a live deployment. The notes below cover the two phases
that still remain.

## Phase 0 — Before any deployment (git-only)

- Close/abort the Draft PR without merging. Delete the feature branch if the
  work is abandoned.
- To return a developer tree to the live baseline:
  `git switch baseline/live-2026-10-24`. No production impact.

## Phase 1 — If staging deploy fails

- `DASHBOARD_ENABLED=false` restores pre-dashboard behavior; existing
  routes are untouched regardless of the env flag. The dashboard code
  path becomes inert (`createDashboardDb` not called, no `/dashboard*`
  routes served).
- The `pg` dependency is only used when `DASHBOARD_ENABLED=true`; a
  staging rollback can leave the installed dep in place.
- If baseline routes regress (should not — they are covered by
  `tests/test_gateway_baseline.mjs`), revert the container image to the
  **saved pre-deploy image ID**, with the original volumes, network,
  ports, env and restart policy, using the existing operational runbook.
- Keep n8n and nginx (Gate F3B) untouched.

## Phase 2 — If production deploy fails

1. Stop new rollout. Do not import or reset n8n workflows. Do not touch
   `trade_fair` data.
2. Set `DASHBOARD_ENABLED=false` via the existing approved Gateway
   configuration process and recreate only the gateway container with
   the existing production service definition. A plain `docker restart`
   does not re-apply changed env or image.
3. If the baseline routes themselves regress, replace the candidate
   image with the pre-deploy image ID (original volumes, network, ports,
   env, restart policy). Do not touch other containers.
4. Verify `/healthz`, `/`, login, capture / status smokes, WF-A–D.
5. The `trade_fair.dashboard_snapshot` function is inert without gateway
   access. **Do not** drop the function or revoke permissions
   automatically during an emergency rollback. Database changes require
   independent owner approval and privilege-impact review. A later
   cleanup may revoke the explicitly approved `EXECUTE` and remove the
   function once there are no callers.
6. Record the incident with old/new image IDs, test evidence and restore
   status. Keep evidence redacted (no PII, no tokens).

## Non-rollback

- `trade_fair_app` role is not modified by this PR; nothing to revert for
  the pipeline roles.
- WF-A–D are not modified; nothing to revert in n8n.
- nginx Gate F3B is not modified; nothing to revert there.
