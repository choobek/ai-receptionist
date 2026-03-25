#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required" >&2
  exit 1
fi

cd "$ROOT_DIR"

echo "Checking repo-read MCP server..."
python3 -m codex.mcp.repo_read.server --self-check

echo "Checking repo-verify MCP server..."
python3 -m codex.mcp.repo_verify.server --self-check

echo "Checking vapi-read MCP server..."
python3 -m codex.mcp.vapi_read.server --self-check

echo "Checking n8n-read MCP server..."
python3 -m codex.mcp.n8n_read.server --self-check

echo "Checking ops-guard MCP server..."
python3 -m codex.mcp.ops_guard.server --self-check

echo "Checking vapi-stage-write MCP server..."
python3 -m codex.mcp.vapi_stage_write.server --self-check

echo "Checking n8n-stage-write MCP server..."
python3 -m codex.mcp.n8n_stage_write.server --self-check

echo "Codex MCP health check passed."
