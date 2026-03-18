#!/usr/bin/env bash

if [ -z "${ROOT_DIR:-}" ]; then
  ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi

load_root_env() {
  if [ -f "$ROOT_DIR/.env" ]; then
    set -a
    # shellcheck source=/dev/null
    . "$ROOT_DIR/.env"
    set +a
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
