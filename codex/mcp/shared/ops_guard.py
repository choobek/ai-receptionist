from __future__ import annotations

import hashlib
import json
import secrets
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from codex.mcp.shared.common import (
    RepoContext,
    compact_timestamp,
    normalize_environment,
    run_command,
    write_json,
)


@dataclass(frozen=True)
class CommandSpec:
    name: str
    command: tuple[str, ...]
    timeout_seconds: int
    mutating: bool


@dataclass(frozen=True)
class ActionPlan:
    scope: str
    action: str
    description: str
    commands: tuple[CommandSpec, ...]
    requires_n8n_backup_check: bool


TICKET_KIND = "codex_ops_guard_ticket.v1"
DEFAULT_TTL_SECONDS = 1800
ALLOWED_SCOPES = ("vapi", "vapi-observability", "n8n", "full")


def normalize_scope(scope: str) -> str:
    normalized = (scope or "").strip().lower() or "full"
    if normalized not in ALLOWED_SCOPES:
        raise ValueError(f"scope must be one of: {', '.join(ALLOWED_SCOPES)}")
    return normalized


def require_staging_environment(environment: str) -> str:
    normalized = normalize_environment(environment)
    if normalized != "staging":
        raise ValueError("ops-guard refuses production; environment must be staging")
    return normalized


def tickets_dir(context: RepoContext) -> Path:
    return context.codex_runs_dir / "ops-guard-tickets"


def action_plan_for_scope(scope: str, environment: str = "staging") -> ActionPlan:
    normalized_scope = normalize_scope(scope)
    normalized_environment = require_staging_environment(environment)

    if normalized_scope == "vapi":
        commands = (
            CommandSpec(
                name="sync-vapi-environment",
                command=("./scripts/sync-vapi-environment.sh", normalized_environment),
                timeout_seconds=1800,
                mutating=True,
            ),
        )
        return ActionPlan(
            scope=normalized_scope,
            action="vapi-environment-sync",
            description="Apply the canonical Vapi environment config to staging through the repo sync script.",
            commands=commands,
            requires_n8n_backup_check=False,
        )

    if normalized_scope == "vapi-observability":
        commands = (
            CommandSpec(
                name="sync-vapi-observability",
                command=("./scripts/sync-vapi-observability.sh", normalized_environment),
                timeout_seconds=1800,
                mutating=True,
            ),
        )
        return ActionPlan(
            scope=normalized_scope,
            action="vapi-observability-sync",
            description="Apply canonical Vapi structured outputs and scorecards to staging.",
            commands=commands,
            requires_n8n_backup_check=False,
        )

    if normalized_scope == "n8n":
        commands = (
            CommandSpec(
                name="check-n8n-workflow-data",
                command=("./scripts/sync-n8n-workflow-data.sh", "--check"),
                timeout_seconds=900,
                mutating=False,
            ),
            CommandSpec(
                name="import-n8n-workflows",
                command=("./scripts/import-n8n-workflows-vps.sh", normalized_environment),
                timeout_seconds=3600,
                mutating=True,
            ),
            CommandSpec(
                name="reconcile-n8n-workflows",
                command=("./scripts/reconcile-n8n-workflows-vps.sh", normalized_environment),
                timeout_seconds=3600,
                mutating=True,
            ),
        )
        return ActionPlan(
            scope=normalized_scope,
            action="n8n-workflow-sync",
            description="Push repo-owned n8n workflows to staging through data-check, import, and reconcile.",
            commands=commands,
            requires_n8n_backup_check=True,
        )

    commands = (
        CommandSpec(
            name="check-n8n-workflow-data",
            command=("./scripts/sync-n8n-workflow-data.sh", "--check"),
            timeout_seconds=900,
            mutating=False,
        ),
        CommandSpec(
            name="import-n8n-workflows",
            command=("./scripts/import-n8n-workflows-vps.sh", normalized_environment),
            timeout_seconds=3600,
            mutating=True,
        ),
        CommandSpec(
            name="reconcile-n8n-workflows",
            command=("./scripts/reconcile-n8n-workflows-vps.sh", normalized_environment),
            timeout_seconds=3600,
            mutating=True,
        ),
        CommandSpec(
            name="sync-vapi-environment",
            command=("./scripts/sync-vapi-environment.sh", normalized_environment),
            timeout_seconds=1800,
            mutating=True,
        ),
    )
    return ActionPlan(
        scope=normalized_scope,
        action="staging-full-sync",
        description="Run the staging-safe n8n and Vapi sync sequence through existing repo scripts.",
        commands=commands,
        requires_n8n_backup_check=True,
    )


def command_plan_payload(plan: ActionPlan) -> list[dict[str, Any]]:
    return [
        {
            "name": spec.name,
            "command": list(spec.command),
            "commandDisplay": " ".join(spec.command),
            "timeoutSeconds": spec.timeout_seconds,
            "mutating": spec.mutating,
        }
        for spec in plan.commands
    ]


def git_state(context: RepoContext) -> dict[str, Any]:
    head = run_command(context, ["git", "-C", str(context.root_dir), "rev-parse", "HEAD"])
    branch = run_command(context, ["git", "-C", str(context.root_dir), "rev-parse", "--abbrev-ref", "HEAD"])
    status = run_command(context, ["git", "-C", str(context.root_dir), "status", "--short"])
    dirty_lines = [line for line in status["stdout"].splitlines() if line.strip()]
    return {
        "head": head["stdout"].strip(),
        "branch": branch["stdout"].strip(),
        "dirty": bool(dirty_lines),
        "dirtyPaths": dirty_lines,
    }


def n8n_import_script_has_backup(context: RepoContext) -> bool:
    script_path = context.root_dir / "scripts" / "import-n8n-workflows-vps.sh"
    text = script_path.read_text(encoding="utf-8")
    backup_index = text.find("n8n export:workflow --backup")
    import_index = text.find("n8n import:workflow")
    if backup_index == -1 or import_index == -1:
        return False
    return backup_index < import_index


def build_preflight(context: RepoContext, scope: str, environment: str = "staging") -> dict[str, Any]:
    plan = action_plan_for_scope(scope, environment)
    backup_before_import = None
    if plan.requires_n8n_backup_check:
        backup_before_import = n8n_import_script_has_backup(context)
        if not backup_before_import:
            raise ValueError("n8n import flow no longer proves backup-before-import")
    return {
        "environment": environment,
        "scope": plan.scope,
        "action": plan.action,
        "description": plan.description,
        "productionPolicy": "refused",
        "productionRefused": True,
        "requiresPostSyncVerification": True,
        "requiresN8nBackupCheck": plan.requires_n8n_backup_check,
        "n8nImportScriptHasBackup": backup_before_import,
        "git": git_state(context),
        "commandPlan": command_plan_payload(plan),
    }


def _ticket_path(context: RepoContext, approval_token: str) -> Path:
    token_hash = hashlib.sha256(approval_token.encode("utf-8")).hexdigest()
    return tickets_dir(context) / f"{token_hash}.json"


def _iso_from_epoch(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def issue_stage_write_ticket(
    context: RepoContext,
    scope: str,
    environment: str = "staging",
    ttl_seconds: int = DEFAULT_TTL_SECONDS,
) -> dict[str, Any]:
    if ttl_seconds <= 0 or ttl_seconds > 86400:
        raise ValueError("ttl_seconds must be between 1 and 86400")

    preflight = build_preflight(context, scope, environment)
    now_epoch = time.time()
    expires_epoch = now_epoch + ttl_seconds
    approval_token = secrets.token_urlsafe(24)
    ticket_path = _ticket_path(context, approval_token)
    issued_at = _iso_from_epoch(now_epoch)
    expires_at = _iso_from_epoch(expires_epoch)
    ticket_payload = {
        "kind": TICKET_KIND,
        "tokenId": approval_token[:12],
        "scope": preflight["scope"],
        "action": preflight["action"],
        "environment": preflight["environment"],
        "issuedAt": issued_at,
        "expiresAt": expires_at,
        "expiresAtEpoch": int(expires_epoch),
        "consumedAt": None,
        "preflight": preflight,
    }
    write_json(ticket_path, ticket_payload)
    return {
        "approvalToken": approval_token,
        "tokenId": ticket_payload["tokenId"],
        "ticketPath": context.relative_path(ticket_path),
        "scope": preflight["scope"],
        "action": preflight["action"],
        "environment": preflight["environment"],
        "issuedAt": issued_at,
        "expiresAt": expires_at,
        "preflight": preflight,
    }


def inspect_stage_write_ticket(
    context: RepoContext,
    approval_token: str,
    scope: str,
    environment: str = "staging",
) -> dict[str, Any]:
    plan = action_plan_for_scope(scope, environment)
    ticket_path = _ticket_path(context, approval_token)
    if not ticket_path.is_file():
        raise ValueError("approval token is unknown")
    payload = json.loads(ticket_path.read_text(encoding="utf-8"))
    if payload.get("kind") != TICKET_KIND:
        raise ValueError("approval token file has an unexpected kind")
    if payload.get("environment") != require_staging_environment(environment):
        raise ValueError("approval token environment does not match the requested environment")
    if payload.get("action") != plan.action:
        raise ValueError("approval token action does not match the requested scope")
    if payload.get("consumedAt"):
        raise ValueError("approval token has already been consumed")
    expires_at_epoch = int(payload.get("expiresAtEpoch", 0))
    if expires_at_epoch <= int(time.time()):
        raise ValueError("approval token has expired")
    return payload


def consume_stage_write_ticket(
    context: RepoContext,
    approval_token: str,
    scope: str,
    environment: str = "staging",
) -> dict[str, Any]:
    payload = inspect_stage_write_ticket(context, approval_token, scope, environment)
    consumed_at = _iso_from_epoch(time.time())
    payload["consumedAt"] = consumed_at
    write_json(_ticket_path(context, approval_token), payload)
    return {
        "tokenId": payload["tokenId"],
        "consumedAt": consumed_at,
        "scope": payload["scope"],
        "action": payload["action"],
        "environment": payload["environment"],
    }


def stage_write_surface_map() -> dict[str, Any]:
    return {
        "allowedEnvironment": "staging",
        "productionPolicy": "refused",
        "tokenTtlSecondsDefault": DEFAULT_TTL_SECONDS,
        "scopes": [
            {
                "scope": scope,
                "action": action_plan_for_scope(scope, "staging").action,
                "description": action_plan_for_scope(scope, "staging").description,
                "commandPlan": command_plan_payload(action_plan_for_scope(scope, "staging")),
            }
            for scope in ALLOWED_SCOPES
        ],
    }
