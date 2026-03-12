#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCHEMA_PATH="${VAPI_STRUCTURED_OUTPUT_SCHEMA_PATH:-$ROOT_DIR/docs/vapi-structured-output.json}"
ASSISTANT_ID="${1:-${VAPI_ASSISTANT_ID:-}}"
API_KEY="${VAPI_API_KEY:-}"
OUTPUT_NAME="${VAPI_STRUCTURED_OUTPUT_NAME:-Dental Call Intake}"
OUTPUT_DESCRIPTION="${VAPI_STRUCTURED_OUTPUT_DESCRIPTION:-Post-call extraction for the Ipokrzyku.pl dental receptionist assistant}"
API_BASE_URL="${VAPI_API_BASE_URL:-https://api.vapi.ai}"

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

if [ -z "$ASSISTANT_ID" ]; then
  echo "Assistant ID is required as the first argument or via VAPI_ASSISTANT_ID" >&2
  exit 1
fi

if [ ! -f "$SCHEMA_PATH" ]; then
  echo "Schema file not found: $SCHEMA_PATH" >&2
  exit 1
fi

CREATE_PAYLOAD="$(
  jq -n \
    --arg name "$OUTPUT_NAME" \
    --arg description "$OUTPUT_DESCRIPTION" \
    --arg assistant_id "$ASSISTANT_ID" \
    --slurpfile schema "$SCHEMA_PATH" \
    '{
      name: $name,
      type: "ai",
      description: $description,
      assistantIds: [$assistant_id],
      schema: $schema[0]
    }'
)"

RESPONSE_BODY_FILE="$(mktemp)"
cleanup() {
  rm -f "$RESPONSE_BODY_FILE"
}
trap cleanup EXIT

HTTP_STATUS="$(
  curl -sS \
    -o "$RESPONSE_BODY_FILE" \
    -w '%{http_code}' \
    -X POST "$API_BASE_URL/structured-output" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "$CREATE_PAYLOAD"
)"

CREATED_OUTPUT="$(cat "$RESPONSE_BODY_FILE")"

if [ "$HTTP_STATUS" -lt 200 ] || [ "$HTTP_STATUS" -ge 300 ]; then
  echo "Structured output creation failed with HTTP $HTTP_STATUS" >&2
  printf '%s\n' "$CREATED_OUTPUT" >&2
  exit 1
fi

STRUCTURED_OUTPUT_ID="$(printf '%s' "$CREATED_OUTPUT" | jq -r '.id')"

if [ -z "$STRUCTURED_OUTPUT_ID" ] || [ "$STRUCTURED_OUTPUT_ID" = "null" ]; then
  echo "Failed to create structured output" >&2
  printf '%s\n' "$CREATED_OUTPUT" >&2
  exit 1
fi

printf 'Structured output created: %s\n' "$STRUCTURED_OUTPUT_ID"
printf 'Assistant linked during create: %s\n' "$ASSISTANT_ID"
