#!/usr/bin/env bash
# WBS-TF real-AI isolated stack bringup.
#
# Starts the n8n-equivalent proxy (demo/real-ai/n8n_equivalent_proxy.mjs) on
# loopback 127.0.0.1:5679 — exposes WF-07/WF-08 webhook URLs byte-equivalent
# to the committed n8n workflows, calling the REAL OpenAI API with the Owner-
# provided key. Isolated from production VPS, Neon, n8n, PAM.
#
# Why not n8n 2.41.7 itself: CLI-import → publish → activate on v2.41.7 does not
# consistently register production webhooks without manual UI activation. The
# proxy executes the exact Code-node JS and prompts from the committed JSON
# (via loadWorkflow + Function()), so the behaviour matches contract tests.
# Production path: Owner imports the SAME committed workflow in production n8n
# and activates via UI (works there — supervised, not CLI-only).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
ENVFILE="$HERE/.env"
PID_FILE="$HERE/.proxy.pid"
LOG_FILE="$HERE/.proxy.log"
N8N_PORT="${N8N_PORT:-5679}"
HEADER_AUTH_KEY="${HEADER_AUTH_KEY:-demo-rc-n8n-header-$(date +%s)}"
AI_CTX_LOGIN="${AI_CTX_LOGIN:-synthetic_context_login}"
AI_CTX_PASSWORD="${AI_CTX_PASSWORD:-synthetic-local-only}"
PG_CT="${PG_CT:-wbs-tf-demo-pg}"
PG_PORT="${PG_PORT:-15432}"

if [ -f "$ENVFILE" ]; then set -a; . "$ENVFILE"; set +a; fi

cmd="${1:-start}"
case "$cmd" in
  start)
    [ -z "${OPENAI_API_KEY:-}" ] && { echo "ERROR: OPENAI_API_KEY not set (edit $ENVFILE)" >&2; exit 2; }
    docker ps --format '{{.Names}}' | grep -q "^${PG_CT}\$" || { echo "ERROR: demo Postgres '${PG_CT}' not running" >&2; exit 2; }
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then echo "Already running (pid $(cat "$PID_FILE"))"; exit 0; fi
    # Ensure the scoped AI-context login exists on the shared demo PG.
    docker exec "$PG_CT" psql -U neondb_owner -d neondb -c "DO \$\$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${AI_CTX_LOGIN}') THEN
        EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', '${AI_CTX_LOGIN}', '${AI_CTX_PASSWORD}');
        EXECUTE format('GRANT trade_fair_ai_context TO %I', '${AI_CTX_LOGIN}');
      END IF;
    END \$\$;" >/dev/null
    cd "$REPO"
    env OPENAI_API_KEY="$OPENAI_API_KEY" N8N_HEADER_KEY="$HEADER_AUTH_KEY" N8N_PORT="$N8N_PORT" \
        AI_CTX_LOGIN="$AI_CTX_LOGIN" AI_CTX_PASSWORD="$AI_CTX_PASSWORD" PG_PORT="$PG_PORT" \
        nohup node demo/real-ai/n8n_equivalent_proxy.mjs > "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"; sleep 1
    if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then echo "Failed. Last log:"; tail -40 "$LOG_FILE"; exit 1; fi
    echo "n8n-equivalent proxy started (pid $(cat "$PID_FILE")) on http://127.0.0.1:${N8N_PORT}"
    echo "HEADER_AUTH_KEY=${HEADER_AUTH_KEY}"
    ;;
  stop)
    if [ -f "$PID_FILE" ]; then kill "$(cat "$PID_FILE")" 2>/dev/null || true; rm -f "$PID_FILE"; echo stopped; fi
    ;;
  status)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then echo "running pid $(cat "$PID_FILE") on 127.0.0.1:${N8N_PORT}"; else echo stopped; fi
    ;;
  logs) tail -f "$LOG_FILE" ;;
  smoke)
    cd "$REPO" && node demo/real-ai/smoke_real_ai.mjs
    ;;
  *) echo "usage: $0 {start|stop|status|logs|smoke}" ;;
esac
