from __future__ import annotations

import sys
from typing import Any

from mcp.server.fastmcp import FastMCP

from codex.mcp.shared.common import RepoContext, resolve_repo_path, run_command
from codex.mcp.shared.healthcheck import run_self_check
from codex.mcp.shared.ops_guard import (
    issue_stage_write_ticket as issue_stage_write_ticket_impl,
    stage_write_surface_map,
)


def build_server() -> FastMCP:
    context = RepoContext.discover()
    server = FastMCP(
        name="ops-guard",
        instructions=(
            "Guarded staging-only orchestration for ai-receptionist. This server must refuse production, "
            "issue approval tickets for staging writes, and route sync operations through the repo-backed "
            "evidence wrapper."
        ),
    )

    @server.tool(description="Return the allowed staging write scopes, command plans, and production refusal policy.")
    def policy_surface_map() -> dict[str, Any]:
        surface = stage_write_surface_map()
        surface["wrapperScript"] = "./scripts/codex/staging-sync-with-evidence.sh"
        return surface

    @server.tool(description="Issue a short-lived approval ticket for a guarded staging write scope.")
    def issue_stage_write_ticket(
        scope: str = "full",
        environment: str = "staging",
        ttl_seconds: int = 1800,
    ) -> dict[str, Any]:
        return issue_stage_write_ticket_impl(
            context,
            scope=scope,
            environment=environment,
            ttl_seconds=ttl_seconds,
        )

    @server.tool(description="Run the guarded staging sync wrapper with before/after evidence. Production is refused.")
    def run_staging_sync_with_evidence(
        scope: str = "full",
        include_saved_eval: bool = False,
        skip_live_autoeval: bool = False,
        since_hours: int = 72,
        live_limit: int = 15,
        dry_run: bool = False,
        output_dir: str | None = None,
        report_path: str | None = None,
        summary_json: str | None = None,
    ) -> dict[str, Any]:
        command = [
            "./scripts/codex/staging-sync-with-evidence.sh",
            "--scope",
            scope,
            "--environment",
            "staging",
            "--since-hours",
            str(since_hours),
            "--live-limit",
            str(live_limit),
        ]
        if include_saved_eval:
            command.append("--include-saved-eval")
        if skip_live_autoeval:
            command.append("--skip-live-autoeval")
        approval: dict[str, Any] | None = None
        if dry_run:
            command.append("--dry-run")
        else:
            approval = issue_stage_write_ticket_impl(context, scope=scope, environment="staging")
            command.extend(["--approval-token", approval["approvalToken"]])
        if output_dir:
            command.extend(["--output-dir", str(resolve_repo_path(context, output_dir))])
        if report_path:
            command.extend(["--report", str(resolve_repo_path(context, report_path))])
        if summary_json:
            command.extend(["--summary-json", str(resolve_repo_path(context, summary_json))])
        result = run_command(context, command, timeout_seconds=10800)
        return {
            "approval": None
            if approval is None
            else {
                "tokenId": approval["tokenId"],
                "ticketPath": approval["ticketPath"],
                "expiresAt": approval["expiresAt"],
                "scope": approval["scope"],
            },
            "run": result,
        }

    return server


def main(argv: list[str] | None = None) -> int:
    args = argv or sys.argv[1:]
    server = build_server()
    if "--self-check" in args:
        run_self_check(server, smoke_tool_name="policy_surface_map")
        return 0
    server.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
