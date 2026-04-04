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

TOOL_DEFINITION_INITIAL_DELAY_SECONDS="${VAPI_TOOL_DEFINITION_INITIAL_DELAY_SECONDS:-5}"
TOOL_DEFINITION_DELAY_SECONDS="${VAPI_TOOL_DEFINITION_DELAY_SECONDS:-2}"
TOOL_DEFINITION_NAMES=(
  lookupPatient
  checkAvailability
  searchKnowledgeBase
  createEvent
  createReceptionTask
  sendSmsToReceptionists
  sendSmsToPatient
)

if [ "$TOOL_DEFINITION_INITIAL_DELAY_SECONDS" != "0" ]; then
  printf 'Waiting %ss before tool definition sync to avoid Vapi burst limiting\n' "$TOOL_DEFINITION_INITIAL_DELAY_SECONDS"
  sleep "$TOOL_DEFINITION_INITIAL_DELAY_SECONDS"
fi

for index in "${!TOOL_DEFINITION_NAMES[@]}"; do
  if [ "$index" -gt 0 ] && [ "$TOOL_DEFINITION_DELAY_SECONDS" != "0" ]; then
    sleep "$TOOL_DEFINITION_DELAY_SECONDS"
  fi
  "$ROOT_DIR/scripts/update-vapi-tool-definition.sh" "$ENVIRONMENT" "${TOOL_DEFINITION_NAMES[$index]}"
done
