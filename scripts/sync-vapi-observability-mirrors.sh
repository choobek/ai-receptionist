#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_PATH="$ROOT_DIR/configs/vapi/structured-outputs/dental-call-intake.v1.json"
TARGET_PATH="$ROOT_DIR/docs/vapi-structured-output.json"

if [ ! -f "$SOURCE_PATH" ]; then
  echo "Structured output source not found: $SOURCE_PATH" >&2
  exit 1
fi

python3 - "$SOURCE_PATH" "$TARGET_PATH" <<'PY'
import json
import sys

source_path, target_path = sys.argv[1:3]

with open(source_path, "r", encoding="utf-8") as handle:
    config = json.load(handle)

schema = config.get("schema")
if not isinstance(schema, dict):
    raise SystemExit(f"schema object is required in {source_path}")

with open(target_path, "w", encoding="utf-8") as handle:
    json.dump(schema, handle, ensure_ascii=True, indent=2)
    handle.write("\n")
PY

printf 'Synced %s\n' "${TARGET_PATH#$ROOT_DIR/}"
