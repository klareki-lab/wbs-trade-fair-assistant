# Security Review — WBS-TF-03

Scope: the dashboard integration applied on branch
`feature/astra-dashboard`, on top of baseline
`854f247546742fd69cc5c81385cf2b73657d440b`.

## Trust model (unchanged by this PR)

- Browser session: HttpOnly, SameSite=Strict, HMAC-signed, 8h TTL. Secret
  rotation invalidates all sessions. Logout clears the cookie in the
  issuing browser only.
- Mutating requests require `Origin === APP_ORIGIN`. There is no wildcard
  CORS. The browser never sees n8n webhook URLs or `X-Trade-Fair-Key`.
- Rate limits are in-memory per socket peer; `X-Forwarded-For` is
  deliberately ignored.
- CSP: `default-src 'self'; script-src 'self'; style-src 'self'; …`.

The dashboard integration does **not** relax any of the above.

## Dashboard-specific security

| Control | Where enforced | Note |
| --- | --- | --- |
| Session required for all dashboard paths | `requireSession(req, res)` at the top of each handler block (`/api/dashboard`, `/dashboard`, `/dashboard.js`, `/dashboard.css`) | Returns 401 when absent — covered by `tests/test_gateway_dashboard.mjs`. |
| GET only on `/api/dashboard` | explicit method check + fall-through 405 branch | Covered. |
| GET or HEAD only on asset routes | explicit method check | Covered. |
| Input validation | `parseDashboardQuery` whitelists keys, enforces page/limit bounds and enum values; rejects duplicates and control chars | Covered by `tests/test_dashboard.mjs`. |
| Parameterised SQL | `createDashboardDb` sends a fixed `SELECT trade_fair.dashboard_snapshot($1..$9)` statement, binds user input as text, never interpolates | Covered. |
| Read-only transaction | `BEGIN READ ONLY` + `SET LOCAL statement_timeout = '5000ms'` + `COMMIT` / `ROLLBACK` | Covered. |
| TLS cert validation | `pg` Pool is constructed with `ssl: { rejectUnauthorized: true }`; `sslmode / sslrootcert / sslcert / sslkey` are stripped from the URL to prevent silent downgrade | Covered. |
| No DB credentials in browser | New code lives only in `gateway/` (server-side); `web/dashboard.js` uses only `fetch('/api/dashboard', ...)` | Covered by `tests/test_dashboard.mjs` fixture scan. |
| Fail-closed storage error | Any adapter exception → `503 STATUS_UNAVAILABLE`, retryable, `persistence_status=unknown`. Error text is never serialised into the response. | Covered. |
| Config fail-closed | `loadConfig` throws if `DASHBOARD_ENABLED` is not `true/false`, or if enabled without a valid `DASHBOARD_DATABASE_URL` | Covered. |

## SECURITY DEFINER function

Properties of `trade_fair.dashboard_snapshot` (see
`sql/dashboard_snapshot.sql`):

- `LANGUAGE sql STABLE SECURITY DEFINER`.
- `SET search_path = pg_catalog, trade_fair, pg_temp` — pinned, prevents
  schema-shadowing attacks on the owner-privileged body.
- Owner must have `SELECT` on all five referenced tables; the function
  caller never gets table-level privileges.
- Bounded pagination (`LEAST(GREATEST(limit, 1), 100)` and
  `LEAST(GREATEST(offset, 0), 1_000_000)`).
- No mutating SQL (`DELETE`, `UPDATE`, `INSERT`, `TRUNCATE` — all absent;
  enforced by `test_dashboard.mjs`).
- `REVOKE ALL ON FUNCTION … FROM PUBLIC` + explicit `GRANT EXECUTE … TO
  <dashboard_role>` — closes the common Postgres default `PUBLIC` grant.
- No `GRANT SELECT` on tables.

**Open security decision for the owner:** which role becomes
`dashboard_role`. Reusing `trade_fair_app` expands its surface to include
processing results and outbox data (today it can only see
`companies / contacts / lead_submissions`). A dedicated minimally-
privileged role is the safer default. See
`docs/DASHBOARD_DEPLOYMENT.md` §C.

## Known risks (documented, not fixed in this PR)

1. **Column-visibility assumption.** `dashboard_snapshot` reads columns on
   `processing_results` and `email_outbox` that the baseline could not
   verify (the live `trade_fair_app` role has no SELECT there). Final
   validation blocked on Neon preflight (§B of deployment doc).
2. **Yuriy's `Messe-Admin-Hub.html` in `dashboard/`** still contains the
   Basic-Auth + direct-n8n-webhook pattern. It is **not** served by the
   gateway; it lives under `dashboard/` as reference only. The dashboard
   actually wired up by this PR is a different file, `web/Messe-Admin-Hub.html`,
   which uses the authenticated same-origin API.
3. **Ad-hoc `docker run` deployment.** The live container is not managed
   by compose or systemd (see `docs/DEPLOYMENT.md`). Any future redeploy
   that forgets to re-apply `DASHBOARD_ENABLED` would silently disable
   the dashboard. The gateway fails open to pre-dashboard behavior in
   that case, which is intentional.
4. **No distributed rate limiter.** In-memory limits reset on restart and
   do not aggregate across containers. Fine for a single-container MVP;
   needs reconsideration before horizontal scaling or public exposure.

## Patcher removed

`scripts/apply_dashboard.mjs` from the candidate ZIP was **not committed**.
Two of its anchors (`publicPrivacyNoticeUrl`, `trustedProxyIps`,
`clientIpMode` and the standalone `publicEnabled` line) do not exist in
the real baseline `server.mjs`; running it would have failed closed. The
integration was applied by hand with the same semantics, and the patcher
was removed so no reviewer or future deployer is misled by a non-
functional installer. The Astra provenance docs are preserved under
`ops/astra-package/` for traceability.

## Secret scan

Repository-wide pattern + structural scan: zero real secrets in the
committed tree. Scan output lives in `docs/HANDOVER.md`.
