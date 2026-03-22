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
  echo "VAPI_API_KEY is required for $ENVIRONMENT" >&2
  exit 1
fi

if [ ! -f "$BINDINGS_PATH" ]; then
  echo "Bindings file not found: $BINDINGS_PATH" >&2
  exit 1
fi

case "$TOOL_NAME" in
  checkAvailability)
    TOOL_DESCRIPTION="Check real appointment availability for the dental clinic and return up to a few valid slots. The clinic books visits only Monday-Friday between 09:00 and 21:00 in Europe/Warsaw. Use this only when the visit type is known and you already know either a preferred date, a preferred time window, or that the caller wants the first available appointment. Use only these service.id values: consultation, urgent_consultation, implant_consultation, orthodontic_consultation, aesthetic_consultation, hygiene. For first-time patients or when unsure about the exact procedure, use service.id = consultation. Always use timezone = Europe/Warsaw. Use timePreference = specific_time when the caller gave an exact hour, morning/afternoon/evening for broad preferences, and first_available for the nearest available term. If the caller gives no time-of-day preference, the backend may prioritize one earlier and one later slot and prefers options adjacent to existing bookings when possible. If the caller asks for the nearest available appointment and gives no date, requestedDate may be omitted."
    SCHEMA_PATH="$ROOT_DIR/schemas/checkAvailability.vapi.request.json"
    TOOL_ENDPOINT="/webhook/ai-receptionist/check-availability"
    ;;
  createEvent)
    TOOL_DESCRIPTION="Use this tool to create a booking only after the caller chose one specific slot and confirmed the final summary. The clinic books visits only Monday-Friday between 09:00 and 21:00 in Europe/Warsaw. Required details include service, slotStart, slotEnd, timezone, language, patient full name, and patient phone number. When the slot came from checkAvailability, copy slotStart and slotEnd exactly from that selected slot. Do not compute slotEnd from duration, label, or default service length. After booking, n8n automatically attempts the booking-confirmation SMS to the live caller number from telephony metadata when available, so do not call any separate patient-SMS tool. Never say the appointment is booked until this tool returns success."
    SCHEMA_PATH="$ROOT_DIR/schemas/createEvent.vapi.request.json"
    TOOL_ENDPOINT="/webhook/ai-receptionist/create-event"
    ;;
  sendSmsToReceptionists)
    TOOL_DESCRIPTION="Use this tool only after createReceptionTask has already returned success and you have the taskId from that result. It prepares or sends an internal receptionist SMS alert based on the saved follow-up task. Do not mention the internal SMS to the caller unless they ask. If this tool fails, the saved receptionist task still exists."
    SCHEMA_PATH="$ROOT_DIR/schemas/sendSmsToReceptionists.request.json"
    TOOL_ENDPOINT="/webhook/ai-receptionist/send-sms-to-receptionists"
    ;;
  sendSmsToPatient)
    TOOL_DESCRIPTION="Use this tool only for direct/manual booking-confirmation SMS probes after createEvent has already returned success. Required details include the calendarEventId returned by createEvent, patient name and phone, appointment start/timezone, and the booked service. When live caller metadata is available, the SMS must target that caller number rather than any separately declared callback number. If this tool fails, the booking still exists."
    SCHEMA_PATH="$ROOT_DIR/schemas/sendSmsToPatient.request.json"
    TOOL_ENDPOINT="/webhook/ai-receptionist/send-sms-to-patient"
    ;;
  *)
    echo "Unsupported tool creation target: $TOOL_NAME" >&2
    exit 1
    ;;
esac

if [ ! -f "$SCHEMA_PATH" ]; then
  echo "Schema file not found: $SCHEMA_PATH" >&2
  exit 1
fi

EXISTING_TOOL_ID="$(
  jq -r --arg tool_name "$TOOL_NAME" '.toolIds[$tool_name] // empty' "$BINDINGS_PATH"
)"

if [ -n "$EXISTING_TOOL_ID" ]; then
  echo "toolIds.$TOOL_NAME is already set in $BINDINGS_PATH ($EXISTING_TOOL_ID)" >&2
  exit 1
fi

PUBLIC_BASE_URL_ENV="$(
  jq -r '.publicBaseUrlEnv // empty' "$BINDINGS_PATH"
)"

if [ -z "$PUBLIC_BASE_URL_ENV" ]; then
  echo "publicBaseUrlEnv is required in $BINDINGS_PATH" >&2
  exit 1
fi

PUBLIC_BASE_URL="${!PUBLIC_BASE_URL_ENV:-}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL%/}"
if [ -z "$PUBLIC_BASE_URL" ] && [ "$ENVIRONMENT" = "production" ] && [ -n "${N8N_DOMAIN:-}" ]; then
  PUBLIC_BASE_URL="https://${N8N_DOMAIN}"
fi
if [ -z "$PUBLIC_BASE_URL" ]; then
  echo "$PUBLIC_BASE_URL_ENV is required in the environment" >&2
  exit 1
fi

WEBHOOK_SECRET_ENV="$(
  jq -r '.webhookSecretEnv // empty' "$BINDINGS_PATH"
)"
WEBHOOK_SECRET=""
if [ -n "$WEBHOOK_SECRET_ENV" ]; then
  WEBHOOK_SECRET="${!WEBHOOK_SECRET_ENV:-}"
fi
if [ -z "$WEBHOOK_SECRET" ] && [ "$ENVIRONMENT" = "production" ]; then
  WEBHOOK_SECRET="${AI_RECEPTIONIST_WEBHOOK_SECRET:-}"
fi

SERVER_URL="$(
  python3 - "$PUBLIC_BASE_URL" "$TOOL_ENDPOINT" "$WEBHOOK_SECRET" <<'PY'
import sys
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

base_url, endpoint, secret = sys.argv[1:4]
url = f"{base_url.rstrip('/')}{endpoint}"
if secret:
    split = urlsplit(url)
    query = dict(parse_qsl(split.query, keep_blank_values=True))
    query["secret"] = secret
    url = urlunsplit((split.scheme, split.netloc, split.path, urlencode(query), split.fragment))
print(url)
PY
)"

SCHEMA_JSON="$(
  jq -c 'del(."$schema", .title, .examples)' "$SCHEMA_PATH"
)"

PAYLOAD="$(
  jq -cn \
    --arg tool_name "$TOOL_NAME" \
    --arg tool_description "$TOOL_DESCRIPTION" \
    --arg server_url "$SERVER_URL" \
    --argjson schema "$SCHEMA_JSON" \
    '{
      type: "function",
      function: {
        name: $tool_name,
        description: $tool_description,
        parameters: $schema
      },
      server: {
        url: $server_url,
        timeoutSeconds: 20
      },
      messages: [
        {
          type: "request-start",
          blocking: false
        }
      ],
      variableExtractionPlan: {
        schema: {
          type: "object",
          required: [],
          properties: {}
        }
      }
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
    -X POST "$API_BASE_URL/tool" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD"
)"

if [ "$HTTP_STATUS" -lt 200 ] || [ "$HTTP_STATUS" -ge 300 ]; then
  echo "Tool creation failed for $TOOL_NAME with HTTP $HTTP_STATUS" >&2
  cat "$RESPONSE_BODY_FILE" >&2
  exit 1
fi

NEW_TOOL_ID="$(
  jq -r '.id // empty' "$RESPONSE_BODY_FILE"
)"

if [ -z "$NEW_TOOL_ID" ]; then
  echo "Created tool response did not include an id" >&2
  cat "$RESPONSE_BODY_FILE" >&2
  exit 1
fi

python3 - "$BINDINGS_PATH" "$TOOL_NAME" "$NEW_TOOL_ID" <<'PY'
import json
import sys

bindings_path, tool_name, tool_id = sys.argv[1:4]

with open(bindings_path, "r", encoding="utf-8") as handle:
    data = json.load(handle)

tool_ids = data.setdefault("toolIds", {})
tool_ids[tool_name] = tool_id

with open(bindings_path, "w", encoding="utf-8") as handle:
    json.dump(data, handle, ensure_ascii=True, indent=2)
    handle.write("\n")
PY

printf 'Tool created: %s (%s)\n' "$TOOL_NAME" "$NEW_TOOL_ID"
printf 'Bindings updated: %s\n' "$BINDINGS_PATH"
