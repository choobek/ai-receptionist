from __future__ import annotations

import anyio
import json
from typing import Any

from mcp.server.fastmcp import FastMCP


def run_self_check(
    server: FastMCP,
    *,
    smoke_tool_name: str,
    smoke_arguments: dict[str, Any] | None = None,
) -> dict[str, Any]:
    async def _run() -> dict[str, Any]:
        tools = await server.list_tools()
        tool_names = [tool.name for tool in tools]
        if smoke_tool_name not in tool_names:
            raise RuntimeError(f"smoke tool {smoke_tool_name!r} is not registered")

        result = await server.call_tool(smoke_tool_name, smoke_arguments or {})
        payload = {
            "server": server.name,
            "toolCount": len(tool_names),
            "tools": tool_names,
            "smokeTool": smoke_tool_name,
            "smokeResultType": type(result).__name__,
        }
        print(json.dumps(payload, ensure_ascii=True, indent=2))
        return payload

    return anyio.run(_run)
