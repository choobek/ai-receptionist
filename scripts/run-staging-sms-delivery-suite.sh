#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=./lib/env-context.sh
. "$ROOT_DIR/scripts/lib/env-context.sh"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/run-staging-sms-delivery-suite.sh --provider <mock|twilio|webhook> [options]

Options:
  --provider <mode>          Required. One of: mock, twilio, webhook.
  --patient-phone-e164 <n>   Patient phone used for the direct patient SMS probe and the assistant SMS scenario.
  --patient-full-name <name> Override the patient full name used in direct probes and the assistant SMS scenario.
  --direct-only              Run only the direct SMS webhook probes.
  --scenario-only            Run only the focused assistant SMS scenarios.
  --keep-provider            Leave staging running in the selected SMS provider mode after the suite finishes.
  --help                     Show this help message.
EOF
}

PROVIDER=""
PATIENT_PHONE_E164=""
PATIENT_FULL_NAME="Test Regresji SMS Delivery"
RUN_DIRECT=1
RUN_SCENARIOS=1
KEEP_PROVIDER=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --provider)
      PROVIDER="${2:-}"
      shift 2
      ;;
    --patient-phone-e164)
      PATIENT_PHONE_E164="${2:-}"
      shift 2
      ;;
    --patient-full-name)
      PATIENT_FULL_NAME="${2:-}"
      shift 2
      ;;
    --direct-only)
      RUN_SCENARIOS=0
      shift
      ;;
    --scenario-only)
      RUN_DIRECT=0
      shift
      ;;
    --keep-provider)
      KEEP_PROVIDER=1
      shift
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

case "$PROVIDER" in
  mock|twilio|webhook)
    ;;
  *)
    echo "--provider must be one of: mock, twilio, webhook" >&2
    exit 1
    ;;
esac

if [ "$RUN_DIRECT" -eq 0 ] && [ "$RUN_SCENARIOS" -eq 0 ]; then
  echo "Nothing to run: choose at least one of direct probes or focused scenarios" >&2
  exit 1
fi

load_root_env

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required" >&2
  exit 1
fi

STAGING_BASE_URL="$(require_context_value staging N8N_PUBLIC_BASE_URL "" "STAGING_N8N_PUBLIC_BASE_URL")"
STAGING_WEBHOOK_SECRET="$(get_context_value staging AI_RECEPTIONIST_WEBHOOK_SECRET "" )"

VPS_SSH_HOST="$(require_context_value staging VPS_SSH_HOST "" "STAGING_VPS_SSH_HOST")"
VPS_SSH_USER="$(require_context_value staging VPS_SSH_USER "" "STAGING_VPS_SSH_USER")"
VPS_SSH_PORT="$(get_context_value staging VPS_SSH_PORT "" )"
VPS_SSH_PORT="${VPS_SSH_PORT:-22}"
VPS_SSH_IDENTITY_FILE="$(get_context_value staging VPS_SSH_IDENTITY_FILE "" )"
VPS_APP_DIR="$(require_context_value staging VPS_APP_DIR "" "STAGING_VPS_APP_DIR")"
VPS_COMPOSE_FILE="$(get_context_value staging VPS_COMPOSE_FILE "" )"
VPS_COMPOSE_FILE="${VPS_COMPOSE_FILE:-deploy/vps/docker-compose.n8n-only.yml}"
VPS_COMPOSE_PROJECT_NAME="$(get_context_value staging VPS_COMPOSE_PROJECT_NAME "" )"
VPS_COMPOSE_PROJECT_NAME="${VPS_COMPOSE_PROJECT_NAME:-$(basename "$VPS_APP_DIR")}"

STAGING_BASE_URL="${STAGING_BASE_URL%/}"

if [ -z "$PATIENT_PHONE_E164" ] && [ -n "${AI_RECEPTIONIST_RECEPTION_SMS_RECIPIENTS:-}" ]; then
  PATIENT_PHONE_E164="${AI_RECEPTIONIST_RECEPTION_SMS_RECIPIENTS%%,*}"
fi

if [ -z "$PATIENT_PHONE_E164" ]; then
  if [ "$PROVIDER" = "mock" ]; then
    PATIENT_PHONE_E164="+48500100200"
  else
    echo "--patient-phone-e164 is required for $PROVIDER mode unless AI_RECEPTIONIST_RECEPTION_SMS_RECIPIENTS is set locally" >&2
    exit 1
  fi
fi

if [[ ! "$PATIENT_PHONE_E164" =~ ^\+[1-9][0-9]{7,14}$ ]]; then
  echo "--patient-phone-e164 must be a valid E.164 number" >&2
  exit 1
fi

ssh_args=(-A -p "$VPS_SSH_PORT")
if [ -n "$VPS_SSH_IDENTITY_FILE" ]; then
  ssh_args+=(-i "$VPS_SSH_IDENTITY_FILE")
fi

tmp_dir="$(mktemp -d)"
cleanup() {
  local exit_code="$1"
  if [ "$KEEP_PROVIDER" -eq 0 ]; then
    echo "Restoring staging SMS provider from remote root .env..."
    if ! ssh "${ssh_args[@]}" "${VPS_SSH_USER}@${VPS_SSH_HOST}" \
      env \
      "APP_DIR=$VPS_APP_DIR" \
      "COMPOSE_FILE=$VPS_COMPOSE_FILE" \
      "COMPOSE_PROJECT_NAME=$VPS_COMPOSE_PROJECT_NAME" \
      bash -s <<'EOF'
set -euo pipefail

cd "$APP_DIR"

if docker compose version >/dev/null 2>&1; then
  docker compose --env-file .env -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" up -d
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" docker-compose -f "$COMPOSE_FILE" up -d
else
  echo "Neither docker-compose nor docker compose is available on the VPS" >&2
  exit 1
fi
EOF
    then
      echo "Failed to restore the staging stack to its root .env defaults" >&2
      exit_code=1
    fi
  fi

  rm -rf "$tmp_dir"
  exit "$exit_code"
}
trap 'cleanup $?' EXIT

polish_digit_word() {
  case "$1" in
    0) printf 'zero' ;;
    1) printf 'jeden' ;;
    2) printf 'dwa' ;;
    3) printf 'trzy' ;;
    4) printf 'cztery' ;;
    5) printf 'piec' ;;
    6) printf 'szesc' ;;
    7) printf 'siedem' ;;
    8) printf 'osiem' ;;
    9) printf 'dziewiec' ;;
    *) return 1 ;;
  esac
}

render_patient_identity_utterance() {
  local full_name="$1"
  local phone_e164="$2"
  local digits="${phone_e164#+}"
  local spoken=()
  local digit
  local word

  if [[ "$digits" =~ ^48[0-9]{9}$ ]]; then
    digits="${digits:2}"
  fi

  for ((index = 0; index < ${#digits}; index += 1)); do
    digit="${digits:index:1}"
    word="$(polish_digit_word "$digit")"
    spoken+=("$word")
  done

  printf '%s, moj numer to %s.' "$full_name" "${spoken[*]}"
}

PATIENT_IDENTITY_UTTERANCE="$(render_patient_identity_utterance "$PATIENT_FULL_NAME" "$PATIENT_PHONE_E164")"
read_remote_default_provider() {
  ssh "${ssh_args[@]}" "${VPS_SSH_USER}@${VPS_SSH_HOST}" \
    env "APP_DIR=$VPS_APP_DIR" bash -s <<'EOF'
set -euo pipefail

cd "$APP_DIR"

if [ ! -f .env ]; then
  echo "mock"
  exit 0
fi

value="$(grep -E '^AI_RECEPTIONIST_SMS_PROVIDER=' .env | tail -n 1 | cut -d '=' -f 2- || true)"
if [ -n "$value" ]; then
  printf '%s\n' "$value"
else
  echo "mock"
fi
EOF
}

restart_remote_stack_with_provider() {
  local provider="$1"
  local -a remote_env

  remote_env=(
    "APP_DIR=$VPS_APP_DIR"
    "COMPOSE_FILE=$VPS_COMPOSE_FILE"
    "COMPOSE_PROJECT_NAME=$VPS_COMPOSE_PROJECT_NAME"
    "AI_RECEPTIONIST_SMS_PROVIDER=$provider"
  )

  for key in \
    AI_RECEPTIONIST_SMS_WEBHOOK_URL \
    AI_RECEPTIONIST_SMS_WEBHOOK_BEARER_TOKEN \
    AI_RECEPTIONIST_SMS_WEBHOOK_TIMEOUT_MS \
    AI_RECEPTIONIST_SMS_SENDER \
    AI_RECEPTIONIST_RECEPTION_SMS_RECIPIENTS \
    TWILIO_ACCOUNT_SID \
    TWILIO_AUTH_TOKEN \
    TWILIO_PHONE_NUMBER
  do
    if [ -n "${!key:-}" ]; then
      remote_env+=("${key}=${!key}")
    fi
  done

  ssh "${ssh_args[@]}" "${VPS_SSH_USER}@${VPS_SSH_HOST}" env "${remote_env[@]}" bash -s <<'EOF'
set -euo pipefail

cd "$APP_DIR"

override_file="$(mktemp)"
cleanup_override() {
  rm -f "$override_file"
}
trap cleanup_override EXIT

if grep -Eq '^[[:space:]]+staging_n8n:' "$COMPOSE_FILE"; then
  service_name="staging_n8n"
else
  service_name="n8n"
fi

cat > "$override_file" <<YAML
services:
  ${service_name}:
    environment:
      - AI_RECEPTIONIST_SMS_PROVIDER=\${AI_RECEPTIONIST_SMS_PROVIDER}
      - AI_RECEPTIONIST_SMS_WEBHOOK_URL=\${AI_RECEPTIONIST_SMS_WEBHOOK_URL}
      - AI_RECEPTIONIST_SMS_WEBHOOK_BEARER_TOKEN=\${AI_RECEPTIONIST_SMS_WEBHOOK_BEARER_TOKEN}
      - AI_RECEPTIONIST_SMS_WEBHOOK_TIMEOUT_MS=\${AI_RECEPTIONIST_SMS_WEBHOOK_TIMEOUT_MS}
      - AI_RECEPTIONIST_SMS_SENDER=\${AI_RECEPTIONIST_SMS_SENDER}
      - AI_RECEPTIONIST_RECEPTION_SMS_RECIPIENTS=\${AI_RECEPTIONIST_RECEPTION_SMS_RECIPIENTS}
      - TWILIO_ACCOUNT_SID=\${TWILIO_ACCOUNT_SID}
      - TWILIO_AUTH_TOKEN=\${TWILIO_AUTH_TOKEN}
      - TWILIO_PHONE_NUMBER=\${TWILIO_PHONE_NUMBER}
YAML

if docker compose version >/dev/null 2>&1; then
  docker compose --env-file .env -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" -f "$override_file" up -d
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" docker-compose -f "$COMPOSE_FILE" -f "$override_file" up -d
else
  echo "Neither docker-compose nor docker compose is available on the VPS" >&2
  exit 1
fi
EOF
}

invoke_webhook() {
  local endpoint_path="$1"
  local payload_path="$2"
  local response_path="$3"
  local -a curl_args
  local attempt
  local http_code=""
  local curl_status=0

  curl_args=(
    -sS
    -o "$response_path"
    -w '%{http_code}'
    -X POST
    "${STAGING_BASE_URL}${endpoint_path}"
    -H 'Content-Type: application/json'
    --data-binary "@${payload_path}"
  )

  if [ -n "$STAGING_WEBHOOK_SECRET" ]; then
    curl_args+=(-H "X-AI-Receptionist-Secret: $STAGING_WEBHOOK_SECRET")
  fi

  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if http_code="$(curl "${curl_args[@]}")"; then
      if [ "$http_code" = "200" ] && [ -s "$response_path" ]; then
        printf '%s\n' "$http_code"
        return 0
      fi
    fi
    curl_status="$?"
    if [ "$attempt" -lt 10 ]; then
      sleep 3
    fi
  done

  if [ -n "$http_code" ]; then
    printf '%s\n' "$http_code"
    return 0
  fi

  return "$curl_status"
}

validate_webhook_response() {
  local response_path="$1"
  local http_code="$2"
  local kind="$3"
  local provider="$4"

  node - "$response_path" "$http_code" "$kind" "$provider" <<'EOF'
const fs = require('node:fs');

const [responsePath, httpCode, kind, provider] = process.argv.slice(2);
const payload = JSON.parse(fs.readFileSync(responsePath, 'utf8'));

function fail(message) {
  throw new Error(`${message}\nResponse: ${JSON.stringify(payload, null, 2)}`);
}

if (httpCode !== '200') {
  fail(`Expected HTTP 200, got ${httpCode}`);
}

if (payload.accepted !== true) {
  fail('Expected accepted=true');
}

if (!payload.delivery || payload.delivery.provider !== provider) {
  fail(`Expected delivery.provider=${provider}`);
}

if (provider === 'mock') {
  if (payload.delivery.status !== 'simulated') {
    fail('Expected delivery.status=simulated in mock mode');
  }
} else if (!['queued', 'sent'].includes(payload.delivery.status)) {
  fail(`Expected delivery.status to be queued or sent in ${provider} mode`);
}

if (kind === 'patient') {
  if (payload.delivery.recipientCount !== 1) {
    fail('Expected patient SMS recipientCount=1');
  }
  if (!payload.sms || payload.sms.kind !== 'booking_confirmation' || typeof payload.sms.body !== 'string' || !payload.sms.body.trim()) {
    fail('Expected patient SMS payload with booking_confirmation body');
  }
} else {
  if (!Number.isInteger(payload.delivery.recipientCount) || payload.delivery.recipientCount < 1) {
    fail('Expected internal SMS recipientCount>=1');
  }
  if (!payload.notification || payload.notification.kind !== 'reception_follow_up' || typeof payload.notification.body !== 'string' || !payload.notification.body.trim()) {
    fail('Expected reception notification payload');
  }
}
EOF
}

run_direct_probes() {
  local reception_payload_path="$tmp_dir/reception.payload.json"
  local reception_response_path="$tmp_dir/reception.response.json"
  local patient_payload_path="$tmp_dir/patient.payload.json"
  local patient_response_path="$tmp_dir/patient.response.json"
  local request_suffix
  local reception_http_code
  local patient_http_code

  request_suffix="$(date -u '+%Y%m%dT%H%M%SZ')"

  node - "$reception_payload_path" "$patient_payload_path" "$request_suffix" "$PATIENT_FULL_NAME" "$PATIENT_PHONE_E164" <<'EOF'
const fs = require('node:fs');

const [receptionPayloadPath, patientPayloadPath, requestSuffix, patientFullName, patientPhoneE164] = process.argv.slice(2);

fs.writeFileSync(receptionPayloadPath, `${JSON.stringify({
  requestId: `test_sms_reception_${requestSuffix}`,
  taskId: `task_${requestSuffix}`,
  taskType: 'existing_patient_booking',
  patient: {
    fullName: patientFullName,
    phoneE164: patientPhoneE164,
    isExistingPatient: true
  },
  summary: 'Automated staging SMS delivery probe.',
  notes: 'Triggered by run-staging-sms-delivery-suite.sh'
}, null, 2)}\n`);

fs.writeFileSync(patientPayloadPath, `${JSON.stringify({
  requestId: `test_sms_patient_${requestSuffix}`,
  calendarEventId: `evt_${requestSuffix}`,
  consentConfirmed: true,
  language: 'pl',
  patient: {
    fullName: patientFullName,
    phoneE164: patientPhoneE164
  },
  appointment: {
    start: '2026-03-27T10:30:00+01:00',
    timezone: 'Europe/Warsaw',
    service: {
      id: 'consultation',
      name: 'Konsultacja'
    }
  }
}, null, 2)}\n`);
EOF

  echo "Running direct sendSmsToReceptionists probe..."
  reception_http_code="$(invoke_webhook "/webhook/ai-receptionist/send-sms-to-receptionists" "$reception_payload_path" "$reception_response_path")"
  validate_webhook_response "$reception_response_path" "$reception_http_code" reception "$PROVIDER"

  echo "Running direct sendSmsToPatient probe..."
  patient_http_code="$(invoke_webhook "/webhook/ai-receptionist/send-sms-to-patient" "$patient_payload_path" "$patient_response_path")"
  validate_webhook_response "$patient_response_path" "$patient_http_code" patient "$PROVIDER"
}

run_booking_sms_scenario_with_retries() {
  local attempt=1
  local utterance
  local -a booking_openings

  booking_openings=(
    "Chcialabym umowic pierwsza konsultacje w najblizszy poniedzialek okolo dziesiatej trzydziesci. Jesli sie uda, prosze potem o SMS z potwierdzeniem."
    "Chcialabym umowic pierwsza konsultacje w najblizszy poniedzialek wczesnym popoldniem. Jesli sie uda, prosze potem o SMS z potwierdzeniem."
    "Chcialabym umowic pierwsza konsultacje w najblizszy poniedzialek poznym popoldniem. Jesli sie uda, prosze potem o SMS z potwierdzeniem."
  )

  for utterance in "${booking_openings[@]}"; do
    echo "Running booking-confirmation-sms attempt ${attempt}/${#booking_openings[@]}..."
    if STAGING_SMS_BOOKING_OPENING_UTTERANCE="$utterance" \
      STAGING_SMS_TEST_PATIENT_IDENTITY_UTTERANCE="$PATIENT_IDENTITY_UTTERANCE" \
      "$ROOT_DIR/scripts/run-staging-regression-suite.sh" \
        --scenario booking-confirmation-sms
    then
      return 0
    fi
    attempt=$((attempt + 1))
  done

  return 1
}

run_internal_sms_scenario() {
  echo "Running reschedule-handoff-internal-sms-alert..."
  "$ROOT_DIR/scripts/run-staging-regression-suite.sh" \
    --scenario reschedule-handoff-internal-sms-alert
}

run_focused_scenarios() {
  echo "Running focused assistant SMS scenarios..."
  run_booking_sms_scenario_with_retries
  run_internal_sms_scenario
}

remote_default_provider="$(read_remote_default_provider)"
echo "Remote staging root .env SMS provider: ${remote_default_provider:-mock}"
echo "Switching staging runtime to SMS provider: $PROVIDER"
restart_remote_stack_with_provider "$PROVIDER"

if [ "$RUN_DIRECT" -eq 1 ]; then
  run_direct_probes
fi

if [ "$RUN_SCENARIOS" -eq 1 ]; then
  run_focused_scenarios
fi

echo "Staging SMS delivery suite passed for provider: $PROVIDER"
