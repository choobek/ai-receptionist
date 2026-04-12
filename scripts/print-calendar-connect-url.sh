#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=./lib/env-context.sh
. "$ROOT_DIR/scripts/lib/env-context.sh"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/print-calendar-connect-url.sh [staging|production] <connection-id> [calendar-id]
  ./scripts/print-calendar-connect-url.sh <connection-id> [calendar-id]

Modes:
  staging|production
    Read the public base URL and connect token from the prefixed values in root .env:
    STAGING_N8N_PUBLIC_BASE_URL / STAGING_CALENDAR_GATEWAY_CONNECT_TOKEN
    PRODUCTION_N8N_PUBLIC_BASE_URL / PRODUCTION_CALENDAR_GATEWAY_CONNECT_TOKEN

  runtime
    When no environment is provided, read the unprefixed runtime values from the current shell
    or from the root .env loaded automatically:
    CALENDAR_GATEWAY_PUBLIC_BASE_URL / CALENDAR_GATEWAY_CONNECT_TOKEN
EOF
}

urlencode() {
  python3 - "$1" <<'PY'
import sys
from urllib.parse import quote
print(quote(sys.argv[1], safe=''))
PY
}

preloaded_calendar_gateway_public_base_url="${CALENDAR_GATEWAY_PUBLIC_BASE_URL:-}"
preloaded_calendar_gateway_connect_token="${CALENDAR_GATEWAY_CONNECT_TOKEN:-}"
preloaded_staging_n8n_public_base_url="${STAGING_N8N_PUBLIC_BASE_URL:-}"
preloaded_staging_calendar_gateway_connect_token="${STAGING_CALENDAR_GATEWAY_CONNECT_TOKEN:-}"
preloaded_production_n8n_public_base_url="${PRODUCTION_N8N_PUBLIC_BASE_URL:-}"
preloaded_production_calendar_gateway_connect_token="${PRODUCTION_CALENDAR_GATEWAY_CONNECT_TOKEN:-}"

load_root_env

[ -n "$preloaded_calendar_gateway_public_base_url" ] && export CALENDAR_GATEWAY_PUBLIC_BASE_URL="$preloaded_calendar_gateway_public_base_url"
[ -n "$preloaded_calendar_gateway_connect_token" ] && export CALENDAR_GATEWAY_CONNECT_TOKEN="$preloaded_calendar_gateway_connect_token"
[ -n "$preloaded_staging_n8n_public_base_url" ] && export STAGING_N8N_PUBLIC_BASE_URL="$preloaded_staging_n8n_public_base_url"
[ -n "$preloaded_staging_calendar_gateway_connect_token" ] && export STAGING_CALENDAR_GATEWAY_CONNECT_TOKEN="$preloaded_staging_calendar_gateway_connect_token"
[ -n "$preloaded_production_n8n_public_base_url" ] && export PRODUCTION_N8N_PUBLIC_BASE_URL="$preloaded_production_n8n_public_base_url"
[ -n "$preloaded_production_calendar_gateway_connect_token" ] && export PRODUCTION_CALENDAR_GATEWAY_CONNECT_TOKEN="$preloaded_production_calendar_gateway_connect_token"

environment=""
connection_id=""
calendar_id=""

case "${1:-}" in
  staging|production)
    environment="$(normalize_deploy_environment "$1")"
    connection_id="${2:-}"
    calendar_id="${3:-}"
    ;;
  ""|-h|--help)
    usage
    exit 0
    ;;
  *)
    connection_id="${1:-}"
    calendar_id="${2:-}"
    ;;
esac

if [ -z "$connection_id" ]; then
  usage >&2
  exit 1
fi

if [ -n "$environment" ]; then
  base_url="$(require_context_value "$environment" "N8N_PUBLIC_BASE_URL" "" "N8N public base URL")"
  connect_token="$(require_context_value "$environment" "CALENDAR_GATEWAY_CONNECT_TOKEN" "" "Calendar gateway connect token")"
else
  base_url="${CALENDAR_GATEWAY_PUBLIC_BASE_URL:-}"
  connect_token="${CALENDAR_GATEWAY_CONNECT_TOKEN:-}"
  if [ -z "$base_url" ] || [ -z "$connect_token" ]; then
    echo "CALENDAR_GATEWAY_PUBLIC_BASE_URL and CALENDAR_GATEWAY_CONNECT_TOKEN are required in runtime mode" >&2
    exit 1
  fi
fi

base_url="${base_url%/}"
printf '%s/calendar/connect?connectionId=%s&token=%s' \
  "$base_url" \
  "$(urlencode "$connection_id")" \
  "$(urlencode "$connect_token")"

if [ -n "$calendar_id" ]; then
  printf '&calendarId=%s' "$(urlencode "$calendar_id")"
fi

printf '\n'
