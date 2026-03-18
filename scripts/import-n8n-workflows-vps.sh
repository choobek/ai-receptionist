#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=./lib/env-context.sh
. "$ROOT_DIR/scripts/lib/env-context.sh"

ENVIRONMENT="$(normalize_deploy_environment "${1:-production}")"

load_root_env

legacy_vps_ssh_host=""
legacy_vps_ssh_user=""
legacy_vps_ssh_port=""
legacy_vps_ssh_identity_file=""
legacy_vps_app_dir=""
legacy_vps_n8n_container_name=""

if [ "$ENVIRONMENT" = "production" ]; then
  legacy_vps_ssh_host="VPS_SSH_HOST"
  legacy_vps_ssh_user="VPS_SSH_USER"
  legacy_vps_ssh_port="VPS_SSH_PORT"
  legacy_vps_ssh_identity_file="VPS_SSH_IDENTITY_FILE"
  legacy_vps_app_dir="VPS_APP_DIR"
  legacy_vps_n8n_container_name="VPS_N8N_CONTAINER_NAME"
fi

VPS_SSH_HOST="$(require_context_value "$ENVIRONMENT" "VPS_SSH_HOST" "$legacy_vps_ssh_host" "VPS_SSH_HOST")"
VPS_SSH_USER="$(require_context_value "$ENVIRONMENT" "VPS_SSH_USER" "$legacy_vps_ssh_user" "VPS_SSH_USER")"
VPS_SSH_PORT="$(get_context_value "$ENVIRONMENT" "VPS_SSH_PORT" "$legacy_vps_ssh_port")"
VPS_SSH_PORT="${VPS_SSH_PORT:-22}"
VPS_SSH_IDENTITY_FILE="$(get_context_value "$ENVIRONMENT" "VPS_SSH_IDENTITY_FILE" "$legacy_vps_ssh_identity_file")"
VPS_APP_DIR="$(require_context_value "$ENVIRONMENT" "VPS_APP_DIR" "$legacy_vps_app_dir" "VPS_APP_DIR")"
VPS_N8N_CONTAINER_NAME="$(get_context_value "$ENVIRONMENT" "VPS_N8N_CONTAINER_NAME" "$legacy_vps_n8n_container_name")"

ssh_args=(-p "$VPS_SSH_PORT")
if [ -n "$VPS_SSH_IDENTITY_FILE" ]; then
  ssh_args+=(-i "$VPS_SSH_IDENTITY_FILE")
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"

ssh "${ssh_args[@]}" "${VPS_SSH_USER}@${VPS_SSH_HOST}" \
  "APP_DIR='$VPS_APP_DIR' REMOTE_CONTAINER='$VPS_N8N_CONTAINER_NAME' TIMESTAMP='$timestamp' bash -s" <<'EOF'
set -euo pipefail

cd "$APP_DIR"
CONTAINER="${REMOTE_CONTAINER:-${N8N_CONTAINER_NAME:-ai-receptionist-n8n}}"
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
echo "Run ./scripts/reconcile-n8n-workflows-vps.sh before unpublishing the currently active workflows."
EOF
