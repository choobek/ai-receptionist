#!/usr/bin/env python3

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib import error, request


ROOT_DIR = Path(__file__).resolve().parents[1]
STRUCTURED_OUTPUTS_DIR = ROOT_DIR / "configs" / "vapi" / "structured-outputs"
SCORECARDS_DIR = ROOT_DIR / "configs" / "vapi" / "scorecards"
EVALS_DIR = ROOT_DIR / "configs" / "vapi" / "evals"
DEFAULT_EVAL_RUNS_DIR = ROOT_DIR / "autonomy" / "runs" / "generated" / "vapi-evals"
DEFAULT_EVAL_REPORTS_DIR = ROOT_DIR / "autonomy" / "reports" / "generated" / "vapi-evals"


class VapiApiError(RuntimeError):
    pass


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=True, indent=2)
        handle.write("\n")


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def compact_timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def api_request(
    method: str,
    path: str,
    api_key: str,
    base_url: str,
    payload: Any | None = None,
) -> Any:
    url = f"{base_url.rstrip('/')}{path}"
    last_error: Exception | None = None

    for attempt in range(1, 6):
        body = None
        headers = {
          "Authorization": f"Bearer {api_key}",
          "Accept": "application/json",
          "User-Agent": "curl/8.5.0",
        }
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
            headers["Content-Type"] = "application/json"

        req = request.Request(url, data=body, method=method, headers=headers)
        try:
            with request.urlopen(req) as response:
                raw = response.read().decode("utf-8")
            break
        except error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            retryable = exc.code in {429, 500, 502, 503, 504}
            if retryable and attempt < 5:
                retry_after = exc.headers.get("Retry-After")
                if retry_after and retry_after.isdigit():
                    wait_seconds = max(1, int(retry_after))
                else:
                    wait_seconds = attempt * 2
                time.sleep(wait_seconds)
                last_error = exc
                continue
            raise VapiApiError(f"{method} {path} failed with HTTP {exc.code}: {raw}") from exc
        except error.URLError as exc:
            if attempt < 5:
                time.sleep(attempt * 2)
                last_error = exc
                continue
            raise VapiApiError(f"{method} {path} failed: {exc}") from exc
    else:
        raise VapiApiError(f"{method} {path} failed after retries: {last_error}")

    if not raw:
        return None

    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw


def list_resources(path: str, api_key: str, base_url: str) -> list[dict[str, Any]]:
    response = api_request("GET", path, api_key, base_url)
    results = response.get("results") if isinstance(response, dict) else None
    if not isinstance(results, list):
        raise VapiApiError(f"Unexpected list response from {path}: {response}")
    return results


def load_ranked_configs(config_dir: Path) -> list[tuple[Path, dict[str, Any]]]:
    items: list[tuple[Path, dict[str, Any]]] = []
    for path in sorted(config_dir.glob("*.json")):
        items.append((path, load_json(path)))
    items.sort(key=lambda item: (int(item[1].get("rank", 9999)), item[0].name))
    return items


def ensure_unique_by_name(items: list[dict[str, Any]], resource_label: str) -> dict[str, dict[str, Any]]:
    indexed: dict[str, dict[str, Any]] = {}
    for item in items:
        name = item.get("name")
        if not isinstance(name, str) or not name:
            continue
        if name in indexed:
            raise VapiApiError(f"Duplicate {resource_label} name found in Vapi: {name}")
        indexed[name] = item
    return indexed


def scoped_name(name: str, environment: str) -> str:
    if environment == "production":
        return name
    return f"{name} [{environment}]"


def update_environment_bindings(
    environment_path: Path,
    structured_output_ids: list[str] | None = None,
    scorecard_ids: list[str] | None = None,
) -> dict[str, Any]:
    bindings = load_json(environment_path)
    if structured_output_ids is not None:
        bindings["structuredOutputIds"] = structured_output_ids
    if scorecard_ids is not None:
        bindings["scorecardIds"] = scorecard_ids
    write_json(environment_path, bindings)
    return bindings


def sync_structured_outputs(
    environment: str,
    assistant_id: str,
    api_key: str,
    base_url: str,
) -> tuple[list[str], dict[str, str], list[dict[str, Any]]]:
    existing = ensure_unique_by_name(
        list_resources("/structured-output", api_key, base_url),
        "structured output",
    )
    output_ids: list[str] = []
    key_to_id: dict[str, str] = {}
    synced: list[dict[str, Any]] = []

    for path, config in load_ranked_configs(STRUCTURED_OUTPUTS_DIR):
        name = scoped_name(config["name"], environment)
        payload = {
            "name": name,
            "description": config["description"],
            "type": config["type"],
            "assistantIds": [assistant_id],
            "schema": config["schema"],
        }

        current = existing.get(name)
        if current:
            resource = api_request(
                "PATCH",
                f"/structured-output/{current['id']}",
                api_key,
                base_url,
                payload,
            )
            action = "updated"
        else:
            resource = api_request(
                "POST",
                "/structured-output",
                api_key,
                base_url,
                payload,
            )
            action = "created"

        resource_id = resource.get("id")
        if not isinstance(resource_id, str) or not resource_id:
            raise VapiApiError(f"Structured output sync did not return an id for {name}")

        output_ids.append(resource_id)
        key_to_id[config["key"]] = resource_id
        synced.append(
            {
                "path": str(path.relative_to(ROOT_DIR)),
                "key": config["key"],
                "name": name,
                "id": resource_id,
                "action": action,
            }
        )

    return output_ids, key_to_id, synced


def sync_scorecards(
    environment: str,
    assistant_id: str,
    output_key_to_id: dict[str, str],
    api_key: str,
    base_url: str,
) -> tuple[list[str], list[dict[str, Any]]]:
    existing = ensure_unique_by_name(
        list_resources("/observability/scorecard", api_key, base_url),
        "scorecard",
    )
    scorecard_ids: list[str] = []
    synced: list[dict[str, Any]] = []

    for path, config in load_ranked_configs(SCORECARDS_DIR):
        metrics = []
        for metric in config.get("metrics", []):
            output_key = metric["structuredOutputKey"]
            structured_output_id = output_key_to_id.get(output_key)
            if not structured_output_id:
                raise VapiApiError(
                    f"Scorecard {config['key']} references unknown structuredOutputKey {output_key}"
                )
            metrics.append(
                {
                    "structuredOutputId": structured_output_id,
                    "conditions": metric["conditions"],
                }
            )

        name = scoped_name(config["name"], environment)
        payload = {
            "name": name,
            "description": config["description"],
            "assistantIds": [assistant_id],
            "metrics": metrics,
        }

        current = existing.get(name)
        if current:
            resource = api_request(
                "PATCH",
                f"/observability/scorecard/{current['id']}",
                api_key,
                base_url,
                payload,
            )
            action = "updated"
        else:
            resource = api_request(
                "POST",
                "/observability/scorecard",
                api_key,
                base_url,
                payload,
            )
            action = "created"

        resource_id = resource.get("id")
        if not isinstance(resource_id, str) or not resource_id:
            raise VapiApiError(f"Scorecard sync did not return an id for {name}")

        scorecard_ids.append(resource_id)
        synced.append(
            {
                "path": str(path.relative_to(ROOT_DIR)),
                "key": config["key"],
                "name": name,
                "id": resource_id,
                "action": action,
            }
        )

    return scorecard_ids, synced


def sync_evals(api_key: str, base_url: str) -> tuple[dict[str, str], list[dict[str, Any]]]:
    existing = ensure_unique_by_name(list_resources("/eval", api_key, base_url), "eval")
    key_to_id: dict[str, str] = {}
    synced: list[dict[str, Any]] = []

    for path, config in load_ranked_configs(EVALS_DIR):
        payload = {
            "name": config["name"],
            "description": config["description"],
            "type": config["type"],
            "messages": config["messages"],
        }

        current = existing.get(config["name"])
        if current:
            resource = api_request(
                "PATCH",
                f"/eval/{current['id']}",
                api_key,
                base_url,
                payload,
            )
            action = "updated"
        else:
            resource = api_request(
                "POST",
                "/eval",
                api_key,
                base_url,
                payload,
            )
            action = "created"

        resource_id = resource.get("id")
        if not isinstance(resource_id, str) or not resource_id:
            raise VapiApiError(f"Eval sync did not return an id for {config['name']}")

        key_to_id[config["key"]] = resource_id
        synced.append(
            {
                "path": str(path.relative_to(ROOT_DIR)),
                "key": config["key"],
                "name": config["name"],
                "id": resource_id,
                "action": action,
            }
        )

    return key_to_id, synced


def render_sync_summary(summary: dict[str, Any]) -> str:
    lines = [
        f"Observability sync completed for {summary['environment']}",
        f"- Assistant: {summary['assistant_id']}",
    ]

    for label, items in (
        ("Structured outputs", summary.get("structured_outputs", [])),
        ("Scorecards", summary.get("scorecards", [])),
        ("Evals", summary.get("evals", [])),
    ):
        if not items:
            continue
        lines.append(f"- {label}:")
        for item in items:
            lines.append(f"  - {item['action']}: {item['name']} ({item['id']})")

    if summary.get("environment_path"):
        lines.append(f"- Updated bindings: {summary['environment_path']}")
    return "\n".join(lines)


def sync_command(args: argparse.Namespace) -> int:
    environment_path = ROOT_DIR / "configs" / "vapi" / "environments" / f"{args.environment}.json"
    bindings = load_json(environment_path)
    assistant_id = bindings.get("assistantId")
    if not isinstance(assistant_id, str) or not assistant_id:
        raise VapiApiError(f"assistantId is required in {environment_path}")

    sections = {section.strip() for section in args.sections.split(",") if section.strip()}
    if not sections:
        sections = {"structured-outputs", "scorecards", "evals"}
    if "scorecards" in sections:
        sections.add("structured-outputs")

    structured_output_ids: list[str] | None = None
    scorecard_ids: list[str] | None = None
    output_key_to_id: dict[str, str] = {}
    structured_outputs_summary: list[dict[str, Any]] = []
    scorecards_summary: list[dict[str, Any]] = []
    evals_summary: list[dict[str, Any]] = []

    if "structured-outputs" in sections:
        structured_output_ids, output_key_to_id, structured_outputs_summary = sync_structured_outputs(
            args.environment,
            assistant_id,
            args.api_key,
            args.base_url,
        )

    if "scorecards" in sections:
        scorecard_ids, scorecards_summary = sync_scorecards(
            args.environment,
            assistant_id,
            output_key_to_id,
            args.api_key,
            args.base_url,
        )

    if structured_output_ids is not None or scorecard_ids is not None:
        update_environment_bindings(
            environment_path,
            structured_output_ids=structured_output_ids,
            scorecard_ids=scorecard_ids,
        )

    if "evals" in sections:
        _, evals_summary = sync_evals(args.api_key, args.base_url)

    summary = {
        "environment": args.environment,
        "assistant_id": assistant_id,
        "environment_path": str(environment_path.relative_to(ROOT_DIR)),
        "structured_outputs": structured_outputs_summary,
        "scorecards": scorecards_summary,
        "evals": evals_summary,
        "synced_at": now_iso(),
    }

    if args.summary_json:
        write_json(Path(args.summary_json), summary)

    print(render_sync_summary(summary))
    return 0


def find_eval_configs(selected_keys: list[str] | None = None) -> list[tuple[Path, dict[str, Any]]]:
    configs = load_ranked_configs(EVALS_DIR)
    if not selected_keys:
        return configs
    wanted = set(selected_keys)
    selected = [item for item in configs if item[1].get("key") in wanted]
    missing = wanted - {item[1].get("key") for item in selected}
    if missing:
        raise VapiApiError(f"Unknown eval key(s): {', '.join(sorted(missing))}")
    return selected


def run_saved_eval(
    eval_id: str,
    assistant_id: str,
    api_key: str,
    base_url: str,
) -> str:
    payload = {
        "type": "eval",
        "evalId": eval_id,
        "target": {
            "type": "assistant",
            "assistantId": assistant_id,
        },
    }
    response = api_request("POST", "/eval/run", api_key, base_url, payload)
    eval_run_id = response.get("evalRunId") if isinstance(response, dict) else None
    if not isinstance(eval_run_id, str) or not eval_run_id:
        raise VapiApiError(f"Eval run creation did not return an evalRunId: {response}")
    return eval_run_id


def poll_eval_run(
    eval_run_id: str,
    api_key: str,
    base_url: str,
    timeout_seconds: int,
    poll_interval_seconds: int,
) -> dict[str, Any]:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        result = api_request("GET", f"/eval/run/{eval_run_id}", api_key, base_url)
        status = result.get("status") if isinstance(result, dict) else None
        if status in {"ended", "failed"}:
            return result
        time.sleep(poll_interval_seconds)
    raise VapiApiError(f"Timed out waiting for eval run {eval_run_id}")


def evaluation_passed(result: dict[str, Any]) -> bool:
    if result.get("status") != "ended":
        return False
    if result.get("endedReason") and result.get("endedReason") != "mockConversation.done":
        return False
    for item in result.get("results", []):
        if item.get("status") != "pass":
            return False
    return True


def render_eval_report(
    suite_summary: dict[str, Any],
    scenario_results: list[dict[str, Any]],
) -> str:
    lines = [
        "# Vapi Eval Suite",
        "",
        f"- Suite run: `{suite_summary['suite_run_id']}`",
        f"- Environment: `{suite_summary['environment']}`",
        f"- Assistant: `{suite_summary['assistant_id']}`",
        f"- Started: `{suite_summary['started_at']}`",
        f"- Completed: `{suite_summary['completed_at']}`",
        f"- Status: **{suite_summary['status'].upper()}**",
        f"- Evals: {suite_summary['passed_count']} passed, {suite_summary['failed_count']} failed",
        "",
        "## Results",
        "",
    ]

    for result in scenario_results:
        status = result["status"].upper()
        lines.append(f"### {result['name']}")
        lines.append("")
        lines.append(f"- Key: `{result['key']}`")
        lines.append(f"- Eval ID: `{result['eval_id']}`")
        lines.append(f"- Eval Run ID: `{result['eval_run_id']}`")
        lines.append(f"- Status: **{status}**")
        lines.append(f"- Result path: `{result['result_path']}`")
        if result.get("failure_reason"):
            lines.append(f"- Failure reason: {result['failure_reason']}")
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def extract_failure_reason(result: dict[str, Any]) -> str | None:
    for item in result.get("results", []):
        for message in item.get("messages", []):
            judge = message.get("judge")
            if isinstance(judge, dict) and judge.get("failureReason"):
                return str(judge["failureReason"])
    if result.get("endedReason") and result.get("endedReason") != "mockConversation.done":
        return str(result["endedReason"])
    return None


def run_evals_command(args: argparse.Namespace) -> int:
    environment_path = ROOT_DIR / "configs" / "vapi" / "environments" / f"{args.environment}.json"
    bindings = load_json(environment_path)
    assistant_id = bindings.get("assistantId")
    if not isinstance(assistant_id, str) or not assistant_id:
        raise VapiApiError(f"assistantId is required in {environment_path}")

    if args.sync_first:
        sync_args = argparse.Namespace(
            environment=args.environment,
            api_key=args.api_key,
            base_url=args.base_url,
            sections="evals",
            summary_json=None,
        )
        sync_command(sync_args)

    selected = find_eval_configs(args.eval_key)
    if args.list:
        for _, config in selected:
            print(f"{config['key']}\t{config['name']}")
        return 0

    available = ensure_unique_by_name(list_resources("/eval", args.api_key, args.base_url), "eval")
    suite_run_id = f"{args.environment}-vapi-evals-{compact_timestamp()}"
    output_dir = DEFAULT_EVAL_RUNS_DIR / suite_run_id
    report_path = DEFAULT_EVAL_REPORTS_DIR / f"{suite_run_id}.md"
    output_dir.mkdir(parents=True, exist_ok=True)
    report_path.parent.mkdir(parents=True, exist_ok=True)

    started_at = now_iso()
    scenario_results: list[dict[str, Any]] = []

    for _, config in selected:
        eval_resource = available.get(config["name"])
        if not eval_resource:
            raise VapiApiError(
                f"Saved eval not found in Vapi after sync: {config['name']}"
            )

        eval_id = eval_resource["id"]
        eval_run_id = None
        raw_result: dict[str, Any]
        failure_reason: str | None = None

        try:
            eval_run_id = run_saved_eval(eval_id, assistant_id, args.api_key, args.base_url)
            raw_result = poll_eval_run(
                eval_run_id,
                args.api_key,
                args.base_url,
                args.timeout_seconds,
                args.poll_interval_seconds,
            )
        except VapiApiError as exc:
            failure_reason = str(exc)
            raw_result = {
                "id": eval_run_id,
                "status": "failed",
                "endedReason": "runner_error",
                "error": failure_reason,
                "target": {
                    "type": "assistant",
                    "assistantId": assistant_id,
                },
            }
            if eval_run_id:
                try:
                    api_request("DELETE", f"/eval/run/{eval_run_id}", args.api_key, args.base_url)
                except VapiApiError:
                    pass

        result_path = output_dir / f"{config['key']}.eval-run.json"
        write_json(result_path, raw_result)

        passed = evaluation_passed(raw_result)
        scenario_results.append(
            {
                "key": config["key"],
                "name": config["name"],
                "eval_id": eval_id,
                "eval_run_id": eval_run_id,
                "status": "passed" if passed else "failed",
                "failure_reason": failure_reason or extract_failure_reason(raw_result),
                "result_path": str(result_path.relative_to(ROOT_DIR)),
            }
        )

    completed_at = now_iso()
    passed_count = sum(1 for item in scenario_results if item["status"] == "passed")
    failed_count = len(scenario_results) - passed_count
    suite_summary = {
        "suite_run_id": suite_run_id,
        "environment": args.environment,
        "assistant_id": assistant_id,
        "started_at": started_at,
        "completed_at": completed_at,
        "status": "passed" if failed_count == 0 else "failed",
        "scenario_count": len(scenario_results),
        "passed_count": passed_count,
        "failed_count": failed_count,
        "results": scenario_results,
        "report_path": str(report_path.relative_to(ROOT_DIR)),
        "run_dir": str(output_dir.relative_to(ROOT_DIR)),
    }

    write_json(output_dir / "suite.result.json", suite_summary)
    report_path.write_text(render_eval_report(suite_summary, scenario_results), encoding="utf-8")

    print(
        f"Vapi eval suite {suite_run_id}: {passed_count} passed, {failed_count} failed\n"
        f"Artifacts: {suite_summary['run_dir']}\n"
        f"Report: {suite_summary['report_path']}"
    )
    return 0 if failed_count == 0 else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Sync and run repo-backed Vapi observability resources.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    sync_parser = subparsers.add_parser("sync", help="Sync structured outputs, scorecards, and evals into Vapi.")
    sync_parser.add_argument("--environment", required=True, choices=["staging", "production"])
    sync_parser.add_argument("--api-key", required=True)
    sync_parser.add_argument("--base-url", default="https://api.vapi.ai")
    sync_parser.add_argument(
        "--sections",
        default="structured-outputs,scorecards,evals",
        help="Comma-separated subset: structured-outputs, scorecards, evals",
    )
    sync_parser.add_argument("--summary-json")
    sync_parser.set_defaults(func=sync_command)

    run_parser = subparsers.add_parser("run-evals", help="Run the saved Vapi eval suite against an assistant.")
    run_parser.add_argument("--environment", required=True, choices=["staging", "production"])
    run_parser.add_argument("--api-key", required=True)
    run_parser.add_argument("--base-url", default="https://api.vapi.ai")
    run_parser.add_argument("--eval-key", action="append", help="Run only the specified eval key. Repeatable.")
    run_parser.add_argument("--list", action="store_true")
    run_parser.add_argument("--sync-first", action="store_true")
    run_parser.add_argument("--timeout-seconds", type=int, default=30)
    run_parser.add_argument("--poll-interval-seconds", type=int, default=2)
    run_parser.set_defaults(func=run_evals_command)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        return args.func(args)
    except VapiApiError as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
