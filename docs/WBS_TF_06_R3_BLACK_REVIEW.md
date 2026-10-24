# WBS-TF-06 R3 — Black CC independent final review

Date: 2026-10-24. Reviewed Draft PR #5 HEAD
`185c208152a3af2585bb38f0ae86fb7a3b687130` (R3). Verifies that Codex's
R3 commit resolves every defect called out in the R2 final verdict on
PR #6 at `f8637f377199363d78a0c69c9cdd5e6c37cfe870`. Scope: read-only
inspection, offline tests on the reviewer machine, and this report. No
production DNS, nginx, Neon, Gateway, workflow, certificate or merge
operation was performed by this review.

Note on PR #6: the task referenced head
`2081b5460b669c96161e3fdadc28b355ef16bfa2`. That object is no longer
reachable from any current ref on origin; PR #6 has advanced to
`f8637f3` via two force-pushed commits (`0761cd9` and `f8637f3`). The
object `2081b54` still exists in the Git object database but is a
dangling commit. This review uses the current PR #6 branch tip, which
contains the stricter R2-final verdict Codex published after the R1
review the task cites.

## Verdict

| Area | Verdict |
| --- | --- |
| Backup and rollback | **PASS** |
| nginx test reproduction | **PASS** |
| Gateway regression tests | **PASS** |
| Bash/runbook commands | **PASS** |
| PR ancestry | **PASS** |
| Secrets/security | **PASS** |
| **F3B PREPARATION** | **ACCEPTED** |
| **Production execution** | **CONDITIONAL GO** — only against the exact §10 sequence under separately listed Owner approvals; nothing in this review authorizes production action. |

## A. Backup and rollback — PASS

| Required check | Result | Evidence |
| --- | --- | --- |
| A.1 Original `gateway.env` backed up before any candidate change | PASS | `docs/WBS_TF_06_F3B_PREP.md` §6 "Baseline capture" copies `/opt/wbs-trade-fair/secrets/gateway.env` into `$TF_BACKUP_DIR/env.pre` **before** §10 step 8 creates `gateway.dashboard.env`. §10 order is explicit: step 7 "Baseline before candidate" precedes step 8 "Candidate env". The §6 swap preflight re-asserts `cmp -s env.pre gateway.env` so a late write to `gateway.env` would STOP the swap. |
| A.2 Candidate configuration stored separately | PASS | Candidate lives at `/opt/wbs-trade-fair/secrets/gateway.dashboard.env`; `gateway.env` is untouched. The `docker create` command binds `--env-file /opt/wbs-trade-fair/secrets/gateway.dashboard.env`. §6 swap preflight asserts `! cmp -s gateway.dashboard.env gateway.env`, so the swap refuses to run until the owner has actually edited the candidate. |
| A.3 Backup permissions prevent secret disclosure | PASS | `umask 077`, `install -d -m 0700 "$TF_BACKUP_DIR"`, and `test "$(stat -c %a env.pre)" = 600` are all in the §6 block. The directory lives under `/opt/wbs-trade-fair/secrets/backups/` on the VPS. No commit, chat log or PR body contains the file contents. |
| A.4 One timestamp variable, consistently used | PASS | `TF_ROLLOUT_TS=$(date -u +%Y%m%dT%H%M%SZ)` is set once in §6 and persisted to `/opt/wbs-trade-fair/secrets/active-rollout-ts`. §9 reloads it in a fresh shell with `TF_ROLLOUT_TS=$(cat .../active-rollout-ts)`. All container and backup paths use `${TF_ROLLOUT_TS}` with no literal `<ts>` in any executable block. |
| A.5 Cutover and rollback commands executable | PASS | 11 ```bash``` blocks + 7 plain shell blocks = 18/18 pass `bash -n` locally with `set -euo pipefail` prepended (full output: §C.3). Preflight asserts precede every destructive step; `! cmp -s` and `! docker container inspect` are correct under `set -e`. |
| A.6 Rollback restores nginx holding before old Gateway | PASS | §9 Layer C's shell block ends with `test $(curl ...) = 503` **before** §9 Layer B is invoked. The explicit prose line "Order matters: nginx first, then Gateway" is between Layer C and the pointer to Layer B. The partial-swap recovery branch in Layer B also keeps HTTPS on holding (its preflight asserts `503`) before any `docker start`. |
| A.7 No old source mounts in the new immutable image | PASS | §6 preflight contains `test "$(docker inspect -f '{{len .Mounts}}' wbs-trade-fair-gateway.candidate)" = 0`. Prose in §6 "Image" explicitly forbids retaining the two `/app/gateway` and `/app/web` host mounts. `compose.dashboard-staging.yaml` is ruled out as a production definition. |

Minor non-blocking suggestions (not required for ACCEPTED):

- §9 Layer B's final `curl` writes `/tmp/h.json` but does not assert the
  JSON body in the same block as §7.1 does. Appending `test "$(cat
  /tmp/h.json)" = '{"success":true,"service":"trade-fair-gateway"}'`
  would make the rollback self-verifying.
- §10 step 11 (final vhost install) does not pre-copy the HTTPS holding
  file to a `.bak-${TF_ROLLOUT_TS}-pre-final` sibling. The design is
  still safe because `nginx -t` gates the reload, but a backup would
  make Layer C's `cp` unnecessary and the symmetry cleaner.

## B. nginx test reproduction — PASS

```
$ bash -n ops/nginx/check_vhosts.sh
PASS

$ ./ops/nginx/check_vhosts.sh
nginx: syntax is ok / test is successful
PASS messe.klare-ki.de.bootstrap.conf
nginx: syntax is ok / test is successful
PASS messe.klare-ki.de.https-holding.conf
nginx: syntax is ok / test is successful
PASS messe.klare-ki.de.conf

$ ls /tmp/wbs-f3b-nginx.* 2>/dev/null
(no matches — EXIT trap cleaned the temp dir and self-signed cert)
```

| Required check | Result | Note |
| --- | --- | --- |
| B.1 Execute `check_vhosts.sh` | PASS | Ran on reviewer machine with Docker + nginx 1.24. |
| B.2 All three vhosts pass independently | PASS | Each file is bound into a fresh `nginx:1.24` container alone (`conf.d/messe.conf`), with the self-signed cert mounted at the production path. Script fails on any nonzero `nginx -t`. |
| B.3 Temporary certificates removed | PASS | `trap cleanup EXIT` deletes `fullchain.pem`, `privkey.pem`, the `cert` subdir and the temp root. Independent `ls /tmp/wbs-f3b-nginx.*` after the run returns no matches. |
| B.4 No production nginx files touched | PASS | Script uses read-only Docker bind mounts; no `ssh klare-ki`; no path under `/etc/nginx` on either host or VPS. |
| B.5 Path preservation and correct upstream | PASS | Final vhost uses `proxy_pass http://127.0.0.1:3000;` with no trailing slash and no `rewrite`. `Host`, `X-Forwarded-Proto`, `X-Forwarded-Host`, `X-Forwarded-For`, `X-Real-IP` set. No `proxy_set_header Origin`. No duplicate CSP, HSTS, or `Set-Cookie`. Holding vhosts return 503 only; no proxy. Bootstrap vhost is HTTP-only. |

## C. Regression tests — PASS

### C.1 Node.js Gateway suite

```
$ node --version
v24.15.0
$ node --test tests/*.mjs
ℹ tests 40
ℹ pass 40
ℹ fail 0
```

### C.2 Reported 40/40 confirmed

Codex evidence file (`ops/nginx/syntax_check_r3_evidence.txt`) claims
`tests 40, pass 40, fail 0`. Independent reproduction above matches
exactly. The one gap called out at the R1/R2 stage — Node 22 vs. Node
24 reproduction — persists; neither this reviewer nor Codex has
reproduced on Node 22 as part of R3. Not blocking because the
production image uses Node 22 and the staging acceptance already
exercised it; mentioned here for completeness.

### C.3 Shell block syntax audit

Independent fenced-block walker (walks `docs/WBS_TF_06_F3B_PREP.md`
line by line and extracts every triple-backtick region together with
its language tag):

```
Total fenced blocks: 18
  bash: 11
  plain (no lang, shell-looking): 7
  other: 0

bash -n totals (bash blocks):   11 pass, 0 fail
bash -n totals (plain blocks):   7 pass, 0 fail
Grand total shell blocks:       18 / 18 pass
```

The 11 explicitly `bash`-tagged blocks match Codex's evidence file
claim of "11 blocks, 11 pass". The 7 plain blocks (DNS probes, runbook
`sudo cp` steps, IPv6 `--resolve` block, Codex handover) also parse
cleanly.

### C.4 No command prints or commits secret values

Static audit over the 18 shell blocks:

- Zero `.Config.Env` references.
- Zero `cat`/`echo`/`printf`/`head`/`tail` targeting
  `gateway.env`, `gateway.dashboard.env`, `env.pre`, or any file under
  `/opt/wbs-trade-fair/secrets/` without redirecting into a protected
  file.
- Every `docker inspect` without `.Config.Env` uses a field-scoped
  `--format` string (NetworkMode, RestartPolicy, Mounts.Destination,
  State.Running, Image, len .Mounts).
- The baseline-capture `docker inspect > inspect.json` and
  `docker image inspect > image.json` write into
  `$TF_BACKUP_DIR` which was just `install -d -m 0700`'d; nothing
  reaches stdout.
- `cp -- gateway.env env.pre` is file-to-file, never stdout.

## D. GitHub ancestry — PASS

### D.1 Runtime chain

```
git merge-base --is-ancestor:
  origin/baseline/live-2026-10-24     -> origin/feature/astra-dashboard             OK
  origin/feature/astra-dashboard      -> origin/fix/wbs-tf-04-preflight-staging     OK
  origin/fix/wbs-tf-04-preflight-staging -> 185c20815... (R3)                        OK
```

PR #1 → PR #2 → PR #3 → PR #5(R3) is a clean ancestor chain.

### D.2 All three R-SHAs preserved on PR #5

```
PRESERVED: 577f1b06ef6997b077c09cac6a4dd1af14168a10   (R1)
PRESERVED: 798e3035f53bb84bf95d647ff8e8cb416f5f07f8   (R2)
PRESERVED: 185c208152a3af2585bb38f0ae86fb7a3b687130   (R3)
```

Each is reachable from `feat/wbs-tf-06-f3b-prep`. §13's integration
strategy (cherry-pick R1 → R2 → R3 onto a branch cut from updated
`main`, or apply the full PR #5 diff against its PR #4 base as one
patch) correctly transplants the complete file set rather than only R2.

### D.3 PR #4 and PR #6 remain as independent review evidence

```
PR#1 OPEN  Draft  baseline: live Trade Fair Assistant inventory
PR#2 OPEN  Draft  feat(dashboard): integrate Astra WBS-TF-02 candidate
PR#3 OPEN  Draft  WBS-TF-04: Neon preflight and isolated staging hardening
PR#4 OPEN  Draft  WBS-TF-05: independent production readiness review
PR#5 OPEN  Draft  WBS-TF-06: Gate F3B prep
PR#6 OPEN  Draft  WBS-TF-06 R2: final independent F3B review
```

PR #4 base `fix/wbs-tf-04-preflight-staging`, head
`db2e72ccc6ccfd22a156f432c18da538a5380704`.
PR #6 base `feat/wbs-tf-06-f3b-prep`, head
`f8637f377199363d78a0c69c9cdd5e6c37cfe870`.

PR #6 descends from R2 (`git merge-base --is-ancestor 798e303
origin/review/wbs-tf-06-f3b` → true) and does **not** contain R3; §13's
warning that merging PR #6 into `main` would pull PR #5's ancestor
while omitting R3 is factually correct.

### D.4 This review does not modify the R3 implementation branch

This document is written on `review/wbs-tf-06-r3-black`, cut from
`feat/wbs-tf-06-f3b-prep` at R3. The implementation branch is
unchanged. No merges, cherry-picks or retargets were performed.

## E. Production readiness ordering — PASS

Required sequence vs. §10:

| Required step | §10 step | Match |
| --- | --- | --- |
| DNS A | 2 | OK — AAAA deferred per §8 |
| nginx bootstrap | 3 | OK |
| TLS issuance | 4 | OK — `certbot --nginx --redirect` |
| HTTPS holding | 5 | OK — replaces bootstrap immediately |
| Production migration | 6 | OK — separately reviewed owner migration |
| Baseline capture | 7 | OK — before candidate changes |
| Candidate env | 8 | OK — separate `gateway.dashboard.env` file |
| Image build | 9 | OK — immutable, digest recorded |
| Gateway swap | 10 | OK — reversible, preflight-gated |
| Loopback acceptance | 10 (nested) + 7.1 | OK — real GET, JSON body assertion |
| Final proxy vhost | 11 | OK — only after loopback acceptance |
| External HTTPS acceptance | 12 + 7.2 | OK — IPv4 only initially |
| Staged HSTS | 13 + 7.3 | OK — nothing → 300 → 31536000, host-only |
| Optional IPv6 | 14 + 8 | OK — external probes before AAAA |

STOP conditions in §11 cover: DNS disagreement, pre-existing vhost
collision, non-zero `nginx -t`, Gateway loopback failure or wrong JSON,
2xx on an outage path, missing security headers, n8n activation drift
during the window, any IPv6 probe failure before AAAA. §9 Rollback
layers A/B/C cover each stage of the rollout, and all restore the
HTTPS holding vhost before touching the Gateway so HTTPS never fronts
the old HTTP-origin container.

Existing production services:

- n8n (`n5n.klare-ki.de`, loopback 5678): unchanged — `messe.` vhost
  forwards nothing to 5678.
- MCP, MinIO/console, bistro, delivery, herman, review: unchanged.
- Live form on the current Gateway: unchanged until the owner swaps the
  container.

## F. Codex R2-final residual items vs. R3

| Codex R2 verdict item | R3 result |
| --- | --- |
| 1. Cutover and HTTPS holding | PASS (unchanged, confirmed). |
| 2. Coupled rollback and names (R2: FAIL) | **FIXED.** One `TF_ROLLOUT_TS`, persisted and reloaded; `.saved-${TF_ROLLOUT_TS}` and `.failed-${TF_ROLLOUT_TS}` used consistently; `bash -n` passes on all 11 bash blocks (and 7 plain blocks). Env backup now runs before candidate creation. |
| 3. Immutable image, no old mounts | PASS (unchanged, confirmed). |
| 4. GET health and JSON | PASS; §7.1 now additionally asserts the JSON body with `test "$(cat /tmp/h.json)" = ...`. |
| 5. No secret-dumping diagnostics | PASS; §12 replaced with `./ops/nginx/check_vhosts.sh`, which this reviewer independently executed. |
| 6. Staged, host-only HSTS | PASS; §7.3 prose corrected to "applies to the exact `messe.klare-ki.de` host only — not to its sub-labels or sibling hosts". |
| 7. IPv6 before AAAA | PASS; §8 unchanged, DNS state still A-only. |
| 8. PR ancestry and docs (R2: FAIL) | **FIXED.** §13 transplants R1, R2 **and** R3 onto a branch from updated `main`, and the warning against merging PR #6 is explicit. |

## G. Remaining Owner approvals

Nothing below is authorized by this review.

- **DNS.** A already present (owner-created); AAAA pending §8 external
  verification.
- **nginx.** Install bootstrap vhost; run `certbot --nginx --redirect`
  as approved owner; swap to HTTPS holding; swap to final proxy; later
  enable `max-age=300` HSTS, then `max-age=31536000` HSTS.
- **Secrets.** Create `/opt/wbs-trade-fair/secrets/gateway.dashboard.env`
  (0600, root); run the §6 baseline-capture block to populate
  `/opt/wbs-trade-fair/secrets/backups/${TF_ROLLOUT_TS}/`; retain and
  later delete under the owner retention window.
- **Image.** Build the production image from the reviewed SHA using
  `Dockerfile.dashboard-staging`; record `RepoDigests`.
- **Production Neon migration.** Owner-reviewed role + function install;
  not the staging-only `sql/dashboard_role_staging.sql`.
- **Gateway cutover.** Execute §6 reversible swap under the preflight
  assertions.
- **Acceptance.** Run §7.1 on loopback, §7.2 externally, and §7.3
  staged HSTS transitions.
- **IPv6.** Only after all four §8 external probes pass.
- **PR integration path.** §13 (transplant R1+R2+R3 onto a new branch
  from updated `main`); keep PR #4 and PR #6 as draft review records or
  close with cross-links after the documentation PR lands.

## H. Scope statement

This review did not deploy production, did not merge any PR, did not
touch the VPS beyond a read-only DNS probe (and does not change that
either), did not issue a certificate, did not touch Neon, did not
restart or change the Gateway, did not change DNS. All execution
remains gated on the Owner approvals in §G above.

**F3B PREPARATION: ACCEPTED.** **PRODUCTION READY: NOT GRANTED** — the
PASS verdict applies to the packet only; real deployment and live
acceptance are a separate gate.
