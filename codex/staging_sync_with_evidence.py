from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from codex.mcp.shared.common import (
    RepoContext,
    compact_timestamp,
    now_iso,
    run_command,
    write_json,
    write_text,
)
from codex.mcp.shared.ops_guard import (
    action_plan_for_scope,
    build_preflight,
    command_plan_payload,
    consume_stage_write_ticket,
    normalize_scope,
    require_staging_environment,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a guarded staging sync with before/after evidence.")
    parser.add_argument("--scope", default="full", choices=["vapi", "vapi-observability", "n8n", "full"])
    parser.add_argument("--environment", default="staging")
    parser.add_argument("--approval-token")
    parser.add_argument("--output-dir")
    parser.add_argument("--report")
    parser.add_argument("--summary-json")
    parser.add_argument("--include-saved-eval", action="store_true")
    parser.add_argument("--skip-live-autoeval", action="store_true")
    parser.add_argument("--since-hours", type=int, default=72)
    parser.add_argument("--live-limit", type=int, default=15)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def _run_logged_command(
    context: RepoContext,
    *,
    name: str,
    command: list[str],
    timeout_seconds: int,
    log_path: Path,
) -> dict[str, Any]:
    result = run_command(
        context,
        command,
        timeout_seconds=timeout_seconds,
    )
    log_lines = [
        f"name: {name}",
        f"command: {result['commandDisplay']}",
        f"cwd: {result['cwd']}",
        f"duration_ms: {result['durationMs']}",
        f"returncode: {result['returncode']}",
        "",
        "stdout:",
        result["stdout"].rstrip(),
        "",
        "stderr:",
        result["stderr"].rstrip(),
        "",
    ]
    write_text(log_path, "\n".join(log_lines).rstrip() + "\n")
    return {
        "name": name,
        "ok": result["ok"],
        "returncode": result["returncode"],
        "durationMs": result["durationMs"],
        "command": result["command"],
        "commandDisplay": result["commandDisplay"],
        "logPath": context.relative_path(log_path),
    }


def _release_gate_command(
    output_dir: Path,
    report_path: Path,
    *,
    include_saved_eval: bool,
    skip_live_autoeval: bool,
    since_hours: int,
    live_limit: int,
) -> list[str]:
    command = [
        "./scripts/codex/run-staging-release-gate.sh",
        "--output-dir",
        str(output_dir),
        "--report",
        str(report_path),
        "--since-hours",
        str(since_hours),
        "--live-limit",
        str(live_limit),
    ]
    if include_saved_eval:
        command.append("--include-saved-eval")
    if skip_live_autoeval:
        command.append("--skip-live-autoeval")
    return command


def _drift_command(output_dir: Path, report_path: Path) -> list[str]:
    return [
        "./scripts/codex/runtime-drift-report.sh",
        "staging",
        "--output-dir",
        str(output_dir),
        "--report",
        str(report_path),
    ]


def _read_json_if_present(path: Path) -> Any | None:
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _run_release_gate(
    context: RepoContext,
    *,
    label: str,
    run_dir: Path,
    reports_root: Path,
    run_id: str,
    include_saved_eval: bool,
    skip_live_autoeval: bool,
    since_hours: int,
    live_limit: int,
) -> dict[str, Any]:
    output_dir = run_dir / f"{label}-release-gate"
    report_path = reports_root / f"{run_id}-{label}-release-gate.md"
    log_path = run_dir / f"{label}-release-gate.log"
    summary_path = output_dir / "release-gate.summary.json"
    result = _run_logged_command(
        context,
        name=f"{label}-release-gate",
        command=_release_gate_command(
            output_dir,
            report_path,
            include_saved_eval=include_saved_eval,
            skip_live_autoeval=skip_live_autoeval,
            since_hours=since_hours,
            live_limit=live_limit,
        ),
        timeout_seconds=7200,
        log_path=log_path,
    )
    result.update(
        {
            "outputDir": context.relative_path(output_dir),
            "reportPath": context.relative_path(report_path),
            "summaryPath": context.relative_path(summary_path),
            "summary": _read_json_if_present(summary_path),
        }
    )
    return result


def _run_drift_report(
    context: RepoContext,
    *,
    label: str,
    run_dir: Path,
    reports_root: Path,
    run_id: str,
) -> dict[str, Any]:
    output_dir = run_dir / f"{label}-runtime-drift"
    report_path = reports_root / f"{run_id}-{label}-runtime-drift.md"
    log_path = run_dir / f"{label}-runtime-drift.log"
    summary_path = output_dir / "runtime-drift.summary.json"
    result = _run_logged_command(
        context,
        name=f"{label}-runtime-drift",
        command=_drift_command(output_dir, report_path),
        timeout_seconds=3600,
        log_path=log_path,
    )
    result.update(
        {
            "outputDir": context.relative_path(output_dir),
            "reportPath": context.relative_path(report_path),
            "summaryPath": context.relative_path(summary_path),
            "summary": _read_json_if_present(summary_path),
        }
    )
    return result


def render_markdown(summary: dict[str, Any], run_dir_rel: str, summary_rel: str) -> str:
    lines = [
        "# Codex Staging Sync With Evidence",
        "",
        f"- Scope: `{summary['scope']}`",
        f"- Environment: `{summary['environment']}`",
        f"- Overall status: `{summary['overallStatus']}`",
        f"- Dry run: `{str(summary['dryRun']).lower()}`",
        f"- Git branch: `{summary['git']['branch']}`",
        f"- Git SHA: `{summary['git']['head']}`",
        f"- Run dir: `{run_dir_rel}`",
        f"- Summary JSON: `{summary_rel}`",
        "",
        "## Guardrails",
        "",
        f"- Production policy: `{summary['preflight']['productionPolicy']}`",
        f"- Post-sync verification required: `{str(summary['preflight']['requiresPostSyncVerification']).lower()}`",
    ]
    if summary["preflight"]["requiresN8nBackupCheck"]:
        lines.append(
            f"- Backup-before-import confirmed: `{str(summary['preflight']['n8nImportScriptHasBackup']).lower()}`"
        )
    if summary["approval"]["tokenId"]:
        lines.append(f"- Approval token id: `{summary['approval']['tokenId']}`")
    if summary["approval"]["consumedAt"]:
        lines.append(f"- Approval token consumed at: `{summary['approval']['consumedAt']}`")

    lines.extend(
        [
            "",
            "## Command Plan",
            "",
        ]
    )
    for command_spec in summary["preflight"]["commandPlan"]:
        lines.append(
            f"- `{command_spec['name']}`: `{command_spec['commandDisplay']}` "
            f"(mutating: `{str(command_spec['mutating']).lower()}`)"
        )

    if summary["dryRun"]:
        lines.extend(
            [
                "",
                "## Dry Run",
                "",
                "- No verification or sync commands were executed.",
            ]
        )
        return "\n".join(lines) + "\n"

    lines.extend(
        [
            "",
            "## Evidence",
            "",
            f"- Before release gate: `{summary['before']['releaseGate']['reportPath']}`",
            f"- Before drift report: `{summary['before']['driftReport']['reportPath']}`",
        ]
    )
    if summary["after"]["releaseGate"]:
        lines.append(f"- After release gate: `{summary['after']['releaseGate']['reportPath']}`")
    if summary["after"]["driftReport"]:
        lines.append(f"- After drift report: `{summary['after']['driftReport']['reportPath']}`")

    lines.extend(
        [
            "",
            "## Sync Steps",
            "",
        ]
    )
    for step in summary["sync"]["steps"]:
        lines.append(
            f"- `{step['name']}`: `{'passed' if step['ok'] else 'failed'}` via `{step['commandDisplay']}` "
            f"(log: `{step['logPath']}`)"
        )

    if summary["stopReason"]:
        lines.extend(
            [
                "",
                "## Stop Reason",
                "",
                f"- {summary['stopReason']}",
            ]
        )
    return "\n".join(lines) + "\n"


def main() -> int:
    args = parse_args()
    if args.since_hours <= 0:
        raise SystemExit("--since-hours must be a positive integer")
    if args.live_limit <= 0:
        raise SystemExit("--live-limit must be a positive integer")

    context = RepoContext.discover()
    environment = require_staging_environment(args.environment)
    scope = normalize_scope(args.scope)
    plan = action_plan_for_scope(scope, environment)
    preflight = build_preflight(context, scope, environment)

    run_id = f"codex-staging-sync-{scope}-{environment}-{compact_timestamp()}"
    run_dir = Path(args.output_dir).resolve() if args.output_dir else context.codex_runs_dir / run_id
    report_path = Path(args.report).resolve() if args.report else context.codex_reports_dir / f"{run_id}.md"
    summary_path = Path(args.summary_json).resolve() if args.summary_json else run_dir / "staging-sync.summary.json"
    run_dir.mkdir(parents=True, exist_ok=True)
    report_path.parent.mkdir(parents=True, exist_ok=True)

    git = preflight["git"]
    summary: dict[str, Any] = {
        "kind": "codex_staging_sync_with_evidence.v1",
        "suite_run_id": run_id,
        "createdAt": now_iso(),
        "scope": scope,
        "environment": environment,
        "dryRun": bool(args.dry_run),
        "runDir": context.relative_path(run_dir),
        "reportPath": context.relative_path(report_path),
        "summaryPath": context.relative_path(summary_path),
        "git": git,
        "options": {
            "includeSavedEval": bool(args.include_saved_eval),
            "skipLiveAutoeval": bool(args.skip_live_autoeval),
            "sinceHours": args.since_hours,
            "liveLimit": args.live_limit,
        },
        "preflight": preflight,
        "approval": {
            "required": not args.dry_run,
            "tokenId": args.approval_token[:12] if args.approval_token else None,
            "consumedAt": None,
        },
        "before": {
            "releaseGate": None,
            "driftReport": None,
        },
        "sync": {
            "action": plan.action,
            "steps": [],
        },
        "after": {
            "releaseGate": None,
            "driftReport": None,
        },
        "overallStatus": "dry_run" if args.dry_run else "pending",
        "stopReason": "",
    }

    exit_code = 0
    try:
        if args.dry_run:
            summary["sync"]["commandPlan"] = command_plan_payload(plan)
        else:
            if not args.approval_token:
                raise ValueError("--approval-token is required unless --dry-run is set")

            before_release = _run_release_gate(
                context,
                label="before",
                run_dir=run_dir,
                reports_root=context.codex_reports_dir,
                run_id=run_id,
                include_saved_eval=bool(args.include_saved_eval),
                skip_live_autoeval=bool(args.skip_live_autoeval),
                since_hours=args.since_hours,
                live_limit=args.live_limit,
            )
            summary["before"]["releaseGate"] = before_release
            if not before_release["ok"]:
                summary["overallStatus"] = "failed"
                summary["stopReason"] = "pre-sync release gate failed"
                exit_code = 1
            else:
                before_drift = _run_drift_report(
                    context,
                    label="before",
                    run_dir=run_dir,
                    reports_root=context.codex_reports_dir,
                    run_id=run_id,
                )
                summary["before"]["driftReport"] = before_drift
                if not before_drift["ok"]:
                    summary["overallStatus"] = "failed"
                    summary["stopReason"] = "pre-sync runtime drift report failed"
                    exit_code = 1

            sync_result: dict[str, Any] = {
                "action": plan.action,
                "steps": [],
                "ok": False,
                "failedStep": None,
            }
            if exit_code == 0:
                consumed = False
                steps: list[dict[str, Any]] = []
                mutating_started = False
                for index, command_spec in enumerate(command_plan_payload(plan), start=1):
                    if command_spec["mutating"] and not consumed:
                        approval = consume_stage_write_ticket(context, args.approval_token, scope, environment)
                        summary["approval"]["tokenId"] = approval["tokenId"]
                        summary["approval"]["consumedAt"] = approval["consumedAt"]
                        consumed = True
                        mutating_started = True
                    log_path = run_dir / f"sync-{index:02d}-{command_spec['name']}.log"
                    step = _run_logged_command(
                        context,
                        name=command_spec["name"],
                        command=list(command_spec["command"]),
                        timeout_seconds=int(command_spec["timeoutSeconds"]),
                        log_path=log_path,
                    )
                    step["mutating"] = bool(command_spec["mutating"])
                    steps.append(step)
                    if not step["ok"]:
                        sync_result = {
                            "action": plan.action,
                            "steps": steps,
                            "ok": False,
                            "failedStep": step["name"],
                            "mutatingStepStarted": mutating_started or bool(command_spec["mutating"]),
                        }
                        break
                else:
                    sync_result = {
                        "action": plan.action,
                        "steps": steps,
                        "ok": True,
                        "failedStep": None,
                        "mutatingStepStarted": mutating_started,
                    }

                summary["sync"] = sync_result
                if not sync_result["ok"]:
                    summary["overallStatus"] = "failed"
                    summary["stopReason"] = f"sync command failed: {sync_result['failedStep']}"
                    exit_code = 1

                if sync_result["mutatingStepStarted"]:
                    after_release = _run_release_gate(
                        context,
                        label="after",
                        run_dir=run_dir,
                        reports_root=context.codex_reports_dir,
                        run_id=run_id,
                        include_saved_eval=bool(args.include_saved_eval),
                        skip_live_autoeval=bool(args.skip_live_autoeval),
                        since_hours=args.since_hours,
                        live_limit=args.live_limit,
                    )
                    summary["after"]["releaseGate"] = after_release
                    if not after_release["ok"]:
                        summary["overallStatus"] = "failed"
                        if not summary["stopReason"]:
                            summary["stopReason"] = "post-sync release gate failed"
                        exit_code = 1

                    after_drift = _run_drift_report(
                        context,
                        label="after",
                        run_dir=run_dir,
                        reports_root=context.codex_reports_dir,
                        run_id=run_id,
                    )
                    summary["after"]["driftReport"] = after_drift
                    if not after_drift["ok"]:
                        summary["overallStatus"] = "failed"
                        if not summary["stopReason"]:
                            summary["stopReason"] = "post-sync runtime drift report failed"
                        exit_code = 1

                if exit_code == 0:
                    summary["overallStatus"] = "passed"
                    summary["stopReason"] = ""
    except Exception as exc:
        summary["overallStatus"] = "failed"
        summary["stopReason"] = str(exc)
        exit_code = 1

    write_json(summary_path, summary)
    write_text(
        report_path,
        render_markdown(
            summary,
            context.relative_path(run_dir),
            context.relative_path(summary_path),
        ),
    )

    print(f"Staging sync summary: {context.relative_path(summary_path)}")
    print(f"Staging sync report: {context.relative_path(report_path)}")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
