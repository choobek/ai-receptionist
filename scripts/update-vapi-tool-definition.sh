#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=./lib/env-context.sh
. "$ROOT_DIR/scripts/lib/env-context.sh"

ENVIRONMENT="$(normalize_deploy_environment "${1:-production}")"
TOOL_NAME="${2:-}"

if [ -z "$TOOL_NAME" ]; then
  echo "Usage: $0 <staging|production> <tool-name>" >&2
  exit 1
fi

load_root_env

API_BASE_URL="${VAPI_API_BASE_URL:-https://api.vapi.ai}"
API_KEY="$(get_context_value "$ENVIRONMENT" "VAPI_API_KEY" "VAPI_API_KEY")"
BINDINGS_PATH="$ROOT_DIR/configs/vapi/environments/$ENVIRONMENT.json"
TOOL_DEFINITIONS_PATH="$ROOT_DIR/configs/vapi/tool-definitions.v1.json"
RENDERED_CONFIG_FILE=""
DEFAULT_MESSAGES_JSON='[
  {
    "type": "request-start",
    "blocking": false
  }
]'
MESSAGES_JSON="$DEFAULT_MESSAGES_JSON"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required" >&2
  exit 1
fi

if [ -z "$API_KEY" ]; then
  echo "VAPI_API_KEY is required for $ENVIRONMENT" >&2
  exit 1
fi

if [ ! -f "$BINDINGS_PATH" ]; then
  echo "Bindings file not found: $BINDINGS_PATH" >&2
  exit 1
fi

RENDERED_CONFIG_FILE="$(mktemp)"
"$ROOT_DIR/scripts/render-vapi-assistant-config.sh" "$ENVIRONMENT" "$RENDERED_CONFIG_FILE"

if [ ! -f "$TOOL_DEFINITIONS_PATH" ]; then
  echo "Tool definitions file not found: $TOOL_DEFINITIONS_PATH" >&2
  exit 1
fi

TOOL_CONFIG_JSON="$(
  jq -cer --arg tool_name "$TOOL_NAME" '.tools[$tool_name] // empty' "$TOOL_DEFINITIONS_PATH"
)" || {
  echo "Unsupported tool definition sync target: $TOOL_NAME" >&2
  exit 1
}

TOOL_DESCRIPTION="$(jq -er '.description' <<<"$TOOL_CONFIG_JSON")"
SCHEMA_PATH="$ROOT_DIR/$(jq -er '.schemaPath' <<<"$TOOL_CONFIG_JSON")"
MESSAGES_JSON="$(
  jq -c '.messages // [{"type":"request-start","blocking":false}]' <<<"$TOOL_CONFIG_JSON"
)"
PARAMETERS_JSON="$(
  jq -c '.parameters // []' <<<"$TOOL_CONFIG_JSON"
)"
VARIABLE_EXTRACTION_PLAN_JSON="$(
  jq -c '.variableExtractionPlan // null' <<<"$TOOL_CONFIG_JSON"
)"

if [ ! -f "$SCHEMA_PATH" ]; then
  echo "Schema file not found: $SCHEMA_PATH" >&2
  exit 1
fi

TOOL_ID="$(
  jq -r --arg tool_name "$TOOL_NAME" '.toolIds[$tool_name] // empty' "$BINDINGS_PATH"
)"

if [ -z "$TOOL_ID" ]; then
  case "$TOOL_NAME" in
    sendSmsToReceptionists|sendSmsToPatient)
      echo "Skipping $TOOL_NAME definition sync because toolIds.$TOOL_NAME is not set in $BINDINGS_PATH" >&2
      exit 0
      ;;
    *)
      echo "toolIds.$TOOL_NAME is required in $BINDINGS_PATH" >&2
      exit 1
      ;;
  esac
fi

SCHEMA_JSON="$(
  jq -c 'del(."$schema", .title, .examples)' "$SCHEMA_PATH"
)"

EXPECTED_SERVER_URL="$(
  jq -r --arg tool_name "$TOOL_NAME" '
    .toolBindings[]
    | select(.name == $tool_name)
    | .serverUrl // empty
  ' "$RENDERED_CONFIG_FILE"
)"

CURRENT_TOOL_FILE=""
SERVER_JSON=""
if [ -n "$EXPECTED_SERVER_URL" ]; then
  SERVER_JSON="$(jq -cn --arg expected_url "$EXPECTED_SERVER_URL" '{url: $expected_url}')"
else
  CURRENT_TOOL_FILE="$(mktemp)"
  CURRENT_TOOL_STATUS="$(
    curl -sS \
      -o "$CURRENT_TOOL_FILE" \
      -w '%{http_code}' \
      "$API_BASE_URL/tool/$TOOL_ID" \
      -H "Authorization: Bearer $API_KEY"
  )"

  if [ "$CURRENT_TOOL_STATUS" -lt 200 ] || [ "$CURRENT_TOOL_STATUS" -ge 300 ]; then
    echo "Failed to fetch current tool state for $TOOL_NAME ($TOOL_ID) with HTTP $CURRENT_TOOL_STATUS" >&2
    cat "$CURRENT_TOOL_FILE" >&2
    rm -f "$CURRENT_TOOL_FILE"
    exit 1
  fi

  SERVER_JSON="$(
    jq -c '
      if (.server | type) == "object" and (.server | length) > 0 then
        .server
      else
        null
      end
    ' "$CURRENT_TOOL_FILE"
  )"
fi

PAYLOAD="$(
  jq -cn \
    --arg tool_name "$TOOL_NAME" \
    --arg tool_description "$TOOL_DESCRIPTION" \
    --argjson schema "$SCHEMA_JSON" \
    --argjson messages "$MESSAGES_JSON" \
    --argjson parameters "$PARAMETERS_JSON" \
    --argjson variable_extraction_plan "$VARIABLE_EXTRACTION_PLAN_JSON" \
    --argjson server "$SERVER_JSON" \
    '{
      function: {
        name: $tool_name,
        description: $tool_description,
        parameters: $schema
      },
      messages: $messages
    }
    | if ($parameters | length) > 0 then .parameters = $parameters else . end
    | if $variable_extraction_plan != null then .variableExtractionPlan = $variable_extraction_plan else . end
    | if $server != null then .server = $server else . end'
)"

RESPONSE_BODY_FILE="$(mktemp)"
RESPONSE_HEADERS_FILE="$(mktemp)"
cleanup() {
  rm -f "$CURRENT_TOOL_FILE" "$RESPONSE_BODY_FILE" "$RESPONSE_HEADERS_FILE" "$RENDERED_CONFIG_FILE"
}
trap cleanup EXIT

is_retryable_http_status() {
  case "$1" in
    429|500|502|503|504)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

extract_retry_after_seconds() {
  awk '
    BEGIN { IGNORECASE = 1 }
    /^Retry-After:/ {
      gsub("\r", "", $2)
      if ($2 ~ /^[0-9]+$/) {
        print $2
      }
      exit
    }
  ' "$RESPONSE_HEADERS_FILE"
}

patch_tool_definition_with_retry() {
  local max_attempts="${VAPI_TOOL_DEFINITION_MAX_ATTEMPTS:-5}"
  local attempt=1
  local http_status=""

  while true; do
    : >"$RESPONSE_HEADERS_FILE"
    : >"$RESPONSE_BODY_FILE"
    http_status="$(
      curl -sS \
        -D "$RESPONSE_HEADERS_FILE" \
        -o "$RESPONSE_BODY_FILE" \
        -w '%{http_code}' \
        -X PATCH "$API_BASE_URL/tool/$TOOL_ID" \
        -H "Authorization: Bearer $API_KEY" \
        -H "Content-Type: application/json" \
        -d "$PAYLOAD"
    )"

    if [ "$http_status" -ge 200 ] && [ "$http_status" -lt 300 ]; then
      printf '%s' "$http_status"
      return 0
    fi

    if ! is_retryable_http_status "$http_status" || [ "$attempt" -ge "$max_attempts" ]; then
      printf '%s' "$http_status"
      return 1
    fi

    retry_after_seconds="$(extract_retry_after_seconds)"
    if [ -z "$retry_after_seconds" ]; then
      retry_after_seconds=$(( attempt * 2 ))
    fi

    printf \
      'Retrying tool definition update for %s (%s) after HTTP %s; waiting %ss (attempt %s/%s)\n' \
      "$TOOL_NAME" \
      "$TOOL_ID" \
      "$http_status" \
      "$retry_after_seconds" \
      "$attempt" \
      "$max_attempts" >&2
    sleep "$retry_after_seconds"
    attempt=$(( attempt + 1 ))
  done
}

HTTP_STATUS="$(patch_tool_definition_with_retry)" || true

if [ "$HTTP_STATUS" -lt 200 ] || [ "$HTTP_STATUS" -ge 300 ]; then
  echo "Tool definition update failed for $TOOL_NAME ($TOOL_ID) with HTTP $HTTP_STATUS" >&2
  cat "$RESPONSE_BODY_FILE" >&2
  exit 1
fi

printf 'Tool definition updated: %s (%s)\n' "$TOOL_NAME" "$TOOL_ID"
