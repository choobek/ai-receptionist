# Operations Runbook

This repo should be operated from one root `.env` and six source-of-truth areas:

- shared Vapi assistant config: [`configs/vapi/assistant.v1.json`](../configs/vapi/assistant.v1.json)
- environment-specific Vapi bindings: [`configs/vapi/environments/`](../configs/vapi/environments/)
- service catalog: [`configs/services/catalog.v1.json`](../configs/services/catalog.v1.json)
- n8n workflows: [`n8n/workflows/`](../n8n/workflows/)
- mock patient data: [`mock-data/mock-patients.json`](../mock-data/mock-patients.json)
- knowledge-base data: [`knowledge-base/clinic-knowledge.json`](../knowledge-base/clinic-knowledge.json)
- environment template: [`../.env.example`](../.env.example)

## 1. Root `.env`

Create root `.env` from [`../.env.example`](../.env.example) and fill at minimum:

- Vapi:
  - `VAPI_API_KEY`
  - `STAGING_N8N_PUBLIC_BASE_URL`
  - `PRODUCTION_N8N_PUBLIC_BASE_URL`
- Local n8n:
  - `N8N_ENCRYPTION_KEY`
  - `N8N_BASIC_AUTH_USER`
  - `N8N_BASIC_AUTH_PASSWORD`
- Staging VPS automation:
  - `STAGING_VPS_SSH_HOST`
  - `STAGING_VPS_SSH_USER`
  - `STAGING_VPS_APP_DIR`
  - `STAGING_VPS_COMPOSE_FILE`
  - `STAGING_VPS_COMPOSE_PROJECT_NAME`
- Production VPS automation:
  - `PRODUCTION_VPS_SSH_HOST`
  - `PRODUCTION_VPS_SSH_USER`
  - `PRODUCTION_VPS_APP_DIR`
  - `PRODUCTION_VPS_COMPOSE_FILE`
  - `PRODUCTION_VPS_COMPOSE_PROJECT_NAME`

Optional but strongly recommended for public webhooks:

- `STAGING_AI_RECEPTIONIST_WEBHOOK_SECRET`
- `PRODUCTION_AI_RECEPTIONIST_WEBHOOK_SECRET`

Each deployed staging or production target still keeps its own unprefixed root `.env`
on that host for runtime values such as `N8N_DOMAIN`, `N8N_ENCRYPTION_KEY`,
`GOOGLE_CALENDAR_ID`, `AI_RECEPTIONIST_WEBHOOK_SECRET`, and container or volume names.

If both environments share one host, keep production on the full compose file and set:

- local root `.env`:
  - `STAGING_VPS_COMPOSE_FILE=deploy/vps/docker-compose.n8n-only.yml`
  - `STAGING_VPS_COMPOSE_PROJECT_NAME=ai-receptionist-staging`
  - `PRODUCTION_VPS_COMPOSE_FILE=deploy/vps/docker-compose.yml`
  - `PRODUCTION_VPS_COMPOSE_PROJECT_NAME=<current production compose project name>`
- production host root `.env`:
  - `STAGING_N8N_DOMAIN=<public staging hostname>`
  - `STAGING_N8N_UPSTREAM=host.docker.internal:<staging-host-port>`

## 2. Update Vapi

Canonical path:

1. Edit the shared assistant behavior in [`configs/vapi/assistant.v1.json`](../configs/vapi/assistant.v1.json) and, when needed, the target binding in [`configs/vapi/environments/`](../configs/vapi/environments/).
2. Sync the readable prompt mirrors:

```bash
./scripts/sync-vapi-prompt-mirrors.sh
```

This updates:
- [`prompts/system-prompt.md`](../prompts/system-prompt.md)
- [`prompts/first-message.md`](../prompts/first-message.md)

3. Apply the config to a named environment:

```bash
./scripts/sync-vapi-environment.sh staging
./scripts/sync-vapi-environment.sh production
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

Use the SSH wrapper with an environment:

```bash
./scripts/deploy-vps.sh staging
./scripts/deploy-vps.sh production
```

What it does:

1. SSH to the configured staging or production VPS.
2. forwards the local SSH agent to the VPS
3. clones the repo first if the target app dir does not exist yet
4. ensures the VPS repo uses the configured GitHub SSH remote
5. `git fetch --all --prune`
6. checks out the requested git branch or exact ref
7. restarts the VPS stack from the configured compose file for that environment

## 6. Update n8n Workflows On VPS

Use the per-environment sync wrapper:

```bash
./scripts/sync-environment.sh staging
./scripts/sync-environment.sh production
```

What it does:

1. checks that embedded workflow source data is already in sync
2. exports a workflow backup from the target `n8n` container into `backups/n8n/<timestamp>/` on the VPS
3. imports the repo workflow JSON files into the target n8n instance
4. reconciles credentials and publish state on the target n8n instance
5. syncs the matching Vapi assistant and tool URLs for the same environment

Important:

- The script assumes the repo on the VPS already contains the desired workflow JSON files. Run deploy first.
- Because workflow import can create drift or duplicates if IDs do not line up, always inspect the post-import workflow list.
- Credentials are not versioned in this repo. Imported workflows can arrive as inactive drafts without the credential attachments used by the currently active workflows.
- Do not unpublish the active workflows manually before the reconcile step finishes successfully.

## 7. Promotion

Promote an approved ref to production:

```bash
git checkout <approved-commit-or-tag>
./scripts/promote-to-production.sh HEAD
```

This requires a clean local git worktree so the production Vapi and n8n sync steps come from the same repo state as the deployed git ref.

## 8. Repo Health Checks

Run these when the repo starts to feel improvised:

```bash
git status --short
./scripts/check-repo-health.sh
./scripts/check-workflow-regressions.js
./scripts/sync-n8n-workflow-data.sh --check
./scripts/render-vapi-assistant-config.sh production >/tmp/ai-receptionist-production-assistant.json
# after staging bindings are filled:
# ./scripts/render-vapi-assistant-config.sh staging >/tmp/ai-receptionist-staging-assistant.json
```

Interpretation:

- `git status --short` should not show accidental secrets, throwaway scripts, or duplicate env templates.
- `./scripts/check-repo-health.sh` should pass before deploys and after repo cleanup. It now includes workflow regression checks when `node` is installed.
- `./scripts/check-workflow-regressions.js` exercises the embedded n8n logic directly and should stay green when tool contracts change.
- `./scripts/sync-n8n-workflow-data.sh --check` should pass after proof-of-concept data edits.
- rendered staging and production assistant configs should build cleanly from repo state plus root `.env`.
- a clean Vapi update path means assistant changes are reproducible outside the dashboard.

## 9. Workflow State Notes

Treat local and VPS `n8n` state as disposable runtime state, not source control.
It is normal for a running instance to drift behind the repo until you explicitly import or reconcile the workflows.

Also, importing the repo workflow JSONs into an existing n8n instance can create inactive duplicates instead of replacing the currently active workflows. This is expected until credentials and publish state are handled as an explicit migration step.
