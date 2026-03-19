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
RENDERED_CONFIG_FILE=""

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

case "$TOOL_NAME" in
  checkAvailability)
    TOOL_DESCRIPTION="Check real appointment availability for the dental clinic and return up to a few valid slots. The clinic books visits only Monday-Friday between 09:00 and 21:00 in Europe/Warsaw. Use this only when the visit type is known and you already know either a preferred date, a preferred time window, or that the caller wants the first available appointment. Use only these service.id values: consultation, urgent_consultation, implant_consultation, orthodontic_consultation, aesthetic_consultation, hygiene. For first-time patients or when unsure about the exact procedure, use service.id = consultation. Always use timezone = Europe/Warsaw. Use timePreference = specific_time when the caller gave an exact hour, morning/afternoon/evening for broad preferences, and first_available for the nearest available term. If the caller gives no time-of-day preference, the backend may prioritize one earlier and one later slot and prefers options adjacent to existing bookings when possible. If the caller asks for the nearest available appointment and gives no date, requestedDate may be omitted."
    SCHEMA_PATH="$ROOT_DIR/schemas/checkAvailability.vapi.request.json"
    ;;
  createEvent)
    TOOL_DESCRIPTION="Use this tool to create a booking only after the caller chose one specific slot and confirmed the final summary. The clinic books visits only Monday-Friday between 09:00 and 21:00 in Europe/Warsaw. Required details include service, slotStart, slotEnd, timezone, patient full name, and patient phone number. When the slot came from checkAvailability, copy slotStart and slotEnd exactly from that selected slot. Do not compute slotEnd from duration, label, or default service length. Never say the appointment is booked until this tool returns success."
    SCHEMA_PATH="$ROOT_DIR/schemas/createEvent.vapi.request.json"
    ;;
  *)
    echo "Unsupported tool definition sync target: $TOOL_NAME" >&2
    exit 1
    ;;
esac

if [ ! -f "$SCHEMA_PATH" ]; then
  echo "Schema file not found: $SCHEMA_PATH" >&2
  exit 1
fi

TOOL_ID="$(
  jq -r --arg tool_name "$TOOL_NAME" '.toolIds[$tool_name] // empty' "$BINDINGS_PATH"
)"

if [ -z "$TOOL_ID" ]; then
  echo "toolIds.$TOOL_NAME is required in $BINDINGS_PATH" >&2
  exit 1
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
  jq -c --arg expected_url "$EXPECTED_SERVER_URL" '
    if (.server | type) == "object" and (.server | length) > 0 then
      .server
    elif ($expected_url | length) > 0 then
      {url: $expected_url}
    else
      null
    end
  ' "$CURRENT_TOOL_FILE"
)"

PAYLOAD="$(
  jq -cn \
    --arg tool_name "$TOOL_NAME" \
    --arg tool_description "$TOOL_DESCRIPTION" \
    --argjson schema "$SCHEMA_JSON" \
    --argjson server "$SERVER_JSON" \
    '{
      function: {
        name: $tool_name,
        description: $tool_description,
        parameters: $schema
      }
    }
    | if $server != null then .server = $server else . end'
)"

RESPONSE_BODY_FILE="$(mktemp)"
cleanup() {
  rm -f "$CURRENT_TOOL_FILE" "$RESPONSE_BODY_FILE" "$RENDERED_CONFIG_FILE"
}
trap cleanup EXIT

HTTP_STATUS="$(
  curl -sS \
    -o "$RESPONSE_BODY_FILE" \
    -w '%{http_code}' \
    -X PATCH "$API_BASE_URL/tool/$TOOL_ID" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD"
)"

if [ "$HTTP_STATUS" -lt 200 ] || [ "$HTTP_STATUS" -ge 300 ]; then
  echo "Tool definition update failed for $TOOL_NAME ($TOOL_ID) with HTTP $HTTP_STATUS" >&2
  cat "$RESPONSE_BODY_FILE" >&2
  exit 1
fi

printf 'Tool definition updated: %s (%s)\n' "$TOOL_NAME" "$TOOL_ID"
