#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=./lib/env-context.sh
. "$ROOT_DIR/scripts/lib/env-context.sh"

ENVIRONMENT="$(normalize_deploy_environment "${1:-production}")"
PRESET_API_BASE_URL="${VAPI_API_BASE_URL:-}"
PRESET_API_KEY="${VAPI_API_KEY:-}"
API_BASE_URL=""
API_KEY=""

load_root_env

API_BASE_URL="${PRESET_API_BASE_URL:-${VAPI_API_BASE_URL:-https://api.vapi.ai}}"
API_KEY="${PRESET_API_KEY:-$(get_context_value "$ENVIRONMENT" "VAPI_API_KEY" "VAPI_API_KEY")}"

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

rendered_config_file="$(mktemp)"
response_body_file="$(mktemp)"
cleanup() {
  rm -f "$rendered_config_file" "$response_body_file"
}
trap cleanup EXIT

"$ROOT_DIR/scripts/render-vapi-assistant-config.sh" "$ENVIRONMENT" "$rendered_config_file"

mask_url() {
  python3 - "$1" <<'PY'
import sys
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

url = sys.argv[1]
split = urlsplit(url)
query = dict(parse_qsl(split.query, keep_blank_values=True))
if "secret" in query:
    query["secret"] = "***"
print(urlunsplit((split.scheme, split.netloc, split.path, urlencode(query), split.fragment)))
PY
}

while IFS=$'\t' read -r tool_name tool_id server_url; do
  [ -n "$tool_id" ] || continue

  payload="$(
    jq -cn \
      --arg url "$server_url" \
      '{server: {url: $url}}'
  )"

  http_status="$(
    curl -sS \
      -o "$response_body_file" \
      -w '%{http_code}' \
      -X PATCH "$API_BASE_URL/tool/$tool_id" \
      -H "Authorization: Bearer $API_KEY" \
      -H "Content-Type: application/json" \
      -d "$payload"
  )"

  if [ "$http_status" -lt 200 ] || [ "$http_status" -ge 300 ]; then
    echo "Tool update failed for $tool_name ($tool_id) with HTTP $http_status" >&2
    cat "$response_body_file" >&2
    exit 1
  fi

  printf 'Tool updated: %s (%s)\n' "$tool_name" "$tool_id"
  printf 'Server URL: %s\n' "$(mask_url "$server_url")"
done < <(
  jq -r '
    .toolBindings[]
    | [.name, .id, .serverUrl]
    | @tsv
  ' "$rendered_config_file"
)
