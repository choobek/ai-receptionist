# Repository Guidelines

## Source Of Truth

- Root `.env.example` is the only env template in the repo.
- Root `.env` is the only local env file future automation should read by default.
- Vapi assistant config lives in `configs/vapi/assistant.v1.json`.
- Prompt mirror files in `prompts/` are generated mirrors for readability. If they drift, the JSON config wins.
- n8n workflow source files live in `n8n/workflows/`.

## Non-Negotiable Rules

- Do not hand-edit the Vapi dashboard and stop there. If Vapi changes, update the repo config and then push through the API.
- Do not treat `n8n` UI state as source control. Workflow JSON files in this repo must stay authoritative.
- Before importing workflows into n8n, make a backup export first.
- Do not assume imported n8n workflows are production-ready. Credentials are not versioned here, so imported workflows may be inactive drafts that still need credential reassociation and controlled publish/unpublish steps.
- Prefer one root `.env` over per-subdirectory env files.
- Never commit secrets. Keep `.env` local only.

## Standard Operations

### Update Vapi Assistant

1. Edit `configs/vapi/assistant.v1.json`.
2. Run `./scripts/sync-vapi-prompt-mirrors.sh`.
3. Run `./scripts/update-vapi-assistant.sh`.
4. If the Vapi API rejects a field, remove or adjust that field in the repo config before retrying.

### Deploy Repo To VPS

1. Ensure SSH placeholders in root `.env` are filled.
2. Run `./scripts/deploy-vps.sh`.
3. The deploy script should use SSH agent forwarding and a GitHub SSH remote on the VPS.
4. Verify the stack on the VPS after pull + restart.

### Push n8n Workflows To VPS

1. Commit or at least save the desired workflow JSON changes locally.
2. Run `./scripts/import-n8n-workflows-vps.sh`.
3. The script must export a backup on the VPS before importing.
4. Verify the workflow list after import.
5. Do not unpublish the currently active workflows until the imported copies have credentials attached and are ready to publish.

## Audit Checklist

- Compare repo workflow files with `docker exec ai-receptionist-n8n n8n list:workflow`.
- Check for config drift between Vapi and `configs/vapi/assistant.v1.json`.
- Check for duplicate env templates or new ad-hoc scripts that bypass root `.env`.
- Prefer additive scripts and docs over tribal knowledge in chat history.

## Human Runbook

- See `docs/operations-runbook.md` for the step-by-step operational guide.
