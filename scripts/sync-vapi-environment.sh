#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=./lib/env-context.sh
. "$ROOT_DIR/scripts/lib/env-context.sh"

ENVIRONMENT="$(normalize_deploy_environment "${1:-production}")"

load_root_env

api_key="$(get_context_value "$ENVIRONMENT" "VAPI_API_KEY" "VAPI_API_KEY")"

if [ -z "$api_key" ]; then
  echo "VAPI_API_KEY is required for $ENVIRONMENT" >&2
  exit 1
fi

"$ROOT_DIR/scripts/sync-vapi-prompt-mirrors.sh"

export VAPI_API_KEY="$api_key"

"$ROOT_DIR/scripts/sync-vapi-observability.sh" "$ENVIRONMENT" --sections structured-outputs,scorecards
"$ROOT_DIR/scripts/update-vapi-assistant.sh" "$ENVIRONMENT"
"$ROOT_DIR/scripts/sync-vapi-phone-number.sh" "$ENVIRONMENT"
"$ROOT_DIR/scripts/update-vapi-tool-bindings.sh" "$ENVIRONMENT"
"$ROOT_DIR/scripts/update-vapi-tool-definition.sh" "$ENVIRONMENT" checkAvailability
"$ROOT_DIR/scripts/update-vapi-tool-definition.sh" "$ENVIRONMENT" createEvent
"$ROOT_DIR/scripts/update-vapi-tool-definition.sh" "$ENVIRONMENT" sendSmsToReceptionists
"$ROOT_DIR/scripts/update-vapi-tool-definition.sh" "$ENVIRONMENT" sendSmsToPatient
