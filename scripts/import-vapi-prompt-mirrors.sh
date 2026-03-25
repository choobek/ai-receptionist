#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_PATH="${VAPI_ASSISTANT_CONFIG_PATH:-$ROOT_DIR/configs/vapi/assistant.v2.json}"
SYSTEM_PROMPT_PATH="$ROOT_DIR/prompts/system-prompt.md"
FIRST_MESSAGE_PATH="$ROOT_DIR/prompts/first-message.md"
UPDATE_SYSTEM=true
UPDATE_FIRST=true

usage() {
  cat <<'EOF'
Usage:
  ./scripts/import-vapi-prompt-mirrors.sh [config-path]
  ./scripts/import-vapi-prompt-mirrors.sh --system-only [config-path]
  ./scripts/import-vapi-prompt-mirrors.sh --first-only [config-path]

Imports the human-readable prompt mirror files in prompts/ back into the
assistant JSON config. This is an explicit reverse-sync step; after import,
the JSON config becomes canonical again.
EOF
}

POSITIONAL_CONFIG_PATH=""
for arg in "$@"; do
  case "$arg" in
    --help|-h)
      usage
      exit 0
      ;;
    --system-only)
      UPDATE_FIRST=false
      ;;
    --first-only)
      UPDATE_SYSTEM=false
      ;;
    --*)
      echo "Unknown option: $arg" >&2
      usage >&2
      exit 1
      ;;
    *)
      if [ -n "$POSITIONAL_CONFIG_PATH" ]; then
        echo "Only one config path may be provided." >&2
        usage >&2
        exit 1
      fi
      POSITIONAL_CONFIG_PATH="$arg"
      ;;
  esac
done

if [ -n "$POSITIONAL_CONFIG_PATH" ]; then
  CONFIG_PATH="$POSITIONAL_CONFIG_PATH"
fi

if [ "$UPDATE_SYSTEM" = false ] && [ "$UPDATE_FIRST" = false ]; then
  echo "Nothing to import: both --system-only and --first-only disabled updates." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required" >&2
  exit 1
fi

if [ ! -f "$CONFIG_PATH" ]; then
  echo "Config file not found: $CONFIG_PATH" >&2
  exit 1
fi

if [ "$UPDATE_SYSTEM" = true ] && [ ! -f "$SYSTEM_PROMPT_PATH" ]; then
  echo "System prompt mirror not found: $SYSTEM_PROMPT_PATH" >&2
  exit 1
fi

if [ "$UPDATE_FIRST" = true ] && [ ! -f "$FIRST_MESSAGE_PATH" ]; then
  echo "First-message mirror not found: $FIRST_MESSAGE_PATH" >&2
  exit 1
fi

python3 - "$CONFIG_PATH" "$SYSTEM_PROMPT_PATH" "$FIRST_MESSAGE_PATH" "$UPDATE_SYSTEM" "$UPDATE_FIRST" <<'PY'
import json
import sys
from pathlib import Path

config_path = Path(sys.argv[1])
system_prompt_path = Path(sys.argv[2])
first_message_path = Path(sys.argv[3])
update_system = sys.argv[4] == "true"
update_first = sys.argv[5] == "true"


def read_prompt_text(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    return text.rstrip("\r\n")


data = json.loads(config_path.read_text(encoding="utf-8"))

if update_system:
    system_prompt = read_prompt_text(system_prompt_path)
    if not system_prompt.strip():
        raise SystemExit(f"System prompt mirror is empty: {system_prompt_path}")

    messages = data.get("assistant", {}).get("model", {}).get("messages", [])
    system_index = next(
        (
            idx
            for idx, message in enumerate(messages)
            if message.get("role") == "system" and isinstance(message.get("content"), str)
        ),
        None,
    )
    if system_index is None:
        raise SystemExit(f"No system message found in {config_path}")
    messages[system_index]["content"] = system_prompt

if update_first:
    first_message = read_prompt_text(first_message_path)
    if not first_message.strip():
        raise SystemExit(f"First-message mirror is empty: {first_message_path}")
    data.setdefault("assistant", {})["firstMessage"] = first_message

config_path.write_text(
    json.dumps(data, ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8",
)
PY

if [ "$UPDATE_SYSTEM" = true ]; then
  printf 'Imported %s -> %s system prompt\n' "$SYSTEM_PROMPT_PATH" "$CONFIG_PATH"
fi

if [ "$UPDATE_FIRST" = true ]; then
  printf 'Imported %s -> %s first message\n' "$FIRST_MESSAGE_PATH" "$CONFIG_PATH"
fi
