#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=./lib/env-context.sh
. "$ROOT_DIR/scripts/lib/env-context.sh"

ENVIRONMENT="$(normalize_deploy_environment "${1:-production}")"
GIT_REF="${2:-}"

load_root_env

legacy_vps_ssh_host=""
legacy_vps_ssh_user=""
legacy_vps_ssh_port=""
legacy_vps_ssh_identity_file=""
legacy_vps_app_dir=""
legacy_vps_git_remote_ssh_url=""
legacy_vps_compose_file=""
legacy_vps_compose_project_name=""

if [ "$ENVIRONMENT" = "production" ]; then
  legacy_vps_ssh_host="VPS_SSH_HOST"
  legacy_vps_ssh_user="VPS_SSH_USER"
  legacy_vps_ssh_port="VPS_SSH_PORT"
  legacy_vps_ssh_identity_file="VPS_SSH_IDENTITY_FILE"
  legacy_vps_app_dir="VPS_APP_DIR"
  legacy_vps_git_remote_ssh_url="VPS_GIT_REMOTE_SSH_URL"
  legacy_vps_compose_file="VPS_COMPOSE_FILE"
  legacy_vps_compose_project_name="VPS_COMPOSE_PROJECT_NAME"
fi

VPS_SSH_HOST="$(require_context_value "$ENVIRONMENT" "VPS_SSH_HOST" "$legacy_vps_ssh_host" "VPS_SSH_HOST")"
VPS_SSH_USER="$(require_context_value "$ENVIRONMENT" "VPS_SSH_USER" "$legacy_vps_ssh_user" "VPS_SSH_USER")"
VPS_SSH_PORT="$(get_context_value "$ENVIRONMENT" "VPS_SSH_PORT" "$legacy_vps_ssh_port")"
VPS_SSH_PORT="${VPS_SSH_PORT:-22}"
VPS_SSH_IDENTITY_FILE="$(get_context_value "$ENVIRONMENT" "VPS_SSH_IDENTITY_FILE" "$legacy_vps_ssh_identity_file")"
VPS_APP_DIR="$(require_context_value "$ENVIRONMENT" "VPS_APP_DIR" "$legacy_vps_app_dir" "VPS_APP_DIR")"
VPS_GIT_REMOTE_SSH_URL="$(get_context_value "$ENVIRONMENT" "VPS_GIT_REMOTE_SSH_URL" "$legacy_vps_git_remote_ssh_url")"
VPS_COMPOSE_FILE="$(get_context_value "$ENVIRONMENT" "VPS_COMPOSE_FILE" "$legacy_vps_compose_file")"
VPS_COMPOSE_FILE="${VPS_COMPOSE_FILE:-deploy/vps/docker-compose.yml}"
VPS_COMPOSE_PROJECT_NAME="$(get_context_value "$ENVIRONMENT" "VPS_COMPOSE_PROJECT_NAME" "$legacy_vps_compose_project_name")"
VPS_COMPOSE_PROJECT_NAME="${VPS_COMPOSE_PROJECT_NAME:-$(basename "$VPS_APP_DIR")}"

if [ -z "$VPS_GIT_REMOTE_SSH_URL" ]; then
  origin_url="$(git -C "$ROOT_DIR" remote get-url origin)"
  if [[ "$origin_url" =~ ^https://github.com/(.+)/(.+)\.git$ ]]; then
    VPS_GIT_REMOTE_SSH_URL="git@github.com:${BASH_REMATCH[1]}/${BASH_REMATCH[2]}.git"
  else
    VPS_GIT_REMOTE_SSH_URL="$origin_url"
  fi
fi

ssh_args=(-A -p "$VPS_SSH_PORT")
if [ -n "$VPS_SSH_IDENTITY_FILE" ]; then
  ssh_args+=(-i "$VPS_SSH_IDENTITY_FILE")
fi

ssh "${ssh_args[@]}" "${VPS_SSH_USER}@${VPS_SSH_HOST}" \
  "APP_DIR='$VPS_APP_DIR' REMOTE_URL='$VPS_GIT_REMOTE_SSH_URL' TARGET_ENV='$ENVIRONMENT' GIT_REF='$GIT_REF' COMPOSE_FILE='$VPS_COMPOSE_FILE' COMPOSE_PROJECT_NAME='$VPS_COMPOSE_PROJECT_NAME' bash -s" <<'EOF'
set -euo pipefail

if [ ! -d "$APP_DIR/.git" ]; then
  mkdir -p "$(dirname "$APP_DIR")"
  git clone "$REMOTE_URL" "$APP_DIR"
fi

cd "$APP_DIR"
git remote set-url origin "$REMOTE_URL"

if [ ! -f .env ]; then
  if [ -f deploy/vps/.env ]; then
    cp deploy/vps/.env .env
  elif [ -f n8n/.env ]; then
    cp n8n/.env .env
  else
    echo "No root .env found and no legacy env file available to migrate" >&2
    exit 1
  fi
fi

git fetch --all --prune

if [ -n "$GIT_REF" ]; then
  git checkout --detach "$GIT_REF"
else
  current_branch="$(git symbolic-ref --quiet --short HEAD || true)"
  if [ -z "$current_branch" ]; then
    current_branch="main"
    git checkout "$current_branch"
  fi
  git pull --ff-only origin "$current_branch"
fi

./scripts/render-vps-caddy-fragments.sh .env

if docker compose version >/dev/null 2>&1; then
  docker compose --env-file .env -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" up -d
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" docker-compose -f "$COMPOSE_FILE" up -d
else
  echo "Neither docker-compose nor docker compose is available on the VPS" >&2
  exit 1
fi
EOF
