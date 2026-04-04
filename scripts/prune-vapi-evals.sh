#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=./lib/env-context.sh
. "$ROOT_DIR/scripts/lib/env-context.sh"

ENVIRONMENT="$(normalize_deploy_environment "${1:-staging}")"
shift || true

load_root_env

API_KEY="$(get_context_value "$ENVIRONMENT" "VAPI_API_KEY" "VAPI_API_KEY")"
API_BASE_URL="${VAPI_API_BASE_URL:-https://api.vapi.ai}"

if [ -z "$API_KEY" ]; then
  echo "VAPI_API_KEY is required for $ENVIRONMENT" >&2
  exit 1
fi

exec python3 "$ROOT_DIR/scripts/vapi_observability.py" \
  prune-evals \
  --api-key "$API_KEY" \
  --base-url "$API_BASE_URL" \
  "$@"
