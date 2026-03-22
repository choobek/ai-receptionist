#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=./lib/env-context.sh
. "$ROOT_DIR/scripts/lib/env-context.sh"

ENVIRONMENT="$(normalize_deploy_environment "${1:-staging}")"
shift || true

load_root_env

PREFIX="$(environment_prefix "$ENVIRONMENT")"
API_KEY="$(get_context_value "$ENVIRONMENT" "VAPI_API_KEY" "VAPI_API_KEY")"

if [ -z "$API_KEY" ]; then
  echo "VAPI_API_KEY is required for $ENVIRONMENT" >&2
  exit 1
fi

export "${PREFIX}_VAPI_API_KEY=$API_KEY"

exec node "$ROOT_DIR/scripts/autonomy/run-vapi-live-autoeval.js" \
  --environment "$ENVIRONMENT" \
  "$@"
