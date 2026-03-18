#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=./lib/env-context.sh
. "$ROOT_DIR/scripts/lib/env-context.sh"

load_root_env

if ! command -v node >/dev/null 2>&1; then
  echo "node is required" >&2
  exit 1
fi

if [ -z "${STAGING_VAPI_API_KEY:-${VAPI_API_KEY:-}}" ]; then
  echo "STAGING_VAPI_API_KEY or VAPI_API_KEY is required" >&2
  exit 1
fi

exec node "$ROOT_DIR/scripts/autonomy/run-staging-regression-suite.js" "$@"
