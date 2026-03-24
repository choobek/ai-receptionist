#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_PATH="${1:-${VAPI_ASSISTANT_CONFIG_PATH:-$ROOT_DIR/configs/vapi/assistant.v2.json}}"
SYSTEM_PROMPT_PATH="$ROOT_DIR/prompts/system-prompt.md"
FIRST_MESSAGE_PATH="$ROOT_DIR/prompts/first-message.md"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

if [ ! -f "$CONFIG_PATH" ]; then
  echo "Config file not found: $CONFIG_PATH" >&2
  exit 1
fi

tmp_system="$(mktemp)"
tmp_first="$(mktemp)"
cleanup() {
  rm -f "$tmp_system" "$tmp_first"
}
trap cleanup EXIT

jq -er '
  .assistant.model.messages
  | map(select(.role == "system" and (.content | type == "string")))
  | .[0].content
' "$CONFIG_PATH" > "$tmp_system"

jq -er '
  .assistant.firstMessage
  | select(type == "string" and length > 0)
' "$CONFIG_PATH" > "$tmp_first"

mv "$tmp_system" "$SYSTEM_PROMPT_PATH"
mv "$tmp_first" "$FIRST_MESSAGE_PATH"

printf 'Updated %s\n' "$SYSTEM_PROMPT_PATH"
printf 'Updated %s\n' "$FIRST_MESSAGE_PATH"
