#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_PATH="${VAPI_ASSISTANT_CONFIG_PATH:-$ROOT_DIR/configs/vapi/assistant.v1.json}"
SYSTEM_PROMPT_PATH="$ROOT_DIR/prompts/system-prompt.md"
FIRST_MESSAGE_PATH="$ROOT_DIR/prompts/first-message.md"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required" >&2
  exit 1
fi

tmp_system="$(mktemp)"
tmp_first="$(mktemp)"
cleanup() {
  rm -f "$tmp_system" "$tmp_first"
}
trap cleanup EXIT

echo "Checking shell scripts..."
for script_path in "$ROOT_DIR"/scripts/*.sh; do
  bash -n "$script_path"
done

echo "Checking JSON files..."
while IFS= read -r json_path; do
  jq empty "$json_path" >/dev/null
done < <(find "$ROOT_DIR" -type f -name '*.json' -not -path "$ROOT_DIR/.git/*" | sort)

echo "Checking workflow data sync..."
"$ROOT_DIR/scripts/sync-n8n-workflow-data.sh" --check >/dev/null

echo "Checking Vapi prompt mirrors..."
jq -er '
  .assistant.model.messages
  | map(select(.role == "system" and (.content | type == "string")))
  | .[0].content
' "$CONFIG_PATH" > "$tmp_system"

jq -er '
  .assistant.firstMessage
  | select(type == "string" and length > 0)
' "$CONFIG_PATH" > "$tmp_first"

if ! diff -u "$tmp_system" "$SYSTEM_PROMPT_PATH" >/dev/null; then
  echo "System prompt mirror is out of sync: $SYSTEM_PROMPT_PATH" >&2
  exit 1
fi

if ! diff -u "$tmp_first" "$FIRST_MESSAGE_PATH" >/dev/null; then
  echo "First-message mirror is out of sync: $FIRST_MESSAGE_PATH" >&2
  exit 1
fi

echo "Checking local markdown links..."
python3 - "$ROOT_DIR" <<'PY'
from pathlib import Path
import re
import sys

root = Path(sys.argv[1]).resolve()
missing = []

for path in root.rglob("*.md"):
    text = path.read_text(encoding="utf-8")
    for match in re.finditer(r"\[[^\]]+\]\(([^)]+)\)", text):
        target = match.group(1)
        if target.startswith(("http://", "https://", "mailto:", "#")):
            continue
        resolved = (path.parent / target).resolve()
        if not resolved.exists():
            missing.append(f"{path.relative_to(root)} -> {target}")

if missing:
    for item in missing:
        print(item, file=sys.stderr)
    raise SystemExit(1)
PY

if command -v node >/dev/null 2>&1; then
  echo "Checking embedded workflow JS..."
  python3 - "$ROOT_DIR" <<'PY'
import json
import subprocess
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()
failures = []

for path in sorted((root / "n8n" / "workflows").glob("*.json")):
    workflow = json.loads(path.read_text(encoding="utf-8"))
    for node in workflow.get("nodes", []):
        js_code = node.get("parameters", {}).get("jsCode")
        if not js_code:
            continue
        result = subprocess.run(
            ["node", "-e", "new Function(process.argv[1]);", js_code],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            failures.append((path.relative_to(root), node.get("name"), result.stderr.strip()))

if failures:
    for path, node_name, stderr in failures:
        print(f"{path} :: {node_name}", file=sys.stderr)
        print(stderr, file=sys.stderr)
    raise SystemExit(1)
PY
else
  echo "Skipping embedded workflow JS check because node is not installed."
fi

echo "Repo health check passed."
