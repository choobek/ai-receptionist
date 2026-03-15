# Operations Runbook

This repo should be operated from one root `.env` and three source-of-truth areas:

- Vapi assistant config: [`configs/vapi/assistant.v1.json`](../configs/vapi/assistant.v1.json)
- n8n workflows: [`n8n/workflows/`](../n8n/workflows/)
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

Notes:

- If the Vapi API rejects a field, treat the API response as source of truth and update the stored config accordingly.
- Avoid editing the Vapi dashboard without syncing the repo immediately after.

## 3. Run Local n8n

Use root `.env`:

```bash
docker-compose -f n8n/docker-compose.yml up -d
```

If your machine uses the Docker Compose plugin instead of `docker-compose`:

```bash
docker compose --env-file .env -f n8n/docker-compose.yml up -d
```

## 4. Deploy Repo On VPS

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

## 5. Update n8n Workflows On VPS

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

Important:

- The script assumes the repo on the VPS already contains the desired workflow JSON files. Run deploy first.
- Because workflow import can create drift or duplicates if IDs do not line up, always inspect the post-import workflow list.

## 6. Repo Health Checks

Run these when the repo starts to feel improvised:

```bash
git status --short
docker exec ai-receptionist-n8n n8n list:workflow
./scripts/update-vapi-assistant.sh
```

Interpretation:

- `git status --short` should not show accidental secrets, throwaway scripts, or duplicate env templates.
- `n8n list:workflow` should roughly match the workflow files under [`n8n/workflows/`](../n8n/workflows/).
- a clean Vapi update path means assistant changes are reproducible outside the dashboard.

## 7. Current Known Drift

At the time of writing, the local running `n8n` instance lists only:

- `AI Receptionist - checkAvailability`
- `AI Receptionist - createEvent`
- `AI Receptionist - Vapi call.ended router`

while the repo contains more workflow JSON files. That means local n8n state is currently behind the repo and should be reconciled before treating the environment as clean.
