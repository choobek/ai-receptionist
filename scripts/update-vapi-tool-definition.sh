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

case "$TOOL_NAME" in
  checkAvailability)
    TOOL_DESCRIPTION="Check real appointment availability for the dental clinic and return up to a few valid slots. The clinic books visits only Monday-Friday between 09:00 and 21:00 in Europe/Warsaw. Use this only when the visit type is known and you already know either a preferred date, a preferred time window, or that the caller wants the first available appointment. Use only these service.id values: consultation, urgent_consultation, implant_consultation, orthodontic_consultation, aesthetic_consultation, hygiene. For first-time patients or when unsure about the exact procedure, use service.id = consultation. Always use timezone = Europe/Warsaw. Use timePreference = specific_time when the caller gave an exact hour, morning/afternoon/evening for broad preferences, and first_available for the nearest available term. If the caller gives no time-of-day preference, the backend may prioritize one earlier and one later slot and prefers options adjacent to existing bookings when possible. If the caller asks for the nearest available appointment and gives no date, requestedDate may be omitted."
    SCHEMA_PATH="$ROOT_DIR/schemas/checkAvailability.vapi.request.json"
    MESSAGES_JSON='[
      {
        "type": "request-start",
        "content": "Już sprawdzam dostępne terminy.",
        "blocking": false
      },
      {
        "type": "request-response-delayed",
        "content": "Jeszcze chwila, sprawdzam kalendarz.",
        "timingMilliseconds": 3000
      },
      {
        "type": "request-failed",
        "content": "Przepraszam, mam chwilowy problem ze sprawdzeniem terminów."
      }
    ]'
    ;;
  searchKnowledgeBase)
    TOOL_DESCRIPTION="Use this tool to answer general non-medical clinic questions from the local knowledge base. It currently covers consultation flow, implant types, All-on-4, veneers, and bonding. Use it for informational questions only. If it does not return a reliable answer, say so clearly and do not invent details."
    SCHEMA_PATH="$ROOT_DIR/schemas/searchKnowledgeBase.request.json"
    MESSAGES_JSON='[
      {
        "type": "request-start",
        "content": "Już sprawdzam informacje.",
        "blocking": false
      },
      {
        "type": "request-response-delayed",
        "content": "Jeszcze chwila, wyszukuję potrzebne informacje.",
        "timingMilliseconds": 3000
      },
      {
        "type": "request-failed",
        "content": "Przepraszam, mam chwilowy problem z wyszukaniem tej informacji."
      }
    ]'
    ;;
  createEvent)
    TOOL_DESCRIPTION="Use this tool to create a booking only after the caller chose one specific slot and confirmed the final summary. The clinic books visits only Monday-Friday between 09:00 and 21:00 in Europe/Warsaw. Required details include service, slotStart, slotEnd, timezone, language, patient full name, and patient phone number. If the caller confirmed using the number they are calling from, pass that exact confirmed number as patient.phoneE164 and never invent placeholder or test numbers. When the slot came from checkAvailability, copy slotStart and slotEnd exactly from that selected slot. Do not compute slotEnd from duration, label, or default service length. After booking, n8n automatically attempts the booking-confirmation SMS to the live caller number from telephony metadata when available, so do not call any separate patient-SMS tool. Never say the appointment is booked until this tool returns success."
    SCHEMA_PATH="$ROOT_DIR/schemas/createEvent.vapi.request.json"
    MESSAGES_JSON='[
      {
        "type": "request-start",
        "content": "Już zapisuję wizytę w kalendarzu.",
        "blocking": false
      },
      {
        "type": "request-response-delayed",
        "content": "Jeszcze moment, finalizuję rezerwację wizyty.",
        "timingMilliseconds": 3000
      },
      {
        "type": "request-failed",
        "content": "Przepraszam, nie udało mi się teraz zapisać wizyty."
      }
    ]'
    ;;
  createReceptionTask)
    TOOL_DESCRIPTION="Use this tool to queue a receptionist follow-up only after the caller's phone number has been repeated and confirmed. Required details include taskType, patient full name, and patient phone number. Use structured fields only: if it is operationally helpful, you may include serviceBucket or preferredCallbackWindow, but do not create free-text summary or notes fields. If the caller confirmed using the number they are calling from, pass that exact confirmed number as patient.phoneE164 and never invent placeholder or test numbers. Never say the reception team will follow up until this tool returns success."
    SCHEMA_PATH="$ROOT_DIR/schemas/createReceptionTask.request.json"
    ;;
  sendSmsToReceptionists)
    TOOL_DESCRIPTION="Use this tool only after createReceptionTask has already returned success and you have the taskId from that result. It prepares or sends an internal receptionist SMS alert based on the saved follow-up task. Do not mention the internal SMS to the caller unless they ask. If this tool fails, the saved receptionist task still exists."
    SCHEMA_PATH="$ROOT_DIR/schemas/sendSmsToReceptionists.request.json"
    ;;
  sendSmsToPatient)
    TOOL_DESCRIPTION="Use this tool only for direct/manual booking-confirmation SMS probes after createEvent has already returned success. Required details include the calendarEventId returned by createEvent, patient name and phone, appointment start/timezone, and the booked service. When live caller metadata is available, the SMS must target that caller number rather than any separately declared callback number. If this tool fails, the booking still exists."
    SCHEMA_PATH="$ROOT_DIR/schemas/sendSmsToPatient.request.json"
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
    --argjson messages "$MESSAGES_JSON" \
    --argjson server "$SERVER_JSON" \
    '{
      function: {
        name: $tool_name,
        description: $tool_description,
        parameters: $schema
      },
      messages: $messages
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
