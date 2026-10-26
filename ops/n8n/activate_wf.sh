#!/usr/bin/env bash
# RC3.3 activate operator script for a single workflow id (WF-07 or WF-08).
#
# Reads current versionId via GET, then POSTs to /rest/workflows/<id>/activate
# with that exact versionId. Writes performed:
#   • POST /rest/login
#   • POST /rest/workflows/<id>/activate
# Final GET confirms active=true and versionId==activeVersionId.
# No PATCH, no deactivate, no settings mutation.
#
# Usage:
#   N8N_BASE_URL=http://127.0.0.1:5678 \
#   N8N_LOGIN_EMAIL=<owner-email> N8N_LOGIN_PASSWORD='<owner-password>' \
#   WORKFLOW_ID=<id-from-import_wf_rc3.sh> \
#     ops/n8n/activate_wf.sh
set -euo pipefail

: "${N8N_BASE_URL:?N8N_BASE_URL required}"
: "${N8N_LOGIN_EMAIL:?N8N_LOGIN_EMAIL required}"
: "${N8N_LOGIN_PASSWORD:?N8N_LOGIN_PASSWORD required}"
: "${WORKFLOW_ID:?WORKFLOW_ID required}"

command -v jq >/dev/null || { echo "FAIL — jq required" >&2; exit 2; }
command -v curl >/dev/null || { echo "FAIL — curl required" >&2; exit 2; }

BASE="${N8N_BASE_URL%/}"
CJ=$(mktemp -t rc33actcookie-XXXXXXXX)
trap 'rm -f "$CJ"' EXIT

http_login=$(curl -sS -o /dev/null -w '%{http_code}' -c "$CJ" \
  -X POST "$BASE/rest/login" \
  -H 'Content-Type: application/json' \
  --data-binary "$(jq -nc --arg e "$N8N_LOGIN_EMAIL" --arg p "$N8N_LOGIN_PASSWORD" '{emailOrLdapLoginId:$e,password:$p}')")
[[ "$http_login" == "200" ]] || { echo "FAIL — /rest/login HTTP $http_login" >&2; exit 1; }

WF_JSON=$(curl -sS -b "$CJ" "$BASE/rest/workflows/$WORKFLOW_ID")
VERSION_ID=$(printf '%s' "$WF_JSON" | jq -r '(.data // .).versionId // ""')
WAS_ACTIVE=$(printf '%s' "$WF_JSON" | jq -r '(.data // .).active // false')
[[ -n "$VERSION_ID" ]] || { echo "FAIL — workflow $WORKFLOW_ID has no versionId" >&2; exit 1; }
if [[ "$WAS_ACTIVE" == "true" ]]; then
  echo "FAIL — workflow $WORKFLOW_ID is already active; refusing to re-activate" >&2
  exit 1
fi

RESP=$(curl -sS -w '\n%{http_code}' -b "$CJ" -c "$CJ" \
  -X POST "$BASE/rest/workflows/$WORKFLOW_ID/activate" \
  -H 'Content-Type: application/json' \
  --data-binary "$(jq -nc --arg v "$VERSION_ID" '{versionId:$v}')")
HTTP_CODE=$(printf '%s\n' "$RESP" | tail -n1)
BODY=$(printf '%s\n' "$RESP" | sed '$d')
if [[ "$HTTP_CODE" != "200" && "$HTTP_CODE" != "204" ]]; then
  echo "FAIL — /rest/workflows/$WORKFLOW_ID/activate HTTP $HTTP_CODE" >&2
  echo "$BODY" >&2
  exit 1
fi

POST=$(curl -sS -b "$CJ" "$BASE/rest/workflows/$WORKFLOW_ID")
ACTIVE=$(printf '%s' "$POST" | jq -r '(.data // .).active')
V_NEW=$(printf '%s' "$POST" | jq -r '(.data // .).versionId')
AV=$(printf '%s' "$POST" | jq -r '(.data // .).activeVersionId')
if [[ "$ACTIVE" != "true" || "$V_NEW" != "$AV" || -z "$AV" ]]; then
  echo "FAIL — post-activate state: active=$ACTIVE versionId=$V_NEW activeVersionId=$AV" >&2
  exit 1
fi

printf '{"workflowId":"%s","active":true,"versionId":"%s","activeVersionId":"%s"}\n' \
  "$WORKFLOW_ID" "$V_NEW" "$AV"
