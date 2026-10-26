#!/usr/bin/env bash
# WBS Messe Hub local demo controller — isolated from production.
set -euo pipefail

DEMO_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$DEMO_DIR/.." && pwd)"
PG_NAME="wbs-tf-demo-pg"
DEMO_PORT="${DEMO_PORT:-3100}"
PID_FILE="$DEMO_DIR/.gateway.pid"
LOG_FILE="$DEMO_DIR/.gateway.log"

cmd="${1:-help}"

running_pid() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null && cat "$PID_FILE"
}

case "$cmd" in
  start)
    if running_pid >/dev/null; then
      echo "Gateway already running on 127.0.0.1:$DEMO_PORT (pid $(cat "$PID_FILE"))"
      exit 0
    fi
    cd "$REPO_DIR"
    DEMO_PORT="$DEMO_PORT" nohup node demo/server.mjs > "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    sleep 2
    if running_pid >/dev/null; then
      echo "Gateway started (pid $(cat "$PID_FILE")). Watch logs: tail -f $LOG_FILE"
      echo "Dashboard: http://127.0.0.1:$DEMO_PORT/dashboard"
    else
      echo "Gateway failed to start. Last 40 log lines:"
      tail -40 "$LOG_FILE"
      exit 1
    fi
    ;;
  stop)
    pid="$(running_pid || true)"
    if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; rm -f "$PID_FILE"; echo "Gateway pid $pid stopped."; fi
    if docker ps -a --format '{{.Names}}' | grep -q "^${PG_NAME}$"; then
      docker rm -f "$PG_NAME" >/dev/null; echo "Postgres container $PG_NAME removed."
    fi
    ;;
  restart)
    "$0" stop
    sleep 1
    "$0" start
    ;;
  status)
    if pid="$(running_pid)"; then
      echo "Gateway: running (pid $pid) on http://127.0.0.1:$DEMO_PORT"
    else
      echo "Gateway: stopped"
    fi
    docker ps -a --filter "name=^${PG_NAME}$" --format "Postgres : {{.Status}} ({{.Image}})" | head -1 || true
    ;;
  logs)
    tail -f "$LOG_FILE"
    ;;
  seed)
    cd "$REPO_DIR" && node demo/seed.mjs
    ;;
  smoke)
    cd "$REPO_DIR" && node demo/smoke.mjs
    ;;
  reset-data)
    docker exec "$PG_NAME" psql -U neondb_owner -d neondb -c \
      "TRUNCATE trade_fair.lead_group_audit, trade_fair.lead_group_members, trade_fair.lead_groups RESTART IDENTITY CASCADE;"
    echo "CRM groups + audit truncated. Synthetic leads retained."
    ;;
  help|*)
    cat <<USAGE
WBS Messe Hub local demo
Usage: ./demo.sh <command>

  start        Start PG16 (if needed) + Gateway on http://127.0.0.1:$DEMO_PORT
  stop         Stop Gateway and remove the PG container
  restart      stop + start
  status       Show Gateway + Postgres status
  logs         Tail Gateway log
  seed         (Re-)apply schema and synthetic leads
  smoke        Run end-to-end API smoke (Merge/Split/Extract/Ignore/Revert/AI)
  reset-data   Truncate CRM groups/audit (keep leads) — fresh demo state
USAGE
    ;;
esac
