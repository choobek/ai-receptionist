from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP

from codex.mcp.shared.common import RepoContext, resolve_repo_path, run_command
from codex.mcp.shared.healthcheck import run_self_check


def build_server() -> FastMCP:
    context = RepoContext.discover()
    server = FastMCP(
        name="repo-verify",
        instructions=(
            "Read-only execution access to repo-native verification lanes for the ai-receptionist "
            "project. This server must not edit files or mutate staging or production runtime state."
        ),
    )

    def _append_path_args(
        command: list[str],
        *,
        output_dir: str | None = None,
        report_path: str | None = None,
        summary_json: str | None = None,
    ) -> list[str]:
        if output_dir:
            command.extend(["--output-dir", str(resolve_repo_path(context, output_dir))])
        if report_path:
            command.extend(["--report", str(resolve_repo_path(context, report_path))])
        if summary_json:
            command.extend(["--summary-json", str(resolve_repo_path(context, summary_json))])
        return command

    @server.tool(description="Return the canonical verification lane order, blocking policy, and artifact roots.")
    def verification_surface_map() -> dict[str, Any]:
        return {
            "blockingOrder": [
                "./scripts/check-repo-health.sh",
                "node scripts/check-workflow-regressions.js",
                "./scripts/run-staging-regression-suite.sh",
            ],
            "advisoryLanes": [
                "./scripts/run-vapi-eval-suite.sh staging",
            ],
            "evidenceLanes": [
                "./scripts/run-vapi-live-autoeval.sh staging",
            ],
            "codexWrapper": "./scripts/codex/run-staging-release-gate.sh",
            "artifactRoots": {
                "codexRuns": "autonomy/runs/generated/codex/",
                "codexReports": "autonomy/reports/generated/codex/",
                "stagingRuns": "autonomy/runs/generated/staging/",
                "stagingReports": "autonomy/reports/generated/staging/",
                "vapiEvalRuns": "autonomy/runs/generated/vapi-evals/",
                "vapiEvalReports": "autonomy/reports/generated/vapi-evals/",
                "liveAutoevalRuns": "autonomy/runs/generated/vapi-live-autoeval/",
                "liveAutoevalReports": "autonomy/reports/generated/vapi-live-autoeval/",
            },
        }

    @server.tool(description="Run the repo health check script.")
    def check_repo_health() -> dict[str, Any]:
        return run_command(context, ["./scripts/check-repo-health.sh"])

    @server.tool(description="Run backend workflow regression checks.")
    def run_backend_regressions(include_experimental: bool = False) -> dict[str, Any]:
        command = ["node", "scripts/check-workflow-regressions.js"]
        if include_experimental:
            command.append("--include-experimental")
        return run_command(context, command)

    @server.tool(description="Run the staging chat regression suite with optional artifact overrides.")
    def run_staging_chat_gate(
        scenario_ids: list[str] | None = None,
        include_draft: bool = False,
        output_dir: str | None = None,
        report_path: str | None = None,
    ) -> dict[str, Any]:
        command = ["./scripts/run-staging-regression-suite.sh"]
        if include_draft:
            command.append("--include-draft")
        for scenario_id in scenario_ids or []:
            command.extend(["--scenario", scenario_id])
        command = _append_path_args(command, output_dir=output_dir, report_path=report_path)
        return run_command(context, command)

    @server.tool(description="Run the saved Vapi eval lane for staging or production. Treat the result as diagnostic only.")
    def run_saved_vapi_eval_lane(environment: str = "staging") -> dict[str, Any]:
        if environment not in {"staging", "production"}:
            raise ValueError("environment must be staging or production")
        return run_command(context, ["./scripts/run-vapi-eval-suite.sh", environment])

    @server.tool(description="Run the live Vapi autoevaluation lane with optional artifact overrides.")
    def run_live_vapi_autoeval(
        environment: str = "staging",
        since_hours: int = 72,
        limit: int = 15,
        fail_on_review: bool = False,
        output_dir: str | None = None,
        report_path: str | None = None,
        summary_json: str | None = None,
    ) -> dict[str, Any]:
        if environment not in {"staging", "production"}:
            raise ValueError("environment must be staging or production")
        command = [
            "./scripts/run-vapi-live-autoeval.sh",
            environment,
            "--since-hours",
            str(since_hours),
            "--limit",
            str(limit),
        ]
        if fail_on_review:
            command.append("--fail-on-review")
        command = _append_path_args(
            command,
            output_dir=output_dir,
            report_path=report_path,
            summary_json=summary_json,
        )
        return run_command(context, command)

    @server.tool(description="Run the Codex-facing staging release gate wrapper and capture a single evidence packet.")
    def run_staging_release_gate(
        include_saved_eval: bool = False,
        skip_live_autoeval: bool = False,
        since_hours: int = 72,
        live_limit: int = 15,
        output_dir: str | None = None,
        report_path: str | None = None,
    ) -> dict[str, Any]:
        command = [
            "./scripts/codex/run-staging-release-gate.sh",
            "--since-hours",
            str(since_hours),
            "--live-limit",
            str(live_limit),
        ]
        if include_saved_eval:
            command.append("--include-saved-eval")
        if skip_live_autoeval:
            command.append("--skip-live-autoeval")
        command = _append_path_args(command, output_dir=output_dir, report_path=report_path)
        return run_command(context, command)

    return server


def main(argv: list[str] | None = None) -> int:
    args = argv or sys.argv[1:]
    server = build_server()
    if "--self-check" in args:
        run_self_check(server, smoke_tool_name="verification_surface_map")
        return 0
    server.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
