#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=./lib/env-context.sh
. "$ROOT_DIR/scripts/lib/env-context.sh"

ENVIRONMENT="$(normalize_deploy_environment "${1:-production}")"

"$ROOT_DIR/scripts/sync-n8n-workflow-data.sh" --check
"$ROOT_DIR/scripts/import-n8n-workflows-vps.sh" "$ENVIRONMENT"
"$ROOT_DIR/scripts/reconcile-n8n-workflows-vps.sh" "$ENVIRONMENT"
"$ROOT_DIR/scripts/sync-vapi-environment.sh" "$ENVIRONMENT"
"$ROOT_DIR/scripts/sync-vps-sms-config.sh" "$ENVIRONMENT"
