#!/usr/bin/env bash
# RC3.3 import operator script for a single canonical workflow (WF-07 or WF-08).
#
# Imports a committed canonical workflow JSON into n8n via /rest/workflows,
# rebinding node credentials to Owner-chosen production credential IDs
# IN MEMORY ONLY. The committed JSON on disk is never modified. New
# workflow is created with active=false; activation is a separate step
# (see activate_wf.sh). This script performs exactly these writes:
#   • POST /rest/login            — open session cookie
#   • POST /rest/workflows        — create the workflow (active=false)
# and no other writes. GETs are limited to re-reading the created
# workflow for verification. No activation. No settings PATCH.
#
# Usage (Owner-side, with secrets provided in the environment only):
#   N8N_BASE_URL=http://127.0.0.1:5678 \
#   N8N_LOGIN_EMAIL=<owner-email> N8N_LOGIN_PASSWORD='<owner-password>' \
#   HEADER_AUTH_CRED_ID=tjqSy2V0odocljw6 \
#   OPENAI_CRED_ID=<newly-created-openAiApi-cred-id> \
#   PG_AI_CTX_CRED_ID=<newly-created-postgres-cred-id> \
#     ops/n8n/import_wf_rc3.sh workflows/wf-08-messe-hub-ai-ask.adapted.json
#
# Prints the created workflow id to stdout. Exits nonzero on any error.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <canonical-workflow-json-path>" >&2
  exit 2
fi
SRC="$1"
test -r "$SRC" || { echo "FAIL — canonical JSON not readable: $SRC" >&2; exit 2; }

: "${N8N_BASE_URL:?N8N_BASE_URL required}"
: "${N8N_LOGIN_EMAIL:?N8N_LOGIN_EMAIL required}"
: "${N8N_LOGIN_PASSWORD:?N8N_LOGIN_PASSWORD required}"
: "${HEADER_AUTH_CRED_ID:?HEADER_AUTH_CRED_ID required (reuse tjqSy2V0odocljw6)}"
: "${OPENAI_CRED_ID:?OPENAI_CRED_ID required (openAiApi credential id)}"
: "${PG_AI_CTX_CRED_ID:?PG_AI_CTX_CRED_ID required (postgres credential id for AI context login role)}"

command -v jq >/dev/null || { echo "FAIL — jq required" >&2; exit 2; }
command -v curl >/dev/null || { echo "FAIL — curl required" >&2; exit 2; }

BASE="${N8N_BASE_URL%/}"
CJ=$(mktemp -t rc33cookie-XXXXXXXX)
trap 'rm -f "$CJ"' EXIT

# --- login (the only write apart from POST /rest/workflows below)
http_login=$(curl -sS -o /dev/null -w '%{http_code}' -c "$CJ" \
  -X POST "$BASE/rest/login" \
  -H 'Content-Type: application/json' \
  --data-binary "$(jq -nc --arg e "$N8N_LOGIN_EMAIL" --arg p "$N8N_LOGIN_PASSWORD" '{emailOrLdapLoginId:$e,password:$p}')")
[[ "$http_login" == "200" ]] || { echo "FAIL — /rest/login HTTP $http_login" >&2; exit 1; }

# --- rebind credentials IN MEMORY, assign webhookId when absent, force active=false
UUID() { python3 -c 'import uuid; print(str(uuid.uuid4()))' 2>/dev/null \
         || od -An -N16 -tx1 /dev/urandom | tr -d ' \n' | sed -E 's/(.{8})(.{4})(.{4})(.{4})(.{12})/\1-\2-\3-\4-\5/'; }
NEW_WEBHOOK=$(UUID)

PAYLOAD=$(jq --arg hdr "$HEADER_AUTH_CRED_ID" \
             --arg oai "$OPENAI_CRED_ID" \
             --arg pg "$PG_AI_CTX_CRED_ID" \
             --arg wh "$NEW_WEBHOOK" '
  .active = false
  | .pinData = {}
  | .staticData = null
  | .nodes |= (map(
      if .credentials.httpHeaderAuth then .credentials.httpHeaderAuth = {id:$hdr, name:"httpHeaderAuth"} else . end
      | if .credentials.openAiApi    then .credentials.openAiApi    = {id:$oai, name:"openAiApi"}    else . end
      | if .credentials.postgres     then .credentials.postgres     = {id:$pg,  name:"postgres"}     else . end
      | if (.type == "n8n-nodes-base.webhook") and ((.webhookId // "") == "")
          then .webhookId = $wh else . end
    ))
' "$SRC")

# --- create (active=false). This is the second and final write.
RESP=$(curl -sS -w '\n%{http_code}' -b "$CJ" -c "$CJ" \
  -X POST "$BASE/rest/workflows" \
  -H 'Content-Type: application/json' \
  --data-binary "$PAYLOAD")
HTTP_CODE=$(printf '%s\n' "$RESP" | tail -n1)
BODY=$(printf '%s\n' "$RESP" | sed '$d')
if [[ "$HTTP_CODE" != "200" && "$HTTP_CODE" != "201" ]]; then
  echo "FAIL — POST /rest/workflows HTTP $HTTP_CODE" >&2
  echo "$BODY" >&2
  exit 1
fi

NEW_ID=$(printf '%s' "$BODY" | jq -r '.data.id // .id // ""')
[[ -n "$NEW_ID" ]] || { echo "FAIL — response did not contain workflow id" >&2; exit 1; }

# --- read-only verification: re-GET and confirm active=false
CHECK=$(curl -sS -b "$CJ" "$BASE/rest/workflows/$NEW_ID" | jq -r '(.data // .).active')
[[ "$CHECK" == "false" ]] || { echo "FAIL — imported workflow has active=$CHECK (expected false)" >&2; exit 1; }

printf '%s\n' "$NEW_ID"
