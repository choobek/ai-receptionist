#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=./lib/env-context.sh
. "$ROOT_DIR/scripts/lib/env-context.sh"

ENVIRONMENT="$(normalize_deploy_environment "${1:-production}")"

load_root_env

legacy_vps_ssh_host=""
legacy_vps_ssh_user=""
legacy_vps_ssh_port=""
legacy_vps_ssh_identity_file=""
legacy_vps_app_dir=""
legacy_vps_n8n_container_name=""

if [ "$ENVIRONMENT" = "production" ]; then
  legacy_vps_ssh_host="VPS_SSH_HOST"
  legacy_vps_ssh_user="VPS_SSH_USER"
  legacy_vps_ssh_port="VPS_SSH_PORT"
  legacy_vps_ssh_identity_file="VPS_SSH_IDENTITY_FILE"
  legacy_vps_app_dir="VPS_APP_DIR"
  legacy_vps_n8n_container_name="VPS_N8N_CONTAINER_NAME"
fi

VPS_SSH_HOST="$(require_context_value "$ENVIRONMENT" "VPS_SSH_HOST" "$legacy_vps_ssh_host" "VPS_SSH_HOST")"
VPS_SSH_USER="$(require_context_value "$ENVIRONMENT" "VPS_SSH_USER" "$legacy_vps_ssh_user" "VPS_SSH_USER")"
VPS_SSH_PORT="$(get_context_value "$ENVIRONMENT" "VPS_SSH_PORT" "$legacy_vps_ssh_port")"
VPS_SSH_PORT="${VPS_SSH_PORT:-22}"
VPS_SSH_IDENTITY_FILE="$(get_context_value "$ENVIRONMENT" "VPS_SSH_IDENTITY_FILE" "$legacy_vps_ssh_identity_file")"
VPS_APP_DIR="$(require_context_value "$ENVIRONMENT" "VPS_APP_DIR" "$legacy_vps_app_dir" "VPS_APP_DIR")"
VPS_N8N_CONTAINER_NAME="$(get_context_value "$ENVIRONMENT" "VPS_N8N_CONTAINER_NAME" "$legacy_vps_n8n_container_name")"

ssh_args=(-p "$VPS_SSH_PORT")
if [ -n "$VPS_SSH_IDENTITY_FILE" ]; then
  ssh_args+=(-i "$VPS_SSH_IDENTITY_FILE")
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"

ssh "${ssh_args[@]}" "${VPS_SSH_USER}@${VPS_SSH_HOST}" \
  "APP_DIR='$VPS_APP_DIR' REMOTE_CONTAINER='$VPS_N8N_CONTAINER_NAME' TIMESTAMP='$timestamp' bash -s" <<'EOF'
set -euo pipefail

cd "$APP_DIR"
if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

CONTAINER="${REMOTE_CONTAINER:-${N8N_CONTAINER_NAME:-ai-receptionist-n8n}}"

BACKUP_DIR="$APP_DIR/backups/n8n/$TIMESTAMP"
TEMP_DIR="/tmp/ai-receptionist-n8n-reconcile-$TIMESTAMP"
EXPORT_DIR="$TEMP_DIR/exported"
MERGED_DIR="$TEMP_DIR/merged"
REPORT_DIR="$TEMP_DIR/report"

mkdir -p "$BACKUP_DIR/workflows" "$BACKUP_DIR/credentials" "$EXPORT_DIR" "$MERGED_DIR" "$REPORT_DIR"

docker exec "$CONTAINER" rm -rf \
  /tmp/n8n-reconcile-backup-workflows \
  /tmp/n8n-reconcile-backup-credentials \
  /tmp/n8n-reconcile-export \
  /tmp/n8n-reconcile-import

docker exec "$CONTAINER" mkdir -p \
  /tmp/n8n-reconcile-backup-workflows \
  /tmp/n8n-reconcile-backup-credentials \
  /tmp/n8n-reconcile-export \
  /tmp/n8n-reconcile-import

docker exec "$CONTAINER" n8n export:workflow --backup --output=/tmp/n8n-reconcile-backup-workflows >/dev/null
docker exec "$CONTAINER" n8n export:credentials --backup --output=/tmp/n8n-reconcile-backup-credentials >/dev/null
docker cp "$CONTAINER:/tmp/n8n-reconcile-backup-workflows/." "$BACKUP_DIR/workflows/"
docker cp "$CONTAINER:/tmp/n8n-reconcile-backup-credentials/." "$BACKUP_DIR/credentials/"

docker exec "$CONTAINER" n8n export:workflow --backup --output=/tmp/n8n-reconcile-export >/dev/null
docker cp "$CONTAINER:/tmp/n8n-reconcile-export/." "$EXPORT_DIR/"

python3 - "$APP_DIR/n8n/workflows" "$EXPORT_DIR" "$MERGED_DIR" "$REPORT_DIR" <<'PY'
import glob
import json
import os
import sys

repo_dir, exported_dir, merged_dir, report_dir = sys.argv[1:]


def load_json(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def credential_count(workflow):
    return sum(1 for node in workflow.get("nodes", []) if node.get("credentials"))


repo_paths = sorted(glob.glob(os.path.join(repo_dir, "*.json")))
exported_paths = sorted(glob.glob(os.path.join(exported_dir, "*.json")))
repo_workflows = [load_json(path) for path in repo_paths]
exported_workflows = [load_json(path) for path in exported_paths]

report = []
target_ids = []
legacy_active_ids = set()
legacy_all_ids = set()
errors = []

for workflow in repo_workflows:
    target_id = workflow["id"]
    target_name = workflow["name"]
    target_ids.append(target_id)

    candidates = [
        item
        for item in exported_workflows
        if item.get("name") == target_name and item.get("id") != target_id
    ]
    candidates.sort(
        key=lambda item: (
            1 if item.get("active") else 0,
            credential_count(item),
            item.get("updatedAt", ""),
        ),
        reverse=True,
    )

    donor = candidates[0] if candidates else None
    donor_credentials = {}
    if donor:
        for node in donor.get("nodes", []):
            credentials = node.get("credentials")
            if credentials:
                donor_credentials[(node.get("name"), node.get("type"))] = credentials
        for item in candidates:
            legacy_all_ids.add(item["id"])
            if item.get("active"):
                legacy_active_ids.add(item["id"])

    copied_nodes = []
    for node in workflow.get("nodes", []):
        key = (node.get("name"), node.get("type"))
        donor_creds = donor_credentials.get(key)
        if donor_creds and not node.get("credentials"):
            node["credentials"] = donor_creds
            copied_nodes.append(node["name"])

    missing_nodes = [
        node["name"]
        for node in workflow.get("nodes", [])
        if node.get("type") == "n8n-nodes-base.googleCalendar" and not node.get("credentials")
    ]

    if missing_nodes:
        errors.append(
            {
                "workflowId": target_id,
                "workflowName": target_name,
                "missingCredentialNodes": missing_nodes,
            }
        )

    output_path = os.path.join(merged_dir, f"{target_id}.json")
    with open(output_path, "w", encoding="utf-8") as handle:
        json.dump(workflow, handle, ensure_ascii=True, indent=2)
        handle.write("\n")

    report.append(
        {
            "workflowId": target_id,
            "workflowName": target_name,
            "donorWorkflowId": donor.get("id") if donor else None,
            "copiedCredentialNodes": copied_nodes,
            "missingCredentialNodes": missing_nodes,
        }
    )

with open(os.path.join(report_dir, "target-ids.txt"), "w", encoding="utf-8") as handle:
    handle.write("\n".join(target_ids) + "\n")

with open(os.path.join(report_dir, "legacy-active-ids.txt"), "w", encoding="utf-8") as handle:
    if legacy_active_ids:
        handle.write("\n".join(sorted(legacy_active_ids)) + "\n")

with open(os.path.join(report_dir, "legacy-all-ids.txt"), "w", encoding="utf-8") as handle:
    if legacy_all_ids:
        handle.write("\n".join(sorted(legacy_all_ids)) + "\n")

with open(os.path.join(report_dir, "report.json"), "w", encoding="utf-8") as handle:
    json.dump(
        {
            "targets": report,
            "legacyActiveIds": sorted(legacy_active_ids),
            "legacyAllIds": sorted(legacy_all_ids),
            "errors": errors,
        },
        handle,
        ensure_ascii=True,
        indent=2,
    )
    handle.write("\n")

if errors:
    print(json.dumps({"errors": errors}, ensure_ascii=True, indent=2), file=sys.stderr)
    sys.exit(1)
PY

docker cp "$MERGED_DIR/." "$CONTAINER:/tmp/n8n-reconcile-import/"
docker exec "$CONTAINER" n8n import:workflow --separate --input=/tmp/n8n-reconcile-import >/dev/null

if [ -s "$REPORT_DIR/legacy-active-ids.txt" ]; then
  while IFS= read -r workflow_id; do
    [ -n "$workflow_id" ] || continue
    docker exec "$CONTAINER" n8n unpublish:workflow --id="$workflow_id" >/dev/null
  done < "$REPORT_DIR/legacy-active-ids.txt"
fi

while IFS= read -r workflow_id; do
  [ -n "$workflow_id" ] || continue
  docker exec "$CONTAINER" n8n publish:workflow --id="$workflow_id" >/dev/null
done < "$REPORT_DIR/target-ids.txt"

docker run --rm --volumes-from "$CONTAINER" python:3.12-alpine \
  python3 - /home/node/.n8n/database.sqlite <<'PY'
import json
import sqlite3
import sys

database_path = sys.argv[1]
conn = sqlite3.connect(database_path)
conn.row_factory = sqlite3.Row

active_rows = conn.execute(
    "SELECT id, nodes FROM workflow_entity WHERE active = 1"
).fetchall()

updates = []
for row in active_rows:
    nodes = json.loads(row["nodes"] or "[]")
    for node in nodes:
        if node.get("type") != "n8n-nodes-base.webhook":
            continue
        path = node.get("parameters", {}).get("path")
        method = node.get("parameters", {}).get("httpMethod", "GET")
        if not path:
            continue
        conn.execute(
            "UPDATE webhook_entity SET workflowId = ? WHERE webhookPath = ? AND method = ?",
            (row["id"], path, method),
        )
        updates.append(
            {
                "workflowId": row["id"],
                "path": path,
                "method": method,
            }
        )

conn.commit()
print(json.dumps({"webhookEntityUpdates": updates}, ensure_ascii=True, indent=2))
PY

docker restart "$CONTAINER" >/dev/null
sleep 5

echo "Credential reconciliation report:"
cat "$REPORT_DIR/report.json"
echo
echo "Active workflows after reconcile:"
docker exec "$CONTAINER" n8n list:workflow --active=true
echo
echo "Fresh backup saved to $BACKUP_DIR"
EOF
