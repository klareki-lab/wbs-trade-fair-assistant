# WBS-TF-06 — HTTPS Gateway and Gate F3B preparation

Scope: design + preparation only. No production change. Companion to the
Codex independent review in `docs/WBS_TF_05_INDEPENDENT_REVIEW.md`. The
output of this document plus the two nginx vhost files under
`ops/nginx/` and the sample env under `ops/env/` is the production
rollout packet handed to the owner for approval.

## 1. Recommended HTTPS origin

- **Hostname:** `messe.klare-ki.de`
- **Scheme/port:** `https://` on default port 443. Gateway reaches
  `APP_ORIGIN=https://messe.klare-ki.de`, so the strict same-origin check
  and `Secure` session cookie attribute activate automatically
  (`gateway/server.mjs:57,186,268`).
- **Why a dedicated subdomain:** matches the house pattern (`mcp.`,
  `delivery.`, `n5n.`, `herman.`, `review.`, `bistro.`, `minio.`,
  `console.` each already run as separate nginx vhosts with their own Let's
  Encrypt certificates). Keeps the existing n8n and MCP routing fully
  isolated and lets a cutover or rollback touch only one vhost.
- **Alternative considered:** `api.klare-ki.de`. Rejected because this
  deployment serves both the admin form and the Dashboard HTML/CSS/JS from
  the same Gateway; `messe` reads more accurately as a product origin.
  Owner can override — the Gateway only cares about one exact string.

## 2. DNS readiness

- Current state (read-only `dig`):
  - `messe.klare-ki.de` A/AAAA/CNAME → **no records**.
  - `klare-ki.de` and `www.klare-ki.de` are proxied through Cloudflare
    (Cloudflare edge IPs; NS = `sid.ns.cloudflare.com`,
    `jillian.ns.cloudflare.com`).
  - `mcp.klare-ki.de` is **DNS-only** (gray cloud), resolving directly to
    the VPS at `77.42.19.144`.
  - CAA for `klare-ki.de`: none. Any CA including Let's Encrypt may issue.
- VPS public IPs (confirmed from the VPS itself): `77.42.19.144` (A),
  `2a01:4f9:c012:c1b5::1` (AAAA).
- **Required records (owner action in Cloudflare):**

  | Type | Name | Value | Proxy | TTL |
  | --- | --- | --- | --- | --- |
  | A    | `messe` | `77.42.19.144`           | DNS only | Auto |
  | AAAA | `messe` | `2a01:4f9:c012:c1b5::1`  | DNS only | Auto |

  DNS-only (gray cloud) matches `mcp.klare-ki.de`, keeps TLS termination on
  the VPS so Let's Encrypt HTTP-01 works without edge-origin cert handling,
  and avoids Cloudflare rules affecting Dashboard behavior.
- **Verification (owner-side, read-only):**
  ```
  dig +short messe.klare-ki.de A      # expect 77.42.19.144
  dig +short messe.klare-ki.de AAAA   # expect 2a01:4f9:c012:c1b5::1
  dig +short messe.klare-ki.de CNAME  # expect empty
  ```

## 3. VPS inventory (read-only, 2026-10-24)

- nginx 1.24.0 (Ubuntu). Vhosts in `/etc/nginx/sites-{available,enabled}/`.
  Core config pins `ssl_protocols TLSv1.2 TLSv1.3;` and
  `ssl_prefer_server_ciphers on;`.
- Existing enabled vhosts: `bistro`, `default`, `delivery`,
  `herman.klare-ki.de`, `mcp.klare-ki.de`, `minio.klare-ki.de`
  (serves both `minio` and `console`), `n5n`, `review.klare-ki.de`.
  None matches `messe` on `server_name` — no vhost conflict.
- Certbot 2.9.0 (apt), `certbot.timer` active (next run ~daily). All
  existing certificates were issued via `certbot --nginx` and live under
  `/etc/letsencrypt/live/<name>/`. Same path convention will apply to
  `messe.klare-ki.de`.
- Listening ports (abridged):
  - `0.0.0.0:80`, `0.0.0.0:443` → nginx master.
  - `127.0.0.1:3000` → Gateway (`node`, PID 4167048 at probe time), host
    network mode, loopback-only. **No public exposure.**
  - `127.0.0.1:5678` → n8n (via docker-proxy).
  - `127.0.0.1:8100` → MCP server (via docker-proxy).
  - `127.0.0.1:5432`, `172.17.0.1:5432`, `172.18.0.1:5432` → local Postgres
    (not used by this product; n8n and WBS Trade Fair Assistant use Neon).
  - `127.0.0.1:13080` currently free; was used by staging compose and
    released on teardown.
- Gateway container (`wbs-trade-fair-gateway`, `node:22-alpine`):
  `NetworkMode=host`, `RestartPolicy=unless-stopped`, env values confirmed
  (`APP_ORIGIN=http://127.0.0.1:3000`, `PUBLIC_FORM_ENABLED=false`,
  `DASHBOARD_ENABLED` not set yet). Dashboard code is present in the
  repository but inert on production until the gateway is recreated with
  Dashboard env plus the production SQL migration.

## 4. nginx configuration

Delivered as two files under `ops/nginx/`:

- `messe.klare-ki.de.bootstrap.conf` — temporary HTTP-only vhost used
  only during Let's Encrypt issuance. Returns `503` for all paths; its
  sole purpose is to give nginx a `server_name` match so
  `certbot --nginx` can edit a known block in place without creating
  side effects.
- `messe.klare-ki.de.conf` — the final vhost. Port 80 → 301 to HTTPS;
  port 443 TLS → `proxy_pass http://127.0.0.1:3000;` with Host preserved,
  no path rewrite, and the forwarded-proto/host/for headers set. HSTS is
  added at the edge; the Gateway continues to send its own CSP,
  `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `Permissions-Policy` and
  `Cache-Control: no-store` (`gateway/server.mjs:94–100`). nginx does
  **not** duplicate those headers.
- Both vhost files were syntax-tested against nginx 1.24 (the VPS
  version) with a self-signed stand-in cert and an isolated
  `nginx.conf` that mirrors the house `ssl_protocols` lines; `nginx -t`
  returned `syntax is ok` and `test is successful` for both.
- Request paths are preserved end to end. The following Gateway routes
  (`gateway/server.mjs:333–421`) all reach the backend unchanged:
  - `GET /healthz`
  - `GET /`, `GET /app.js`, `GET /styles.css`,
    `GET /berater`, `GET /berater-adapter.js`
  - `GET /api/session`
  - `POST /api/login`, `POST /api/logout`
  - `POST /api/leads`
  - `GET /api/leads/FAIR-<uuid>?submission_id=<id>`
  - `GET /dashboard`, `GET /dashboard.js`, `GET /dashboard.css`
  - `GET /api/dashboard` (query string carries the filter)
  - `POST /api/public/leads` returns 404 while `PUBLIC_FORM_ENABLED=false`.
- Only the Gateway serves these paths. No `/api/*` is forwarded to n8n.
  The n8n endpoints keep running on `n5n.klare-ki.de`; `messe.` never
  reaches 5678.

## 5. TLS readiness

- Standard house pattern: `certbot --nginx -d messe.klare-ki.de --redirect
  --agree-tos -m <owner-email> --no-eff-email`. HTTP-01 challenge over
  port 80, which is already open and served by nginx. `certbot.timer`
  then picks up the new cert for 60-day renewal automatically.
- Cipher/protocol posture is inherited from the main `nginx.conf`
  (`TLSv1.2 TLSv1.3`, server-ciphers preferred). HSTS is set in the
  `messe` vhost at one year with `includeSubDomains` (`klare-ki.de` has
  no other HTTPS host that would be broken by inclusion; verify before
  flipping on `preload`). Scheme redirect is a 301 to HTTPS.
- Post-issuance, replace the bootstrap vhost with
  `ops/nginx/messe.klare-ki.de.conf`, run `sudo nginx -t`, then
  `sudo systemctl reload nginx`. The cert path references match the
  existing Let's Encrypt layout.
- Residual TLS acceptance (owner-side, before enabling the vhost for
  users): `curl -I https://messe.klare-ki.de/healthz` returns 200;
  `openssl s_client -connect messe.klare-ki.de:443 -servername
  messe.klare-ki.de` presents the issued leaf chained to ISRG; HTTP→HTTPS
  redirect returns 301.

## 6. Gateway cutover

- Create a new private env file at `/opt/wbs-trade-fair/secrets/gateway.env`
  (owner-only; see `ops/env/gateway.production.env.example`). Set
  `APP_ORIGIN=https://messe.klare-ki.de`. Do not commit it.
- Rebuild the Gateway image from a reviewed SHA using
  `Dockerfile.dashboard-staging` (Node 22, `npm ci`, `pg` included). The
  live container currently relies on host-mounted source; the production
  recreate must either keep the mount pattern (apply APP_ORIGIN by
  recreating the container alone) **or** switch to the built image. Per
  the Codex review §5, the built image path is preferred; preserve host
  networking only after confirming it against the saved `docker inspect`.
- Reversible swap: create the candidate container under a temporary name,
  stop and rename the old one, rename and start the candidate. Keep the
  old container and image until acceptance passes.

## 7. Acceptance tests (Gate F3B)

Run from the VPS loopback **before** the nginx vhost is enabled, and then
again against `https://messe.klare-ki.de` **after** the vhost is enabled.
All responses must include `Cache-Control: no-store`, `Content-Security-
Policy default-src 'self'; ...`, `X-Frame-Options: DENY`, `Referrer-Policy:
no-referrer`. Over HTTPS, `Strict-Transport-Security: max-age=31536000;
includeSubDomains` must appear exactly once.

| Case | Expected |
| --- | --- |
| `GET /healthz` (loopback and HTTPS) | 200, body `ok` |
| `GET /` HTTPS | 200, correct `Content-Type: text/html` |
| `GET /app.js`, `/styles.css`, `/berater`, `/berater-adapter.js` HTTPS | 200 with correct `Content-Type` |
| `GET http://messe.klare-ki.de/` | 301 → `https://messe.klare-ki.de/` |
| anonymous `GET /dashboard`, `/dashboard.js`, `/dashboard.css`, `/api/dashboard` | 401 |
| `POST /api/login` with form key, bad `Origin` header | 403 `SAME_ORIGIN_REQUIRED` |
| `POST /api/login` with form key, `Origin: https://messe.klare-ki.de` | 200; `Set-Cookie trade_fair_session=...; Path=/; HttpOnly; SameSite=Strict; Secure` |
| form-session `GET /api/dashboard`, `GET /dashboard*` | 401 |
| admin-session `GET /dashboard`, `/dashboard.js`, `/dashboard.css` | 200 |
| admin-session `GET /api/dashboard?limit=10` | 200 with real production data |
| admin-session `GET /api/dashboard?band=HOT` | 200, filter applied |
| admin-session `GET /api/dashboard?score_band=HOT` | 400 `INVALID_JSON` |
| admin-session `POST /api/dashboard` | 405 `REQUEST_REJECTED` |
| synthetic DB outage (owner-induced, out of scope here) | 503 retryable; `/healthz` stays 200; recovery → 200 without Gateway restart |
| capture/status: existing form POST `/api/leads` and `GET /api/leads/FAIR-...` | Behave as the current live gateway, with WF-A–D unchanged |

Owner also verifies: `nginx -t` is clean, `systemctl reload nginx`
succeeds, `journalctl -u nginx` has no new errors for one quiet minute,
and no other vhost's TLS chain or server_name has changed.

## 8. Impact on existing services

- **n8n (`n5n.klare-ki.de`, port 5678)**: untouched. The `messe.` vhost
  forwards no path to 5678.
- **MCP (`mcp.klare-ki.de`)**: untouched.
- **MinIO console (`minio./console.klare-ki.de`)**: untouched.
- **Other static vhosts (`bistro`, `delivery`, `herman`, `review`)**:
  untouched.
- **Live form on the current Gateway**: unchanged until the owner
  recreates the container with `APP_ORIGIN=https://messe.klare-ki.de`.
  During the swap, the form briefly 502s if the new container is late to
  bind; the rollback below is the mitigation.
- **Cookies**: session cookies become `Secure`. Clients mid-session over
  `http://127.0.0.1:3000` would see their cookie invalidated — not a
  real-world case because the current Gateway is loopback-only, but the
  cutover still forces a fresh login for anyone with a cached session.

## 9. Rollback plan

Owner-executable in two independent layers; either layer can be reverted
without touching the other.

**Gateway rollback (container swap):**
1. `docker stop wbs-trade-fair-gateway-candidate && docker rename
   wbs-trade-fair-gateway-candidate wbs-trade-fair-gateway-candidate.failed`.
2. `docker rename wbs-trade-fair-gateway.saved wbs-trade-fair-gateway &&
   docker start wbs-trade-fair-gateway`.
3. Confirm `curl -sS http://127.0.0.1:3000/healthz` → 200 and the live
   `APP_ORIGIN` is back on `http://127.0.0.1:3000`.

**nginx rollback (vhost):**
1. `sudo mv /etc/nginx/sites-available/messe.klare-ki.de
   /etc/nginx/sites-available/messe.klare-ki.de.bak-<ts>-f3b`.
2. `sudo rm /etc/nginx/sites-enabled/messe.klare-ki.de`.
3. `sudo nginx -t && sudo systemctl reload nginx`.
4. Confirm `curl -I http://messe.klare-ki.de/` returns the default
   server's response (not a WBS 503 or 200) and `openssl s_client`
   shows no `messe.` certificate presentation beyond what Let's Encrypt
   already issued.
5. The issued certificate itself is harmless if left in place; it can be
   removed with `sudo certbot delete --cert-name messe.klare-ki.de` once
   DNS is also reverted or decided to stay down.

**Neon rollback (if required separately):** cover under WBS-TF-04's
`sql/dashboard_staging_rollback.sql` recipe — but note it is staging-only
and must not run against production. Production rollback of the
dashboard role + function is a separately reviewed migration; it must
run only after the Gateway no longer references the function (i.e.
after `DASHBOARD_ENABLED=false` recreate).

## 10. Production rollout packet (owner-approved execution)

Execution order is intentional; stop immediately on any failed check.

1. **Freeze inputs.** Owner records target SHAs for PR #1 → #2 → #3,
   production Neon project/branch/endpoint, cutover window, and
   recipient email for Let's Encrypt. Codex independent review on PR #4
   stays unchanged.
2. **DNS.** In Cloudflare, add `A messe → 77.42.19.144 (DNS only)` and
   `AAAA messe → 2a01:4f9:c012:c1b5::1 (DNS only)`. Owner-side verify:
   `dig +short messe.klare-ki.de A|AAAA` from two independent networks.
3. **nginx bootstrap vhost.** On VPS:
   ```
   sudo cp ops/nginx/messe.klare-ki.de.bootstrap.conf \
     /etc/nginx/sites-available/messe.klare-ki.de
   sudo ln -s ../sites-available/messe.klare-ki.de \
     /etc/nginx/sites-enabled/messe.klare-ki.de
   sudo nginx -t && sudo systemctl reload nginx
   curl -I http://messe.klare-ki.de/   # expect 503 plain text
   ```
4. **Certificate.** `sudo certbot --nginx -d messe.klare-ki.de --redirect
   --agree-tos -m <owner-email> --no-eff-email`. Certbot edits the
   bootstrap block in place.
5. **Final vhost.** Replace the file in sites-available with
   `ops/nginx/messe.klare-ki.de.conf` and reload:
   ```
   sudo cp ops/nginx/messe.klare-ki.de.conf \
     /etc/nginx/sites-available/messe.klare-ki.de
   sudo nginx -t && sudo systemctl reload nginx
   ```
6. **PR merge order.** Merge PR #1 (`baseline/live-2026-10-24` → `main`).
   Retarget and review PR #2 against the updated `main`; merge PR #2.
   Retarget and review PR #3 against the updated `main`; merge PR #3.
   PR #4 is Codex's independent review — do not merge; close with a
   comment linking the production acceptance. Re-run `node --test
   tests/*.mjs` at every retarget point.
7. **Production Neon migration.** Under a separately reviewed owner
   migration (not the staging-only `sql/dashboard_role_staging.sql`),
   create a production `trade_fair_dashboard` login with a fresh
   password, install the reviewed `dashboard_snapshot(...)` function,
   revoke `PUBLIC EXECUTE`, grant schema `USAGE` and function `EXECUTE`
   only to the new role. Confirm WF-A–D role ACLs unchanged.
8. **Gateway recreate.** Build the Dashboard-capable image from the
   final PR #3 SHA. Save `docker inspect wbs-trade-fair-gateway > ...`
   plus `docker image inspect` for the current image and the new one.
   Create the candidate container with the new env file; swap as in §6.
9. **Enable the vhost.** `sudo systemctl reload nginx` after the final
   vhost is in place (step 5 already did this; re-verify after the
   container swap).
10. **Acceptance.** Run every check in §7 against
    `https://messe.klare-ki.de`. If any step fails, execute the §9
    rollback immediately.

## 11. STOP conditions

Owner must stop and page back to this packet if any of these holds:

- `dig messe.klare-ki.de` returns a Cloudflare proxy IP (confirming the
  DNS record landed on orange cloud); fix in Cloudflare before any
  nginx step.
- Any pre-existing enabled vhost under `/etc/nginx/sites-enabled/` lists
  `messe.klare-ki.de` on `server_name`; investigate before overwriting.
- `nginx -t` ever returns non-zero: revert the file and reload; do not
  continue.
- The Gateway candidate fails `/healthz` on `127.0.0.1:3000`; execute the
  Gateway rollback in §9.
- A production acceptance check in §7 returns an unexpected 2xx on an
  outage path, or any Dashboard route serves data without the admin
  session cookie: execute both rollback layers and preserve logs.
- Any workflow in n8n changes activation state during the window; the
  owner must confirm WF-A–D are untouched (`sudo docker exec -i
  n8n-n8n-1 n8n list:workflow --onlyActive`).

## 12. Codex handover

Independent review targets:

- `ops/nginx/messe.klare-ki.de.bootstrap.conf` and
  `ops/nginx/messe.klare-ki.de.conf` — static review for header
  duplication, path rewriting, security posture, and compatibility with
  the Gateway's own headers (`gateway/server.mjs:94–100,186,268`).
- `ops/env/gateway.production.env.example` — shape only, no secrets.
- `docs/WBS_TF_06_F3B_PREP.md` (this file) — numbers against observed
  VPS/DNS state, independence of impact statements, and completeness of
  the rollout and rollback.

Reproduce the read-only probes:

```
dig +short messe.klare-ki.de A AAAA CNAME
dig +short klare-ki.de NS CAA
ssh klare-ki 'ss -tlnp; sudo nginx -T | grep -E "server_name|listen|proxy_pass|ssl_certificate"'
ssh klare-ki 'sudo certbot certificates | head -60'
docker inspect wbs-trade-fair-gateway --format '{{.HostConfig.NetworkMode}} {{.Config.Env}}'
```

No production change is approved by this document.
