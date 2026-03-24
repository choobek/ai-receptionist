#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_CONFIG_PATH="$ROOT_DIR/configs/vapi/assistant.v2.json"
# shellcheck source=./lib/env-context.sh
. "$ROOT_DIR/scripts/lib/env-context.sh"
PRESET_CONFIG_PATH="${VAPI_ASSISTANT_CONFIG_PATH:-}"
PRESET_API_BASE_URL="${VAPI_API_BASE_URL:-}"
PRESET_API_KEY="${VAPI_API_KEY:-}"
PRESET_WEBHOOK_SECRET="${AI_RECEPTIONIST_WEBHOOK_SECRET:-}"
PRESET_ASSISTANT_ID="${VAPI_ASSISTANT_ID:-}"
TARGET_ARG="${1:-}"
TEMP_CONFIG_PATH=""

load_root_env

API_BASE_URL="${PRESET_API_BASE_URL:-${VAPI_API_BASE_URL:-https://api.vapi.ai}}"

if [ -z "$TARGET_ARG" ] || [ "$TARGET_ARG" = "staging" ] || [ "$TARGET_ARG" = "production" ]; then
  ENVIRONMENT="$(normalize_deploy_environment "${TARGET_ARG:-production}")"
  TEMP_CONFIG_PATH="$(mktemp)"
  CONFIG_PATH="$TEMP_CONFIG_PATH"
  API_KEY="${PRESET_API_KEY:-$(get_context_value "$ENVIRONMENT" "VAPI_API_KEY" "VAPI_API_KEY")}"
  WEBHOOK_SECRET="$(get_context_value "$ENVIRONMENT" "AI_RECEPTIONIST_WEBHOOK_SECRET")"
  if [ "$ENVIRONMENT" = "production" ] && [ -z "$WEBHOOK_SECRET" ]; then
    WEBHOOK_SECRET="${PRESET_WEBHOOK_SECRET:-${AI_RECEPTIONIST_WEBHOOK_SECRET:-}}"
  fi
  "$ROOT_DIR/scripts/render-vapi-assistant-config.sh" "$ENVIRONMENT" "$CONFIG_PATH"
else
  CONFIG_PATH="${TARGET_ARG:-${PRESET_CONFIG_PATH:-${VAPI_ASSISTANT_CONFIG_PATH:-$DEFAULT_CONFIG_PATH}}}"
  API_KEY="${PRESET_API_KEY:-${VAPI_API_KEY:-}}"
  WEBHOOK_SECRET="${PRESET_WEBHOOK_SECRET:-${AI_RECEPTIONIST_WEBHOOK_SECRET:-}}"
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required" >&2
  exit 1
fi

if [ -z "$API_KEY" ]; then
  echo "VAPI_API_KEY is required" >&2
  exit 1
fi

if [ -z "$WEBHOOK_SECRET" ]; then
  echo "AI_RECEPTIONIST_WEBHOOK_SECRET is required" >&2
  exit 1
fi

if [ ! -f "$CONFIG_PATH" ]; then
  echo "Config file not found: $CONFIG_PATH" >&2
  exit 1
fi

ASSISTANT_ID="$(
  jq -r '.assistantId // empty' "$CONFIG_PATH"
)"

if [ -z "$ASSISTANT_ID" ]; then
  ASSISTANT_ID="${PRESET_ASSISTANT_ID:-${VAPI_ASSISTANT_ID:-}}"
fi

if [ -z "$ASSISTANT_ID" ]; then
  echo "Assistant ID is required in the config file or via VAPI_ASSISTANT_ID" >&2
  exit 1
fi

mapfile -t TOOL_IDS < <(jq -r '.assistant.model.toolIds[]?' "$CONFIG_PATH")

if [ "${#TOOL_IDS[@]}" -eq 0 ]; then
  echo "No tool IDs found in $CONFIG_PATH" >&2
  exit 1
fi

tmp_response="$(mktemp)"
cleanup() {
  rm -f "$tmp_response" "$TEMP_CONFIG_PATH"
}
trap cleanup EXIT

patch_server_url() {
  local resource_type="$1"
  local resource_id="$2"
  local get_url="$API_BASE_URL/$resource_type/$resource_id"

  local current
  current="$(curl -sS -H "Authorization: Bearer $API_KEY" "$get_url")"

  local payload
  payload="$(
    RESOURCE_JSON="$current" python3 - "$WEBHOOK_SECRET" <<'PY'
import json
import os
import sys
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

resource = json.loads(os.environ["RESOURCE_JSON"])
secret = sys.argv[1]
server = resource.get("server")
if not isinstance(server, dict):
    raise SystemExit("server object is missing")
url = server.get("url")
if not isinstance(url, str) or not url:
    raise SystemExit("server.url is missing")
split = urlsplit(url)
query = dict(parse_qsl(split.query, keep_blank_values=True))
query["secret"] = secret
server["url"] = urlunsplit(
    (split.scheme, split.netloc, split.path, urlencode(query), split.fragment)
)
print(json.dumps({"server": server}, ensure_ascii=True, separators=(",", ":")))
PY
  )"

  local http_status
  http_status="$(
    curl -sS \
      -o "$tmp_response" \
      -w '%{http_code}' \
      -X PATCH "$get_url" \
      -H "Authorization: Bearer $API_KEY" \
      -H "Content-Type: application/json" \
      -d "$payload"
  )"

  if [ "$http_status" -lt 200 ] || [ "$http_status" -ge 300 ]; then
    echo "Failed to update $resource_type/$resource_id with HTTP $http_status" >&2
    cat "$tmp_response" >&2
    exit 1
  fi

  RESPONSE_JSON="$(cat "$tmp_response")" python3 - <<'PY'
import json
import os
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

response = json.loads(os.environ["RESPONSE_JSON"])
server = response.get("server") or {}
url = server.get("url")
if isinstance(url, str) and url:
    split = urlsplit(url)
    query = dict(parse_qsl(split.query, keep_blank_values=True))
    if "secret" in query:
        query["secret"] = "***"
    masked_url = urlunsplit(
        (split.scheme, split.netloc, split.path, urlencode(query), split.fragment)
    )
else:
    masked_url = "n/a"

print(f"{response.get('id')} {masked_url}")
PY
}

echo "Updating assistant server URL secret..."
patch_server_url "assistant" "$ASSISTANT_ID"

echo "Updating tool server URL secrets..."
for tool_id in "${TOOL_IDS[@]}"; do
  patch_server_url "tool" "$tool_id"
done
