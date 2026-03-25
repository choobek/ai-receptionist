from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP

from codex.mcp.shared.common import (
    RepoContext,
    merged_env,
    read_text_slice,
    redact_text,
    redact_value,
    run_command,
)
from codex.mcp.shared.healthcheck import run_self_check


def build_server() -> FastMCP:
    context = RepoContext.discover()
    server = FastMCP(
        name="repo-read",
        instructions=(
            "Read-only access to canonical repo state, rendered Vapi config, git metadata, "
            "and doc search for the ai-receptionist project."
        ),
    )

    @server.tool(
        description="Return the repo's source-of-truth files, generated artifact roots, and key operational docs."
    )
    def source_of_truth_map() -> dict[str, Any]:
        return {
            "repoRoot": str(context.root_dir),
            "rootEnvTemplate": ".env.example",
            "rootEnvFile": ".env",
            "vapi": {
                "assistantConfig": "configs/vapi/assistant.v2.json",
                "environmentBindings": [
                    "configs/vapi/environments/staging.json",
                    "configs/vapi/environments/production.json",
                ],
                "structuredOutputs": "configs/vapi/structured-outputs/",
                "scorecards": "configs/vapi/scorecards/",
                "evals": "configs/vapi/evals/",
                "autoevaluationPolicy": "configs/vapi/autoevaluation-policy.v1.json",
                "promptMirrors": [
                    "prompts/system-prompt.md",
                    "prompts/first-message.md",
                ],
            },
            "n8n": {
                "workflows": "n8n/workflows/",
                "serviceCatalog": "configs/services/catalog.v1.json",
                "mockPatients": "mock-data/mock-patients.json",
                "knowledgeBase": "knowledge-base/clinic-knowledge.json",
            },
            "generatedArtifacts": {
                "codexRuns": "autonomy/runs/generated/codex/",
                "codexReports": "autonomy/reports/generated/codex/",
                "stagingRuns": "autonomy/runs/generated/staging/",
                "stagingReports": "autonomy/reports/generated/staging/",
            },
            "docs": [
                "AGENTS.md",
                "docs/operations-runbook.md",
                "docs/environment-separation.md",
                "docs/testing-strategy.md",
                "docs/autonomy-loop.md",
                "docs/vapi-observability.md",
            ],
        }

    @server.tool(description="Return git branch, HEAD SHA, worktree cleanliness, and short status output.")
    def git_overview() -> dict[str, Any]:
        head = run_command(context, ["git", "-C", str(context.root_dir), "rev-parse", "HEAD"])
        branch = run_command(
            context,
            ["git", "-C", str(context.root_dir), "rev-parse", "--abbrev-ref", "HEAD"],
        )
        status = run_command(context, ["git", "-C", str(context.root_dir), "status", "--short"])
        return {
            "head": head["stdout"].strip(),
            "branch": branch["stdout"].strip(),
            "clean": status["stdout"].strip() == "",
            "statusShort": status["stdout"].splitlines(),
        }

    @server.tool(description="Read a UTF-8 text file from inside the repo with line slicing and secret redaction.")
    def read_repo_file(
        path: str,
        start_line: int = 1,
        line_count: int = 200,
    ) -> dict[str, Any]:
        return read_text_slice(context, path, start_line=start_line, line_count=line_count)

    @server.tool(description="Find repo files with ripgrep globs.")
    def find_repo_files(glob: str, max_results: int = 200) -> dict[str, Any]:
        if max_results < 1 or max_results > 500:
            raise ValueError("max_results must be between 1 and 500")
        result = run_command(context, ["rg", "--files", "-g", glob])
        files = [line for line in result["stdout"].splitlines() if line][:max_results]
        return {
            "glob": glob,
            "count": len(files),
            "truncated": len(result["stdout"].splitlines()) > len(files),
            "files": files,
        }

    @server.tool(description="Search repo text with ripgrep and return redacted line matches.")
    def search_repo(pattern: str, glob: str | None = None, max_matches: int = 50) -> dict[str, Any]:
        if max_matches < 1 or max_matches > 200:
            raise ValueError("max_matches must be between 1 and 200")
        command = ["rg", "--json", "--line-number", "--color", "never", pattern]
        if glob:
            command.extend(["-g", glob])
        result = run_command(context, command)
        matches: list[dict[str, Any]] = []
        env = merged_env(context)
        for raw_line in result["stdout"].splitlines():
            if not raw_line.startswith("{"):
                continue
            event = json.loads(raw_line)
            if event.get("type") != "match":
                continue
            data = event.get("data", {})
            line_text = data.get("lines", {}).get("text", "").rstrip("\n")
            matches.append(
                {
                    "path": data.get("path", {}).get("text", ""),
                    "lineNumber": data.get("line_number"),
                    "line": redact_text(line_text, env=env),
                }
            )
            if len(matches) >= max_matches:
                break
        return {
            "pattern": pattern,
            "glob": glob,
            "count": len(matches),
            "matches": matches,
            "searchOk": result["ok"],
            "stderr": result["stderr"],
        }

    @server.tool(
        description="Render the effective Vapi assistant config for staging or production using the repo's existing script."
    )
    def render_vapi_assistant(environment: str = "staging") -> dict[str, Any]:
        if environment not in {"staging", "production"}:
            raise ValueError("environment must be staging or production")
        env = merged_env(context)
        result = run_command(
            context,
            ["./scripts/render-vapi-assistant-config.sh", environment],
            redact_output=False,
        )
        rendered = None
        if result["ok"] and result["stdout"].strip():
            rendered = redact_value(json.loads(result["stdout"]), env=env)
        return {
            "environment": environment,
            "bindingsPath": f"configs/vapi/environments/{environment}.json",
            "command": result["command"],
            "ok": result["ok"],
            "returncode": result["returncode"],
            "stderr": redact_text(result["stderr"], env=env),
            "rendered": rendered,
        }

    return server


def main(argv: list[str] | None = None) -> int:
    args = argv or sys.argv[1:]
    server = build_server()
    if "--self-check" in args:
        run_self_check(server, smoke_tool_name="source_of_truth_map")
        return 0
    server.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
