from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    import tomllib  # type: ignore[attr-defined]
except ModuleNotFoundError:  # pragma: no cover - Python 3.10 fallback
    import tomli as tomllib  # type: ignore[no-redef]


ROOT_DIR = Path(__file__).resolve().parents[1]
AGENTS_DIR = ROOT_DIR / ".codex" / "agents"
CONFIG_PATH = ROOT_DIR / ".codex" / "config.toml"

REQUIRED_ROLES = (
    "repo-auditor",
    "runtime-auditor",
    "patch-worker",
    "staging-verifier",
    "staging-sync-operator",
    "post-sync-evaluator",
    "release-reviewer",
)

REQUIRED_AUTHORITY_KEYS = (
    "repo_read",
    "runtime_read",
    "repo_edit",
    "pre_sync_verify",
    "staging_write",
    "post_sync_evaluate",
    "release_review",
    "production_write",
)

EXPECTED_ROLE_PROFILES: dict[str, dict[str, Any]] = {
    "repo-auditor": {
        "authority": {
            "repo_read": True,
            "runtime_read": False,
            "repo_edit": False,
            "pre_sync_verify": False,
            "staging_write": False,
            "post_sync_evaluate": False,
            "release_review": False,
            "production_write": False,
        },
        "required_mcp_servers": {"repo-read"},
        "required_skills": {"repo-operating-model"},
        "default_environment": "staging",
    },
    "runtime-auditor": {
        "authority": {
            "repo_read": False,
            "runtime_read": True,
            "repo_edit": False,
            "pre_sync_verify": False,
            "staging_write": False,
            "post_sync_evaluate": False,
            "release_review": False,
            "production_write": False,
        },
        "required_mcp_servers": {"vapi-read", "n8n-read"},
        "required_skills": {"runtime-drift-audit"},
        "default_environment": "staging",
    },
    "patch-worker": {
        "authority": {
            "repo_read": True,
            "runtime_read": False,
            "repo_edit": True,
            "pre_sync_verify": False,
            "staging_write": False,
            "post_sync_evaluate": False,
            "release_review": False,
            "production_write": False,
        },
        "required_mcp_servers": {"repo-read"},
        "required_skills": {"repo-operating-model"},
        "default_environment": "staging",
    },
    "staging-verifier": {
        "authority": {
            "repo_read": False,
            "runtime_read": False,
            "repo_edit": False,
            "pre_sync_verify": True,
            "staging_write": False,
            "post_sync_evaluate": False,
            "release_review": False,
            "production_write": False,
        },
        "required_mcp_servers": {"repo-verify"},
        "required_skills": {"staging-verification"},
        "default_environment": "staging",
    },
    "staging-sync-operator": {
        "authority": {
            "repo_read": False,
            "runtime_read": False,
            "repo_edit": False,
            "pre_sync_verify": False,
            "staging_write": True,
            "post_sync_evaluate": False,
            "release_review": False,
            "production_write": False,
        },
        "required_mcp_servers": {"vapi-stage-write", "n8n-stage-write", "ops-guard"},
        "required_skills": {"repo-operating-model", "vapi-config-ops", "n8n-runtime-ops"},
        "default_environment": "staging",
        "allowed_environments": {"staging"},
    },
    "post-sync-evaluator": {
        "authority": {
            "repo_read": False,
            "runtime_read": True,
            "repo_edit": False,
            "pre_sync_verify": False,
            "staging_write": False,
            "post_sync_evaluate": True,
            "release_review": False,
            "production_write": False,
        },
        "required_mcp_servers": {"repo-verify", "vapi-read", "n8n-read"},
        "required_skills": {"staging-verification", "runtime-drift-audit"},
        "default_environment": "staging",
        "allowed_environments": {"staging"},
    },
    "release-reviewer": {
        "authority": {
            "repo_read": True,
            "runtime_read": False,
            "repo_edit": False,
            "pre_sync_verify": False,
            "staging_write": False,
            "post_sync_evaluate": False,
            "release_review": True,
            "production_write": False,
        },
        "required_mcp_servers": {"repo-read", "repo-verify"},
        "required_skills": {"repo-operating-model", "runtime-drift-audit"},
        "default_environment": "production",
    },
}


@dataclass(frozen=True)
class RoleDefinition:
    path: Path
    name: str
    status: str
    phase: int
    summary: str
    authority: dict[str, bool]
    default_environment: str
    allowed_environments: list[str]
    allowed_mcp_servers: list[str]
    allowed_skills: list[str]
    allowed_write_roots: list[str]
    blocked_write_roots: list[str]
    must_not: list[str]
    distinct_from: list[str]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate Codex Phase 3 role boundaries.")
    parser.add_argument("--agents-dir", default=str(AGENTS_DIR))
    parser.add_argument("--config", default=str(CONFIG_PATH))
    return parser.parse_args()


def _load_toml(path: Path) -> dict[str, Any]:
    with path.open("rb") as handle:
        data = tomllib.load(handle)
    if not isinstance(data, dict):
        raise ValueError(f"{path} did not parse as a TOML table")
    return data


def _require_str(table: dict[str, Any], key: str, path: Path, errors: list[str]) -> str:
    value = table.get(key)
    if isinstance(value, str) and value:
        return value
    errors.append(f"{path}: missing or invalid string field `{key}`")
    return ""


def _require_int(table: dict[str, Any], key: str, path: Path, errors: list[str]) -> int:
    value = table.get(key)
    if isinstance(value, int):
        return value
    errors.append(f"{path}: missing or invalid integer field `{key}`")
    return 0


def _require_bool_table(
    table: dict[str, Any],
    keys: tuple[str, ...],
    path: Path,
    errors: list[str],
) -> dict[str, bool]:
    values: dict[str, bool] = {}
    for key in keys:
        value = table.get(key)
        if isinstance(value, bool):
            values[key] = value
        else:
            errors.append(f"{path}: missing or invalid boolean field `authority.{key}`")
            values[key] = False
    return values


def _require_str_list(table: dict[str, Any], key: str, path: Path, errors: list[str]) -> list[str]:
    value = table.get(key)
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return value
    errors.append(f"{path}: missing or invalid string list field `{key}`")
    return []


def load_role(path: Path, errors: list[str]) -> RoleDefinition | None:
    raw = _load_toml(path)
    schema_version = _require_str(raw, "schema_version", path, errors)
    if schema_version and schema_version != "codex_agent_role.v1":
        errors.append(f"{path}: unsupported schema version `{schema_version}`")

    name = _require_str(raw, "name", path, errors)
    if name and name != path.stem:
        errors.append(f"{path}: role name `{name}` does not match filename stem `{path.stem}`")

    status = _require_str(raw, "status", path, errors)
    if status and status not in {"active", "planned"}:
        errors.append(f"{path}: invalid status `{status}`")

    phase = _require_int(raw, "phase", path, errors)
    summary = _require_str(raw, "summary", path, errors)

    authority_raw = raw.get("authority")
    if not isinstance(authority_raw, dict):
        errors.append(f"{path}: missing table `[authority]`")
        return None
    authority = _require_bool_table(authority_raw, REQUIRED_AUTHORITY_KEYS, path, errors)

    scope_raw = raw.get("scope")
    if not isinstance(scope_raw, dict):
        errors.append(f"{path}: missing table `[scope]`")
        return None

    handoff_raw = raw.get("handoff")
    if not isinstance(handoff_raw, dict):
        errors.append(f"{path}: missing table `[handoff]`")
        return None

    independence_raw = raw.get("independence")
    if not isinstance(independence_raw, dict):
        errors.append(f"{path}: missing table `[independence]`")
        return None

    return RoleDefinition(
        path=path,
        name=name,
        status=status,
        phase=phase,
        summary=summary,
        authority=authority,
        default_environment=_require_str(scope_raw, "default_environment", path, errors),
        allowed_environments=_require_str_list(scope_raw, "allowed_environments", path, errors),
        allowed_mcp_servers=_require_str_list(scope_raw, "allowed_mcp_servers", path, errors),
        allowed_skills=_require_str_list(scope_raw, "allowed_skills", path, errors),
        allowed_write_roots=_require_str_list(scope_raw, "allowed_write_roots", path, errors),
        blocked_write_roots=_require_str_list(scope_raw, "blocked_write_roots", path, errors),
        must_not=_require_str_list(handoff_raw, "must_not", path, errors),
        distinct_from=_require_str_list(independence_raw, "must_be_distinct_from", path, errors),
    )


def load_configured_mcp_servers(config_path: Path) -> set[str]:
    raw = _load_toml(config_path)
    mcp_servers = raw.get("mcp_servers", {})
    if not isinstance(mcp_servers, dict):
        return set()
    return {name for name, value in mcp_servers.items() if isinstance(name, str) and isinstance(value, dict)}


def validate_roles(roles: dict[str, RoleDefinition], configured_mcp_servers: set[str]) -> list[str]:
    errors: list[str] = []
    missing_roles = sorted(set(REQUIRED_ROLES) - set(roles))
    if missing_roles:
        errors.append(f"Missing required role definitions: {', '.join(missing_roles)}")

    for role in roles.values():
        expected = EXPECTED_ROLE_PROFILES.get(role.name)
        if expected is None:
            continue

        if role.phase != 3:
            errors.append(f"{role.path}: expected `phase = 3`")
        if not role.summary:
            errors.append(f"{role.path}: summary must not be empty")
        if role.default_environment != expected["default_environment"]:
            errors.append(
                f"{role.path}: expected default environment `{expected['default_environment']}`, "
                f"found `{role.default_environment}`"
            )

        if expected_authority := expected.get("authority"):
            for key, expected_value in expected_authority.items():
                if role.authority.get(key) != expected_value:
                    errors.append(
                        f"{role.path}: expected `authority.{key} = {str(expected_value).lower()}`"
                    )

        required_servers = expected.get("required_mcp_servers", set())
        missing_servers = sorted(set(required_servers) - set(role.allowed_mcp_servers))
        if missing_servers:
            errors.append(f"{role.path}: missing required MCP servers: {', '.join(missing_servers)}")

        required_skills = expected.get("required_skills", set())
        missing_skills = sorted(set(required_skills) - set(role.allowed_skills))
        if missing_skills:
            errors.append(f"{role.path}: missing required skills: {', '.join(missing_skills)}")

        expected_envs = expected.get("allowed_environments")
        if expected_envs is not None and set(role.allowed_environments) != set(expected_envs):
            errors.append(
                f"{role.path}: expected allowed environments `{sorted(expected_envs)}`, "
                f"found `{sorted(role.allowed_environments)}`"
            )

        if role.status == "active":
            missing_configured_servers = sorted(set(role.allowed_mcp_servers) - configured_mcp_servers)
            if missing_configured_servers:
                errors.append(
                    f"{role.path}: active role references unavailable MCP servers: "
                    f"{', '.join(missing_configured_servers)}"
                )

        if role.authority["production_write"]:
            errors.append(f"{role.path}: production writes must stay disabled in Phase 3")
        if role.authority["repo_edit"] and role.authority["staging_write"]:
            errors.append(f"{role.path}: patch and staging-write authority must stay separate")
        if role.authority["repo_edit"] and (
            role.authority["pre_sync_verify"]
            or role.authority["post_sync_evaluate"]
            or role.authority["release_review"]
        ):
            errors.append(f"{role.path}: repo-edit authority must stay separate from grading or release review")
        if role.authority["staging_write"] and (
            role.authority["post_sync_evaluate"] or role.authority["release_review"]
        ):
            errors.append(f"{role.path}: staging-write authority must stay separate from grading or release review")
        if not role.authority["repo_edit"] and role.allowed_write_roots:
            errors.append(f"{role.path}: only repo-edit roles may declare `allowed_write_roots`")
        if role.authority["staging_write"] and "production" in role.allowed_environments:
            errors.append(f"{role.path}: staging-write roles must refuse production")
        if ".env" not in role.blocked_write_roots:
            errors.append(f"{role.path}: `.env` must stay blocked")
        if not role.must_not:
            errors.append(f"{role.path}: `handoff.must_not` must not be empty")

        for other_name in role.distinct_from:
            if other_name == role.name:
                errors.append(f"{role.path}: `independence.must_be_distinct_from` references itself")
            elif other_name not in roles:
                errors.append(f"{role.path}: distinct role `{other_name}` is not defined")

    patch_worker = roles.get("patch-worker")
    repo_auditor = roles.get("repo-auditor")
    staging_verifier = roles.get("staging-verifier")
    post_sync_evaluator = roles.get("post-sync-evaluator")
    staging_sync_operator = roles.get("staging-sync-operator")

    if patch_worker and repo_auditor:
        if not patch_worker.authority["repo_edit"] or repo_auditor.authority["repo_edit"]:
            errors.append("Patch-worker and repo-auditor do not establish an independent audit path")
    if patch_worker and staging_verifier:
        if not staging_verifier.authority["pre_sync_verify"] or staging_verifier.authority["repo_edit"]:
            errors.append("Patched changes cannot be independently pre-verified")
    if patch_worker and post_sync_evaluator:
        if not post_sync_evaluator.authority["post_sync_evaluate"] or post_sync_evaluator.authority["repo_edit"]:
            errors.append("Patched changes cannot be independently post-sync evaluated")
    if staging_sync_operator and post_sync_evaluator:
        if staging_sync_operator.authority["staging_write"] and post_sync_evaluator.authority["staging_write"]:
            errors.append("Sync and post-sync evaluation must stay on different roles")

    return errors


def format_authority(role: RoleDefinition) -> str:
    flags = []
    if role.authority["repo_read"]:
        flags.append("repo-read")
    if role.authority["runtime_read"]:
        flags.append("runtime-read")
    if role.authority["repo_edit"]:
        flags.append("repo-edit")
    if role.authority["pre_sync_verify"]:
        flags.append("pre-sync-verify")
    if role.authority["staging_write"]:
        flags.append("staging-write")
    if role.authority["post_sync_evaluate"]:
        flags.append("post-sync-evaluate")
    if role.authority["release_review"]:
        flags.append("release-review")
    if role.authority["production_write"]:
        flags.append("production-write")
    return ", ".join(flags) or "read-none"


def main() -> int:
    args = parse_args()
    agents_dir = Path(args.agents_dir).resolve()
    config_path = Path(args.config).resolve()

    if not agents_dir.is_dir():
        print(f"Agents directory not found: {agents_dir}", file=sys.stderr)
        return 1
    if not config_path.is_file():
        print(f"Config file not found: {config_path}", file=sys.stderr)
        return 1

    configured_mcp_servers = load_configured_mcp_servers(config_path)
    parse_errors: list[str] = []
    roles: dict[str, RoleDefinition] = {}

    for path in sorted(agents_dir.glob("*.toml")):
        role = load_role(path, parse_errors)
        if role is None:
            continue
        roles[role.name] = role

    errors = parse_errors + validate_roles(roles, configured_mcp_servers)
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1

    print(f"Configured MCP servers: {', '.join(sorted(configured_mcp_servers))}")
    for name in REQUIRED_ROLES:
        role = roles[name]
        print(f"{role.name}: {role.status} | {format_authority(role)}")
    print(
        "Independent change path: "
        "repo-auditor -> patch-worker -> staging-verifier -> staging-sync-operator -> post-sync-evaluator -> release-reviewer"
    )
    print("Codex agent boundary check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
