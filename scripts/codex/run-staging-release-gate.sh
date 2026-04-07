#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNS_ROOT="$ROOT_DIR/autonomy/runs/generated/codex"
REPORTS_ROOT="$ROOT_DIR/autonomy/reports/generated/codex"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/codex/run-staging-release-gate.sh [options]

Options:
  --output-dir <dir>         Override the generated run directory.
  --report <path>            Override the generated Markdown report path.
  --include-saved-eval       Also run the saved Vapi eval lane as advisory evidence.
  --skip-live-autoeval       Skip the live Vapi autoevaluation lane.
  --since-hours <n>          Live autoeval lookback window. Default: 72.
  --live-limit <n>           Live autoeval fetch limit. Default: 15.
  --help                     Show this help message.
EOF
}

RUN_DIR=""
REPORT_PATH=""
INCLUDE_SAVED_EVAL=false
SKIP_LIVE_AUTOEVAL=false
SINCE_HOURS=72
LIVE_LIMIT=15

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir)
      RUN_DIR="$2"
      shift 2
      ;;
    --report)
      REPORT_PATH="$2"
      shift 2
      ;;
    --include-saved-eval)
      INCLUDE_SAVED_EVAL=true
      shift
      ;;
    --skip-live-autoeval)
      SKIP_LIVE_AUTOEVAL=true
      shift
      ;;
    --since-hours)
      SINCE_HOURS="$2"
      shift 2
      ;;
    --live-limit)
      LIVE_LIMIT="$2"
      shift 2
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if ! [[ "$SINCE_HOURS" =~ ^[0-9]+$ ]] || [ "$SINCE_HOURS" -le 0 ]; then
  echo "--since-hours must be a positive integer" >&2
  exit 1
fi

if ! [[ "$LIVE_LIMIT" =~ ^[0-9]+$ ]] || [ "$LIVE_LIMIT" -le 0 ]; then
  echo "--live-limit must be a positive integer" >&2
  exit 1
fi

RUN_ID="codex-staging-release-gate-$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="${RUN_DIR:-$RUNS_ROOT/$RUN_ID}"
REPORT_PATH="${REPORT_PATH:-$REPORTS_ROOT/$RUN_ID.md}"
SUMMARY_JSON_PATH="$RUN_DIR/release-gate.summary.json"
LANES_JSONL_PATH="$RUN_DIR/lanes.jsonl"

mkdir -p "$RUN_DIR" "$(dirname "$REPORT_PATH")"
: >"$LANES_JSONL_PATH"

to_relative_path() {
  local target="$1"
  case "$target" in
    "$ROOT_DIR"/*)
      printf '%s\n' "${target#"$ROOT_DIR"/}"
      ;;
    *)
      printf '%s\n' "$target"
      ;;
  esac
}

append_lane_record() {
  local name="$1"
  local blocking="$2"
  local status="$3"
  local exit_code="$4"
  local started_at="$5"
  local finished_at="$6"
  local command_display="$7"
  local log_path="$8"
  local artifacts_json="$9"

  python3 - "$LANES_JSONL_PATH" "$name" "$blocking" "$status" "$exit_code" \
    "$started_at" "$finished_at" "$command_display" "$log_path" "$artifacts_json" <<'PY'
import json
import sys

(
    lanes_path,
    name,
    blocking,
    status,
    exit_code,
    started_at,
    finished_at,
    command_display,
    log_path,
    artifacts_json,
) = sys.argv[1:11]

record = {
    "name": name,
    "blocking": blocking == "true",
    "status": status,
    "exitCode": int(exit_code),
    "startedAt": started_at,
    "finishedAt": finished_at,
    "command": command_display,
    "logPath": log_path,
    "artifacts": json.loads(artifacts_json),
}

with open(lanes_path, "a", encoding="utf-8") as handle:
    handle.write(json.dumps(record, ensure_ascii=True) + "\n")
PY
}

run_lane() {
  local name="$1"
  local blocking="$2"
  local artifacts_json="$3"
  shift 3

  local log_path="$RUN_DIR/${name}.log"
  local log_rel
  local started_at
  local finished_at
  local rc

  log_rel="$(to_relative_path "$log_path")"
  started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  echo
  echo "==> $name"
  echo "Command: $*"

  set +e
  (
    cd "$ROOT_DIR"
    "$@" 2>&1 | tee "$log_path"
  )
  rc=${PIPESTATUS[0]}
  set -e

  finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  if [ "$rc" -eq 0 ]; then
    append_lane_record "$name" "$blocking" "passed" "$rc" "$started_at" "$finished_at" "$*" "$log_rel" "$artifacts_json"
    return 0
  fi

  append_lane_record "$name" "$blocking" "failed" "$rc" "$started_at" "$finished_at" "$*" "$log_rel" "$artifacts_json"
  return "$rc"
}

FINAL_RC=0
OVERALL_STATUS="passed"
STOP_REASON=""

REPO_HEALTH_ARTIFACTS='[]'
BACKEND_ARTIFACTS='[]'
STAGING_CHAT_DIR="$RUN_DIR/staging-chat-gate"
STAGING_CHAT_REPORT="$RUN_DIR/staging-chat-gate.md"
STAGING_CHAT_ARTIFACTS=$(python3 - "$(to_relative_path "$STAGING_CHAT_DIR")" "$(to_relative_path "$STAGING_CHAT_REPORT")" <<'PY'
import json
import sys
run_dir, report_path = sys.argv[1:3]
print(json.dumps([run_dir, f"{run_dir}/suite.result.v1.json", report_path], ensure_ascii=True))
PY
)
LIVE_AUTOEVAL_DIR="$RUN_DIR/live-autoeval"
LIVE_AUTOEVAL_REPORT="$RUN_DIR/live-autoeval.md"
LIVE_AUTOEVAL_SUMMARY="$RUN_DIR/live-autoeval.summary.json"
LIVE_AUTOEVAL_ARTIFACTS=$(python3 - "$(to_relative_path "$LIVE_AUTOEVAL_DIR")" "$(to_relative_path "$LIVE_AUTOEVAL_REPORT")" "$(to_relative_path "$LIVE_AUTOEVAL_SUMMARY")" <<'PY'
import json
import sys
print(json.dumps(sys.argv[1:], ensure_ascii=True))
PY
)
SAVED_EVAL_ARTIFACTS='[]'

if run_lane "01-repo-health" true "$REPO_HEALTH_ARTIFACTS" ./scripts/check-repo-health.sh; then
  :
else
  FINAL_RC=$?
  OVERALL_STATUS="failed"
  STOP_REASON="repo health failed"
fi

if [ "$FINAL_RC" -eq 0 ]; then
  if run_lane "02-backend-regressions" true "$BACKEND_ARTIFACTS" node scripts/check-workflow-regressions.js; then
    :
  else
    FINAL_RC=$?
    OVERALL_STATUS="failed"
    STOP_REASON="backend regressions failed"
  fi
fi

if [ "$FINAL_RC" -eq 0 ]; then
  if run_lane \
    "03-staging-chat-gate" \
    true \
    "$STAGING_CHAT_ARTIFACTS" \
    ./scripts/run-staging-regression-suite.sh \
    --output-dir "$STAGING_CHAT_DIR" \
    --report "$STAGING_CHAT_REPORT"; then
    :
  else
    FINAL_RC=$?
    OVERALL_STATUS="failed"
    STOP_REASON="staging chat gate failed"
  fi
fi

if [ "$INCLUDE_SAVED_EVAL" = true ]; then
  if run_lane "04-saved-vapi-eval-advisory" false "$SAVED_EVAL_ARTIFACTS" ./scripts/run-vapi-eval-suite.sh staging; then
    :
  else
    if [ "$OVERALL_STATUS" = "passed" ]; then
      OVERALL_STATUS="passed_with_advisories"
    fi
  fi
fi

if [ "$SKIP_LIVE_AUTOEVAL" = false ] && [ "$FINAL_RC" -eq 0 ]; then
  if run_lane \
    "05-live-autoeval" \
    true \
    "$LIVE_AUTOEVAL_ARTIFACTS" \
    ./scripts/run-vapi-live-autoeval.sh \
    staging \
    --since-hours "$SINCE_HOURS" \
    --limit "$LIVE_LIMIT" \
    --output-dir "$LIVE_AUTOEVAL_DIR" \
    --report "$LIVE_AUTOEVAL_REPORT" \
    --summary-json "$LIVE_AUTOEVAL_SUMMARY"; then
    :
  else
    FINAL_RC=$?
    OVERALL_STATUS="failed"
    STOP_REASON="live autoeval failed"
  fi
fi

GIT_SHA="$(git -C "$ROOT_DIR" rev-parse HEAD)"
GIT_BRANCH="$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD)"
REPORT_REL="$(to_relative_path "$REPORT_PATH")"
RUN_DIR_REL="$(to_relative_path "$RUN_DIR")"
SUMMARY_JSON_REL="$(to_relative_path "$SUMMARY_JSON_PATH")"

python3 - "$LANES_JSONL_PATH" "$SUMMARY_JSON_PATH" "$REPORT_PATH" "$RUN_ID" "$RUN_DIR_REL" "$REPORT_REL" \
  "$SUMMARY_JSON_REL" "$GIT_SHA" "$GIT_BRANCH" "$OVERALL_STATUS" "$STOP_REASON" "$INCLUDE_SAVED_EVAL" \
  "$SKIP_LIVE_AUTOEVAL" "$SINCE_HOURS" "$LIVE_LIMIT" <<'PY'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

(
    lanes_jsonl_path,
    summary_json_path,
    report_path,
    run_id,
    run_dir_rel,
    report_rel,
    summary_json_rel,
    git_sha,
    git_branch,
    overall_status,
    stop_reason,
    include_saved_eval,
    skip_live_autoeval,
    since_hours,
    live_limit,
) = sys.argv[1:16]

lanes = []
with open(lanes_jsonl_path, "r", encoding="utf-8") as handle:
    for raw_line in handle:
        line = raw_line.strip()
        if line:
            lanes.append(json.loads(line))

summary = {
    "kind": "codex_staging_release_gate.v1",
    "suite_run_id": run_id,
    "created_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    "run_dir": run_dir_rel,
    "report_path": report_rel,
    "git": {
        "sha": git_sha,
        "branch": git_branch,
    },
    "options": {
        "include_saved_eval": include_saved_eval == "true",
        "skip_live_autoeval": skip_live_autoeval == "true",
        "since_hours": int(since_hours),
        "live_limit": int(live_limit),
    },
    "overall_status": overall_status,
    "stop_reason": stop_reason or None,
    "lanes": lanes,
}

summary_path = Path(summary_json_path)
summary_path.parent.mkdir(parents=True, exist_ok=True)
summary_path.write_text(f"{json.dumps(summary, ensure_ascii=True, indent=2)}\n", encoding="utf-8")

lines = [
    "# Codex Staging Release Gate",
    "",
    f"- Suite run: `{run_id}`",
    f"- Status: `{overall_status}`",
    f"- Git branch: `{git_branch}`",
    f"- Git SHA: `{git_sha}`",
    f"- Run dir: `{run_dir_rel}`",
    f"- Summary JSON: `{summary_json_rel}`",
]

if stop_reason:
    lines.append(f"- Stop reason: {stop_reason}")

lines.extend(
    [
        "",
        "## Options",
        "",
        f"- Include saved eval: {'yes' if include_saved_eval == 'true' else 'no'}",
        f"- Skip live autoeval: {'yes' if skip_live_autoeval == 'true' else 'no'}",
        f"- Live autoeval since-hours: `{since_hours}`",
        f"- Live autoeval limit: `{live_limit}`",
        "",
        "## Lanes",
        "",
    ]
)

for lane in lanes:
    lines.append(f"- `{lane['name']}`: `{lane['status']}` (exit `{lane['exitCode']}`)")
    lines.append(f"  - Command: `{lane['command']}`")
    lines.append(f"  - Log: `{lane['logPath']}`")
    if lane["artifacts"]:
        artifact_list = ", ".join(f"`{item}`" for item in lane["artifacts"])
        lines.append(f"  - Artifacts: {artifact_list}")

report = "\n".join(lines) + "\n"
Path(report_path).parent.mkdir(parents=True, exist_ok=True)
Path(report_path).write_text(report, encoding="utf-8")
PY

echo
echo "Release gate summary: $SUMMARY_JSON_REL"
echo "Release gate report: $REPORT_REL"

exit "$FINAL_RC"
