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

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is required" >&2
  exit 1
fi

for arg in "$@"; do
  if [ "$arg" = "--list" ]; then
    exec node "$ROOT_DIR/scripts/autonomy/run-staging-voice-smoke-suite.js" "$@"
  fi
done

if [ -z "${STAGING_VAPI_API_KEY:-${VAPI_API_KEY:-}}" ]; then
  echo "STAGING_VAPI_API_KEY or VAPI_API_KEY is required" >&2
  exit 1
fi

if [ -z "${STAGING_VAPI_WEB_TOKEN:-${STAGING_VAPI_PUBLIC_KEY:-${VAPI_WEB_TOKEN:-${VAPI_PUBLIC_KEY:-}}}}" ]; then
  echo "STAGING_VAPI_WEB_TOKEN, STAGING_VAPI_PUBLIC_KEY, VAPI_WEB_TOKEN, or VAPI_PUBLIC_KEY is required" >&2
  exit 1
fi

if [ ! -d "$ROOT_DIR/node_modules/playwright-core" ] || [ ! -d "$ROOT_DIR/node_modules/@vapi-ai/web" ]; then
  echo "Voice smoke suite dependencies are missing. Run: npm install" >&2
  exit 1
fi

exec node "$ROOT_DIR/scripts/autonomy/run-staging-voice-smoke-suite.js" "$@"
