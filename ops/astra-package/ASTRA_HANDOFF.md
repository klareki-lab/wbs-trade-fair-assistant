# Handover to Black / Codex

## Confirmed locally

- Yuri's original `Messe-Admin-Hub.html` visually retained (core CSS, sidebar, cards, charts, tabular area, details drawer); obsolete auth/chat/merge paths removed.
- New Gateway route patch validated against **historical 2.0.1 reference**, not the authoritative GitHub base commit.
- Existing Gateway suite 33/33 PASS against the historical reference.
- Dashboard API/contract/security mock suite 25/25 PASS.
- Gateway/dashboard HTTP suite 5/5 PASS using mock PostgreSQL output.
- No production writes; no real Neon, n8n, Resend or VPS touched.

## BLOCKED / PENDING items

1. **Authoritative baseline retrieval**: checkout SHA `854f247546742fd69cc5c81385cf2b73657d440b`; compare actual `gateway/server.mjs`, `gateway/package.json`, `web/` and tests. The archive used for local smoke is NOT the source of truth.
2. **GitHub write access**: feature branch, commit SHA and Draft PR URL not generated in this environment (no authenticated GitHub write connector; container cannot resolve github.com).
3. **Neon DDL/ACL**: current `sql/trade_fair_schema.txt` is incomplete. Run read-only `sql/PREFLIGHT_READ_ONLY.sql` or receive full DDL. Do not apply SQL until reviewed. Verify executing role/owner, function collision and grants.
4. **PG dependency install**: `pg@^8.16.3` specified by patcher but not downloaded/lockfile-generated in offline sandbox. Generate lockfile in authorized checkout and run npm CI/lockfile audit.
5. **SQL execution**: schema migration compiled/reviewed statically only; needs isolated PostgreSQL/Neon branch test (no local psql available).
6. **Browser and actual VPS E2E**: no true live validation. SSL, nginx Gate F3B route forwarding, mobile screens, reported test lead WARM 45/100 and real email outbox must be checked by Black/Codex.

## Codex step-by-step

1. Review `docs/WBS_TF_02_OVERVIEW.md`, `API_CONTRACT.md`, `DEPLOY.md`, `ROLLBACK.md` and `TEST_REPORT.md` within this package.
2. Clone repository; branch from exact baseline commit as in DEPLOY.md (not `main`).
3. Copy overlay files and run `node scripts/apply_dashboard.mjs` from repo root. Stop if mismatch; compare changes without replacing the baseline wholesale.
4. Generate `gateway/package-lock.json` using a reachable npm registry and install `pg`; inspect Docker build context/npm CI step.
5. Run all existing tests plus new tests; check no leaked tokens/credentials, no production workflow modifications, no surprise nginx changes. Review the SQL function in isolation.
6. Run Neon read-only metadata preflight with owner-approved credentials; request missing DDL if needed, decide approved existing role, and test optional function only on isolated branch.
7. Commit to `feature/astra-dashboard`, push, create Draft PR into `baseline/live-2026-10-24`; do not merge. Suggested Git commands:

```sh
git add gateway/server.mjs gateway/package.json gateway/package-lock.json gateway/dashboard-api.mjs gateway/dashboard-db.mjs web/Messe-Admin-Hub.html web/dashboard.js web/dashboard.css sql/dashboard_snapshot.sql sql/PREFLIGHT_READ_ONLY.sql scripts/apply_dashboard.mjs tests/test_dashboard.mjs tests/test_gateway_dashboard.mjs DEPLOY.md ROLLBACK.md API_CONTRACT.md TEST_REPORT.md HANDOFF.md
git diff --cached --check
git commit -m "feat: authenticated read-only Neon admin dashboard"
git push -u origin feature/astra-dashboard
gh pr create --draft --base baseline/live-2026-10-24 --head feature/astra-dashboard --title "WBS-TF-02: Admin Dashboard read-only Gateway/Neon integration" --body "Local mock PASS; Neon DDL/ACL and VPS E2E PENDING; no production changes."
git rev-parse HEAD
```

8. Send operator PR URL, commit SHA, test logs and current blockers, then hand staging validation to Black. No merge or VPS deploy until gates cleared.
