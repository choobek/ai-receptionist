from __future__ import annotations

import sys
from typing import Any

from mcp.server.fastmcp import FastMCP

from codex.mcp.shared.common import RepoContext
from codex.mcp.shared.healthcheck import run_self_check
from codex.mcp.shared.vapi import (
    fetch_environment_runtime,
    fetch_recent_calls,
    load_environment_bindings,
)


def build_server() -> FastMCP:
    context = RepoContext.discover()
    server = FastMCP(
        name="vapi-read",
        instructions=(
            "Read-only Vapi API access for assistants, tools, calls, and observability resources "
            "for the ai-receptionist project."
        ),
    )

    @server.tool(description="Return the repo binding file content for a Vapi environment.")
    def vapi_environment_bindings(environment: str = "staging") -> dict[str, Any]:
        bindings = load_environment_bindings(context, environment)
        return {
            "environment": bindings.get("environment"),
            "assistantId": bindings.get("assistantId"),
            "assistantName": bindings.get("assistantName"),
            "toolIds": bindings.get("toolIds") or {},
            "structuredOutputIds": bindings.get("structuredOutputIds") or [],
            "scorecardIds": bindings.get("scorecardIds") or [],
            "phoneNumberId": bindings.get("phoneNumberId"),
            "phoneNumber": bindings.get("phoneNumber"),
            "bindingsPath": f"configs/vapi/environments/{bindings.get('environment')}.json",
        }

    @server.tool(description="Fetch the live Vapi assistant summary for the configured environment assistant.")
    def vapi_assistant_runtime(environment: str = "staging") -> dict[str, Any]:
        runtime = fetch_environment_runtime(context, environment)
        return {
            "environment": runtime["config"]["environment"],
            "assistantId": runtime["config"]["bindings"]["assistantId"],
            "assistant": runtime["assistantSummary"],
            "errors": runtime["errors"],
        }

    @server.tool(description="Fetch live Vapi tool summaries for the configured environment.")
    def vapi_tool_runtime(environment: str = "staging", tool_name: str | None = None) -> dict[str, Any]:
        runtime = fetch_environment_runtime(context, environment)
        tool_summaries = runtime["toolSummaries"]
        if tool_name:
            return {
                "environment": runtime["config"]["environment"],
                "tool": {tool_name: tool_summaries.get(tool_name)},
                "errors": runtime["errors"],
            }
        return {
            "environment": runtime["config"]["environment"],
            "tools": tool_summaries,
            "errors": runtime["errors"],
        }

    @server.tool(description="Fetch live structured output and scorecard summaries bound to the environment assistant.")
    def vapi_observability_runtime(environment: str = "staging") -> dict[str, Any]:
        runtime = fetch_environment_runtime(context, environment)
        return {
            "environment": runtime["config"]["environment"],
            "structuredOutputs": runtime["structuredOutputSummaries"],
            "scorecards": runtime["scorecardSummaries"],
            "phoneNumber": runtime["phoneNumberSummary"],
            "errors": runtime["errors"],
        }

    @server.tool(description="Fetch recent Vapi call summaries without transcripts or caller PII.")
    def vapi_recent_calls(environment: str = "staging", since_hours: int = 72, limit: int = 10) -> dict[str, Any]:
        return fetch_recent_calls(context, environment, since_hours=since_hours, limit=limit)

    return server


def main(argv: list[str] | None = None) -> int:
    args = argv or sys.argv[1:]
    server = build_server()
    if "--self-check" in args:
        run_self_check(server, smoke_tool_name="vapi_environment_bindings")
        return 0
    server.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
