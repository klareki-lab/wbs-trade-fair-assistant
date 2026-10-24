# Deployment — Observed State

Captured on 2026-10-24. No deployment actions were performed by this task;
this document only describes what is already running.

## Gateway container

- Image: `node:22-alpine` (no custom Dockerfile).
- Container name: `wbs-trade-fair-gateway`.
- Launched by: `docker run` (no docker-compose, no systemd unit for this
  container was found on the VPS).
- Restart policy: `unless-stopped`.
- Working dir: `/app/gateway`.
- Entrypoint: `docker-entrypoint.sh node server.mjs`.
- Mounts (both read-only):
  - `/opt/wbs-trade-fair/trade_fair_assistant/gateway` → `/app/gateway`
  - `/opt/wbs-trade-fair/trade_fair_assistant/web` → `/app/web`
- Published ports: **none**. The container listens on `127.0.0.1:3000`
  inside the Docker bridge; the host-facing nginx (not in scope for this
  baseline) proxies to it.
- Environment: loaded from `/opt/wbs-trade-fair/secrets/gateway.env` at
  startup. The expected variables are documented in `.env.example` and
  `gateway/README.md`:
  `HOST`, `PORT`, `APP_ORIGIN`, `TRADE_FAIR_ACCESS_KEY`, `SESSION_SECRET`,
  `N8N_CAPTURE_URL`, `N8N_STATUS_URL`, `N8N_HEADER_KEY`,
  `PUBLIC_FORM_ENABLED`.

## n8n instance

- Container name: `n8n-n8n-1`.
- Version: 2.41.7.
- Data volume: `/root/n8n/n8n_data` → `/home/node/.n8n` (contains sqlite,
  encrypted credentials, `config` with the n8n encryption key).
- Credential store: n8n's own sqlite (not the `n8n-postgres` container, which
  is used by other projects on this VPS for operational incidents).
- Not managed by this repository. Only the four Trade-Fair workflows are
  within scope.

## Neon database

- Database: `neondb`.
- Schema: `trade_fair`.
- App role: `trade_fair_app` (least-privileged; access via SECURITY DEFINER
  functions). This is the role bound to the live n8n credential.
- The gateway does **not** connect to Neon directly.

## Operational boundaries

- Nginx vhost config: owned by Gate F3B; not touched here.
- `/opt/wbs-trade-fair/secrets/`: owner-only, never copied off the VPS.
- Firewall / IP policy: outside scope.
- Monitoring / alerting: outside scope.

## Re-deployment, in principle

To rebuild the gateway from this repository, in an isolated environment:

```bash
# Launch node:22-alpine with gateway/ and web/ mounted read-only, loading a
# private env file provisioned by the operator.
docker run -d --name wbs-trade-fair-gateway \
  --restart unless-stopped \
  --env-file /path/to/private/gateway.env \
  -v /path/to/gateway:/app/gateway:ro \
  -v /path/to/web:/app/web:ro \
  -w /app/gateway \
  node:22-alpine node server.mjs
```

The expected private env values are listed in `gateway/README.md`.

Workflows are re-created by importing each JSON in `workflows/` into n8n and
re-binding to the operator's own Postgres / Tavily / OpenAI (or Requesty) /
Resend / Gateway-Auth credentials (same names, new values — the credential
`id`s inside the JSON will no longer resolve on a fresh instance).
