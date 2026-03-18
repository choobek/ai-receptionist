#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_REF="${1:-}"

if [ -z "$TARGET_REF" ]; then
  echo "Usage: ./scripts/promote-to-production.sh <git-ref>" >&2
  exit 1
fi

if ! git -C "$ROOT_DIR" diff --quiet || ! git -C "$ROOT_DIR" diff --cached --quiet; then
  echo "Promotion requires a clean git worktree" >&2
  exit 1
fi

TARGET_COMMIT="$(git -C "$ROOT_DIR" rev-parse "$TARGET_REF^{commit}")"
CURRENT_COMMIT="$(git -C "$ROOT_DIR" rev-parse HEAD)"

if [ "$TARGET_COMMIT" != "$CURRENT_COMMIT" ]; then
  echo "Checkout $TARGET_COMMIT locally before promoting so repo files match the promoted release" >&2
  exit 1
fi

"$ROOT_DIR/scripts/sync-n8n-workflow-data.sh" --check
"$ROOT_DIR/scripts/deploy-vps.sh" production "$TARGET_COMMIT"
"$ROOT_DIR/scripts/sync-environment.sh" production
