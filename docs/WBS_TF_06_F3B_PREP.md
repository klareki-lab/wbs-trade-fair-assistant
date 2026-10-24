# WBS-TF-06 — HTTPS Gateway and Gate F3B preparation (R2)

Scope: design + preparation only. No production change. Supersedes R1
after the independent Codex review in
`docs/WBS_TF_06_INDEPENDENT_F3B_REVIEW.md` (PR #6). Companion to the
Codex review in `docs/WBS_TF_05_INDEPENDENT_REVIEW.md` (PR #4). The
output of this document plus the three nginx vhost files under
`ops/nginx/` and the sample env under `ops/env/` is the production
rollout packet handed to the owner for approval.

## 1. Recommended HTTPS origin

- **Hostname:** `messe.klare-ki.de`.
- **Scheme/port:** `https://` on default port 443. Gateway reaches
  `APP_ORIGIN=https://messe.klare-ki.de`, so the strict same-origin check
  and `Secure` session cookie attribute activate automatically
  (`gateway/server.mjs:40-57,186,268`).
- **Why a dedicated subdomain:** matches the house pattern (`mcp.`,
  `delivery.`, `n5n.`, `herman.`, `review.`, `bistro.`, `minio.`,
  `console.` each already run as separate nginx vhosts with their own Let's
  Encrypt certificates). Keeps n8n and MCP routing fully isolated and lets
  a cutover or rollback touch only this vhost.

## 2. DNS readiness

- Current state (independently verified against the Cloudflare
  authoritatives `sid.ns.cloudflare.com` and `jillian.ns.cloudflare.com`,
  plus 8.8.8.8 and 1.1.1.1):
  - `A messe.klare-ki.de` → `77.42.19.144` (DNS-only, gray cloud).
  - `AAAA messe.klare-ki.de` → **absent** (deliberately withheld until
    external IPv6 HTTPS acceptance passes; see §8).
  - `CNAME messe.klare-ki.de` → absent.
  - CAA for `klare-ki.de`: none. Any CA including Let's Encrypt may issue.
- VPS public IPs (confirmed from the VPS itself): `77.42.19.144` (A),
  `2a01:4f9:c012:c1b5::1` (AAAA, not yet published).
- **Verification (one query per record type):**
  ```
  dig @sid.ns.cloudflare.com +short messe.klare-ki.de A      # 77.42.19.144
  dig @sid.ns.cloudflare.com +short messe.klare-ki.de AAAA   # empty
  dig @sid.ns.cloudflare.com +short messe.klare-ki.de CNAME  # empty
  ```

## 3. VPS inventory (read-only, 2026-10-24)

- nginx 1.24.0 (Ubuntu). Vhosts in `/etc/nginx/sites-{available,enabled}/`.
  Core config pins `ssl_protocols TLSv1.2 TLSv1.3;` and
  `ssl_prefer_server_ciphers on;`.
- Existing enabled vhosts: `bistro`, `default`, `delivery`,
  `herman.klare-ki.de`, `mcp.klare-ki.de`, `minio.klare-ki.de`
  (serves `minio` and `console`), `n5n`, `review.klare-ki.de`. None
  matches `messe` on `server_name` — no vhost conflict.
- Certbot 2.9.0 (apt), `certbot.timer` active (next run ~daily). All
  existing certificates were issued via `certbot --nginx` and live under
  `/etc/letsencrypt/live/<name>/`. Same path convention will apply to
  `messe.klare-ki.de`.
- Listening ports (abridged):
  - `0.0.0.0:80`, `0.0.0.0:443` → nginx master.
  - `127.0.0.1:3000` → Gateway (`node:22-alpine`), host network mode,
    loopback-only. **No public exposure.**
  - `127.0.0.1:5678` → n8n (via docker-proxy).
  - `127.0.0.1:8100` → MCP server (via docker-proxy).
- Gateway container (`wbs-trade-fair-gateway`): `NetworkMode=host`,
  `RestartPolicy=unless-stopped`, read-only mounts of `/app/gateway` and
  `/app/web` from the host, current `APP_ORIGIN=http://127.0.0.1:3000`,
  `PUBLIC_FORM_ENABLED=false`, `DASHBOARD_ENABLED` unset. Dashboard code
  is present in the repository but inert on production until a reviewed
  recreate.
- Codex independently confirmed external IPv6 reachability on port 80
  but refusal on port 443 (expected: nginx has no `messe` IPv6 TLS
  listener yet). This is one reason AAAA is withheld.

## 4. nginx configuration

Delivered as three files under `ops/nginx/`. Each is used in a specific
phase; **the final proxy file never goes live until the Gateway has
been swapped and loopback-accepted**.

- `messe.klare-ki.de.bootstrap.conf` — HTTP-only vhost used during Let's
  Encrypt HTTP-01 issuance. Returns 503 for every path. Enabled before
  certbot runs; it exists only so certbot has a known `server_name` match
  to edit in place.
- `messe.klare-ki.de.https-holding.conf` — HTTPS vhost that presents the
  certificate and returns 503 for every path. Replaces the bootstrap file
  immediately after certbot inserts its HTTPS block. Public requests reach
  nginx but never reach the Gateway while any of (a) the production SQL
  migration, (b) the private env file, or (c) the Gateway swap, is
  outstanding. Also serves as the Layer A rollback target (§9).
- `messe.klare-ki.de.conf` — final HTTPS proxy: port 80 → 301; port 443
  TLS → `proxy_pass http://127.0.0.1:3000;` with Host and
  X-Forwarded-\* preserved, no path rewrite. Ships **without** HSTS;
  the staged HSTS lines are commented in place and enabled only after
  external HTTPS acceptance (§7).
- All three files pass `nginx -t` on an isolated nginx 1.24 harness with
  a self-signed stand-in cert; see `ops/nginx/syntax_check_evidence.txt`.
  A production `nginx -t` run is required after each file change.
- Request paths are preserved end to end. The final file alone reaches
  these Gateway routes (`gateway/server.mjs:333-421`):
  - `GET /healthz` (JSON `{"success":true,"service":"trade-fair-gateway"}`)
  - `GET /`, `GET /app.js`, `GET /styles.css`,
    `GET /berater`, `GET /berater-adapter.js`
  - `GET /api/session`
  - `POST /api/login`, `POST /api/logout`
  - `POST /api/leads`
  - `GET /api/leads/FAIR-<uuid>?submission_id=<id>`
  - `GET /dashboard`, `GET /dashboard.js`, `GET /dashboard.css`
  - `GET /api/dashboard` (query string carries the filter)
  - `POST /api/public/leads` returns 404 while `PUBLIC_FORM_ENABLED=false`.
- No `/api/*` is forwarded to n8n. The n8n endpoints keep running on
  `n5n.klare-ki.de`; `messe.` never reaches 5678.

## 5. TLS readiness

- Standard house pattern:
  `sudo certbot --nginx -d messe.klare-ki.de --redirect --agree-tos
   -m <owner-email> --no-eff-email`.
  HTTP-01 challenge over port 80, which is already open and served by
  nginx. `certbot.timer` picks up renewal automatically.
- The one-shot sequence that makes certbot safe:
  1. Enable the bootstrap vhost (§10 step 3).
  2. Run certbot. Certbot writes an HTTPS block into the bootstrap file.
  3. **Immediately** replace that file with
     `ops/nginx/messe.klare-ki.de.https-holding.conf`, `nginx -t`,
     reload. Public HTTPS now returns 503 with no application exposure.
- Cipher/protocol posture is inherited from the main `nginx.conf`
  (`TLSv1.2 TLSv1.3`, server-ciphers preferred).
- Residual TLS acceptance (owner-side, after each nginx reload):
  - `curl -sS -w '\nhttp=%{http_code}\n' https://messe.klare-ki.de/`
    returns 503 (while on the HTTPS holding vhost).
  - `openssl s_client -connect messe.klare-ki.de:443 -servername
    messe.klare-ki.de -brief` presents the issued leaf chained to ISRG.
  - `curl -sS -o /tmp/healthz.json -w 'http=%{http_code}\n'
    http://127.0.0.1:3000/healthz` returns 200 and
    `{"success":true,"service":"trade-fair-gateway"}` once the Gateway
    is on the new image.

## 6. Gateway cutover (immutable image, no source mounts)

- **Image.** Build the production image from `Dockerfile.dashboard-staging`
  at the reviewed PR #3 SHA. The Dockerfile installs `pg` and bakes code
  into `/app/gateway` and `/app/web` inside the image. Do **not** keep
  the live container's host mounts; they would hide the baked code and
  `node_modules`. Record the content-addressed digest (`docker image
  inspect --format '{{index .RepoDigests 0}} {{.Id}}'`) and store it with
  the baseline.
- **Service definition.** `compose.dashboard-staging.yaml` must not be
  reused as production configuration — it overrides `APP_ORIGIN`, port
  and upstream URLs for the staging harness. Use a separately reviewed
  production definition (either a dedicated compose file at
  `ops/compose/production.yaml` or a reviewed `docker run` recipe) that
  preserves the fields recorded in the baseline inspect: `HOST=127.0.0.1`,
  `PORT=3000`, `NetworkMode=host`, `RestartPolicy=unless-stopped`,
  env-file at `/opt/wbs-trade-fair/secrets/gateway.env`, no bind mounts
  under `/app`.
- **Private env file.** `/opt/wbs-trade-fair/secrets/gateway.env` with
  mode 0600 and root ownership. Shape in
  `ops/env/gateway.production.env.example`. Minimum changes vs. the
  live file:
  - `APP_ORIGIN=https://messe.klare-ki.de`
  - `DASHBOARD_ENABLED=true`
  - `DASHBOARD_ACCESS_KEY=<new value, distinct from TRADE_FAIR_ACCESS_KEY>`
  - `DASHBOARD_DATABASE_URL=<production trade_fair_dashboard URL>`
  Keep the current `TRADE_FAIR_ACCESS_KEY`, `SESSION_SECRET`,
  `N8N_HEADER_KEY`, `N8N_CAPTURE_URL`, `N8N_STATUS_URL` unless the owner
  decides to rotate.
- **Baseline capture (secrets-safe).** Save, under `umask 077` into
  `/opt/wbs-trade-fair/secrets/backups/<YYYYMMDD-HHMM>/`:
  - `docker inspect wbs-trade-fair-gateway > inspect.json`
  - `docker image inspect $(docker inspect -f '{{.Image}}'
     wbs-trade-fair-gateway) > image.json`
  - `cp /opt/wbs-trade-fair/secrets/gateway.env env.pre`
  - `sudo nginx -T > nginx-pre.conf`
  All four files are 0600 root. They never land in Git, PR text, chat
  logs or the backup container's mount. Delete the directory after the
  owner-defined retention window.
- **Reversible swap.** Create the candidate container under a temporary
  name from the immutable image and private env, without starting it:
  ```
  docker create --name wbs-trade-fair-gateway.candidate \
    --network host --restart unless-stopped \
    --env-file /opt/wbs-trade-fair/secrets/gateway.env \
    <image@digest>
  ```
  In the approved window:
  ```
  docker stop  wbs-trade-fair-gateway
  docker rename wbs-trade-fair-gateway wbs-trade-fair-gateway.saved-<ts>
  docker rename wbs-trade-fair-gateway.candidate wbs-trade-fair-gateway
  docker start wbs-trade-fair-gateway
  ```
  Keep `wbs-trade-fair-gateway.saved-<ts>` and the old image until
  acceptance passes, so the rollback in §9 has deterministic names.

## 7. Acceptance tests (Gate F3B) and staged HSTS

All responses must include `Cache-Control: no-store`, `Content-Security-
Policy default-src 'self'; ...`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, `Permissions-Policy camera=(),
microphone=(), geolocation=()`. HTTPS responses must **not** carry an
HSTS header during initial cutover (see "Staged HSTS" below).

### 7.1 Loopback acceptance (while HTTPS holding vhost is in place)

Run on the VPS before touching the final proxy vhost. These confirm the
new Gateway is correct in isolation.

| Case | Command | Expected |
| --- | --- | --- |
| Healthz GET | `curl -sS -o /tmp/h.json -w 'http=%{http_code}\n' http://127.0.0.1:3000/healthz` | 200, body `{"success":true,"service":"trade-fair-gateway"}` |
| Healthz HEAD | `curl -sS -I http://127.0.0.1:3000/healthz` | 404 (Gateway intentionally serves only GET) |
| Static index | `curl -sS -o /dev/null -w 'http=%{http_code}\n' http://127.0.0.1:3000/` | 200 |
| Session probe | `curl -sS http://127.0.0.1:3000/api/session` | JSON with `authenticated=false` |
| Login wrong Origin | `curl -sS -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' --data '{"access_key":"<form>"}' http://127.0.0.1:3000/api/login` | 403 `SAME_ORIGIN_REQUIRED` |
| Login right Origin | add `-H 'Origin: https://messe.klare-ki.de'` to the above | 200; `Set-Cookie trade_fair_session=...; Path=/; HttpOnly; SameSite=Strict; Secure` |
| Dashboard anon | `curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/dashboard` | 401 |
| Dashboard admin | login with the admin key via the right-Origin command above, then `curl -b` the saved cookie against `/dashboard` and `/api/dashboard?limit=10` | 200 for both, API JSON matching Dashboard contract |
| Public form | `curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3000/api/public/leads` | 404 while `PUBLIC_FORM_ENABLED=false` |

Compare the recorded Set-Cookie to confirm `Secure` is present (it will
be, because `APP_ORIGIN` is now `https://…`).

### 7.2 External acceptance (after final proxy vhost is live)

Run from outside the VPS over IPv4. If any step fails, execute the §9
rollback immediately.

| Case | Command | Expected |
| --- | --- | --- |
| HTTP redirect | `curl -4 -sS -o /dev/null -w 'http=%{http_code} loc=%{redirect_url}\n' http://messe.klare-ki.de/` | `301`, `https://messe.klare-ki.de/` |
| Healthz GET | `curl -4 -sS -o /tmp/h.json -w 'http=%{http_code}\n' https://messe.klare-ki.de/healthz` | 200 and the same JSON body as 7.1 |
| Static index | `curl -4 -sS -I https://messe.klare-ki.de/` | 200, `Content-Type: text/html; charset=utf-8` |
| TLS chain | `openssl s_client -4 -connect messe.klare-ki.de:443 -servername messe.klare-ki.de -brief </dev/null` | ISRG chain, matching SAN |
| Dashboard anon | `curl -4 -sS -o /dev/null -w '%{http_code}\n' https://messe.klare-ki.de/dashboard` | 401 |
| Dashboard admin | authenticated flow against `https://messe.klare-ki.de/api/dashboard?limit=10` | 200 with real production data |
| Invalid filter | `.../api/dashboard?score_band=HOT` | 400 `INVALID_JSON` |
| POST method | `-X POST https://messe.klare-ki.de/api/dashboard` | 405 `REQUEST_REJECTED` |
| Capture/status | existing form POST and GET flows | behave as current live gateway, WF-A–D unchanged |

### 7.3 Staged HSTS

Enable only after §7.2 passes end-to-end:

1. Uncomment the first HSTS line in `ops/nginx/messe.klare-ki.de.conf`:
   `add_header Strict-Transport-Security "max-age=300" always;`
   `sudo nginx -t && sudo systemctl reload nginx`. Re-run §7.2 to
   confirm the header appears and the service still passes.
2. After at least 7 days of uninterrupted stable operation, replace the
   short line with the long one:
   `add_header Strict-Transport-Security "max-age=31536000" always;`
   `sudo nginx -t && sudo systemctl reload nginx`.

Both lines are host-only (no `includeSubDomains`, no `preload`). Per
RFC 6797, this HSTS policy applies to `messe.klare-ki.de` and its
sub-labels only — never to `mcp.`, `n5n.` or any other sibling host.
`includeSubDomains` is deliberately not used because the owner has not
committed every future `*.messe.klare-ki.de` label to HTTPS.

## 8. IPv6 release step (deferred until external verification)

AAAA stays unpublished until all four of these pass **from a machine
outside the VPS with real IPv6 egress** (not the VPS itself):

```
# Force resolution to the proposed AAAA; no record is published yet.
V6=2a01:4f9:c012:c1b5::1
H=messe.klare-ki.de

# 1. TCP 443 reachable over IPv6.
curl -6 -sS -o /dev/null -w 'http=%{http_code}\n' \
  --resolve "$H:443:$V6" https://$H/healthz
# expect 200 and the JSON body from §7

# 2. TLS/SNI with correct cert.
openssl s_client -6 -connect "[$V6]:443" -servername "$H" -brief </dev/null
# expect ISRG chain, SAN matches $H, no handshake error

# 3. HTTP → HTTPS redirect reachable over IPv6.
curl -6 -sS -o /dev/null -w 'http=%{http_code} loc=%{redirect_url}\n' \
  --resolve "$H:80:$V6" http://$H/
# expect 301 to https://messe.klare-ki.de/

# 4. Dashboard scope enforced over IPv6.
curl -6 -sS -o /dev/null -w '%{http_code}\n' \
  --resolve "$H:443:$V6" https://$H/dashboard
# expect 401
```

Publish `AAAA messe → 2a01:4f9:c012:c1b5::1` in Cloudflare (DNS only)
only after all four pass. IPv4-only service is a valid final state if
IPv6 fails any step. If AAAA is later removed as rollback, keep A in
place.

**Stop conditions for IPv6**:
- Any of the four probes fails or times out.
- The IPv6 handshake presents a different certificate than IPv4.
- The IPv6 response headers differ from IPv4 beyond expected
  address-family framing.

## 9. Rollback

Three independent layers. Owner picks the lowest layer that recovers.
Rollback steps always first restore the holding HTTPS vhost (so the
old Gateway's HTTP-only `APP_ORIGIN` is never presented behind HTTPS).

**Layer A — abort before Gateway swap.** The final proxy vhost is not
yet installed; the HTTPS holding vhost is in place.
1. If AAAA was published, remove it in Cloudflare.
2. Keep the HTTPS holding vhost. Public HTTPS continues to return 503.
3. No Gateway change needed. Clean up unused certbot cert later with
   `sudo certbot delete --cert-name messe.klare-ki.de` after owner
   decision.

**Layer B — Gateway swap failed loopback acceptance.** The final proxy
vhost is still **not** installed; the HTTPS holding vhost is live. The
new container exists under the name `wbs-trade-fair-gateway`, and the
saved container is at `wbs-trade-fair-gateway.saved-<ts>`.
```
docker stop   wbs-trade-fair-gateway
docker rename wbs-trade-fair-gateway        wbs-trade-fair-gateway.failed-<ts>
docker rename wbs-trade-fair-gateway.saved-<ts> wbs-trade-fair-gateway
docker start  wbs-trade-fair-gateway
curl -sS -o /tmp/h.json -w 'http=%{http_code}\n' \
  http://127.0.0.1:3000/healthz        # expect 200 + original JSON
```
Nothing changes in nginx; HTTPS stays on the holding 503.

**Layer C — final proxy vhost failed external HTTPS acceptance.** The
final proxy vhost is live; the new Gateway is running.
```
sudo cp /etc/nginx/sites-available/messe.klare-ki.de \
  /etc/nginx/sites-available/messe.klare-ki.de.bak-<ts>-f3b
sudo cp ops/nginx/messe.klare-ki.de.https-holding.conf \
  /etc/nginx/sites-available/messe.klare-ki.de
sudo nginx -t && sudo systemctl reload nginx
curl -4 -sS -o /dev/null -w 'http=%{http_code}\n' https://messe.klare-ki.de/
# expect 503
```
Then, if the Gateway must also roll back (e.g. for Dashboard behavior
or a DB fault), execute Layer B. Order matters: nginx first, then
Gateway. Reversing the order would briefly serve the old
HTTP-origin-only Gateway behind HTTPS and break form login.

**Residual cleanups** (never in the same window as the hot rollback):
- `sudo certbot delete --cert-name messe.klare-ki.de` only after owner
  decides to retire the hostname.
- Production Neon role/function cleanup is a separately reviewed
  migration. It must run only after the Gateway no longer references
  `DASHBOARD_DATABASE_URL` (i.e. after `DASHBOARD_ENABLED=false`
  recreate). The staging-only `sql/dashboard_staging_rollback.sql` must
  not run against production.
- Delete `/opt/wbs-trade-fair/secrets/backups/<ts>/` after the owner's
  retention window; it contains the pre-cutover env file.

## 10. Production rollout runbook (owner-approved execution)

Execution is strictly ordered. **Stop immediately** on any failed check
and go to §9. Each step names the exact probe commands.

1. **Freeze inputs.** Owner records target SHAs for PR #1 → #2 → #3,
   production Neon project/branch/endpoint, cutover window, Let's Encrypt
   recipient email, immutable image digest. Codex independent reviews on
   PR #4 and PR #6 stay unchanged.
2. **DNS A.** In Cloudflare, A `messe → 77.42.19.144` (DNS only). AAAA
   stays unpublished. Verify from two external resolvers:
   ```
   dig @8.8.8.8 +short messe.klare-ki.de A
   dig @1.1.1.1 +short messe.klare-ki.de A
   ```
3. **Bootstrap vhost.** On VPS:
   ```
   sudo cp ops/nginx/messe.klare-ki.de.bootstrap.conf \
     /etc/nginx/sites-available/messe.klare-ki.de
   sudo ln -s ../sites-available/messe.klare-ki.de \
     /etc/nginx/sites-enabled/messe.klare-ki.de
   sudo nginx -t && sudo systemctl reload nginx
   curl -4 -sS -o /dev/null -w 'http=%{http_code}\n' http://messe.klare-ki.de/
   # expect 503
   ```
4. **Certificate.** `sudo certbot --nginx -d messe.klare-ki.de --redirect
   --agree-tos -m <owner-email> --no-eff-email`. Certbot writes an HTTPS
   block into the file.
5. **HTTPS holding.** Replace the file with the holding HTTPS vhost
   immediately. Reload. Nothing reaches the Gateway from public yet:
   ```
   sudo cp ops/nginx/messe.klare-ki.de.https-holding.conf \
     /etc/nginx/sites-available/messe.klare-ki.de
   sudo nginx -t && sudo systemctl reload nginx
   curl -4 -sS -o /dev/null -w 'http=%{http_code}\n' https://messe.klare-ki.de/
   # expect 503
   ```
6. **Production Neon migration.** Under a separately reviewed owner
   migration (not the staging-only `sql/dashboard_role_staging.sql`),
   create a production `trade_fair_dashboard` login with a fresh
   password, install the reviewed `dashboard_snapshot(...)` function,
   revoke `PUBLIC EXECUTE`, grant schema `USAGE` and function `EXECUTE`
   only to the new role. Verify WF-A–D ACLs unchanged. Capture an
   immediate post-install catalog snapshot (owner, prosecdef, provolatile,
   search_path, ACL) to the owner backup directory.
7. **Private env.** Write `/opt/wbs-trade-fair/secrets/gateway.env` with
   mode 0600 per §6. Validate the file does not contain any staging host.
8. **Image + baseline.** Build the production image from the reviewed
   SHA using `Dockerfile.dashboard-staging`; record the digest. Save
   the baseline inspect dumps per §6 into
   `/opt/wbs-trade-fair/secrets/backups/<ts>/` (umask 077).
9. **Gateway swap.** Execute §6 "reversible swap". After `docker start`,
   wait up to 10 s, then run §7.1 loopback acceptance.
10. **Final proxy vhost.** Only after §7.1 passes:
    ```
    sudo cp ops/nginx/messe.klare-ki.de.conf \
      /etc/nginx/sites-available/messe.klare-ki.de
    sudo nginx -t && sudo systemctl reload nginx
    ```
11. **External HTTPS acceptance.** Run §7.2 from outside the VPS.
12. **Staged HSTS.** Enable per §7.3 only after §7.2 passes.
13. **IPv6 (optional).** Follow §8 end to end. If any step fails, do
    not publish AAAA; declare rollout complete over IPv4.

## 11. STOP conditions

Owner must stop and page back to this packet if any of these holds:

- `dig @sid.ns.cloudflare.com messe.klare-ki.de A|AAAA` disagrees with
  §2.
- Any pre-existing enabled vhost under `/etc/nginx/sites-enabled/` lists
  `messe.klare-ki.de` on `server_name`.
- `nginx -t` ever returns non-zero.
- The Gateway candidate fails `/healthz` on `127.0.0.1:3000` or returns
  a different JSON body than §7.1.
- Any §7.1 or §7.2 step returns 2xx on an outage path, serves a Dashboard
  route without the admin session cookie, or omits a Gateway security
  header listed in §7.
- `n8n-n8n-1` changes activation state during the window; verify
  (`sudo docker exec -i n8n-n8n-1 n8n list:workflow --onlyActive`).
- Any §8 IPv6 probe fails before AAAA is published.

## 12. Codex handover

Independent review targets:

- `ops/nginx/messe.klare-ki.de.bootstrap.conf`,
  `ops/nginx/messe.klare-ki.de.https-holding.conf`,
  `ops/nginx/messe.klare-ki.de.conf` — static review for header
  duplication, path preservation, security posture and compatibility
  with the Gateway's own headers (`gateway/server.mjs:94-100,186,268`).
- `ops/env/gateway.production.env.example` — shape only, no secrets.
- `ops/nginx/syntax_check_evidence.txt` — the three `nginx -t` runs on
  an isolated nginx 1.24 container with a self-signed stand-in cert.
- `docs/WBS_TF_06_F3B_PREP.md` (this file) — numbers against observed
  VPS/DNS state, independence of impact statements, and completeness of
  the rollout and rollback.

**Reproducible read-only probes (no secret output):**

```
# DNS
dig @sid.ns.cloudflare.com +short messe.klare-ki.de A
dig @sid.ns.cloudflare.com +short messe.klare-ki.de AAAA
dig @sid.ns.cloudflare.com +short messe.klare-ki.de CNAME

# nginx vhost conflict + certbot inventory (on the VPS)
ssh klare-ki 'sudo nginx -T | grep -nE "^\s*server_name|^\s*listen|^\s*ssl_certificate "'
ssh klare-ki 'sudo certbot certificates | grep -E "Certificate Name|Domains|Expiry"'

# Current Gateway runtime shape — no env dump
ssh klare-ki "docker inspect wbs-trade-fair-gateway \
  --format '{{.HostConfig.NetworkMode}} {{.HostConfig.RestartPolicy.Name}} \
            mounts={{range .Mounts}}{{.Destination}} {{end}}\
            image={{.Image}}'"

# Local syntax + regression + evidence
docker run --rm -v $PWD/ops/nginx:/vhosts:ro nginx:1.24 \
  nginx -t -c /dev/stdin <<< 'events{} http{ include /vhosts/*.conf; }'
node --test tests/*.mjs
cat ops/nginx/syntax_check_evidence.txt
```

The `.Config.Env` dump from the R1 version is deliberately removed: it
would print production secrets. Any needed deep inspect lives behind
`umask 077` under `/opt/wbs-trade-fair/secrets/backups/`.

## 13. PR integration strategy (post PR #1 → #2 → #3)

PR #4 (independent WBS-TF-05 review) and PR #6 (independent WBS-TF-06
F3B review) stay as review-only Draft PRs; neither merges to `main`.
PR #5 is based on PR #4 and currently targets `review/wbs-tf-05`, which
would otherwise force the review PRs onto the runtime chain.

After PR #3 lands on `main`, the clean path is:

1. Transplant the single corrected PR #5 commit (this R2 commit)
   onto a new branch cut from the updated `main`:
   `git checkout -b docs/wbs-tf-06-f3b-r2 origin/main`
   `git cherry-pick <sha of R2 commit on PR #5>`.
2. Open PR #7 against `main` with that commit, title
   `docs(ops): WBS-TF-06 F3B packet (R2)`, linking PR #5 and PR #6.
3. Close PR #4, PR #5 and PR #6 as drafts with cross-links to PR #7 and
   to the production acceptance record. Nothing in the review history is
   deleted; GitHub preserves them as closed Draft PRs.

If the owner prefers to keep review PRs discoverable from `main`, the
alternative is to merge PR #4 and PR #6 as documentation after PR #3,
then merge the retargeted PR #5. Either path is acceptable; the
runbook ordering above does not depend on which is chosen.

**No merge is part of this packet.** The runbook ordering (DNS → nginx
bootstrap → cert → holding → migration → secrets → image → swap →
loopback acceptance → final vhost → external acceptance → staged HSTS →
optional IPv6) is independent of the PR integration path.

## 14. Remaining owner approvals (nothing in this R2 is self-approving)

- Cloudflare DNS: A already present (owner-created); AAAA pending §8.
- nginx: install bootstrap vhost, run certbot, swap to HTTPS holding,
  swap to final proxy, enable staged HSTS.
- Private secrets: write `/opt/wbs-trade-fair/secrets/gateway.env` and
  the `backups/<ts>/` directory on the VPS.
- Image: build and store the content-addressed production image.
- Production Neon migration: owner-reviewed role + function install.
- Gateway: reversible container swap.
- Rollout acceptance and HSTS stage transitions.
- PR integration path (§13 option A or option B).

No step above is authorized by this document.
