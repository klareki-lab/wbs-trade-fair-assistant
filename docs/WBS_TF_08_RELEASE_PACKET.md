# WBS-TF-08 — Final release packet (operator checklist)

Date: 2026-10-24. Target: `https://messe.klare-ki.de`. Scope: one
executable release for the Trade Fair Assistant. **No production DDL,
nginx change, certificate issuance, container swap, DNS modification,
external email or PR merge was performed to produce this packet.**

This document is the single operator-facing checklist for the TF-08
cutover. It consolidates `docs/WBS_TF_06_F3B_PREP.md` R3 and
`docs/WBS_TF_07_PRODUCTION_PREFLIGHT.md`, and uses the atomic SQL from
PR #9. Each step is cross-referenced to the authoritative source and
retains its original STOP conditions.

## 1. Release-candidate identity

| Item | Value |
| --- | --- |
| Release branch | `release/wbs-tf-08` |
| Reviewed release base | PR #11 `f3b847f534dab9b88c10bdfe853271163f73b017` (includes PR #9) |
| Corrected release | Follow-on documentation correction PR; freeze its exact head and tree SHA before integration. |
| PR #9 head SHA | `45e0d741e2d7bc25f3cce23e419a1ef4f5c78734` |
| Independent SQL acceptance | PR #10 at `e8318bfdcc4773e8d88d48269657db1adff7c5e0` |
| Runtime chain (merged in order into updated `main`) | PR #1 `854f247` → PR #2 `413d8ad` → PR #3 `e143d8f` |
| Documentation chain (R1/R2/R3 of F3B) | PR #5 at `185c208` (R3 tip reachable from this branch) |
| Preflight baseline | PR #8 at `81d8d29` (documentation only; its defective migration is overridden by PR #9) |

The runtime and SQL tree at PR #11 descends from the PR #9 tip. PR #11
adds the release and acceptance documents. The corrected release adds
documentation fixes only. It descends from PR #8
and inherits PR #5/#3/#2/#1 by `git merge-base --is-ancestor`:

```
main (07a3969)
  └── baseline/live-2026-10-24           PR #1  854f247
        └── feature/astra-dashboard      PR #2  413d8ad
              └── fix/wbs-tf-04-...      PR #3  e143d8f
                    └── review/wbs-tf-05 PR #4  db2e72c  (review, docs only)
                          └── feat/wbs-tf-06-f3b-prep  PR #5  185c208  (R1 577f1b0 → R2 798e303 → R3 185c208)
                                └── feat/wbs-tf-07-preflight  PR #8  81d8d29
                                      └── fix/wbs-tf-07-sql-atomicity  PR #9  45e0d74
                                            └── release/wbs-tf-08    PR #11 f3b847f
                                                  └── corrected documentation release
```

PR #6 (`f8637f3`), PR #7 (`0a1d5d0`) and PR #10 (`e8318bf`) are review
records outside the merge chain. PR #4 is an ancestor and its review
document is included in the final tree.

## 2. Regression on the assembled release candidate

- `npm test --prefix gateway` on `release/wbs-tf-08`: **40/40 PASS**
  on Node 24.15.0 (same tests ran green on PR #3, PR #5, PR #8 and
  PR #9; the suite exercises form inertness, same-origin, session,
  retryable-503 contract, Dashboard fail-closed, outage mapping,
  anonymous/form-key rejection on Dashboard routes).
- `git diff --check` on the release tip: PASS.
- `sql/dashboard_snapshot_definition.sql` body is byte-identical to the
  function body previously reviewed on PR #3 (independent review in
  PR #10 §2 verified byte-for-byte equality).
- `sql/production/dashboard_role_production.sql` and
  `..._rollback.sql` each wrap one `BEGIN;…COMMIT;` with the shared
  function body included via `\ir ../dashboard_snapshot_definition.sql`;
  on isolated PostgreSQL 16, induced function-creation failure and
  induced privilege-assertion failure both left `role=0, function=0`
  (PR #10 §2).
- All Gateway runtime assets (`gateway/server.mjs`, `dashboard-api.mjs`,
  `dashboard-db.mjs`, `package.json`, `package-lock.json`, `web/*`) are
  present on the release tip; `Dockerfile.dashboard-staging`,
  `ops/nginx/*`, `ops/env/gateway.production.env.example` are present.
- PR #11 adds the release and acceptance documents, so its tree is
  **not** the PR #9 tree. Freeze and verify the corrected final tree
  before any merge or image build.

## 3. Production Neon identity (expected vs. verification required)

Target production branch (per TF-08 dispatch; must be re-verified by
Owner before any DDL):

| Field | Expected |
| --- | --- |
| Project | `wbs-trade-fair-assistant` |
| Branch | `production` |
| Branch ID | `br-proud-moon-bapf67qs` |
| Database | `neondb` |
| Endpoint | `ep-soft-field-bad37quw.c-8.eu-central-1.aws.neon.tech` |
| Owner role | `neondb_owner` with `rolcreaterole=true` |
| Staging branch (never target) | `br-rapid-sun-bandpl0m` (timeline `a171e976ae189ef43d7ca803d826354e`) |

Owner-side read-only verification has **two independent parts**:

1. In the authenticated Neon Console or owner API, open project
   `wbs-trade-fair-assistant` and branch
   `br-proud-moon-bapf67qs`. Confirm branch name `production`, its
   database `neondb` and endpoint hostname
   `ep-soft-field-bad37quw.c-8.eu-central-1.aws.neon.tech`. The
   endpoint must be associated with that branch, not staging. Record
   the metadata privately.
2. Using the Owner's existing credential through an approved private
   connection, authenticate as `neondb_owner` to **that exact endpoint**
   and run the following read-only SQL. Do not print a connection URL
   or password:

```sql
SELECT current_database(), current_user, inet_server_addr();
SELECT setting FROM pg_settings WHERE name='neon.timeline_id';
SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname='trade_fair';
SELECT rolcreaterole FROM pg_roles WHERE rolname=current_user;
SELECT count(*) FROM pg_proc p
  JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='trade_fair' AND p.proname='dashboard_snapshot';
```

PASS requires the authenticated metadata match **and**
`current_database=neondb`, `current_user=neondb_owner`,
`trade_fair` owner = `neondb_owner`, `rolcreaterole=true`, function
count `0`, and `neon.timeline_id` present and different from staging
`a171e976ae189ef43d7ca803d826354e`. An IP address or a
non-staging timeline alone does not establish the branch ID. Record
the verified ID, endpoint and timeline privately. If owner-authenticated
metadata or SQL access is unavailable, **STOP before §5.9**.

## 4. Pre-rollout preparation (no production change required)

1. **Freeze inputs.** Record the SHAs from §1, the chosen immutable
   image reference target, the production Neon branch ID/endpoint from
   §3, the Let's Encrypt recipient email and the maintenance window.
2. **Owner approvals.** Collect written approvals for the full §5
   sequence (production migration, candidate env creation, image
   build, nginx + Certbot, Gateway swap, staged HSTS, optional AAAA,
   PR integration path). Nothing in §5 is self-approving.
3. **Housekeeping (optional, pre-cutover).** Decide retention for
   `/opt/wbs-trade-fair/secrets/wbs-tf-04-dashboard-role.env` and
   `/opt/wbs-trade-fair/secrets/wbs-tf-04-staging.env` (both 0600 root)
   per TF-07 preflight §6.
4. **Freeze the corrected release.** Record its reviewed head and
   `git rev-parse HEAD^{tree}` in the private release log. Check that
   PR #9 commit `45e0d741e2d7bc25f3cce23e419a1ef4f5c78734`
   is an ancestor. Do not build the production image from PR #8.

### GitHub integration — one merge-commit chain

Use **merge commits**, never squash or rebase, for PR #1, #2, #3 and
the final corrected release PR. Their ancestry then lets Git recognize
already integrated commits; the final release PR brings only the
remaining documentation and corrected SQL. Retarget PR #2 and #3 to
`main` immediately before their merges. Retarget the corrected
release PR to `main` only after PR #3. Do not separately merge or
cherry-pick PR #4/#5/#8/#9/#11, and do not repeat the old F3B
documentation transplant: those files and the PR #9 correction are
already ancestors of the corrected release.

Before each merge, confirm the frozen PR head SHA (§1); after each
merge, fetch `main` and require its **tree SHA** to equal the
corresponding reviewed head's tree SHA. Stop on conflict, changed head,
tree mismatch or failed tests. No other main change may land during
this sequence. After PR #2 run `node --test tests/*.mjs` (38/38);
its historical `npm test` script points to a directory and fails on
Node 24, while PR #3 corrects it. After
PR #3 and after the final release merge require Gateway 40/40. Run
`ops/nginx/check_vhosts.sh` on the final tree. This is an execution
plan requiring Owner approval, not a merge authorization.

Execute these phases in a clean integration clone **only after the
Owner authorizes each merge**. Do not paste all phases as one unattended
script. For PR #2, #3 and the final release PR, retarget first, obtain
a fresh review of the changed diff, then mark ready and run the merge
phase. A failed command is a STOP. The Owner freezes
`TF_APPROVED_FINAL_HEAD` from the final review record; it must include
PR #9 commit `45e0d741e2d7bc25f3cce23e419a1ef4f5c78734`.

**Phase 1 — PR #1, after review and Owner approval:**

```bash
set -euo pipefail
test -z "$(git status --porcelain)"
git fetch origin
test "$(git rev-parse origin/main)" = 07a3969e59611943c5f8a001df1edd6bc1820fb9
test "$(gh pr view 1 --json headRefOid --jq .headRefOid)" = 854f247546742fd69cc5c81385cf2b73657d440b
gh pr merge 1 --merge
git fetch origin main
test "$(git rev-parse 'origin/main^{tree}')" = "$(git rev-parse '854f247546742fd69cc5c81385cf2b73657d440b^{tree}')"
```

**Phase 2 — PR #2:** Retarget with `gh pr edit 2 --base main`;
**STOP for renewed review and Owner approval**. Once PR #2 is ready:

```bash
set -euo pipefail
git fetch origin main
test "$(git rev-parse 'origin/main^{tree}')" = "$(git rev-parse '854f247546742fd69cc5c81385cf2b73657d440b^{tree}')"
test "$(gh pr view 2 --json headRefOid --jq .headRefOid)" = 413d8ad085fea93f424e22790de421ec15495e28
gh pr merge 2 --merge
git fetch origin main
test "$(git rev-parse 'origin/main^{tree}')" = "$(git rev-parse '413d8ad085fea93f424e22790de421ec15495e28^{tree}')"
git switch --detach origin/main
node --test tests/*.mjs  # require 38/38 at PR #2
```

**Phase 3 — PR #3:** Retarget with `gh pr edit 3 --base main`;
**STOP for renewed review and Owner approval**. Once PR #3 is ready:

```bash
set -euo pipefail
git fetch origin main
test "$(git rev-parse 'origin/main^{tree}')" = "$(git rev-parse '413d8ad085fea93f424e22790de421ec15495e28^{tree}')"
test "$(gh pr view 3 --json headRefOid --jq .headRefOid)" = e143d8ff1ab9938fd43866803bcd9ce9bd5c3e57
gh pr merge 3 --merge
git fetch origin main
test "$(git rev-parse 'origin/main^{tree}')" = "$(git rev-parse 'e143d8ff1ab9938fd43866803bcd9ce9bd5c3e57^{tree}')"
git switch --detach origin/main
npm test --prefix gateway  # require 40/40
```

**Phase 4 — corrected final release PR:** Retarget it to `main` only
after phase 3; **STOP for renewed review and Owner approval**. Set the
approved SHA in the shell from the private release record, then:

```bash
set -euo pipefail
: "${TF_APPROVED_FINAL_HEAD:?Owner-approved corrected release SHA required}"
git fetch origin main
test "$(git rev-parse 'origin/main^{tree}')" = "$(git rev-parse 'e143d8ff1ab9938fd43866803bcd9ce9bd5c3e57^{tree}')"
test "$(gh pr view 12 --json headRefOid --jq .headRefOid)" = "$TF_APPROVED_FINAL_HEAD"
git merge-base --is-ancestor 45e0d741e2d7bc25f3cce23e419a1ef4f5c78734 "$TF_APPROVED_FINAL_HEAD"
test "$(git rev-parse "${TF_APPROVED_FINAL_HEAD}:sql/production/dashboard_role_production.sql")" = d518c0042572152a236cdf523e57573c38a4feb7
test "$(git rev-parse "${TF_APPROVED_FINAL_HEAD}:sql/production/dashboard_role_production_rollback.sql")" = 22f5b402359a804c16d0cd38debc16ee6d5f0f4c
gh pr merge 12 --merge
git fetch origin main
test "$(git rev-parse 'origin/main^{tree}')" = "$(git rev-parse "${TF_APPROVED_FINAL_HEAD}^{tree}")"
git switch --detach origin/main
npm test --prefix gateway  # require 40/40
./ops/nginx/check_vhosts.sh  # require 3/3
```

Before phase 4, compare the frozen final tree SHA from the Owner
record with `git rev-parse "${TF_APPROVED_FINAL_HEAD}^{tree}"`. Do not
continue on a changed head, tree mismatch or failed test. PR #11 and
its ancestor PRs need no separate merge after the corrected release PR.

## 5. Deployment execution order (single ordered checklist)

Each step maps to the authoritative detail in the referenced source.
**Stop immediately** on any failed check and route to the §6 rollback
layer. The order below supersedes the two older checklists wherever
they overlap.

| # | Step | Authority |
| --- | --- | --- |
| 5.1 | Confirm PR #1 head `854f247546742fd69cc5c81385cf2b73657d440b`; merge with a **merge commit** into `main`. Verify the resulting main tree equals this head's tree. | Integration plan above. |
| 5.2 | Retarget PR #2 to `main`; confirm head `413d8ad085fea93f424e22790de421ec15495e28`; merge with a **merge commit**. Verify tree equality and run `node --test tests/*.mjs` (38/38). | Integration plan above. |
| 5.3 | Retarget PR #3 to `main`; confirm head `e143d8ff1ab9938fd43866803bcd9ce9bd5c3e57`; merge with a **merge commit**. Verify tree equality and Gateway 40/40. Retarget the final corrected release PR to `main` only after this checkpoint. | Integration plan above. |
| 5.3a | Confirm the frozen corrected release head; merge its PR into `main` with a **merge commit**. Verify the main tree equals its frozen tree. Run Gateway 40/40 and nginx 3/3 on that exact tree. Only then proceed to DNS and production steps. | Integration plan above. |
| 5.4 | **DNS A verification.** `dig @8.8.8.8 +short messe.klare-ki.de A` and `dig @1.1.1.1 +short messe.klare-ki.de A` both return `77.42.19.144`. AAAA empty. Any disagreement → STOP. | F3B §2, TF-07 §8 step 5. |
| 5.5 | **nginx bootstrap vhost.** Install `ops/nginx/messe.klare-ki.de.bootstrap.conf` (ACME `/.well-known/acme-challenge/` only on port 80, nothing on 443). `nginx -t` must PASS. | F3B §10 step 3. |
| 5.6 | **TLS issuance.** `sudo certbot --nginx -d messe.klare-ki.de --redirect --agree-tos -m <owner-email> --no-eff-email`. | F3B §10 step 4. |
| 5.7 | **HTTPS holding.** Swap in `ops/nginx/messe.klare-ki.de.https-holding.conf`; confirm `curl -sS -o /dev/null -w '%{http_code}' https://messe.klare-ki.de/` = `503`. | F3B §10 step 5. |
| 5.8 | **Neon identity re-verification.** Match the production branch ID and endpoint in authenticated Neon metadata, then run §3 read-only SQL as `neondb_owner` on that endpoint. Record a pre-migration WF-A–D role/ACL catalog baseline privately for acceptance C9. STOP on any disagreement or missing baseline. | TF-07 §4; TF-08 §3. |
| 5.9 | **Production SQL migration (PR #9 version only).** From the repository root: `psql -X -v ON_ERROR_STOP=1 -v production_branch_confirmed=on -f sql/production/dashboard_role_production.sql` as `neondb_owner`, with `WBS_DASHBOARD_PROD_ROLE_PASSWORD` only in the process environment. The script runs role creation, function install, grants and all catalog assertions in **one transaction**; any failure rolls everything back. The defective PR #8 migration must **never** be run. | PR #9, PR #10. |
| 5.10 | **Baseline capture.** F3B §6 "Baseline capture" block (defines `TF_ROLLOUT_TS`, writes it to `/opt/wbs-trade-fair/secrets/active-rollout-ts`, saves `inspect.json`, `image.json`, `env.pre`, `nginx-pre.conf` under `/opt/wbs-trade-fair/secrets/backups/${TF_ROLLOUT_TS}/` with mode 0700, root). | F3B §6. |
| 5.11 | **Candidate env.** Create `/opt/wbs-trade-fair/secrets/gateway.dashboard.env` (mode 0600, root), shape from `ops/env/gateway.production.env.example`, set `APP_ORIGIN=https://messe.klare-ki.de`, `DASHBOARD_ENABLED=true`, a fresh `DASHBOARD_ACCESS_KEY` distinct from `TRADE_FAIR_ACCESS_KEY`, and the production `DASHBOARD_DATABASE_URL` for the `trade_fair_dashboard` role (never for `neondb_owner`). Keep `/opt/wbs-trade-fair/secrets/gateway.env` **unchanged**. Do not reverse 5.10 and 5.11. | F3B §6. |
| 5.12 | **Immutable image build.** Build the production image from the merged runtime SHA using `Dockerfile.dashboard-staging`; capture content-addressed digest; assign `TF_GATEWAY_IMAGE`. Image must not keep host mounts; `docker create` + `docker inspect -f '{{len .Mounts}}'` returns `0`. | F3B §6, TF-07 §5. |
| 5.13 | **Reversible Gateway swap.** F3B §6 "Reversible swap" preflight block (asserts `TF_ROLLOUT_TS`, candidate container, zero mounts, matching image, env-file mode, backup presence, holding 503) **before** `docker stop wbs-trade-fair-gateway`. Then rename old → `.saved-${TF_ROLLOUT_TS}`, candidate → `wbs-trade-fair-gateway`, `docker start`. Any failed assertion is a STOP; do not stop the old container. | F3B §6. |
| 5.14 | **Loopback acceptance.** F3B §7.1. Every row must pass; `/healthz` body must equal `{"success":true,"service":"trade-fair-gateway"}`. | F3B §7.1. |
| 5.15 | **Final proxy vhost.** Swap `ops/nginx/messe.klare-ki.de.conf` into place. `nginx -t` PASS, reload. | F3B §10 step 11. |
| 5.16 | **External HTTPS acceptance.** F3B §7.2. Every row must pass (including same-origin, Dashboard anonymous/form-key rejection, outage mapping to retryable 503). | F3B §7.2. |
| 5.17 | **Product acceptance.** Execute `docs/WBS_TF_08_ACCEPTANCE_TESTS.md`; every executed row must pass. Owner-approved deferrals under its §G are recorded explicitly and are not live PASS evidence. | TF-08 acceptance. |
| 5.18 | **Staged HSTS.** F3B §7.3: no header → `max-age=300` after acceptance → `max-age=31536000` only after at least seven stable days. Policy covers the exact `messe.klare-ki.de` host; no `includeSubDomains` or preload. | F3B §7.3. |
| 5.19 | **Optional IPv6 release.** F3B §8. All four external IPv6 probes PASS before publishing AAAA. IPv4-only final state is acceptable. | F3B §8. |
| 5.20 | **Review records.** After acceptance, cross-link the historical PRs and record the final tree and deployment evidence. Do not merge or transplant F3B documentation again. | Integration plan above. |

## 6. Rollback (reversible)

Rollback is layered so no single failure requires more than it must.
Use the deterministic `TF_ROLLOUT_TS` recorded in step 5.10.

| Layer | Trigger | Action | Authority |
| --- | --- | --- | --- |
| L1 — Gateway container | Loopback or product acceptance fails after swap | If final proxy is live, **first perform L2** and verify HTTPS 503. Then run the exact F3B §9 Layer B preflight, stop/rename the new `wbs-trade-fair-gateway` to `.failed-${TF_ROLLOUT_TS}`, restore `.saved-${TF_ROLLOUT_TS}` and start the old container. Its original env remains in the saved container. | F3B §9. |
| L2 — nginx | Final proxy is live and external acceptance fails, or L1 is needed after 5.15 | Restore `ops/nginx/messe.klare-ki.de.https-holding.conf`, run `nginx -t`, reload and assert HTTPS 503 **before** restoring the old HTTP-origin Gateway. | F3B §9 Layer C. |
| L3 — TLS/vhost | Bootstrap, certificate or holding setup fails before Gateway swap | Keep the safe holding response where TLS works; otherwise stop and inspect the existing vhost/default route. Do not delete the certificate or remove the vhost in the hot rollback. Certificate retirement is a separate Owner decision after the incident. | F3B §9. |
| L4 — Neon role/function | Feature retired after Gateway rollback | Only after the Gateway is stopped or **recreated with** `DASHBOARD_ENABLED=false` and no client uses the role, run `psql -X -v ON_ERROR_STOP=1 -v production_branch_confirmed=on -f sql/production/dashboard_role_production_rollback.sql` as `neondb_owner` on the confirmed production branch. Dependency errors roll the removal transaction back; WF-A–D grants are untouched. | PR #9, PR #10 §2. |
| L5 — GitHub integration | A merge checkpoint has a changed head, failed test or unexpected tree | Stop before the next merge or production step. Keep review PRs open and investigate; do not compensate with a documentation transplant. | Integration plan above. |

Rollback readiness checks (do before 5.13):

- `TF_ROLLOUT_TS` present in `/opt/wbs-trade-fair/secrets/active-rollout-ts` and equal to the current shell variable.
- Pre-cutover `env.pre`, `inspect.json`, `image.json`, `nginx-pre.conf` present under `/opt/wbs-trade-fair/secrets/backups/${TF_ROLLOUT_TS}/`.
- Original Gateway image (saved by `docker image inspect` digest) still present on the host.
- `gateway.env` byte-identical to `env.pre`.
- `gateway.dashboard.env` differs from `gateway.env`.
- No pre-existing `wbs-trade-fair-gateway.saved-*` or `.failed-*` with the same timestamp.

## 7. STOP conditions (union of all sources)

Stop and page back to this packet if any of these hold at any step:

- `dig @sid.ns.cloudflare.com messe.klare-ki.de A` disagrees with `77.42.19.144`, or AAAA/CNAME becomes non-empty unexpectedly before §5.19.
- Any `/etc/nginx/sites-enabled/` entry other than the three TF-08 files claims `messe.klare-ki.de` on `server_name`.
- `nginx -t` ever returns non-zero.
- `sql/production/dashboard_role_production.sql` fails any pre-install sanity check or post-install assertion (role catalog, function catalog, privileges, search_path, direct table SELECT, access to other `trade_fair` functions).
- Production Neon `current_user` is not `neondb_owner`, `trade_fair` owner is not `neondb_owner`, or `neon.timeline_id` matches the staging value `a171e976ae189ef43d7ca803d826354e`.
- `docker inspect wbs-trade-fair-gateway.candidate --format '{{len .Mounts}}'` returns anything but `0`.
- Gateway `GET http://127.0.0.1:3000/healthz` body differs from `{"success":true,"service":"trade-fair-gateway"}` or returns non-200.
- Any §7.1 or §7.2 row returns 2xx on an outage path, admits an anonymous or form-key session to a Dashboard route, or omits any Gateway security header listed in F3B §7.
- `n8n list:workflow --onlyActive` shows any of WF-A..D ID (`d5uO1lnwjOirJ5Xf`, `dr05aJRh8Lu6VpSA`, `bRkCsVxZXU85yqLI`, `THulrTbNEZ2FrgJ3`) toggling `active`.
- Product acceptance (`docs/WBS_TF_08_ACCEPTANCE_TESTS.md`) fails any
  executed row, or any deferral lacks an Owner decision.
- Any §8 IPv6 probe fails before AAAA is published.

## 8. Outstanding blockers (TF-08)

| # | Blocker | Owner-side action |
| --- | --- | --- |
| B1 | Production Neon branch identity verified only on paper, not against the live endpoint. No production credential is available to this preparation; `psql` is not installed on the controller host. | Owner connects to `ep-soft-field-bad37quw.c-8.eu-central-1.aws.neon.tech` as `neondb_owner` and runs §3 queries out of band; records the result privately. Required before step 5.9. |
| B2 | No TLS certificate for `messe.klare-ki.de` yet. | 5.6 issues it. |
| B3 | Immutable production image not built. | 5.12 builds it from merged runtime SHA. |
| B4 | Original PR #8 migration must never run; its defect is independent-reviewed on PR #10 §1. | Use PR #9's SQL only; §5.9 is pinned to PR #9. |
| B5 | PR #1 → #2 → #3 not merged to `main`. | §§5.1–5.3 under Owner authorization. |
| B6 | Residual stale staging secret files on the VPS. | Housekeeping §4.3; non-blocking. |
| B7 | Original PR #11 acceptance routes and rollback summary do not match the Gateway/F3B contracts. | Review and integrate the follow-on documentation correction before the final release merge. |

## 9. What is NOT in scope of this packet

- Changing n8n workflows (WF-A..D remain unchanged).
- Rotating `TRADE_FAIR_ACCESS_KEY`, `SESSION_SECRET`, `N8N_HEADER_KEY`, `N8N_CAPTURE_URL`, `N8N_STATUS_URL` (owner decision; the candidate env can keep them or receive new values).
- Any change to Gateway source during cutover beyond the immutable image already built.
- Publishing AAAA before external IPv6 verification (deferred).
- Sending any email through WF-C in acceptance without explicit Owner authorization (see acceptance test plan).

## 10. Status

- **Assembled release base:** PR #11 contains runtime, SQL correction and 40/40 regression evidence. Its acceptance and rollback documents require the follow-on correction before GO.
- **SQL correction:** INCORPORATED (PR #9 `45e0d74`); defective PR #8 migration never used.
- **F3B PREPARATION:** ACCEPTED (PR #7).
- **TF-07 preflight correction:** ACCEPTED (PR #10).
- **Production execution:** **NO-GO until the corrected release is
  reviewed and integrated**, Owner completes §3 branch verification
  and approves the controlled merge/deployment sequence. No
  production side effect was produced here.
