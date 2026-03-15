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

if [ -z "$VPS_SSH_HOST" ] || [ -z "$VPS_SSH_USER" ] || [ -z "$VPS_APP_DIR" ]; then
  echo "VPS_SSH_HOST, VPS_SSH_USER, and VPS_APP_DIR are required" >&2
  exit 1
fi

ssh_args=(-p "$VPS_SSH_PORT")
if [ -n "$VPS_SSH_IDENTITY_FILE" ]; then
  ssh_args+=(-i "$VPS_SSH_IDENTITY_FILE")
fi

ssh "${ssh_args[@]}" "${VPS_SSH_USER}@${VPS_SSH_HOST}" "APP_DIR='$VPS_APP_DIR' bash -s" <<'EOF'
set -euo pipefail

cd "$APP_DIR"
git fetch --all --prune
git pull --ff-only

if command -v docker-compose >/dev/null 2>&1; then
  set -a
  . ./.env
  set +a
  docker-compose -f deploy/vps/docker-compose.yml up -d
elif docker compose version >/dev/null 2>&1; then
  docker compose --env-file .env -f deploy/vps/docker-compose.yml up -d
else
  echo "Neither docker-compose nor docker compose is available on the VPS" >&2
  exit 1
fi
EOF
