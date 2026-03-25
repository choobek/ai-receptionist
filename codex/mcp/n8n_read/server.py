from __future__ import annotations

import sys
from typing import Any

from mcp.server.fastmcp import FastMCP

from codex.mcp.shared.common import RepoContext
from codex.mcp.shared.healthcheck import run_self_check
from codex.mcp.shared.n8n import (
    build_duplicate_workflow_report,
    fetch_runtime_workflow_inventory,
    repo_workflow_catalog,
)


def build_server() -> FastMCP:
    context = RepoContext.discover()
    server = FastMCP(
        name="n8n-read",
        instructions=(
            "Read-only runtime inspection for n8n workflows, active workflow inventory, and "
            "duplicate workflow detection in the ai-receptionist project."
        ),
    )

    @server.tool(description="Return the repo-owned n8n workflow IDs, names, and file paths.")
    def n8n_repo_workflow_catalog() -> dict[str, Any]:
        catalog = repo_workflow_catalog(context)
        return {
            "count": len(catalog),
            "workflows": catalog,
        }

    @server.tool(description="Fetch live n8n workflow inventory and active workflow inventory from a target environment.")
    def n8n_runtime_workflow_inventory(environment: str = "staging") -> dict[str, Any]:
        return fetch_runtime_workflow_inventory(context, environment)

    @server.tool(description="Compare repo-owned workflow IDs with runtime inventory and report duplicate legacy workflows.")
    def n8n_duplicate_workflow_report(environment: str = "staging") -> dict[str, Any]:
        return build_duplicate_workflow_report(context, environment)

    return server


def main(argv: list[str] | None = None) -> int:
    args = argv or sys.argv[1:]
    server = build_server()
    if "--self-check" in args:
        run_self_check(server, smoke_tool_name="n8n_repo_workflow_catalog")
        return 0
    server.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
