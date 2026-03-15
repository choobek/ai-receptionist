#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_CONFIG_PATH="$ROOT_DIR/configs/vapi/assistant.v1.json"

for env_file in "$ROOT_DIR/.env" "$ROOT_DIR/.env.local"; do
  if [ -f "$env_file" ]; then
    set -a
    # shellcheck source=/dev/null
    . "$env_file"
    set +a
  fi
done

CONFIG_PATH="${1:-${VAPI_ASSISTANT_CONFIG_PATH:-$DEFAULT_CONFIG_PATH}}"
API_BASE_URL="${VAPI_API_BASE_URL:-https://api.vapi.ai}"
API_KEY="${VAPI_API_KEY:-}"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required" >&2
  exit 1
fi

if [ -z "$API_KEY" ]; then
  echo "VAPI_API_KEY is required" >&2
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
  ASSISTANT_ID="${VAPI_ASSISTANT_ID:-}"
fi

if [ -z "$ASSISTANT_ID" ]; then
  echo "Assistant ID is required in the config file or via VAPI_ASSISTANT_ID" >&2
  exit 1
fi

PAYLOAD="$(
  jq -c '.assistant' "$CONFIG_PATH"
)"

if [ -z "$PAYLOAD" ] || [ "$PAYLOAD" = "null" ]; then
  echo "Config file must contain an .assistant object" >&2
  exit 1
fi

RESPONSE_BODY_FILE="$(mktemp)"
cleanup() {
  rm -f "$RESPONSE_BODY_FILE"
}
trap cleanup EXIT

HTTP_STATUS="$(
  curl -sS \
    -o "$RESPONSE_BODY_FILE" \
    -w '%{http_code}' \
    -X PATCH "$API_BASE_URL/assistant/$ASSISTANT_ID" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD"
)"

UPDATED_ASSISTANT="$(cat "$RESPONSE_BODY_FILE")"

if [ "$HTTP_STATUS" -lt 200 ] || [ "$HTTP_STATUS" -ge 300 ]; then
  echo "Assistant update failed with HTTP $HTTP_STATUS" >&2
  printf '%s\n' "$UPDATED_ASSISTANT" >&2
  exit 1
fi

printf 'Assistant updated: %s\n' "$(printf '%s' "$UPDATED_ASSISTANT" | jq -r '.id')"
printf 'Name: %s\n' "$(printf '%s' "$UPDATED_ASSISTANT" | jq -r '.name')"
printf 'Model: %s\n' "$(printf '%s' "$UPDATED_ASSISTANT" | jq -r '.model.model')"
printf 'Temperature: %s\n' "$(printf '%s' "$UPDATED_ASSISTANT" | jq -r '.model.temperature')"
printf 'Transcriber: %s\n' "$(printf '%s' "$UPDATED_ASSISTANT" | jq -r '.transcriber.model')"
printf 'Updated at: %s\n' "$(printf '%s' "$UPDATED_ASSISTANT" | jq -r '.updatedAt // "n/a"')"
