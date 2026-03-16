# Operations Runbook

This repo should be operated from one root `.env` and five source-of-truth areas:

- Vapi assistant config: [`configs/vapi/assistant.v1.json`](../configs/vapi/assistant.v1.json)
- service catalog: [`configs/services/catalog.v1.json`](../configs/services/catalog.v1.json)
- n8n workflows: [`n8n/workflows/`](../n8n/workflows/)
- mock patient data: [`mock-data/mock-patients.json`](../mock-data/mock-patients.json)
- knowledge-base data: [`knowledge-base/clinic-knowledge.json`](../knowledge-base/clinic-knowledge.json)
- environment template: [`../.env.example`](../.env.example)

## 1. Root `.env`

Create root `.env` from [`../.env.example`](../.env.example) and fill at minimum:

- Vapi:
  - `VAPI_API_KEY`
  - `VAPI_ASSISTANT_ID`
- Local n8n:
  - `N8N_ENCRYPTION_KEY`
  - `N8N_BASIC_AUTH_USER`
  - `N8N_BASIC_AUTH_PASSWORD`
- VPS automation:
  - `VPS_SSH_HOST`
  - `VPS_SSH_USER`
  - `VPS_APP_DIR`

Optional for SSH:

- `VPS_SSH_PORT`
- `VPS_SSH_IDENTITY_FILE`
- `VPS_N8N_CONTAINER_NAME`
- `VPS_GIT_REMOTE_SSH_URL`

Optional but strongly recommended for public webhooks:

- `AI_RECEPTIONIST_WEBHOOK_SECRET`

If `VPS_SSH_IDENTITY_FILE` is empty, the SSH-based scripts will use normal
password authentication and prompt for the password interactively.

## 2. Update Vapi

Canonical path:

1. Edit [`configs/vapi/assistant.v1.json`](../configs/vapi/assistant.v1.json).
2. Sync the readable prompt mirrors:

```bash
./scripts/sync-vapi-prompt-mirrors.sh
```

This updates:
- [`prompts/system-prompt.md`](../prompts/system-prompt.md)
- [`prompts/first-message.md`](../prompts/first-message.md)

3. Apply the config:

```bash
./scripts/update-vapi-assistant.sh
```

4. If `AI_RECEPTIONIST_WEBHOOK_SECRET` is set, patch the live Vapi webhook URLs so they include the same secret without storing it in git:

```bash
./scripts/update-vapi-webhook-secret.sh
```

Notes:

- If the Vapi API rejects a field, treat the API response as source of truth and update the stored config accordingly.
- Avoid editing the Vapi dashboard without syncing the repo immediately after.

## 3. Sync Embedded Workflow Data

If you edit either proof-of-concept dataset:

- [`mock-data/mock-patients.json`](../mock-data/mock-patients.json)
- [`knowledge-base/clinic-knowledge.json`](../knowledge-base/clinic-knowledge.json)
- [`configs/services/catalog.v1.json`](../configs/services/catalog.v1.json)

sync the embedded n8n workflow snapshots before import or deployment:

```bash
./scripts/sync-n8n-workflow-data.sh
```

To check for drift without modifying files:

```bash
./scripts/sync-n8n-workflow-data.sh --check
```

## 4. Run Local n8n

Use root `.env`:

```bash
docker-compose -f n8n/docker-compose.yml up -d
```

Run it from the repo root so `docker-compose` automatically reads the root `.env`.

If your machine uses the Docker Compose plugin instead of `docker-compose`:

```bash
docker compose --env-file .env -f n8n/docker-compose.yml up -d
```

## 5. Deploy Repo On VPS

Use the SSH wrapper:

```bash
./scripts/deploy-vps.sh
```

What it does:

1. SSH to the configured VPS.
2. forwards the local SSH agent to the VPS
3. ensures the VPS repo uses the configured GitHub SSH remote
4. `git fetch --all --prune`
5. `git pull --ff-only`
6. restart the VPS stack from `deploy/vps/docker-compose.yml`

## 6. Update n8n Workflows On VPS

Use the workflow import wrapper:

```bash
./scripts/import-n8n-workflows-vps.sh
```

What it does:

1. SSH to the VPS.
2. export a workflow backup from the running `n8n` container into `backups/n8n/<timestamp>/` on the VPS
3. copy repo workflow JSON files into the container
4. run `n8n import:workflow --separate --input=/tmp/n8n-workflows-import`
5. print the workflow list after import

Then reconcile the imported repo-ID workflows with the currently working credentials and publish state:

```bash
./scripts/reconcile-n8n-workflows-vps.sh
```

What it does:

1. makes a fresh backup of workflows and credentials on the VPS
2. exports the current n8n workflows
3. copies credential references from the currently working duplicates into the repo-ID workflow JSON files, only in a temporary VPS import directory
4. re-imports those repo workflows by ID so the stored definitions match the repo while keeping the credential attachments needed in production
5. unpublishes the legacy active duplicates
6. publishes the repo-ID workflows as the final active set
7. updates `webhook_entity` to point the public webhook routes at those repo-ID workflows and restarts `n8n`

Important:

- The script assumes the repo on the VPS already contains the desired workflow JSON files. Run deploy first.
- Because workflow import can create drift or duplicates if IDs do not line up, always inspect the post-import workflow list.
- Credentials are not versioned in this repo. Imported workflows can arrive as inactive drafts without the credential attachments used by the currently active workflows.
- Do not unpublish the active workflows manually before `./scripts/reconcile-n8n-workflows-vps.sh` finishes successfully.

## 7. Repo Health Checks

Run these when the repo starts to feel improvised:

```bash
git status --short
./scripts/check-repo-health.sh
./scripts/check-workflow-regressions.js
./scripts/sync-n8n-workflow-data.sh --check
docker exec ai-receptionist-n8n n8n list:workflow
./scripts/update-vapi-assistant.sh
```

Interpretation:

- `git status --short` should not show accidental secrets, throwaway scripts, or duplicate env templates.
- `./scripts/check-repo-health.sh` should pass before deploys and after repo cleanup. It now includes workflow regression checks when `node` is installed.
- `./scripts/check-workflow-regressions.js` exercises the embedded n8n logic directly and should stay green when tool contracts change.
- `./scripts/sync-n8n-workflow-data.sh --check` should pass after proof-of-concept data edits.
- `n8n list:workflow` should roughly match the workflow files under [`n8n/workflows/`](../n8n/workflows/).
- a clean Vapi update path means assistant changes are reproducible outside the dashboard.

## 8. Workflow State Notes

Treat local and VPS `n8n` state as disposable runtime state, not source control.
It is normal for a running instance to drift behind the repo until you explicitly import or reconcile the workflows.

Also, importing the repo workflow JSONs into an existing n8n instance can create inactive duplicates instead of replacing the currently active workflows. This is expected until credentials and publish state are handled as an explicit migration step.
