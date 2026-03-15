#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for env_file in "$ROOT_DIR/.env" "$ROOT_DIR/.env.local"; do
  if [ -f "$env_file" ]; then
    set -a
    # shellcheck source=/dev/null
    . "$env_file"
    set +a
  fi
done

VPS_SSH_HOST="${VPS_SSH_HOST:-}"
VPS_SSH_USER="${VPS_SSH_USER:-}"
VPS_SSH_PORT="${VPS_SSH_PORT:-22}"
VPS_SSH_IDENTITY_FILE="${VPS_SSH_IDENTITY_FILE:-}"
VPS_APP_DIR="${VPS_APP_DIR:-}"
VPS_N8N_CONTAINER_NAME="${VPS_N8N_CONTAINER_NAME:-ai-receptionist-n8n}"

if [ -z "$VPS_SSH_HOST" ] || [ -z "$VPS_SSH_USER" ] || [ -z "$VPS_APP_DIR" ]; then
  echo "VPS_SSH_HOST, VPS_SSH_USER, and VPS_APP_DIR are required" >&2
  exit 1
fi

ssh_args=(-p "$VPS_SSH_PORT")
if [ -n "$VPS_SSH_IDENTITY_FILE" ]; then
  ssh_args+=(-i "$VPS_SSH_IDENTITY_FILE")
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"

ssh "${ssh_args[@]}" "${VPS_SSH_USER}@${VPS_SSH_HOST}" \
  "APP_DIR='$VPS_APP_DIR' CONTAINER='$VPS_N8N_CONTAINER_NAME' TIMESTAMP='$timestamp' bash -s" <<'EOF'
set -euo pipefail

cd "$APP_DIR"
BACKUP_DIR="$APP_DIR/backups/n8n/$TIMESTAMP"
mkdir -p "$BACKUP_DIR"

docker exec "$CONTAINER" rm -rf /tmp/n8n-workflows-backup /tmp/n8n-workflows-import
docker exec "$CONTAINER" mkdir -p /tmp/n8n-workflows-backup /tmp/n8n-workflows-import
docker exec "$CONTAINER" n8n export:workflow --backup --output=/tmp/n8n-workflows-backup
docker cp "$CONTAINER:/tmp/n8n-workflows-backup/." "$BACKUP_DIR/"
docker cp "$APP_DIR/n8n/workflows/." "$CONTAINER:/tmp/n8n-workflows-import/"
docker exec "$CONTAINER" n8n import:workflow --separate --input=/tmp/n8n-workflows-import
docker exec "$CONTAINER" n8n list:workflow

echo
echo "Workflow backup saved to $BACKUP_DIR"
echo "Warning: imported workflows may be inactive drafts without credentials."
echo "Review credentials and publish state before unpublishing the currently active workflows."
EOF
