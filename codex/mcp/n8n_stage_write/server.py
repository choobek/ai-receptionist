from __future__ import annotations

import sys
from typing import Any

from mcp.server.fastmcp import FastMCP

from codex.mcp.shared.common import RepoContext, resolve_repo_path, run_command
from codex.mcp.shared.healthcheck import run_self_check
from codex.mcp.shared.ops_guard import stage_write_surface_map


def build_server() -> FastMCP:
    context = RepoContext.discover()
    server = FastMCP(
        name="n8n-stage-write",
        instructions=(
            "Guarded staging-only n8n write access for ai-receptionist. This server must require an "
            "ops-guard approval ticket and route all writes through the staging evidence wrapper."
        ),
    )

    @server.tool(description="Return the guarded n8n write scope and its import-plus-reconcile route.")
    def write_surface_map() -> dict[str, Any]:
        surface = stage_write_surface_map()
        surface["scopes"] = [item for item in surface["scopes"] if item["scope"] == "n8n"]
        surface["wrapperScript"] = "./scripts/codex/staging-sync-with-evidence.sh"
        return surface

    @server.tool(description="Run a guarded staging n8n workflow sync through data-check, import, and reconcile.")
    def run_guarded_n8n_sync(
        approval_token: str,
        skip_live_autoeval: bool = False,
        include_saved_eval: bool = False,
        since_hours: int = 72,
        live_limit: int = 15,
        output_dir: str | None = None,
        report_path: str | None = None,
        summary_json: str | None = None,
    ) -> dict[str, Any]:
        command = [
            "./scripts/codex/staging-sync-with-evidence.sh",
            "--scope",
            "n8n",
            "--environment",
            "staging",
            "--approval-token",
            approval_token,
            "--since-hours",
            str(since_hours),
            "--live-limit",
            str(live_limit),
        ]
        if skip_live_autoeval:
            command.append("--skip-live-autoeval")
        if include_saved_eval:
            command.append("--include-saved-eval")
        if output_dir:
            command.extend(["--output-dir", str(resolve_repo_path(context, output_dir))])
        if report_path:
            command.extend(["--report", str(resolve_repo_path(context, report_path))])
        if summary_json:
            command.extend(["--summary-json", str(resolve_repo_path(context, summary_json))])
        return run_command(context, command, timeout_seconds=10800)

    return server


def main(argv: list[str] | None = None) -> int:
    args = argv or sys.argv[1:]
    server = build_server()
    if "--self-check" in args:
        run_self_check(server, smoke_tool_name="write_surface_map")
        return 0
    server.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
