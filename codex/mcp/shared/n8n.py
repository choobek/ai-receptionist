from __future__ import annotations

import json
import shlex
import subprocess
import time
from pathlib import Path
from typing import Any

from codex.mcp.shared.common import (
    RepoContext,
    get_context_env_value,
    merged_env,
    normalize_environment,
    redact_text,
)


class N8nReadError(RuntimeError):
    pass


def repo_workflow_catalog(context: RepoContext) -> list[dict[str, Any]]:
    workflows_dir = context.root_dir / "n8n" / "workflows"
    items: list[dict[str, Any]] = []
    for path in sorted(workflows_dir.glob("*.json")):
        payload = json.loads(path.read_text(encoding="utf-8"))
        items.append(
            {
                "id": payload.get("id"),
                "name": payload.get("name"),
                "path": context.relative_path(path),
            }
        )
    return items


def build_runtime_target(context: RepoContext, environment: str) -> dict[str, Any]:
    normalized = normalize_environment(environment)
    env = merged_env(context)

    legacy_host = "VPS_SSH_HOST" if normalized == "production" else None
    legacy_user = "VPS_SSH_USER" if normalized == "production" else None
    legacy_port = "VPS_SSH_PORT" if normalized == "production" else None
    legacy_identity = "VPS_SSH_IDENTITY_FILE" if normalized == "production" else None
    legacy_app_dir = "VPS_APP_DIR" if normalized == "production" else None
    legacy_container = "VPS_N8N_CONTAINER_NAME" if normalized == "production" else None

    host = get_context_env_value(env, normalized, "VPS_SSH_HOST", legacy_host)
    user = get_context_env_value(env, normalized, "VPS_SSH_USER", legacy_user)
    if not host or not user:
        raise N8nReadError(f"VPS SSH target is incomplete for {normalized}")

    port = get_context_env_value(env, normalized, "VPS_SSH_PORT", legacy_port) or "22"
    identity_file = get_context_env_value(env, normalized, "VPS_SSH_IDENTITY_FILE", legacy_identity)
    app_dir = get_context_env_value(env, normalized, "VPS_APP_DIR", legacy_app_dir)
    if not app_dir:
        raise N8nReadError(f"VPS_APP_DIR is required for {normalized}")
    container_name = get_context_env_value(env, normalized, "VPS_N8N_CONTAINER_NAME", legacy_container)

    return {
        "environment": normalized,
        "env": env,
        "host": host,
        "user": user,
        "port": str(port),
        "identityFile": identity_file,
        "appDir": app_dir,
        "containerName": container_name,
    }


def _run_ssh_command(target: dict[str, Any], remote_script: str) -> dict[str, Any]:
    ssh_args = [
        "ssh",
        "-p",
        target["port"],
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
    ]
    if target.get("identityFile"):
        ssh_args.extend(["-i", target["identityFile"]])

    remote_command = []
    if target.get("containerName"):
        remote_command.append(f"REMOTE_CONTAINER={shlex.quote(target['containerName'])}")
    remote_command.extend(["bash", "-lc", shlex.quote(remote_script)])

    start = time.monotonic()
    completed = subprocess.run(
        ssh_args + [f"{target['user']}@{target['host']}", " ".join(remote_command)],
        capture_output=True,
        text=True,
        check=False,
    )
    duration_ms = int((time.monotonic() - start) * 1000)
    return {
        "ok": completed.returncode == 0,
        "returncode": completed.returncode,
        "durationMs": duration_ms,
        "stdout": completed.stdout,
        "stderr": redact_text(completed.stderr, env=target["env"]),
    }


def _build_list_workflow_script(app_dir: str, *, active_only: bool) -> str:
    active_flag = " --active=true" if active_only else ""
    return f"""
set -euo pipefail
cd {shlex.quote(app_dir)}
c="${{REMOTE_CONTAINER:-}}"
if [ -z "$c" ] && [ -f .env ]; then
  c="$(awk -F= '/^N8N_CONTAINER_NAME=/{{
    sub(/^[^=]*=/, "");
    print;
    exit
  }}' .env)"
fi
c="${{c:-ai-receptionist-n8n}}"
echo "CONTAINER:$c"
docker exec "$c" n8n list:workflow{active_flag}
"""


def _parse_workflow_inventory(output: str) -> dict[str, Any]:
    container_name = None
    workflows: list[dict[str, str]] = []
    notices: list[str] = []
    for raw_line in output.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("CONTAINER:"):
            container_name = line.split(":", 1)[1]
            continue
        if "|" not in line:
            notices.append(line)
            continue
        workflow_id, workflow_name = line.split("|", 1)
        workflows.append({"id": workflow_id, "name": workflow_name})
    return {
        "containerName": container_name,
        "workflows": workflows,
        "notices": notices,
    }


def fetch_runtime_workflow_inventory(context: RepoContext, environment: str) -> dict[str, Any]:
    target = build_runtime_target(context, environment)
    all_result = _run_ssh_command(target, _build_list_workflow_script(target["appDir"], active_only=False))
    if not all_result["ok"]:
        raise N8nReadError(all_result["stderr"] or all_result["stdout"] or "n8n workflow inventory failed")

    active_result = _run_ssh_command(target, _build_list_workflow_script(target["appDir"], active_only=True))
    if not active_result["ok"]:
        raise N8nReadError(active_result["stderr"] or active_result["stdout"] or "active n8n workflow inventory failed")

    all_inventory = _parse_workflow_inventory(all_result["stdout"])
    active_inventory = _parse_workflow_inventory(active_result["stdout"])
    return {
        "environment": target["environment"],
        "containerName": active_inventory["containerName"] or all_inventory["containerName"],
        "allWorkflows": all_inventory["workflows"],
        "activeWorkflows": active_inventory["workflows"],
        "notices": sorted(set(all_inventory["notices"] + active_inventory["notices"])),
        "commands": {
            "all": "n8n list:workflow",
            "active": "n8n list:workflow --active=true",
        },
    }


def build_duplicate_workflow_report(context: RepoContext, environment: str) -> dict[str, Any]:
    repo_catalog = repo_workflow_catalog(context)
    runtime_inventory = fetch_runtime_workflow_inventory(context, environment)

    repo_ids = {item["id"] for item in repo_catalog if item.get("id")}
    repo_names = {item["name"] for item in repo_catalog if item.get("name")}
    all_workflows = runtime_inventory["allWorkflows"]
    active_workflows = runtime_inventory["activeWorkflows"]

    all_ids = {item["id"] for item in all_workflows}
    active_ids = {item["id"] for item in active_workflows}

    legacy_duplicates = [
        item for item in all_workflows if item["id"] not in repo_ids and item["name"] in repo_names
    ]
    active_legacy_duplicates = [
        item for item in active_workflows if item["id"] not in repo_ids and item["name"] in repo_names
    ]
    repo_owned_active = [item for item in active_workflows if item["id"] in repo_ids]
    repo_owned_inactive = [item for item in all_workflows if item["id"] in repo_ids and item["id"] not in active_ids]

    missing_repo_ids = sorted(repo_ids - all_ids)
    unexpected_active = [item for item in active_workflows if item["id"] not in repo_ids]

    return {
        "environment": runtime_inventory["environment"],
        "containerName": runtime_inventory["containerName"],
        "repoWorkflowCount": len(repo_catalog),
        "runtimeWorkflowCount": len(all_workflows),
        "activeWorkflowCount": len(active_workflows),
        "repoOwnedActive": repo_owned_active,
        "repoOwnedInactive": repo_owned_inactive,
        "legacyDuplicates": legacy_duplicates,
        "activeLegacyDuplicates": active_legacy_duplicates,
        "missingRepoWorkflowIds": missing_repo_ids,
        "unexpectedActiveWorkflows": unexpected_active,
        "notices": runtime_inventory["notices"],
        "repoCatalog": repo_catalog,
        "runtimeInventory": runtime_inventory,
    }
