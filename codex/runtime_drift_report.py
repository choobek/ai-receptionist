from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from codex.mcp.shared.common import (
    RepoContext,
    compact_timestamp,
    merged_env,
    normalize_environment,
    now_iso,
    redact_value,
    run_command,
    write_json,
    write_text,
)
from codex.mcp.shared.n8n import build_duplicate_workflow_report
from codex.mcp.shared.vapi import (
    fetch_environment_runtime,
    summarize_assistant_config,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a repo-vs-runtime drift report for staging or production.")
    parser.add_argument("environment", nargs="?", default="staging")
    parser.add_argument("--output-dir")
    parser.add_argument("--report")
    return parser.parse_args()


def _compare_values(diffs: list[dict[str, Any]], surface: str, expected: Any, actual: Any) -> None:
    if expected != actual:
        diffs.append({"surface": surface, "expected": expected, "actual": actual})


def _expected_tool_summaries(rendered: dict[str, Any], env: dict[str, str]) -> dict[str, dict[str, Any]]:
    summaries: dict[str, dict[str, Any]] = {}
    for binding in rendered.get("toolBindings", []):
        if not isinstance(binding, dict):
            continue
        summaries[binding["name"]] = redact_value(
            {
                "id": binding.get("id"),
                "name": binding.get("name"),
                "serverUrl": binding.get("serverUrl"),
            },
            env=env,
        )
    return summaries


def build_report(context: RepoContext, environment: str) -> dict[str, Any]:
    normalized = normalize_environment(environment)
    env = merged_env(context)

    git_overview = {
        "head": run_command(context, ["git", "-C", str(context.root_dir), "rev-parse", "HEAD"])["stdout"].strip(),
        "branch": run_command(
            context,
            ["git", "-C", str(context.root_dir), "rev-parse", "--abbrev-ref", "HEAD"],
        )["stdout"].strip(),
    }

    rendered_result = run_command(
        context,
        ["./scripts/render-vapi-assistant-config.sh", normalized],
        redact_output=False,
    )
    rendered = json.loads(rendered_result["stdout"])
    expected_assistant_summary = summarize_assistant_config(rendered["assistant"], env)
    expected_tool_summaries = _expected_tool_summaries(rendered, env)

    live_vapi = fetch_environment_runtime(context, normalized)
    live_n8n = build_duplicate_workflow_report(context, normalized)

    vapi_diffs: list[dict[str, Any]] = []
    actual_assistant_summary = live_vapi["assistantSummary"] or {}
    for surface in [
        "name",
        "model",
        "transcriber",
        "voice",
        "artifactPlan",
        "server",
        "firstMessageSha256",
        "voicemailMessageSha256",
        "endCallMessageSha256",
    ]:
        _compare_values(
            vapi_diffs,
            f"assistant.{surface}",
            expected_assistant_summary.get(surface),
            actual_assistant_summary.get(surface),
        )

    actual_tool_summaries = live_vapi["toolSummaries"]
    configured_only_tools = sorted(set(actual_tool_summaries) - set(expected_tool_summaries))
    for tool_name in sorted(expected_tool_summaries):
        expected_tool = expected_tool_summaries.get(tool_name)
        actual_tool = actual_tool_summaries.get(tool_name)
        if expected_tool is None or actual_tool is None:
            _compare_values(vapi_diffs, f"tool:{tool_name}", expected_tool, actual_tool)
            continue
        _compare_values(vapi_diffs, f"tool:{tool_name}.id", expected_tool.get("id"), actual_tool.get("id"))
        _compare_values(vapi_diffs, f"tool:{tool_name}.name", expected_tool.get("name"), actual_tool.get("name"))
        _compare_values(
            vapi_diffs,
            f"tool:{tool_name}.serverUrl",
            expected_tool.get("serverUrl"),
            actual_tool.get("serverUrl"),
        )

    n8n_findings = {
        "repoOwnedActiveIds": [item["id"] for item in live_n8n["repoOwnedActive"]],
        "repoOwnedInactiveIds": [item["id"] for item in live_n8n["repoOwnedInactive"]],
        "missingRepoWorkflowIds": live_n8n["missingRepoWorkflowIds"],
        "legacyDuplicateIds": [item["id"] for item in live_n8n["legacyDuplicates"]],
        "activeLegacyDuplicateIds": [item["id"] for item in live_n8n["activeLegacyDuplicates"]],
        "unexpectedActiveIds": [item["id"] for item in live_n8n["unexpectedActiveWorkflows"]],
    }

    return {
        "kind": "codex_runtime_drift_report.v1",
        "environment": normalized,
        "generatedAt": now_iso(),
        "git": git_overview,
        "renderedConfigSummary": {
            "assistant": expected_assistant_summary,
            "tools": expected_tool_summaries,
        },
        "liveVapiSummary": {
            "assistant": live_vapi["assistantSummary"],
            "tools": live_vapi["toolSummaries"],
            "configuredOnlyTools": configured_only_tools,
            "structuredOutputs": live_vapi["structuredOutputSummaries"],
            "scorecards": live_vapi["scorecardSummaries"],
            "phoneNumber": live_vapi["phoneNumberSummary"],
            "errors": live_vapi["errors"],
        },
        "vapiDrift": {
            "diffCount": len(vapi_diffs),
            "diffs": vapi_diffs,
        },
        "liveN8nSummary": {
            "containerName": live_n8n["containerName"],
            "runtimeWorkflowCount": live_n8n["runtimeWorkflowCount"],
            "activeWorkflowCount": live_n8n["activeWorkflowCount"],
            "notices": live_n8n["notices"],
        },
        "n8nFindings": n8n_findings,
    }


def render_markdown(report: dict[str, Any], run_dir_rel: str, summary_rel: str) -> str:
    lines = [
        "# Codex Runtime Drift Report",
        "",
        f"- Environment: `{report['environment']}`",
        f"- Git branch: `{report['git']['branch']}`",
        f"- Git SHA: `{report['git']['head']}`",
        f"- Run dir: `{run_dir_rel}`",
        f"- Summary JSON: `{summary_rel}`",
        "",
        "## Vapi",
        "",
        f"- Assistant drift count: `{report['vapiDrift']['diffCount']}`",
        f"- Runtime read errors: `{len(report['liveVapiSummary']['errors'])}`",
    ]
    if report["liveVapiSummary"]["configuredOnlyTools"]:
        lines.append(
            f"- Configured but not rendered tool resources: `{', '.join(report['liveVapiSummary']['configuredOnlyTools'])}`"
        )
    if report["vapiDrift"]["diffs"]:
        lines.append("- Drift surfaces:")
        for diff in report["vapiDrift"]["diffs"]:
            lines.append(f"  - `{diff['surface']}`")
    lines.extend(
        [
            "",
            "## n8n",
            "",
            f"- Container: `{report['liveN8nSummary']['containerName']}`",
            f"- Runtime workflow count: `{report['liveN8nSummary']['runtimeWorkflowCount']}`",
            f"- Active workflow count: `{report['liveN8nSummary']['activeWorkflowCount']}`",
            f"- Missing repo workflow IDs: `{len(report['n8nFindings']['missingRepoWorkflowIds'])}`",
            f"- Legacy duplicate workflow IDs: `{len(report['n8nFindings']['legacyDuplicateIds'])}`",
            f"- Active legacy duplicate IDs: `{len(report['n8nFindings']['activeLegacyDuplicateIds'])}`",
        ]
    )
    if report["n8nFindings"]["legacyDuplicateIds"]:
        lines.append("- Legacy duplicate IDs:")
        for workflow_id in report["n8nFindings"]["legacyDuplicateIds"]:
            lines.append(f"  - `{workflow_id}`")
    if report["n8nFindings"]["unexpectedActiveIds"]:
        lines.append("- Unexpected active workflow IDs:")
        for workflow_id in report["n8nFindings"]["unexpectedActiveIds"]:
            lines.append(f"  - `{workflow_id}`")
    return "\n".join(lines) + "\n"


def main() -> int:
    args = parse_args()
    context = RepoContext.discover()
    environment = normalize_environment(args.environment)

    run_id = f"codex-runtime-drift-{environment}-{compact_timestamp()}"
    run_dir = Path(args.output_dir).resolve() if args.output_dir else context.codex_runs_dir / run_id
    summary_path = run_dir / "runtime-drift.summary.json"
    report_path = Path(args.report).resolve() if args.report else context.codex_reports_dir / f"{run_id}.md"

    report = build_report(context, environment)
    run_dir.mkdir(parents=True, exist_ok=True)

    summary_payload = {
        **report,
        "suite_run_id": run_id,
        "run_dir": context.relative_path(run_dir),
        "report_path": context.relative_path(report_path),
    }
    write_json(summary_path, summary_payload)
    write_text(
        report_path,
        render_markdown(
            summary_payload,
            context.relative_path(run_dir),
            context.relative_path(summary_path),
        ),
    )

    print(f"Runtime drift summary: {context.relative_path(summary_path)}")
    print(f"Runtime drift report: {context.relative_path(report_path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
