from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence


REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CODEX_RUNS_DIR = REPO_ROOT / "autonomy" / "runs" / "generated" / "codex"
DEFAULT_CODEX_REPORTS_DIR = REPO_ROOT / "autonomy" / "reports" / "generated" / "codex"
SENSITIVE_KEY_TOKENS = (
    "AUTH",
    "KEY",
    "PASSWORD",
    "SECRET",
    "SID",
    "TOKEN",
)
QUERY_SECRET_RE = re.compile(
    r"([?&](?:api[_-]?key|authorization|bearer|secret|token)=)([^&#\s]+)",
    re.IGNORECASE,
)
BEARER_RE = re.compile(r"(Bearer\s+)([^\s]+)", re.IGNORECASE)


@dataclass(frozen=True)
class RepoContext:
    root_dir: Path
    env_path: Path
    codex_runs_dir: Path
    codex_reports_dir: Path

    @classmethod
    def discover(cls) -> "RepoContext":
        configured_root = os.environ.get("PROJECT_ROOT", "").strip()
        root_dir = Path(configured_root).resolve() if configured_root else REPO_ROOT
        return cls(
            root_dir=root_dir,
            env_path=root_dir / ".env",
            codex_runs_dir=root_dir / "autonomy" / "runs" / "generated" / "codex",
            codex_reports_dir=root_dir / "autonomy" / "reports" / "generated" / "codex",
        )

    def relative_path(self, path: Path) -> str:
        try:
            return str(path.resolve().relative_to(self.root_dir))
        except ValueError:
            return str(path.resolve())


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def compact_timestamp() -> str:
    return time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())


def normalize_environment(environment: str) -> str:
    normalized = (environment or "").strip().lower() or "staging"
    if normalized not in {"staging", "production"}:
        raise ValueError("environment must be staging or production")
    return normalized


def environment_prefix(environment: str) -> str:
    return normalize_environment(environment).upper()


def get_context_env_value(
    env: Mapping[str, str],
    environment: str,
    key: str,
    legacy_var: str | None = None,
) -> str:
    prefix = environment_prefix(environment)
    value = env.get(f"{prefix}_{key}", "")
    if value == "" and legacy_var:
        value = env.get(legacy_var, "")
    return value


def load_env_file(env_path: Path) -> dict[str, str]:
    if not env_path.is_file():
        return {}

    env: dict[str, str] = {}
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key:
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            quote = value[0]
            value = value[1:-1]
            if quote == '"':
                value = bytes(value, "utf-8").decode("unicode_escape")
        env[key] = value
    return env


def merged_env(context: RepoContext, extra_env: Mapping[str, str] | None = None) -> dict[str, str]:
    env = dict(os.environ)
    env.setdefault("PROJECT_ROOT", str(context.root_dir))
    env.update(load_env_file(context.env_path))
    if extra_env:
        env.update(extra_env)
    return env


def secret_values(env: Mapping[str, str]) -> list[str]:
    values: list[str] = []
    for key, value in env.items():
        if not value or len(value) < 6:
            continue
        upper_key = key.upper()
        if any(token in upper_key for token in SENSITIVE_KEY_TOKENS):
            values.append(value)
    return sorted(set(values), key=len, reverse=True)


def redact_text(value: str, env: Mapping[str, str] | None = None) -> str:
    secrets = secret_values(env or os.environ)
    redacted = value
    redacted = QUERY_SECRET_RE.sub(r"\1[REDACTED]", redacted)
    redacted = BEARER_RE.sub(r"\1[REDACTED]", redacted)
    for secret in secrets:
        redacted = redacted.replace(secret, "[REDACTED]")
    return redacted


def redact_value(value: Any, env: Mapping[str, str] | None = None) -> Any:
    if isinstance(value, dict):
        return {key: redact_value(nested, env=env) for key, nested in value.items()}
    if isinstance(value, list):
        return [redact_value(item, env=env) for item in value]
    if isinstance(value, str):
        return redact_text(value, env=env)
    return value


def resolve_repo_path(context: RepoContext, path_value: str) -> Path:
    candidate = Path(path_value)
    resolved = candidate.resolve() if candidate.is_absolute() else (context.root_dir / candidate).resolve()
    try:
        resolved.relative_to(context.root_dir)
    except ValueError as exc:
        raise ValueError(f"path must stay inside the repo: {path_value}") from exc
    return resolved


def read_text_slice(
    context: RepoContext,
    path_value: str,
    start_line: int = 1,
    line_count: int = 200,
) -> dict[str, Any]:
    if start_line < 1:
        raise ValueError("start_line must be >= 1")
    if line_count < 1 or line_count > 500:
        raise ValueError("line_count must be between 1 and 500")

    path = resolve_repo_path(context, path_value)
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    start_index = start_line - 1
    end_index = min(len(lines), start_index + line_count)
    selected_lines = lines[start_index:end_index]
    env = merged_env(context)
    return {
        "path": context.relative_path(path),
        "startLine": start_line,
        "endLine": end_index,
        "lineCount": len(selected_lines),
        "content": redact_text("\n".join(selected_lines), env=env),
    }


def run_command(
    context: RepoContext,
    command: Sequence[str],
    *,
    cwd: Path | None = None,
    extra_env: Mapping[str, str] | None = None,
    timeout_seconds: int | None = None,
    redact_output: bool = True,
) -> dict[str, Any]:
    env = merged_env(context, extra_env=extra_env)
    start = time.monotonic()
    completed = subprocess.run(
        list(command),
        cwd=str(cwd or context.root_dir),
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
        check=False,
    )
    duration_ms = int((time.monotonic() - start) * 1000)
    stdout = completed.stdout
    stderr = completed.stderr
    if redact_output:
        stdout = redact_text(stdout, env=env)
        stderr = redact_text(stderr, env=env)
    return {
        "command": [str(item) for item in command],
        "commandDisplay": shlex.join(str(item) for item in command),
        "cwd": context.relative_path((cwd or context.root_dir).resolve()),
        "durationMs": duration_ms,
        "ok": completed.returncode == 0,
        "returncode": completed.returncode,
        "stdout": stdout,
        "stderr": stderr,
    }


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"{json.dumps(payload, ensure_ascii=True, indent=2)}\n", encoding="utf-8")


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
