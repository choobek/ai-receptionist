#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-sync}"

case "$MODE" in
  sync|--sync)
    MODE="sync"
    ;;
  check|--check)
    MODE="check"
    ;;
  *)
    echo "Usage: ./scripts/sync-n8n-workflow-data.sh [sync|--check]" >&2
    exit 1
    ;;
esac

python3 - "$ROOT_DIR" "$MODE" <<'PY'
import json
import re
import sys
from pathlib import Path

root_dir = Path(sys.argv[1])
mode = sys.argv[2]

targets = [
    {
        "workflow_path": root_dir / "n8n/workflows/tool_lookup-patient.json",
        "node_name": "Find Patient",
        "source_path": root_dir / "mock-data/mock-patients.json",
        "const_name": "registry",
        "anchor": "let match = null;",
    },
    {
        "workflow_path": root_dir / "n8n/workflows/tool_search-knowledge-base.json",
        "node_name": "Search KB",
        "source_path": root_dir / "knowledge-base/clinic-knowledge.json",
        "const_name": "knowledge",
        "anchor": "const stopWords = new Set(",
    },
]


def replace_embedded_data(code: str, const_name: str, anchor: str, data) -> str:
    literal = json.dumps(data, ensure_ascii=True, indent=2)
    pattern = re.compile(
        rf"const {re.escape(const_name)} = \[.*?\];\n{re.escape(anchor)}",
        re.DOTALL,
    )
    replacement = f"const {const_name} = {literal};\n{anchor}"
    updated_code, substitutions = pattern.subn(replacement, code, count=1)
    if substitutions != 1:
        raise RuntimeError(
            f"Failed to replace embedded {const_name} data before anchor {anchor!r}"
        )
    return updated_code


drifted_files = []

for target in targets:
    workflow_path = target["workflow_path"]
    source_path = target["source_path"]
    workflow = json.loads(workflow_path.read_text(encoding="utf-8"))
    source_data = json.loads(source_path.read_text(encoding="utf-8"))

    node = next(
        (item for item in workflow.get("nodes", []) if item.get("name") == target["node_name"]),
        None,
    )
    if node is None:
        raise RuntimeError(f"Node {target['node_name']!r} not found in {workflow_path}")

    current_code = node.get("parameters", {}).get("jsCode")
    if not isinstance(current_code, str):
        raise RuntimeError(f"Node {target['node_name']!r} in {workflow_path} has no jsCode")

    updated_code = replace_embedded_data(
        current_code,
        target["const_name"],
        target["anchor"],
        source_data,
    )

    if updated_code != current_code:
        drifted_files.append(workflow_path.relative_to(root_dir).as_posix())
        if mode == "sync":
            node["parameters"]["jsCode"] = updated_code
            workflow_path.write_text(
                json.dumps(workflow, ensure_ascii=True, indent=2) + "\n",
                encoding="utf-8",
            )

if mode == "check":
    if drifted_files:
        print("Embedded workflow data is out of sync:", file=sys.stderr)
        for path in drifted_files:
            print(path, file=sys.stderr)
        sys.exit(1)
    print("Workflow data is in sync.")
else:
    if drifted_files:
        for path in drifted_files:
            print(f"Updated {path}")
    else:
        print("Workflow data already in sync.")
PY
