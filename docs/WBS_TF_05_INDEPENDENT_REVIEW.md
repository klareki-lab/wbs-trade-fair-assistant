# WBS-TF-05 — Independent review and production readiness

Review date: 2026-10-24. Reviewed PR #3 HEAD:
`e143d8ff1ab9938fd43866803bcd9ce9bd5c3e57`. Scope: read-only audit,
local tests and this review document. No Neon write, container restart, nginx
edit, workflow execution or merge was performed by Codex.

## Verdict

| Gate | Verdict | Basis |
| --- | --- | --- |
| CODE READY | **PASS** | Runtime and migration files unchanged since `9411667`; 40/40 tests independently passed on Node 24.15.0. |
| DB READY evidence | **ACCEPTED** | Eight committed staging evidence files show role/function install, least-privilege probes and rollback. A fresh read-only Neon query independently confirmed the role and function absent and all five tables empty after rollback. Historical install ownership was not independently queried before rollback. |
| STAGING READY evidence | **ACCEPTED** | Committed HTTP matrix shows real-branch positive data 200, scoped access, input/method rejection and teardown. The HTTP run itself is Black's evidence; Codex did not recreate the rolled-back environment. |
| Gate F3B | **CHANGES REQUIRED** | Active nginx configuration has no WBS vhost or proxy to `127.0.0.1:3000`; production Gateway `APP_ORIGIN` is `http://127.0.0.1:3000`. HTTPS origin and forwarding are not ready. |
| PRODUCTION READY | **NO-GO** | Gate F3B, production migration/deploy approval and production acceptance remain. |

## Independent checks versus documented evidence

**Independently reproduced:** `git fetch origin --prune` and `gh pr view 3`
show the expected HEAD and Draft status, with no reported CI checks. `git
merge-base --is-ancestor` and PR metadata confirm the exact stack:
`main` `07a3969` → PR #1 `854f247` → PR #2 `413d8ad` → PR #3 `e143d8f`.
The two post-`9411667` commits add documentation/evidence only. The WF-A–D
JSON exports are unchanged from the live baseline. `npm test --prefix gateway`
passed 40/40 locally. Local static review confirmed scoped session checks on
all Dashboard routes, separate form/admin access keys, fixed parameterized SQL,
`BEGIN READ ONLY`, statement timeout and 503 failure mapping. The PostgreSQL
function is `STABLE SECURITY DEFINER` with pinned `search_path`, bounded
pagination, explicit PUBLIC EXECUTE revoke and one dedicated-role EXECUTE
grant. The dedicated-role migration grants no base-table access.

**Black's committed staging evidence, inspected file by file:**

| File | Recorded result |
| --- | --- |
| `role_install.txt` | Transaction committed CREATE ROLE and database CONNECT grant. |
| `function_install.txt` | Transaction committed CREATE FUNCTION, REVOKE and two GRANT statements. |
| `role_audit.txt` | Read-only audit DO completed, then ROLLBACK. |
| `role_probe.txt` | Dashboard role obtained empty function JSON; all five direct table SELECTs denied; 14 other function EXECUTE checks false; dashboard function true. |
| `seed.txt` | One synthetic lead inserted. |
| `e2e_positive.txt` | Anonymous and form-key Dashboard access denied; admin assets and API returned 200; WARM/45/delivered row matched the seed; invalid filter 400 and POST 405. |
| `rows_rollback.txt` | One delete per table; all five counts zero; transaction committed. |
| `role_rollback.txt` | Function and role DROP transaction committed. |

The earlier committed `sql/e2e_staging_result.txt` records the expected 503
when the function was not yet installed. The staging catalog and preflight
files are byte-identical to the committed production metadata captures
(`cmp` exit 0 for both). No credential values were printed or copied.

**Fresh independent rollback probe:** A read-only transaction through the
branch-owner connection returned `current_database=neondb`,
`current_user=neondb_owner`, the same Neon timeline marker recorded in the
handover, `role_exists=false`, `fn_exists=false` and `0|0|0|0|0` rows across
`companies`, `contacts`, `lead_submissions`, `processing_results` and
`email_outbox`. This confirms the present cleanup state, not the past install
function owner or HTTP behavior.

## Neon branch identity

The VPS staging env exposes `NEON_STAGING_BRANCH_ID=br-rapid-sun-bandpl0m`.
The branch-owner connection reaches `neondb` as `neondb_owner` and has the
same Neon timeline marker documented by Black. Codex independently opened
the authenticated Neon Console Branch overview at
`https://console.neon.tech/app/projects/steep-lab-70197219/branches/br-rapid-sun-bandpl0m`.
The page displays the project name `wbs-trade-fair-assistant`, branch name
`wbs-tf-dashboard-staging` and branch ID `br-rapid-sun-bandpl0m` together.
This establishes the requested name/ID/project relationship without reading
or printing a connection string.

## Gate F3B: current routing and security boundary

`sudo nginx -T` on the production VPS showed no WBS server block and no
reference to `3000`, `13080`, `dashboard` or `trade-fair`. The existing
Gateway is a `node:22-alpine` container in **host** network mode, with
read-only source mounts and restart policy `unless-stopped`. It listens only
on `127.0.0.1:3000`; read-only local HTTP checks returned `/healthz=200`,
`/=200`, `/dashboard=404` (Dashboard disabled). Its current
`APP_ORIGIN=http://127.0.0.1:3000`, so cookies are not marked Secure.
The repository's earlier deployment/architecture text describing a bridge
network and an nginx proxy does not match this observed state.

**Required F3B design and acceptance:** The owner must select an HTTPS origin
for the existing form and Dashboard. Configure a dedicated nginx TLS vhost
whose `/`, form assets and existing `/api/*` routes, plus `/dashboard`,
`/dashboard.js`, `/dashboard.css` and `/api/dashboard`, reach the same Gateway
without rewriting their paths or forwarding any route to n8n. Review exact,
prefix and regex location precedence and method behavior. Set `APP_ORIGIN` to
that exact HTTPS origin before Gateway startup; verify `Origin` enforcement,
`Secure; HttpOnly; SameSite=Strict` cookies, Dashboard 401 for anonymous and
form sessions, admin 200, CSP `self` for assets/API, and existing capture/status
behavior. Keep the Gateway loopback-only and do not expose port 3000. Test
`nginx -t`, HTTP→HTTPS redirect and TLS certificate before enabling traffic.
No current nginx route can be declared PASS for these paths.

## Reversible production deployment plan — for separate owner approval

1. **Freeze inputs.** Record the exact PR SHAs above, code image digest,
   production Neon project/branch/database/endpoint, target HTTPS origin and
   deployment window. Obtain owner approval separately for production Neon
   migration, Gateway recreate and F3B nginx change. Merge only in order
   PR #1 into `main`, retarget/review PR #2 on updated `main`, merge PR #2,
   then retarget/review PR #3 on updated `main` and merge it. Revalidate SHAs,
   tests and migration diff after each merge; no merge is part of this review.
2. **Capture recoverable baseline.** Save the running Gateway's image ID,
   complete `docker inspect` configuration, source release/version, health
   response, current nginx config and private env backup in an owner-only
   location. Do not put environment values in logs or Git. Record WF-A–D
   activation and normal capture/status smoke baselines without sending real
   customer data during the change window.
3. **Prepare production SQL.** Compare all five production table contracts
   and existing function ACLs to the reviewed metadata. Use a separately
   reviewed production migration, executed as the approved owner on the
   verified production endpoint: create a new, unique
   `trade_fair_dashboard` login with a generated password; grant CONNECT on
   `neondb`; install the reviewed `dashboard_snapshot` function; revoke
   PUBLIC EXECUTE and grant only schema USAGE and function EXECUTE to the new
   role. Do not run the staging-only guarded role/rollback scripts against
   production. Verify catalog owner is the intended privileged role,
   `prosecdef=true`, `provolatile=stable`, pinned `search_path`, ACL and no
   unexpected role memberships or direct table privileges. Connect as the
   dedicated role for positive function and negative table/other-function
   probes. Confirm WF-A–D role ACLs are unchanged before continuing.
4. **Prepare secrets and image.** Store the dedicated-role Neon URL,
   `DASHBOARD_ACCESS_KEY` distinct from the form key, session secret and
   `APP_ORIGIN=https://<approved-host>` in a root-owned private env file.
   Never put them in the image, Git, shell history or review artifacts.
   Build `Dockerfile.dashboard-staging` from the reviewed SHA with Node 22 and
   `npm ci`; record a content-addressed image digest/immutable tag, scan the
   image context and run 40 tests. Use a production service definition that
   copies code and `pg` into the image. **Do not retain the old mounts at
   `/app/gateway` or `/app/web`: they would hide the built code and
   `node_modules`.** Preserve host networking, loopback `HOST`, port, and
   restart behavior only after reviewing the saved inspect output.
5. **Stage cutover with a reversible container swap.** Create the new
   container under a temporary name from the immutable image and private env,
   without starting it. In the approved window, stop and rename the old
   container, rename and start the candidate on `127.0.0.1:3000`; retain the
   old container and image. Validate local health and form before applying the
   separately approved nginx vhost. Run `nginx -t` then reload nginx only
   under that approval. Do not alter n8n or WF-A–D.
6. **Acceptance and stop conditions.** Check HTTPS `/healthz`, `/`, form
   assets, login/logout, synthetic capture/status smoke, and all four
   Dashboard paths. Anonymous/form key → 401 on Dashboard; admin → assets
   200 and API 200 with verified real data; invalid filter → 400; POST API
   → 405; DB outage → retryable 503 without Gateway crash, recovery → 200.
   Verify `Secure` session cookie, CSP, no credential or PII leakage, and
   nginx path precedence. Stop for any baseline regression, unexpected write,
   privilege expansion, schema mismatch, missing route/TLS, false 200 during
   outage, failure to recover, or any unapproved production change.
7. **Rollback.** If Gateway checks fail, stop/rename the candidate, restore
   and start the saved old container with its original image, mounts, network,
   env and restart policy; revert the separately changed nginx config to its
   saved version and validate `nginx -t` before reload. Recheck health,
   form login/capture/status and original routing. The new SQL function and
   role can remain inert while the Gateway is rolled back; revoke/drop them
   only under a separate reviewed database cleanup after confirming no caller.
   Record old/new image digests, timestamps and redacted acceptance results.

## Remaining risks and approvals

- The installed function owner and effective ACL were documented at install
  time, but no post-install catalog snapshot was committed before rollback.
  Production must include that catalog check.
- No CI checks are reported on PR #3; the 40 tests were reproduced locally
  on Node 24, while Node 22 results remain Black's evidence.
- F3B requires a new HTTPS origin and nginx route; current live form is
  loopback-only. This is a material production integration change.
- Owner approvals needed: production Neon migration and dedicated role,
  secret provisioning, Gateway image/container swap, F3B nginx change and
  staged merge order. None is granted by this review.
