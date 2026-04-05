# Operations Runbook

This repo should be operated from one root `.env` and six source-of-truth areas:

- shared Vapi assistant config: [`configs/vapi/assistant.v2.json`](../configs/vapi/assistant.v2.json)
- environment-specific Vapi bindings and optional assistant overrides: [`configs/vapi/environments/`](../configs/vapi/environments/)
- Vapi structured outputs: [`../configs/vapi/structured-outputs/`](../configs/vapi/structured-outputs/)
- Vapi scorecards: [`../configs/vapi/scorecards/`](../configs/vapi/scorecards/)
- Vapi eval definitions: [`../configs/vapi/evals/`](../configs/vapi/evals/)
- Vapi live-call autoevaluation policy: [`../configs/vapi/autoevaluation-policy.v1.json`](../configs/vapi/autoevaluation-policy.v1.json)
- service catalog: [`configs/services/catalog.v1.json`](../configs/services/catalog.v1.json)
- n8n workflows: [`n8n/workflows/`](../n8n/workflows/)
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
  - `STAGING_N8N_UPSTREAM=staging-n8n:5678`

## 2. Update Vapi

Canonical path:

1. Edit the shared assistant behavior in [`configs/vapi/assistant.v2.json`](../configs/vapi/assistant.v2.json), the target binding in [`configs/vapi/environments/`](../configs/vapi/environments/), and any relevant observability configs under [`../configs/vapi/structured-outputs/`](../configs/vapi/structured-outputs/), [`../configs/vapi/scorecards/`](../configs/vapi/scorecards/), or [`../configs/vapi/evals/`](../configs/vapi/evals/).
2. Sync the readable prompt mirrors:

```bash
./scripts/sync-vapi-prompt-mirrors.sh
```

If you intentionally edited the readable prompt mirror first, import it back into the canonical JSON config before syncing:

```bash
./scripts/import-vapi-prompt-mirrors.sh --system-only
```

This updates:
- [`prompts/system-prompt.md`](../prompts/system-prompt.md)
- [`prompts/first-message.md`](../prompts/first-message.md)
- [`docs/vapi-structured-output.json`](./vapi-structured-output.json) via the observability sync path

3. Apply the config to a named environment:

```bash
./scripts/sync-vapi-environment.sh staging
./scripts/sync-vapi-environment.sh production
```

Observability-only sync:

```bash
./scripts/sync-vapi-observability.sh staging
./scripts/sync-vapi-observability.sh production
```

Notes:

- If the Vapi API rejects a field, treat the API response as source of truth and update the stored config accordingly.
- Avoid editing the Vapi dashboard without syncing the repo immediately after.

### Saved Vapi Eval Lane

Run the saved Vapi eval pack against staging:

```bash
./scripts/run-vapi-eval-suite.sh staging
```

Artifacts land under:

- `autonomy/runs/generated/vapi-evals/<suite-run-id>/`
- `autonomy/reports/generated/vapi-evals/<suite-run-id>.md`

The saved Vapi chat eval lane is configured and repo-backed, but the current staging assistant can still time out before returning the assistant turn inside Vapi's saved eval runner. Treat this lane as a fast diagnostic surface, not the release gate. The repo-local workflow regression checks and staging regression suite remain authoritative.

### Live Vapi Autoevaluation Lane

Run the live-call review queue against recent ended calls:

```bash
./scripts/run-vapi-live-autoeval.sh staging
./scripts/run-vapi-live-autoeval.sh staging --since-hours 24 --limit 15
./scripts/run-vapi-live-autoeval.sh production --since-hours 72
./scripts/run-vapi-live-autoeval.sh staging --include-raw-calls
```

Artifacts land under:

- `autonomy/runs/generated/vapi-live-autoeval/<suite-run-id>/`
- `autonomy/reports/generated/vapi-live-autoeval/<suite-run-id>.md`

Interpretation:

- The runner fetches recent calls from Vapi, writes minimized normalized `run.v1` artifacts by default, and scores the runs against [`../configs/vapi/autoevaluation-policy.v1.json`](../configs/vapi/autoevaluation-policy.v1.json).
- When SSH plus container bindings are available, the runner also pulls matched n8n event logs and Caddy access logs from the target VPS to split webhook latency into `dispatch`, `tool-to-edge start`, `edge ingress`, backend workflow, `edge egress`, `edge-to-result`, and full platform gap buckets.
- For shared-host staging, set `STAGING_VPS_CADDY_CONTAINER_NAME` only when the shared Caddy container is not the default `CADDY_CONTAINER_NAME`.
- Raw call JSON is written only when `--include-raw-calls` is explicitly requested for short-lived debugging.
- Treat this as the live-call review queue and drift monitor.
- Keep the repo-local workflow regression checks and staging regression suite as the release gate.

### Direct Webhook Latency Probe

Run the direct webhook probe lane against the public n8n tools:

```bash
./scripts/run-webhook-latency-probe.sh staging
./scripts/run-webhook-latency-probe.sh staging --samples 5 --fail-on-budget
./scripts/run-webhook-latency-probe.sh staging --probe check-availability-first-available
```

Artifacts land under:

- `autonomy/runs/generated/codex/<suite-run-id>/`
- `autonomy/reports/generated/codex/<suite-run-id>.md`

Interpretation:

- The probe hits safe public webhooks directly and records repeated end-to-end timings with response-shape validation.
- The default suite covers `lookupPatient`, `searchKnowledgeBase`, two `checkAvailability` variants, and `createReceptionTask`.
- Availability probes must fail on provider-level errors such as `CALENDAR_PROVIDER_REJECTED`; treat those as production incidents, not healthy `available=false` responses.
- `createEvent` is intentionally excluded from the default suite because it writes calendar state.
- When a tool definition has a delayed-response budget, the report flags probes that exceed that budget.

## 3. Sync Embedded Workflow Data

If you edit either repo-backed workflow dataset:

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

### Google Calendar Credential Recovery

Use this when staging or production starts returning empty or failed availability responses and the n8n executions show Google Calendar auth failures such as `EAUTH` or `invalid_grant`.

Recommended recovery path:

1. Make sure the desired repo workflow JSON is already deployed to the VPS.
2. Run the reconcile step for the affected environment:

```bash
./scripts/reconcile-n8n-workflows-vps.sh staging
./scripts/reconcile-n8n-workflows-vps.sh production
```

This is the safe first move because it:
- exports workflow and credential backups on the VPS first
- copies credential attachments from the best matching existing workflows onto the repo-owned workflow IDs
- republishes the repo-owned workflows and rewires webhooks to those active IDs

3. If reconcile reports missing Google Calendar credentials, or the next execution still fails with `EAUTH` / `invalid_grant`, refresh or recreate the Google Calendar credential inside the target n8n environment.
4. Run the reconcile step again after the credential refresh so the repo-owned workflow IDs inherit the live credential attachment.
5. Verify the fix with both a direct webhook probe and a suite run:

```bash
curl -sS "https://<environment-host>/webhook/ai-receptionist/check-availability?secret=***" \
  -H 'content-type: application/json' \
  --data '{"service":{"id":"consultation"},"timePreference":"first_available","timezone":"Europe/Warsaw"}'

./scripts/run-staging-regression-suite.sh
node ./scripts/check-workflow-regressions.js
```

Notes:

- Treat direct sqlite edits as emergency-only incident response, not the standard operator path.
- If you must do an emergency runtime patch, follow up by refreshing the real n8n credential and rerunning reconcile so the active state is recoverable through normal scripts.
- A healthy `checkAvailability` response should return JSON with `available`, `slots`, and `normalizedRequest`, not HTTP 200 with an empty body.

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
# optional quarantined prompt/config checks:
# ./scripts/check-workflow-regressions.js --include-experimental
./scripts/sync-n8n-workflow-data.sh --check
./scripts/render-vapi-assistant-config.sh production >/tmp/ai-receptionist-production-assistant.json
# after staging bindings are filled:
# ./scripts/render-vapi-assistant-config.sh staging >/tmp/ai-receptionist-staging-assistant.json
```

Interpretation:

- `git status --short` should not show accidental secrets, throwaway scripts, or duplicate env templates.
- `./scripts/check-repo-health.sh` should pass before deploys and after repo cleanup. It now includes workflow regression checks when `node` is installed.
- `./scripts/run-vapi-eval-suite.sh staging` is a useful observability check, but it is not a substitute for the repo-local workflow regression checks and staging regression suite.
- `./scripts/run-vapi-live-autoeval.sh staging` is the fastest way to turn recent real calls into a concrete review queue with scorecard thresholds, reason counts, and proxy-vs-backend latency attribution.
- `./scripts/check-workflow-regressions.js` is the default must-pass contract/invariant lane. Use `--include-experimental` only for explicit audits of quarantined prompt/config checks.
- `./scripts/sync-n8n-workflow-data.sh --check` should pass after proof-of-concept data edits.
- rendered staging and production assistant configs should build cleanly from repo state plus root `.env`.
- a clean Vapi update path means assistant changes are reproducible outside the dashboard.

## 9. Workflow State Notes

Treat local and VPS `n8n` state as disposable runtime state, not source control.
It is normal for a running instance to drift behind the repo until you explicitly import or reconcile the workflows.

Also, importing the repo workflow JSONs into an existing n8n instance can create inactive duplicates instead of replacing the currently active workflows. This is expected until credentials and publish state are handled as an explicit migration step.
