#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
N8N_ENV_FILE="${N8N_ENV_FILE:-$ROOT_DIR/n8n/.env}"
PUBLIC_BASE_URL="${1:-}"

if [ -z "$PUBLIC_BASE_URL" ]; then
  echo "Usage: ./scripts/update-n8n-public-url.sh https://your-public-url" >&2
  exit 1
fi

if [ ! -f "$N8N_ENV_FILE" ]; then
  echo "n8n env file not found: $N8N_ENV_FILE" >&2
  exit 1
fi

normalized_base="${PUBLIC_BASE_URL%/}"
normalized_webhook_url="${normalized_base}/"

tmp_file="$(mktemp)"
cleanup() {
  rm -f "$tmp_file"
}
trap cleanup EXIT

awk -v webhook_url="$normalized_webhook_url" -v editor_url="$normalized_base" '
  BEGIN {
    webhook_set = 0;
    editor_set = 0;
  }
  /^WEBHOOK_URL=/ {
    print "WEBHOOK_URL=" webhook_url;
    webhook_set = 1;
    next;
  }
  /^N8N_EDITOR_BASE_URL=/ {
    print "N8N_EDITOR_BASE_URL=" editor_url;
    editor_set = 1;
    next;
  }
  { print }
  END {
    if (!webhook_set) print "WEBHOOK_URL=" webhook_url;
    if (!editor_set) print "N8N_EDITOR_BASE_URL=" editor_url;
  }
' "$N8N_ENV_FILE" > "$tmp_file"

mv "$tmp_file" "$N8N_ENV_FILE"

echo "Updated $N8N_ENV_FILE"
echo
echo "Restart n8n to apply the new public URL:"
echo "  cd n8n && docker-compose up -d"
echo
echo "Public endpoints to use:"
echo "  checkAvailability: ${normalized_base}/webhook/ai-receptionist/check-availability"
echo "  createEvent: ${normalized_base}/webhook/ai-receptionist/create-event"
echo "  vapi call.ended router: ${normalized_base}/webhook/ai-receptionist/vapi-call-ended"
