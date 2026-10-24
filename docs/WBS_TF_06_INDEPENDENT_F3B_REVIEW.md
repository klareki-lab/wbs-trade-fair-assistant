# WBS-TF-06 — Independent Gate F3B review

Reviewed 2026-10-24: Draft PR #5 at
`577f1b06ef6997b077c09cac6a4dd1af14168a10`, based on PR #4 at
`db2e72ccc6ccfd22a156f432c18da538a5380704`. Scope: read-only VPS,
DNS and code checks plus local tests. Codex made no DNS, nginx, Neon,
Gateway, workflow, merge or deployment change.

## Verdict

**CHANGES REQUIRED** for PR #5. **Production GO/NO-GO: NO-GO.** The vhost
shape and existing-service isolation are sound, but the runbook contains
cutover, rollback and verification defects that could create a visible outage
or expose secrets if followed literally. Gate F3B remains **PREPARED**, not
PASS, until a corrected packet is approved and executed.

## Independently verified facts and passing design elements

- PR #5 HEAD matches the expected SHA and contains only the two nginx files,
  env example and preparation document. `git diff --check` is clean. PR #5
  has no reported CI checks. The repository chain is `main` → PR #1 baseline
  → PR #2 Dashboard → PR #3 staging/security → PR #4 review → PR #5 packet;
  `git merge-base --is-ancestor` confirms each link. Runtime Gateway, SQL,
  web and WF-A–D files are unchanged by PR #5. Local `npm test --prefix
  gateway` passed **40/40** on Node 24.15.0.
- `sudo nginx -T` on the VPS showed no `messe.klare-ki.de` server name or
  proxy to port 3000. Existing vhosts are separate; the new hostname does
  not collide with them. The live Gateway is in host network mode with
  read-only `/app/gateway` and `/app/web` mounts, listening on
  `127.0.0.1:3000`. The current `APP_ORIGIN` is HTTP loopback.
- The final nginx `location /` has `proxy_pass http://127.0.0.1:3000` with
  no URI suffix or rewrite. It therefore preserves paths, query strings and
  methods for form assets, Dashboard assets and `/api/*`. It does not route
  to n8n. The Gateway itself enforces the Dashboard-scoped session, strict
  login Origin, HTTP method rules, CSP and `Secure` cookie when
  `APP_ORIGIN=https://messe.klare-ki.de`. The vhost does not duplicate CSP
  or Set-Cookie headers; its `add_header ... always` adds HSTS even on errors.
- `messe.klare-ki.de` currently has no A, AAAA or CNAME. The VPS has the
  proposed global IPv6 address, and UFW allows 80/443 over both families.
  An external IPv6 TCP probe reached port 80. Port 443 over IPv6 currently
  refused because nginx has no IPv6 TLS listener; post-install external
  IPv6 443 and HTTPS behavior remain unproved.
- The sample n8n capture and status URLs were compared as exact strings
  to the current production env without printing their values; both match.
  The sample contains placeholders for secrets, not actual credentials.
- Nginx 1.24 and Certbot 2.9 with the nginx plugin are present. Codex ran
  `nginx -t` independently on **both** proposed vhosts in a local official
  `nginx:1.24-alpine` container, with a one-day self-signed stand-in cert;
  both passed. No certificate was issued for the hostname. A production
  `nginx -t` after each file change remains mandatory.

## Required corrections to PR #5

### 1. Keep the new hostname closed until the Gateway is ready — high

`docs/WBS_TF_06_F3B_PREP.md` §10 enables the final proxy vhost in step 5,
before production SQL migration (step 7) and Gateway cutover (step 8). It
would send public HTTPS requests to the **old** Gateway: Dashboard paths
return 404, and form login from the HTTPS origin fails the old
`APP_ORIGIN=http://127.0.0.1:3000` check. Replace the sequence with:

1. Owner approves hostname and production actions; publish **A only**,
   install the HTTP bootstrap holding vhost, validate HTTP-01 and issue TLS.
2. Keep the hostname on a holding 503 response while completing PR/code
   freeze, production migration, secret preparation and image build.
3. Save the old container/config, perform the Gateway swap, and verify GET
   `/healthz`, form login and Dashboard authentication on loopback using the
   future HTTPS `Origin` header.
4. Only then install/reload the final proxy vhost and run the full HTTPS
   acceptance matrix. Add AAAA after external IPv6 443/TLS checks pass.

If the owner intentionally accepts early exposure of a nonfunctional form,
that decision must be explicit; the current packet describes it as safe.

### 2. Make rollback executable and coupled to Origin — high

§6 renames the candidate container to `wbs-trade-fair-gateway`. §9 then
tries to stop `wbs-trade-fair-gateway-candidate`, which no longer exists,
and rename the saved container onto an occupied name. Use the **actual**
post-cutover names: stop `wbs-trade-fair-gateway`, rename it to a unique
failed name, rename `.saved` back, and start it. Validate the saved image,
network, mounts, restart policy and original env before the swap.

The old Gateway expects HTTP loopback Origin. Restoring it while the final
HTTPS proxy remains active still breaks form login, so rollback layers are
not independent. Put the `messe` vhost back into a holding 503 state (or
remove it) before restoring the old Gateway; then verify the old form on
loopback. Do not claim HTTPS form service has been restored by the old
container. Keep Neon cleanup a separate reviewed operation.

### 3. Remove the unsafe mount alternative — high

§6 says production can keep the old `/app/gateway` and `/app/web` bind
mounts while using the new image. The `/app/gateway` mount would hide the
image's code and `node_modules` containing `pg`. Require an immutable image
built from the reviewed SHA **without either old source mount**. Use a
separate, reviewed production service definition that preserves the needed
host networking, loopback bind and restart behavior. Record image digest and
rollback image/container identity. Do not reuse `compose.dashboard-staging.yaml`
as production configuration: it overrides origin/upstreams and port.

### 4. Correct health checks and executable probe commands — medium

§5 uses `curl -I https://messe.klare-ki.de/healthz` expecting 200, but
`-I` sends HEAD; the live Gateway independently returned GET 200 and HEAD
404. §7 expects body `ok`, while GET returns JSON
`{"success":true,"service":"trade-fair-gateway"}`. Use a real GET, check
that JSON and status 200. Replace `dig +short name A AAAA CNAME` and
`dig +short name NS CAA` in §12 with one query per record type; the shown
multi-type commands do not prove all records. Use distinct IPv4/IPv6
HTTPS probes after final vhost activation.

### 5. Remove secret-dumping audit instructions — high

§12 proposes `docker inspect ... --format '{{.Config.Env}}'`. This prints
the production form key, session secret, n8n header key and Dashboard URL.
Delete this command. A read-only audit should print only allowlisted
nonsecret configuration fields (network mode, mount destinations, image ID,
restart policy, relevant Boolean flags); check specific env keys through
an on-server redacted comparator. §10's full `docker inspect > ...` backup
may be operationally needed, but explicitly store it under `umask 077` in
an owner-only directory, never in Git or PR output, and remove it after the
retention window. Apply the same handling to the copied production env.

### 6. Stage HSTS and clarify its scope — medium

The final vhost immediately emits `max-age=31536000; includeSubDomains`
on **every** response, including a pre-acceptance 503. A browser can cache
that policy for a year even if the rollout is rolled back. Start with no
HSTS during cutover or a short, host-only max-age after HTTPS acceptance;
increase it separately after stable operation. Remove `includeSubDomains`
unless the owner intentionally commits every future `*.messe.klare-ki.de`
name to HTTPS. Per [RFC 6797](https://www.rfc-editor.org/rfc/rfc6797), a
header from `messe.klare-ki.de` applies to that hostname and descendants,
**not** to sibling hosts such as `mcp.klare-ki.de`; the current §5 rationale
about other `klare-ki.de` hosts is therefore misplaced. No preload step is
proposed or needed.

### 7. Treat IPv6 as a separately verified release step — medium

The proposed AAAA is a real address and IPv6 port 80 is reachable from
Codex's external client, but IPv6 port 443 currently refuses connections.
This is expected before the new vhost, yet it means end-to-end IPv6 HTTPS
has not passed. Publish A first for HTTP-01. After the cert and final nginx
IPv6 listener exist, verify from outside the VPS with `curl -6 --resolve`
or equivalent: TCP 443, certificate/SNI, redirect, GET `/healthz` and
Dashboard 401. Publish AAAA only after those checks. If IPv6 cannot pass,
leave AAAA absent; IPv4-only service is a valid initial rollout.

### 8. Resolve the PR #4/#5 documentation stack — medium

The runtime integration order remains PR #1 → PR #2 → PR #3, with retarget
and review after each merge. PR #4 is a separate independent report; PR #5
is **based on PR #4**, so §10 cannot both close PR #4 unmerged and merge PR
#5 as-is. State one of two explicit paths after PR #3 lands: merge PR #4
then a corrected PR #5 as documentation, or transplant only the corrected
PR #5 commit onto a new branch from updated `main` and close both draft
review PRs. Neither is a runtime prerequisite for migration, but the
approved final runbook must be preserved and traceable in the project.

## Production decision and owner permissions

**NO-GO now.** Gate F3B becomes PASS only after this packet is corrected,
the owner approves and executes it, and IPv4 HTTPS plus any published IPv6
record pass acceptance without breaking the form or other vhosts. The
owner's separate permissions are required for: Cloudflare A (and later
optional AAAA), nginx bootstrap/final configuration and reload, Certbot
issuance, PR merge/documentation disposition, production Neon role/function
migration, private secret provisioning, immutable Gateway image/container
swap, live HTTP acceptance and any rollback. No such action is authorized
or performed by this review.
