#!/usr/bin/env bash

if [ -z "${ROOT_DIR:-}" ]; then
  ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi

load_root_env() {
  if [ -f "$ROOT_DIR/.env" ]; then
    local exports
    exports="$(
      python3 - "$ROOT_DIR/.env" <<'PY'
import shlex
import sys

env_path = sys.argv[1]

with open(env_path, "r", encoding="utf-8") as handle:
    for raw_line in handle:
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        if not key:
            continue

        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            quote = value[0]
            value = value[1:-1]
            if quote == '"':
                value = bytes(value, "utf-8").decode("unicode_escape")

        print(f"export {key}={shlex.quote(value)}")
PY
    )"
    eval "$exports"
  fi
}

normalize_deploy_environment() {
  local environment="${1:-production}"
  case "$environment" in
    production|staging)
      printf '%s\n' "$environment"
      ;;
    *)
      echo "Environment must be staging or production" >&2
      return 1
      ;;
  esac
}

environment_prefix() {
  printf '%s\n' "$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')"
}

get_context_value() {
  local environment="$1"
  local key="$2"
  local legacy_var="${3:-}"
  local prefix
  local var_name
  local value

  prefix="$(environment_prefix "$environment")"
  var_name="${prefix}_${key}"
  value="${!var_name:-}"

  if [ -z "$value" ] && [ -n "$legacy_var" ]; then
    value="${!legacy_var:-}"
  fi

  printf '%s' "$value"
}

require_context_value() {
  local environment="$1"
  local key="$2"
  local legacy_var="${3:-}"
  local label="${4:-$key}"
  local value

  value="$(get_context_value "$environment" "$key" "$legacy_var")"
  if [ -z "$value" ]; then
    echo "$label is required for $environment" >&2
    return 1
  fi

  printf '%s' "$value"
}
