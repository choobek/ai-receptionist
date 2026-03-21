#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=./lib/env-context.sh
. "$ROOT_DIR/scripts/lib/env-context.sh"

ENVIRONMENT="$(normalize_deploy_environment "${1:-production}")"

load_root_env

legacy_vps_ssh_host=""
legacy_vps_ssh_user=""
legacy_vps_ssh_port=""
legacy_vps_ssh_identity_file=""
legacy_vps_app_dir=""
legacy_vps_compose_file=""
legacy_vps_compose_project_name=""

if [ "$ENVIRONMENT" = "production" ]; then
  legacy_vps_ssh_host="VPS_SSH_HOST"
  legacy_vps_ssh_user="VPS_SSH_USER"
  legacy_vps_ssh_port="VPS_SSH_PORT"
  legacy_vps_ssh_identity_file="VPS_SSH_IDENTITY_FILE"
  legacy_vps_app_dir="VPS_APP_DIR"
  legacy_vps_compose_file="VPS_COMPOSE_FILE"
  legacy_vps_compose_project_name="VPS_COMPOSE_PROJECT_NAME"
fi

VPS_SSH_HOST="$(require_context_value "$ENVIRONMENT" "VPS_SSH_HOST" "$legacy_vps_ssh_host" "VPS_SSH_HOST")"
VPS_SSH_USER="$(require_context_value "$ENVIRONMENT" "VPS_SSH_USER" "$legacy_vps_ssh_user" "VPS_SSH_USER")"
VPS_SSH_PORT="$(get_context_value "$ENVIRONMENT" "VPS_SSH_PORT" "$legacy_vps_ssh_port")"
VPS_SSH_PORT="${VPS_SSH_PORT:-22}"
VPS_SSH_IDENTITY_FILE="$(get_context_value "$ENVIRONMENT" "VPS_SSH_IDENTITY_FILE" "$legacy_vps_ssh_identity_file")"
VPS_APP_DIR="$(require_context_value "$ENVIRONMENT" "VPS_APP_DIR" "$legacy_vps_app_dir" "VPS_APP_DIR")"
VPS_COMPOSE_FILE="$(get_context_value "$ENVIRONMENT" "VPS_COMPOSE_FILE" "$legacy_vps_compose_file")"
VPS_COMPOSE_FILE="${VPS_COMPOSE_FILE:-deploy/vps/docker-compose.yml}"
VPS_COMPOSE_PROJECT_NAME="$(get_context_value "$ENVIRONMENT" "VPS_COMPOSE_PROJECT_NAME" "$legacy_vps_compose_project_name")"
VPS_COMPOSE_PROJECT_NAME="${VPS_COMPOSE_PROJECT_NAME:-$(basename "$VPS_APP_DIR")}"

AI_RECEPTIONIST_SMS_PROVIDER="$(get_context_value "$ENVIRONMENT" "AI_RECEPTIONIST_SMS_PROVIDER" "AI_RECEPTIONIST_SMS_PROVIDER")"
AI_RECEPTIONIST_SMS_WEBHOOK_URL="$(get_context_value "$ENVIRONMENT" "AI_RECEPTIONIST_SMS_WEBHOOK_URL" "AI_RECEPTIONIST_SMS_WEBHOOK_URL")"
AI_RECEPTIONIST_SMS_WEBHOOK_BEARER_TOKEN="$(get_context_value "$ENVIRONMENT" "AI_RECEPTIONIST_SMS_WEBHOOK_BEARER_TOKEN" "AI_RECEPTIONIST_SMS_WEBHOOK_BEARER_TOKEN")"
AI_RECEPTIONIST_SMS_WEBHOOK_TIMEOUT_MS="$(get_context_value "$ENVIRONMENT" "AI_RECEPTIONIST_SMS_WEBHOOK_TIMEOUT_MS" "AI_RECEPTIONIST_SMS_WEBHOOK_TIMEOUT_MS")"
AI_RECEPTIONIST_SMS_SENDER="$(get_context_value "$ENVIRONMENT" "AI_RECEPTIONIST_SMS_SENDER" "AI_RECEPTIONIST_SMS_SENDER")"
AI_RECEPTIONIST_RECEPTION_SMS_RECIPIENTS="$(get_context_value "$ENVIRONMENT" "AI_RECEPTIONIST_RECEPTION_SMS_RECIPIENTS" "AI_RECEPTIONIST_RECEPTION_SMS_RECIPIENTS")"
TWILIO_ACCOUNT_SID="$(get_context_value "$ENVIRONMENT" "TWILIO_ACCOUNT_SID" "TWILIO_ACCOUNT_SID")"
TWILIO_AUTH_TOKEN="$(get_context_value "$ENVIRONMENT" "TWILIO_AUTH_TOKEN" "TWILIO_AUTH_TOKEN")"
TWILIO_PHONE_NUMBER="$(get_context_value "$ENVIRONMENT" "TWILIO_PHONE_NUMBER" "TWILIO_PHONE_NUMBER")"

if [ -z "$AI_RECEPTIONIST_SMS_PROVIDER" ]; then
  echo "AI_RECEPTIONIST_SMS_PROVIDER is required for $ENVIRONMENT" >&2
  exit 1
fi

case "$AI_RECEPTIONIST_SMS_PROVIDER" in
  mock)
    ;;
  twilio)
    if [ -z "$AI_RECEPTIONIST_RECEPTION_SMS_RECIPIENTS" ]; then
      echo "AI_RECEPTIONIST_RECEPTION_SMS_RECIPIENTS is required for twilio mode" >&2
      exit 1
    fi
    for key in TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN TWILIO_PHONE_NUMBER; do
      if [ -z "${!key:-}" ]; then
        echo "$key is required for twilio mode" >&2
        exit 1
      fi
    done
    ;;
  webhook)
    if [ -z "$AI_RECEPTIONIST_SMS_WEBHOOK_URL" ]; then
      echo "AI_RECEPTIONIST_SMS_WEBHOOK_URL is required for webhook mode" >&2
      exit 1
    fi
    if [ -z "$AI_RECEPTIONIST_RECEPTION_SMS_RECIPIENTS" ]; then
      echo "AI_RECEPTIONIST_RECEPTION_SMS_RECIPIENTS is required for webhook mode" >&2
      exit 1
    fi
    ;;
  *)
    echo "Unsupported AI_RECEPTIONIST_SMS_PROVIDER: $AI_RECEPTIONIST_SMS_PROVIDER" >&2
    exit 1
    ;;
esac

ssh_args=(-p "$VPS_SSH_PORT")
scp_args=(-P "$VPS_SSH_PORT")
if [ -n "$VPS_SSH_IDENTITY_FILE" ]; then
  ssh_args+=(-i "$VPS_SSH_IDENTITY_FILE")
  scp_args+=(-i "$VPS_SSH_IDENTITY_FILE")
fi

local_sms_env_file="$(mktemp "${TMPDIR:-/tmp}/ai-receptionist-sms-env-${ENVIRONMENT}.XXXXXX")"
remote_sms_env_file="/tmp/ai-receptionist-sms-env-${ENVIRONMENT}-$$"

cleanup() {
  rm -f "$local_sms_env_file"
}
trap cleanup EXIT

cat >"$local_sms_env_file" <<EOF
AI_RECEPTIONIST_SMS_PROVIDER=$AI_RECEPTIONIST_SMS_PROVIDER
AI_RECEPTIONIST_SMS_WEBHOOK_URL=$AI_RECEPTIONIST_SMS_WEBHOOK_URL
AI_RECEPTIONIST_SMS_WEBHOOK_BEARER_TOKEN=$AI_RECEPTIONIST_SMS_WEBHOOK_BEARER_TOKEN
AI_RECEPTIONIST_SMS_WEBHOOK_TIMEOUT_MS=$AI_RECEPTIONIST_SMS_WEBHOOK_TIMEOUT_MS
AI_RECEPTIONIST_SMS_SENDER=$AI_RECEPTIONIST_SMS_SENDER
AI_RECEPTIONIST_RECEPTION_SMS_RECIPIENTS=$AI_RECEPTIONIST_RECEPTION_SMS_RECIPIENTS
TWILIO_ACCOUNT_SID=$TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN=$TWILIO_AUTH_TOKEN
TWILIO_PHONE_NUMBER=$TWILIO_PHONE_NUMBER
EOF

scp "${scp_args[@]}" "$local_sms_env_file" "${VPS_SSH_USER}@${VPS_SSH_HOST}:${remote_sms_env_file}"

ssh "${ssh_args[@]}" "${VPS_SSH_USER}@${VPS_SSH_HOST}" \
  "APP_DIR='$VPS_APP_DIR' COMPOSE_FILE='$VPS_COMPOSE_FILE' COMPOSE_PROJECT_NAME='$VPS_COMPOSE_PROJECT_NAME' REMOTE_SMS_ENV_FILE='$remote_sms_env_file' TARGET_ENV='$ENVIRONMENT' bash -s" <<'EOF'
set -euo pipefail

cd "$APP_DIR"

if [ ! -f .env ]; then
  echo "Remote root .env not found in $APP_DIR" >&2
  exit 1
fi

tmp_env_file="$(mktemp)"
cp .env "$tmp_env_file"

while IFS='=' read -r key _; do
  if [ -n "$key" ]; then
    sed -i "/^${key}=/d" "$tmp_env_file"
  fi
done < "$REMOTE_SMS_ENV_FILE"

printf '\n# Managed by scripts/sync-vps-sms-config.sh for %s\n' "$TARGET_ENV" >> "$tmp_env_file"
cat "$REMOTE_SMS_ENV_FILE" >> "$tmp_env_file"
mv "$tmp_env_file" .env
rm -f "$REMOTE_SMS_ENV_FILE"

if docker compose version >/dev/null 2>&1; then
  docker compose --env-file .env -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" up -d
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" docker-compose -f "$COMPOSE_FILE" up -d
else
  echo "Neither docker-compose nor docker compose is available on the VPS" >&2
  exit 1
fi
EOF
