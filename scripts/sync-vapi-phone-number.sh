#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=./lib/env-context.sh
. "$ROOT_DIR/scripts/lib/env-context.sh"

ENVIRONMENT="$(normalize_deploy_environment "${1:-production}")"

load_root_env

API_BASE_URL="${VAPI_API_BASE_URL:-https://api.vapi.ai}"
API_KEY="$(get_context_value "$ENVIRONMENT" "VAPI_API_KEY" "VAPI_API_KEY")"
TWILIO_ACCOUNT_SID="$(get_context_value "$ENVIRONMENT" "TWILIO_ACCOUNT_SID" "TWILIO_ACCOUNT_SID")"
TWILIO_AUTH_TOKEN="$(get_context_value "$ENVIRONMENT" "TWILIO_AUTH_TOKEN" "TWILIO_AUTH_TOKEN")"
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

ASSISTANT_ID="$(
  jq -r '.assistantId // empty' "$BINDINGS_PATH"
)"
ASSISTANT_NAME="$(
  jq -r '.assistantName // empty' "$BINDINGS_PATH"
)"
PHONE_NUMBER_ID="$(
  jq -r '.phoneNumberId // empty' "$BINDINGS_PATH"
)"
DECLARED_PHONE_NUMBER="$(
  jq -r '.phoneNumber // empty' "$BINDINGS_PATH"
)"
PHONE_NUMBER_SMS_ENABLED="$(
  jq -r 'if has("phoneNumberSmsEnabled") then .phoneNumberSmsEnabled else false end' "$BINDINGS_PATH"
)"

if [ -z "$ASSISTANT_ID" ]; then
  echo "assistantId is required in $BINDINGS_PATH" >&2
  exit 1
fi

case "$PHONE_NUMBER_SMS_ENABLED" in
  true|false) ;;
  *)
    echo "phoneNumberSmsEnabled must be true or false in $BINDINGS_PATH" >&2
    exit 1
    ;;
esac

resolve_twilio_phone_number() {
  if [ -n "$DECLARED_PHONE_NUMBER" ]; then
    printf '%s\n' "$DECLARED_PHONE_NUMBER"
    return 0
  fi

  local configured_phone_number
  configured_phone_number="$(get_context_value "$ENVIRONMENT" "TWILIO_PHONE_NUMBER")"
  configured_phone_number="${TWILIO_PHONE_NUMBER:-$configured_phone_number}"
  if [ -n "$configured_phone_number" ]; then
    printf '%s\n' "$configured_phone_number"
    return 0
  fi

  if [ -z "$TWILIO_ACCOUNT_SID" ] || [ -z "$TWILIO_AUTH_TOKEN" ]; then
    echo "TWILIO_PHONE_NUMBER is not set and Twilio credentials are unavailable for auto-discovery" >&2
    return 1
  fi

  local response_file
  local http_status
  local discovered_count
  local discovered_number

  response_file="$(mktemp)"
  http_status="$(
    curl -sS \
      -o "$response_file" \
      -w '%{http_code}' \
      -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" \
      "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/IncomingPhoneNumbers.json?PageSize=20"
  )"

  if [ "$http_status" -lt 200 ] || [ "$http_status" -ge 300 ]; then
    echo "Failed to list Twilio incoming phone numbers with HTTP $http_status" >&2
    cat "$response_file" >&2
    rm -f "$response_file"
    return 1
  fi

  discovered_count="$(
    jq '[.incoming_phone_numbers[]? | select(.phone_number and (.phone_number | type == "string"))] | length' "$response_file"
  )"
  discovered_number="$(
    jq -r '[.incoming_phone_numbers[]? | select(.phone_number and (.phone_number | type == "string"))][0].phone_number // empty' "$response_file"
  )"

  rm -f "$response_file"

  if [ "$discovered_count" -ne 1 ]; then
    echo "Expected exactly one Twilio incoming phone number for auto-discovery, found $discovered_count" >&2
    return 1
  fi

  printf '%s\n' "$discovered_number"
}

update_bindings_phone_number_id() {
  local phone_number_id="$1"
  local phone_number="$2"
  python3 - "$BINDINGS_PATH" "$phone_number_id" "$phone_number" <<'PY'
import json
import sys

bindings_path, phone_number_id, phone_number = sys.argv[1:4]

with open(bindings_path, "r", encoding="utf-8") as handle:
    data = json.load(handle)

data["phoneNumberId"] = phone_number_id
data["phoneNumber"] = phone_number

with open(bindings_path, "w", encoding="utf-8") as handle:
    json.dump(data, handle, ensure_ascii=True, indent=2)
    handle.write("\n")
PY
}

lookup_phone_number() {
  local phone_number_id="$1"
  local response_file
  local http_status

  response_file="$(mktemp)"
  http_status="$(
    curl -sS \
      -o "$response_file" \
      -w '%{http_code}' \
      -H "Authorization: Bearer $API_KEY" \
      "$API_BASE_URL/phone-number/$phone_number_id"
  )"

  if [ "$http_status" -lt 200 ] || [ "$http_status" -ge 300 ]; then
    echo "Failed to fetch phone number $phone_number_id with HTTP $http_status" >&2
    cat "$response_file" >&2
    rm -f "$response_file"
    return 1
  fi

  cat "$response_file"
  rm -f "$response_file"
}

build_patch_payload() {
  jq -cn \
    --arg assistant_id "$ASSISTANT_ID" \
    --arg assistant_name "$ASSISTANT_NAME" \
    --argjson sms_enabled "$PHONE_NUMBER_SMS_ENABLED" \
    '{
      assistantId: $assistant_id,
      smsEnabled: $sms_enabled
    }
    | if $assistant_name != "" then .name = $assistant_name else . end'
}

patch_phone_number() {
  local phone_number_id="$1"
  local payload="$2"
  local response_file
  local http_status

  response_file="$(mktemp)"
  http_status="$(
    curl -sS \
      -o "$response_file" \
      -w '%{http_code}' \
      -X PATCH "$API_BASE_URL/phone-number/$phone_number_id" \
      -H "Authorization: Bearer $API_KEY" \
      -H "Content-Type: application/json" \
      -d "$payload"
  )"

  if [ "$http_status" -lt 200 ] || [ "$http_status" -ge 300 ]; then
    echo "Phone number update failed for $phone_number_id with HTTP $http_status" >&2
    cat "$response_file" >&2
    rm -f "$response_file"
    return 1
  fi

  printf 'Phone number updated: %s\n' "$phone_number_id"
  printf 'Assistant bound: %s\n' "$ASSISTANT_ID"
  printf 'SMS enabled: %s\n' "$PHONE_NUMBER_SMS_ENABLED"
  rm -f "$response_file"
}

import_phone_number() {
  local twilio_phone_number="$1"
  local existing_phone_number_id="${2:-}"
  local payload
  local response_file
  local http_status
  local imported_phone_number_id

  payload="$(
    jq -cn \
      --arg twilio_phone_number "$twilio_phone_number" \
      --arg twilio_account_sid "$TWILIO_ACCOUNT_SID" \
      --arg twilio_auth_token "$TWILIO_AUTH_TOKEN" \
      --arg assistant_id "$ASSISTANT_ID" \
      --arg assistant_name "$ASSISTANT_NAME" \
      --argjson sms_enabled "$PHONE_NUMBER_SMS_ENABLED" \
      '{
        twilioPhoneNumber: $twilio_phone_number,
        twilioAccountSid: $twilio_account_sid,
        twilioAuthToken: $twilio_auth_token,
        assistantId: $assistant_id,
        smsEnabled: $sms_enabled
      }
      | if $assistant_name != "" then .name = $assistant_name else . end'
  )"

  response_file="$(mktemp)"
  http_status="$(
    curl -sS \
      -o "$response_file" \
      -w '%{http_code}' \
      -X POST "$API_BASE_URL/phone-number/import" \
      -H "Authorization: Bearer $API_KEY" \
      -H "Content-Type: application/json" \
      -d "$payload"
  )"

  if [ "$http_status" -lt 200 ] || [ "$http_status" -ge 300 ]; then
    echo "Phone number import failed with HTTP $http_status" >&2
    cat "$response_file" >&2
    rm -f "$response_file"
    return 1
  fi

  imported_phone_number_id="$(
    jq -r '.id // empty' "$response_file"
  )"

  if [ -z "$imported_phone_number_id" ]; then
    echo "Imported phone number response did not include an id" >&2
    cat "$response_file" >&2
    rm -f "$response_file"
    return 1
  fi

  update_bindings_phone_number_id "$imported_phone_number_id" "$twilio_phone_number"

  printf 'Phone number imported: %s\n' "$imported_phone_number_id"
  printf 'Assistant bound: %s\n' "$ASSISTANT_ID"
  printf 'SMS enabled: %s\n' "$PHONE_NUMBER_SMS_ENABLED"
  printf 'Bindings updated: %s\n' "$BINDINGS_PATH"
  if [ -n "$existing_phone_number_id" ] && [ "$existing_phone_number_id" != "$imported_phone_number_id" ]; then
    printf 'Replaced previous phone number binding: %s\n' "$existing_phone_number_id"
  fi

  rm -f "$response_file"
}

RESOLVED_TWILIO_PHONE_NUMBER=""
if [ -n "$DECLARED_PHONE_NUMBER" ] || [ -n "${TWILIO_PHONE_NUMBER:-}" ] || [ -n "$(get_context_value "$ENVIRONMENT" "TWILIO_PHONE_NUMBER")" ]; then
  RESOLVED_TWILIO_PHONE_NUMBER="$(resolve_twilio_phone_number)"
elif [ -n "$TWILIO_ACCOUNT_SID" ] && [ -n "$TWILIO_AUTH_TOKEN" ]; then
  RESOLVED_TWILIO_PHONE_NUMBER="$(resolve_twilio_phone_number)"
fi

PATCH_PAYLOAD="$(build_patch_payload)"

if [ -n "$PHONE_NUMBER_ID" ]; then
  if [ -n "$RESOLVED_TWILIO_PHONE_NUMBER" ]; then
    CURRENT_PHONE_NUMBER="$(
      lookup_phone_number "$PHONE_NUMBER_ID" | jq -r '.number // empty'
    )"
    if [ -n "$CURRENT_PHONE_NUMBER" ] && [ "$CURRENT_PHONE_NUMBER" != "$RESOLVED_TWILIO_PHONE_NUMBER" ]; then
      if [ -z "$TWILIO_ACCOUNT_SID" ] || [ -z "$TWILIO_AUTH_TOKEN" ]; then
        echo "Cannot replace phone number $CURRENT_PHONE_NUMBER with $RESOLVED_TWILIO_PHONE_NUMBER because Twilio credentials are missing" >&2
        exit 1
      fi
      import_phone_number "$RESOLVED_TWILIO_PHONE_NUMBER" "$PHONE_NUMBER_ID"
      exit 0
    fi
  fi
  patch_phone_number "$PHONE_NUMBER_ID" "$PATCH_PAYLOAD"
  if [ -n "$RESOLVED_TWILIO_PHONE_NUMBER" ]; then
    update_bindings_phone_number_id "$PHONE_NUMBER_ID" "$RESOLVED_TWILIO_PHONE_NUMBER"
  fi
  exit 0
fi

if [ -z "$TWILIO_ACCOUNT_SID" ] || [ -z "$TWILIO_AUTH_TOKEN" ]; then
  echo "Skipping Vapi phone number sync because phoneNumberId is not set in $BINDINGS_PATH and Twilio credentials are missing" >&2
  exit 0
fi

if [ -z "$RESOLVED_TWILIO_PHONE_NUMBER" ]; then
  echo "Skipping Vapi phone number sync because a Twilio phone number could not be resolved" >&2
  exit 0
fi

import_phone_number "$RESOLVED_TWILIO_PHONE_NUMBER"
