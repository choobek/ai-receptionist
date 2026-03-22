#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=./lib/env-context.sh
. "$ROOT_DIR/scripts/lib/env-context.sh"

ENVIRONMENT="$(normalize_deploy_environment "${1:-production}")"
OUTPUT_PATH="${2:-}"
CONFIG_PATH="${VAPI_ASSISTANT_CONFIG_PATH:-$ROOT_DIR/configs/vapi/assistant.v1.json}"
BINDINGS_PATH="$ROOT_DIR/configs/vapi/environments/$ENVIRONMENT.json"

load_root_env

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required" >&2
  exit 1
fi

if [ ! -f "$CONFIG_PATH" ]; then
  echo "Config file not found: $CONFIG_PATH" >&2
  exit 1
fi

if [ ! -f "$BINDINGS_PATH" ]; then
  echo "Bindings file not found: $BINDINGS_PATH" >&2
  exit 1
fi

rendered_config="$(
  python3 - "$CONFIG_PATH" "$BINDINGS_PATH" <<'PY'
import copy
import json
import os
import sys
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

config_path, bindings_path = sys.argv[1:3]

TOOL_ORDER = [
    "lookupPatient",
    "checkAvailability",
    "searchKnowledgeBase",
    "createEvent",
    "createReceptionTask",
    "sendSmsToReceptionists",
]

TOOL_ENDPOINTS = {
    "lookupPatient": "/webhook/ai-receptionist/lookup-patient",
    "checkAvailability": "/webhook/ai-receptionist/check-availability",
    "searchKnowledgeBase": "/webhook/ai-receptionist/search-knowledge-base",
    "createEvent": "/webhook/ai-receptionist/create-event",
    "createReceptionTask": "/webhook/ai-receptionist/create-reception-task",
    "sendSmsToReceptionists": "/webhook/ai-receptionist/send-sms-to-receptionists",
    "sendSmsToPatient": "/webhook/ai-receptionist/send-sms-to-patient",
}

OPTIONAL_TOOLS = {
    "sendSmsToReceptionists",
}

CALL_ENDED_ENDPOINT = "/webhook/ai-receptionist/vapi-call-ended"


def append_secret(url: str, secret: str) -> str:
    if not secret:
        return url
    split = urlsplit(url)
    query = dict(parse_qsl(split.query, keep_blank_values=True))
    query["secret"] = secret
    return urlunsplit(
        (split.scheme, split.netloc, split.path, urlencode(query), split.fragment)
    )


def deep_merge(base, override):
    if not isinstance(base, dict) or not isinstance(override, dict):
        return copy.deepcopy(override)

    merged = copy.deepcopy(base)
    for key, value in override.items():
        existing = merged.get(key)
        if isinstance(existing, dict) and isinstance(value, dict):
            merged[key] = deep_merge(existing, value)
        else:
            merged[key] = copy.deepcopy(value)
    return merged


with open(config_path, "r", encoding="utf-8") as handle:
    shared = json.load(handle)

with open(bindings_path, "r", encoding="utf-8") as handle:
    bindings = json.load(handle)

assistant_id = (bindings.get("assistantId") or "").strip()
if not assistant_id:
    raise SystemExit(f"assistantId is required in {bindings_path}")

public_base_url_env = bindings.get("publicBaseUrlEnv")
if not isinstance(public_base_url_env, str) or not public_base_url_env.strip():
    raise SystemExit(f"publicBaseUrlEnv is required in {bindings_path}")

public_base_url = (os.environ.get(public_base_url_env) or "").strip().rstrip("/")
if not public_base_url and bindings.get("environment") == "production":
    legacy_domain = (os.environ.get("N8N_DOMAIN") or "").strip()
    if legacy_domain:
        public_base_url = f"https://{legacy_domain}".rstrip("/")
if not public_base_url:
    raise SystemExit(f"{public_base_url_env} is required in the environment")

webhook_secret_env = bindings.get("webhookSecretEnv")
webhook_secret = ""
if isinstance(webhook_secret_env, str) and webhook_secret_env.strip():
    webhook_secret = (os.environ.get(webhook_secret_env) or "").strip()
if not webhook_secret and bindings.get("environment") == "production":
    webhook_secret = (os.environ.get("AI_RECEPTIONIST_WEBHOOK_SECRET") or "").strip()

tool_id_map = bindings.get("toolIds")
if not isinstance(tool_id_map, dict):
    raise SystemExit(f"toolIds must be an object in {bindings_path}")

tool_ids = []
tool_bindings = []
for tool_name in TOOL_ORDER:
    tool_id = (tool_id_map.get(tool_name) or "").strip()
    if not tool_id:
        if tool_name in OPTIONAL_TOOLS:
            continue
        raise SystemExit(f"toolIds.{tool_name} is required in {bindings_path}")
    tool_ids.append(tool_id)
    tool_bindings.append(
        {
            "name": tool_name,
            "id": tool_id,
            "serverUrl": append_secret(
                f"{public_base_url}{TOOL_ENDPOINTS[tool_name]}",
                webhook_secret,
            ),
        }
    )

assistant = copy.deepcopy(shared.get("assistant") or {})
assistant_name = bindings.get("assistantName")
if isinstance(assistant_name, str) and assistant_name.strip():
    assistant["name"] = assistant_name.strip()

assistant_overrides = bindings.get("assistantOverrides")
if isinstance(assistant_overrides, dict):
    assistant = deep_merge(assistant, assistant_overrides)

model = assistant.setdefault("model", {})
model["toolIds"] = tool_ids

artifact_plan = assistant.setdefault("artifactPlan", {})
structured_output_ids = bindings.get("structuredOutputIds")
if isinstance(structured_output_ids, list):
    artifact_plan["structuredOutputIds"] = structured_output_ids
else:
    artifact_plan["structuredOutputIds"] = []

scorecard_ids = bindings.get("scorecardIds")
if isinstance(scorecard_ids, list):
    artifact_plan["scorecardIds"] = scorecard_ids
else:
    artifact_plan["scorecardIds"] = []

server = assistant.setdefault("server", {})
server["url"] = append_secret(
    f"{public_base_url}{CALL_ENDED_ENDPOINT}",
    webhook_secret,
)

rendered = copy.deepcopy(shared)
rendered["assistantId"] = assistant_id
rendered["environment"] = bindings.get("environment")
rendered["assistant"] = assistant
rendered["toolBindings"] = tool_bindings

print(json.dumps(rendered, ensure_ascii=True, indent=2))
PY
)"

if [ -n "$OUTPUT_PATH" ]; then
  printf '%s\n' "$rendered_config" > "$OUTPUT_PATH"
else
  printf '%s\n' "$rendered_config"
fi
