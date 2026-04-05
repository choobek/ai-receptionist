#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=./lib/env-context.sh
. "$ROOT_DIR/scripts/lib/env-context.sh"

ENVIRONMENT="$(normalize_deploy_environment "${1:-staging}")"
shift || true

load_root_env

BASE_URL="$(require_context_value "$ENVIRONMENT" "N8N_PUBLIC_BASE_URL" "" "$(environment_prefix "$ENVIRONMENT")_N8N_PUBLIC_BASE_URL")"
WEBHOOK_SECRET="$(get_context_value "$ENVIRONMENT" "AI_RECEPTIONIST_WEBHOOK_SECRET" "")"

export WEBHOOK_LATENCY_BASE_URL="$BASE_URL"
export WEBHOOK_LATENCY_SECRET="$WEBHOOK_SECRET"

exec node "$ROOT_DIR/scripts/codex/run-webhook-latency-probe.js" \
  --environment "$ENVIRONMENT" \
  "$@"
