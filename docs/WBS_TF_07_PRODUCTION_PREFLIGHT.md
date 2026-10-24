# WBS-TF-07 — Production preflight and release freeze

Scope: read-only preflight only. No DNS, nginx, Neon, Gateway, workflow,
certificate, image push or merge operation was performed by this
preflight. **PRODUCTION EXECUTION — NOT YET AUTHORIZED.**

## 1. Freeze — exact release SHAs

```
origin/main                              07a3969e59611943c5f8a001df1edd6bc1820fb9
origin/baseline/live-2026-10-24          854f247546742fd69cc5c81385cf2b73657d440b   PR #1 head
origin/feature/astra-dashboard           413d8ad085fea93f424e22790de421ec15495e28   PR #2 head
origin/fix/wbs-tf-04-preflight-staging   e143d8ff1ab9938fd43866803bcd9ce9bd5c3e57   PR #3 head
origin/review/wbs-tf-05                  db2e72ccc6ccfd22a156f432c18da538a5380704   PR #4 head
origin/feat/wbs-tf-06-f3b-prep           185c208152a3af2585bb38f0ae86fb7a3b687130   PR #5 head (R3)
origin/review/wbs-tf-06-f3b              f8637f377199363d78a0c69c9cdd5e6c37cfe870   PR #6 head
origin/review/wbs-tf-06-r3-black         0a1d5d04fb29b8322085fc2457568f6d58bacf35   PR #7 head
```

`git merge-base --is-ancestor` independently confirmed the runtime chain:
`main → baseline/live-2026-10-24 → feature/astra-dashboard →
fix/wbs-tf-04-preflight-staging`. R3 `185c208` is reachable from
`feat/wbs-tf-06-f3b-prep`; R1 `577f1b0` and R2 `798e303` are also
reachable from the same tip, so §13 of the F3B packet's cherry-pick
plan can preserve all three documentation revisions.

### Intended integration order (owner approval still required)

1. Merge PR #1 (`baseline/live-2026-10-24` → `main`).
2. Retarget PR #2 against updated `main`, re-review, merge.
3. Retarget PR #3 against updated `main`, re-review, merge.
4. Documentation: transplant R1 + R2 + R3 of PR #5 onto a new
   `docs/wbs-tf-06-f3b-r3` branch cut from updated `main`, open a new
   PR to `main`. Close PR #4, PR #5, PR #6 as draft review records
   with cross-links; keep PR #7 (this preflight's parent review)
   likewise.
5. Only after PR #3 lands on `main` does any production action from
   §4–§10 of the F3B packet become eligible for execution.

## 2. Production prerequisites

| Prerequisite | State | Evidence |
| --- | --- | --- |
| PR #1 → #2 → #3 ancestor chain | PASS | `git merge-base --is-ancestor` three-step check in §1. |
| Dashboard code reviewed on PR #3 | PASS | Final head `e143d8f`, inherits WBS-TF-05 and WBS-TF-05 Codex PASS. |
| F3B packet R3 accepted by independent review | PASS | PR #7 verdict ACCEPTED; `docs/WBS_TF_06_R3_BLACK_REVIEW.md`. |
| Node regression suite | PASS | `node --test tests/*.mjs` → `tests 40, pass 40, fail 0` on Node 24.15.0 locally. |
| nginx vhost syntax | PASS | `ops/nginx/check_vhosts.sh` → 3/3 PASS on nginx 1.24. |
| Immutable image recipe | PASS | `Dockerfile.dashboard-staging` builds locally without mounts; dry-run image id `sha256:1b8ea19e...` size 239 MB; `docker create` of the resulting image reports `len .Mounts = 0` and no `Binds`. |
| Production SQL migration script | PREPARED | New files `sql/production/dashboard_role_production.sql` and `sql/production/dashboard_role_production_rollback.sql`; see §4. |
| Private backup location | AVAILABLE | `/opt/wbs-trade-fair/secrets/` exists mode 0700 root; a dry-run `install -d -m 0700 /opt/wbs-trade-fair/secrets/backups.dryrun` succeeded and was cleaned. Free space on `/opt` is 8.7 G. |

## 3. DNS and TLS readiness

Independently re-verified from four distinct resolvers (two Cloudflare
authoritatives, 8.8.8.8, 1.1.1.1):

```
messe.klare-ki.de A      → 77.42.19.144   (same across all four)
messe.klare-ki.de AAAA   → (empty)        deliberately absent until §8 of F3B
messe.klare-ki.de CNAME  → (empty)
klare-ki.de       CAA    → (empty)        any CA may issue
```

No TLS certificate for `messe.klare-ki.de` is present on the VPS yet
(`sudo certbot certificates` lists eight unrelated hosts; §3 of F3B).
TLS issuance is a separate owner-approved step in §10 of the F3B
packet (certbot --nginx HTTP-01, port 80 bootstrap vhost in place).

## 4. Database migration readiness

The F3B R3 §10 step 6 defers production Neon migration to "a separately
reviewed owner migration — not the staging-only
`sql/dashboard_role_staging.sql`". This preflight commits that script:

- **`sql/production/dashboard_role_production.sql`.** Guarded by
  `-v production_branch_confirmed=on`. Reads the role password only from
  the process environment `WBS_DASHBOARD_PROD_ROLE_PASSWORD`. Early
  sanity checks assert that `trade_fair` exists, is owned by
  `neondb_owner`, and that neither the role nor the function already
  exists. Role, function, grants and assertions run in **one transaction**.
  The shared function body is included from
  `sql/dashboard_snapshot_definition.sql` via `\ir`, resolved relative
  to the migration file. Before commit, the transaction asserts:
  - `prosecdef=true`, `provolatile='s'`, `proowner=neondb_owner`,
  - no `PUBLIC` EXECUTE on the function,
  - `trade_fair_dashboard` has `EXECUTE` on it,
  - `trade_fair_dashboard` has `USAGE` and lacks `CREATE` on the schema,
  - a pinned `search_path`, exact role flags and database `CONNECT`,
  - no direct table privileges, no `EXECUTE` on any other
    `trade_fair.*` function.
- **`sql/production/dashboard_role_production_rollback.sql`.** Same
  guard. Checks the owner, role and function, then `DROP FUNCTION`,
  `REVOKE USAGE/CONNECT` and `DROP ROLE`. It asserts both are gone
  before commit; a dependency error rolls the removal back.

Both scripts refuse to run without the explicit guard variable, so
accidental execution against staging (which uses
`-v isolated_branch_confirmed=on`) is prevented by name mismatch.

### Production Neon branch identity (not yet verified in this preflight)

The staging branch is `br-rapid-sun-bandpl0m` (verified earlier under
WBS-TF-04). The production branch identity (ID, endpoint, timeline)
is **not** available to this preflight; `/opt/wbs-trade-fair/secrets/`
holds only the staging owner URL and staging env. Production Neon is
reached by the n8n container's encrypted credential, not by the
Gateway. Owner-side out-of-band verification analogous to Codex's
staging confirmation is required before running the migration:

1. In the Neon Console, open the production branch for the
   `wbs-trade-fair-assistant` project (NOT `br-rapid-sun-bandpl0m`).
2. Record the branch ID, endpoint hostname and timeline marker in the
   private deployment log, not in Git or chat.
3. Open a temporary owner connection to the production branch with the
   production `neondb_owner` password and run:
   ```sql
   SELECT current_database(), current_user, inet_server_addr();
   SELECT setting FROM pg_settings WHERE name='neon.timeline_id';
   SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname='trade_fair';
   SELECT rolcreaterole FROM pg_roles WHERE rolname=current_user;
   SELECT count(*) FROM pg_proc p
     JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='trade_fair' AND p.proname='dashboard_snapshot';
   ```
   Confirm `current_user=neondb_owner`, `current_database=neondb`,
   schema owner `neondb_owner`, `rolcreaterole=true`, function count
   `0`, and that the
   `neon.timeline_id` is **not** `a171e976ae189ef43d7ca803d826354e`
   (that is the staging timeline). Only then, from the repository root,
   run
   `psql -X -v ON_ERROR_STOP=1 -v production_branch_confirmed=on
    -f sql/production/dashboard_role_production.sql`.

## 5. VPS baseline (read-only, field-scoped — no secrets)

```
Gateway: name=/wbs-trade-fair-gateway
         image=sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
         base-image=node:22-alpine (code lives in host mounts)
         net=host restart=unless-stopped running=true
         started 2026-10-24T14:15:22Z

Mounts (RO): /opt/wbs-trade-fair/trade_fair_assistant/web      -> /app/web      ro
             /opt/wbs-trade-fair/trade_fair_assistant/gateway  -> /app/gateway  ro

Healthz: curl http://127.0.0.1:3000/healthz
         → 200 {"success":true,"service":"trade-fair-gateway"}

nginx 1.24.0 vhosts: bistro, delivery, herman, mcp, minio, console,
                     n5n, review, default. None matches messe.
                     grep for 'messe|trade.?fair|wbs' in /etc/nginx: none.

Listen: 0.0.0.0:80, 0.0.0.0:443, 127.0.0.1:3000, 127.0.0.1:5678,
        127.0.0.1:8100, 0.0.0.0:5680. Port 13080 is free.

n8n container: n8n-n8n-1, net=n8n_default, restart=no, running=true.
WF-A..D active=1 (all four):
  d5uO1lnwjOirJ5Xf  WBS — Trade Fair Assistant — WF-A Lead Capture
  dr05aJRh8Lu6VpSA  WBS — Trade Fair Assistant — WF-B Lead Processing
  bRkCsVxZXU85yqLI  WBS — Trade Fair Assistant — WF-C Sales Email Delivery
  THulrTbNEZ2FrgJ3  WBS — Trade Fair Assistant — WF-D Lead Status
```

**Impact**: F3B R3 §6 "Immutable image" is correctly scoped. The current
Gateway relies entirely on the two bind mounts; the production image
bakes `gateway/*.mjs` and `web/` and drops the mounts. The §6 preflight
assertion `test "$(docker inspect -f '{{len .Mounts}}' wbs-trade-fair-gateway.candidate)" = 0` is **required** to prevent accidentally
copying the live container's mount pattern onto the candidate.

## 6. Backup and rollback readiness

- `/opt/wbs-trade-fair/secrets/` is `drwx------ root root`; subdirectory
  `backups.dryrun` was created with mode 0700 and removed in the probe.
  Free space is 8.7 G on `/`; the baseline capture of
  `inspect.json`, `image.json`, `env.pre`, `nginx-pre.conf` is on the
  order of 20–50 KB per run.
- The F3B R3 §9 three-layer rollback uses the single `TF_ROLLOUT_TS`
  variable written to `/opt/wbs-trade-fair/secrets/active-rollout-ts`
  during §6 "Baseline capture". Container names `.saved-${TF_ROLLOUT_TS}`
  and `.failed-${TF_ROLLOUT_TS}` are consistent across cutover (§6) and
  rollback (§9). PR #7 independent review confirmed the ordering keeps
  the HTTPS holding vhost in place before any Gateway rename, so HTTPS
  never fronts an HTTP-origin Gateway.
- Residual stale secret files on the VPS:
  - `/opt/wbs-trade-fair/secrets/wbs-tf-04-dashboard-role.env` (mode
    0600). The staging dashboard role was dropped at WBS-TF-04 rollback;
    this file is obsolete. Owner should delete or rotate during the
    pre-cutover window.
  - `/opt/wbs-trade-fair/secrets/wbs-tf-04-staging.env` (mode 0600).
    Private staging env for the WBS-TF-04 compose harness; still useful
    for future staging reruns. Keep or delete per owner retention
    policy.

Neither affects production rollback; both are housekeeping items.

## 7. Required Owner approvals

Nothing below is self-approving.

1. **Neon production branch verification.** Owner-side out-of-band
   confirmation of the production Neon branch ID, endpoint, timeline
   marker (§4). Must not reuse the staging branch
   `br-rapid-sun-bandpl0m` or its owner URL.
2. **Neon production migration.**
   `psql -X -v ON_ERROR_STOP=1 -v production_branch_confirmed=on
    -f sql/production/dashboard_role_production.sql` as `neondb_owner`
   on the confirmed production branch, with
   `WBS_DASHBOARD_PROD_ROLE_PASSWORD` only in the process environment.
3. **DNS AAAA.** Deferred per §8 of F3B R3. Publish only after the four
   external IPv6 probes pass. IPv4-only final state is acceptable.
4. **nginx install** (in order from F3B §10):
   - bootstrap vhost (`ops/nginx/messe.klare-ki.de.bootstrap.conf`),
   - `sudo certbot --nginx -d messe.klare-ki.de --redirect --agree-tos
      -m <owner-email> --no-eff-email`,
   - swap to `ops/nginx/messe.klare-ki.de.https-holding.conf`,
   - after loopback acceptance passes, swap to
     `ops/nginx/messe.klare-ki.de.conf`,
   - staged HSTS (nothing → `max-age=300` → `max-age=31536000`,
     host-only).
5. **Private secrets provisioning.** First run F3B §6 "Baseline
   capture" while the original `gateway.env` is unchanged; verify
   `env.pre` under `/opt/wbs-trade-fair/secrets/backups/${TF_ROLLOUT_TS}/`.
   Then create the distinct `gateway.dashboard.env` (mode 0600,
   root). Do not reverse this order.
6. **Production image.** Build from the final PR #3 (plus merged PR #1,
   #2) SHA using `Dockerfile.dashboard-staging`; record the content-
   addressed digest in the deployment log.
7. **Reversible Gateway swap.** Execute §6 "Reversible swap" with
   `TF_GATEWAY_IMAGE=<digest>` under preflight assertions.
8. **Loopback acceptance** (§7.1 of F3B R3), then **external HTTPS
   acceptance** (§7.2), then **staged HSTS transitions** (§7.3).
9. **Optional IPv6 release** (§8 of F3B R3).
10. **PR integration path** (§13 of F3B R3): transplant R1 + R2 + R3
    onto a new branch from updated `main`; close PR #4, PR #5, PR #6,
    PR #7 as drafts with cross-links.
11. **Rollback of the production dashboard role + function** (if the
    deployment is retired): execute
    `sql/production/dashboard_role_production_rollback.sql` as owner,
    only after the Gateway has been recreated with
    `DASHBOARD_ENABLED=false` or stopped, so no caller remains.

## 8. Deployment execution order (ordered checklist)

Each step maps to the authoritative detail in `docs/WBS_TF_06_F3B_PREP.md`
and `sql/production/`. **Stop immediately** on any failed check and go
to the referenced rollback layer.

1. **Freeze inputs.** Record SHAs from §1, the chosen immutable image
   reference, the production Neon branch ID/endpoint confirmed in §4,
   the Let's Encrypt recipient email, and the maintenance window.
2. **Merge PR #1.** `main` moves forward.
3. **Merge PR #2** (retargeted on updated `main`, re-reviewed).
4. **Merge PR #3** (retargeted on updated `main`, re-reviewed, 40/40
   tests re-run after retarget).
5. **DNS A verification.** `dig @8.8.8.8 +short messe.klare-ki.de A`
   and `dig @1.1.1.1 +short messe.klare-ki.de A` both return
   `77.42.19.144`. No AAAA. Any disagreement → STOP.
6. **nginx bootstrap vhost.** F3B §10 step 3.
7. **TLS issuance.** F3B §10 step 4.
8. **HTTPS holding.** F3B §10 step 5. Confirm
   `https://messe.klare-ki.de/` returns 503.
9. **Production Neon migration.**
   `sql/production/dashboard_role_production.sql` under the §4 guard.
   Post-install assertions in the same script are the owner's PASS
   signal.
10. **Baseline capture.** F3B §6 "Baseline capture" block (defines
    `TF_ROLLOUT_TS`, saves pre-cutover config under
    `/opt/wbs-trade-fair/secrets/backups/${TF_ROLLOUT_TS}/`).
11. **Candidate env.** F3B §10 step 8 (new
    `/opt/wbs-trade-fair/secrets/gateway.dashboard.env`, mode 0600;
    `gateway.env` untouched).
12. **Immutable image.** Build with `Dockerfile.dashboard-staging` from
    the merged SHA; record digest; assign `TF_GATEWAY_IMAGE`.
13. **Gateway swap.** F3B §6 "Reversible swap" preflight asserts
    (`len .Mounts = 0`, env files, holding 503), then
    stop/rename/rename/start.
14. **Loopback acceptance.** F3B §7.1. Every row must pass; healthz
    JSON body must equal
    `{"success":true,"service":"trade-fair-gateway"}`.
15. **Final proxy vhost.** F3B §10 step 11.
16. **External HTTPS acceptance.** F3B §7.2. Every row must pass.
17. **Staged HSTS.** F3B §7.3 (short → long).
18. **Optional IPv6.** F3B §8. External probes before AAAA.
19. **Documentation PR.** F3B §13 transplant onto `main`.

## 9. STOP conditions

Owner must stop and page back to this preflight if any of these hold:

- `dig @sid.ns.cloudflare.com messe.klare-ki.de A` disagrees with
  `77.42.19.144`, or AAAA/CNAME becomes non-empty unexpectedly.
- Any new `/etc/nginx/sites-enabled/` entry claims `messe.klare-ki.de`
  on `server_name`.
- `nginx -t` ever returns non-zero.
- `sql/production/dashboard_role_production.sql` fails any pre-install
  sanity check or any post-install assertion.
- Production Neon current_user is not `neondb_owner`, schema owner is
  not `neondb_owner`, or `neon.timeline_id` matches the staging value
  `a171e976ae189ef43d7ca803d826354e`.
- `docker inspect wbs-trade-fair-gateway.candidate --format
  '{{len .Mounts}}'` returns anything but `0`.
- Gateway `GET http://127.0.0.1:3000/healthz` body differs from
  `{"success":true,"service":"trade-fair-gateway"}` or returns non-200.
- Any F3B §7.1 or §7.2 row returns 2xx on an outage path, admits an
  anonymous or form-key session to a Dashboard route, or omits any
  Gateway security header listed in F3B §7.
- `n8n list:workflow --onlyActive` shows any of WF-A..D ID
  (`d5uO1lnwjOirJ5Xf`, `dr05aJRh8Lu6VpSA`, `bRkCsVxZXU85yqLI`,
  `THulrTbNEZ2FrgJ3`) toggling `active`.
- Any §8 IPv6 probe fails before AAAA is published.

## 10. Outstanding blockers

| Blocker | Owner-side action |
| --- | --- |
| Production Neon branch identity not confirmed in this preflight | Confirm branch via Neon Console + the §4 verification SQL. Required before step 9. |
| No current TLS certificate for `messe.klare-ki.de` | certbot issuance is step 7. |
| Current Gateway has no immutable image; relies on host mounts | Build immutable image in step 12 before swap. |
| Residual stale staging secret files on the VPS (two files, housekeeping) | Delete or rotate during the pre-cutover window. |
| Documentation PR path | Execute §13 of F3B R3 after PR #1 → #2 → #3 lands. |

The production Neon identity, TLS certificate and immutable image
remain execution gates. The SQL transaction defect in the original
PR #8 migration is corrected in the separate Codex fix branch and
must be reviewed and integrated before any production DDL.

## 11. Status

- **F3B PREPARATION:** ACCEPTED (PR #7).
- **WBS-TF-07 PREFLIGHT:** CHANGES REQUIRED on PR #8. The separate
  atomic migration fix passed isolated PostgreSQL tests; it is not
  production-accepted until reviewed and integrated.
- **PRODUCTION EXECUTION — NOT YET AUTHORIZED.** Independent review of
  the fix, Owner approval for §7 and successful live acceptance per §8
  are required before Gate F3B and PRODUCTION READY can pass.
