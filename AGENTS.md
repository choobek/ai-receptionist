# Repository Guidelines

## Source Of Truth

- Root `.env.example` is the only env template in the repo.
- Root `.env` is the only local env file future automation should read by default.
- Shared Vapi assistant behavior lives in `configs/vapi/assistant.v2.json`.
- Environment-specific Vapi bindings live in `configs/vapi/environments/staging.json` and `configs/vapi/environments/production.json`.
- Vapi structured output configs live in `configs/vapi/structured-outputs/`.
- Vapi scorecard configs live in `configs/vapi/scorecards/`.
- Vapi eval definitions live in `configs/vapi/evals/`.
- Vapi live-call autoevaluation policy lives in `configs/vapi/autoevaluation-policy.v1.json`.
- Service catalog source data lives in `configs/services/catalog.v1.json`.
- `docs/vapi-structured-output.json` is a generated mirror of `configs/vapi/structured-outputs/dental-call-intake.v1.json`.
- Prompt mirror files in `prompts/` are generated mirrors for readability. If they drift, the JSON config wins.
- n8n workflow source files live in `n8n/workflows/`.
- Mock patient source data lives in `mock-data/mock-patients.json`.
- Knowledge-base source data lives in `knowledge-base/clinic-knowledge.json`.

## Non-Negotiable Rules

- Do not hand-edit the Vapi dashboard and stop there. If Vapi changes, update the repo config and then push through the API.
- Do not treat `n8n` UI state as source control. Workflow JSON files in this repo must stay authoritative.
- Before importing workflows into n8n, make a backup export first.
- Do not assume imported n8n workflows are production-ready. Credentials are not versioned here, so imported workflows may be inactive drafts that still need credential reassociation and controlled publish/unpublish steps.
- Prefer one root `.env` over per-subdirectory env files.
- Never commit secrets. Keep `.env` local only.

## Standard Operations

### Sync Vapi Environment

1. Edit `configs/vapi/assistant.v2.json` for shared behavior, the matching file under `configs/vapi/environments/`, and any relevant files under `configs/vapi/structured-outputs/`, `configs/vapi/scorecards/`, or `configs/vapi/evals/`.
2. Run `./scripts/sync-vapi-prompt-mirrors.sh`.
3. Run `./scripts/sync-vapi-observability-mirrors.sh` if you changed the canonical call-intake schema and want the readable mirror refreshed immediately.
4. Run `./scripts/sync-vapi-environment.sh staging` or `./scripts/sync-vapi-environment.sh production`.
5. If you changed only observability resources and do not need a full assistant/tool sync, run `./scripts/sync-vapi-observability.sh staging` or `./scripts/sync-vapi-observability.sh production`.
6. Use `./scripts/run-vapi-eval-suite.sh staging` for the saved Vapi eval lane. Treat the repo-local staging regression and staging voice smoke suites as the release gate.
7. Use `./scripts/run-vapi-live-autoeval.sh staging` or `./scripts/run-vapi-live-autoeval.sh production` to ingest recent real calls, score them against the repo policy, and render a review queue report.
8. If the Vapi API rejects a field, remove or adjust that field in the repo config before retrying.

### Deploy Repo To VPS

1. Ensure the `STAGING_*` or `PRODUCTION_*` SSH placeholders in root `.env` are filled.
2. Run `./scripts/deploy-vps.sh staging` or `./scripts/deploy-vps.sh production`.
3. The deploy script should use SSH agent forwarding and a GitHub SSH remote on the VPS.
4. Verify the stack on the VPS after pull + restart.

### Push n8n Workflows To VPS

1. Commit or at least save the desired workflow JSON changes locally.
2. If you changed `mock-data/mock-patients.json`, `knowledge-base/clinic-knowledge.json`, or `configs/services/catalog.v1.json`, run `./scripts/sync-n8n-workflow-data.sh` first so the embedded workflow data stays in sync.
3. Run `./scripts/import-n8n-workflows-vps.sh staging` or `./scripts/import-n8n-workflows-vps.sh production`.
4. The script must export a backup on the VPS before importing.
5. Verify the workflow list after import.
6. Do not unpublish the currently active workflows until the imported copies have credentials attached and are ready to publish.

## Audit Checklist

- Compare repo workflow files with the target environment's `n8n list:workflow`.
- Check for config drift between Vapi and `configs/vapi/assistant.v2.json` plus `configs/vapi/environments/*.json`.
- Run `./scripts/sync-n8n-workflow-data.sh --check` after changing proof-of-concept data files.
- Check for duplicate env templates or new ad-hoc scripts that bypass root `.env`.
- Prefer additive scripts and docs over tribal knowledge in chat history.

## Human Runbook

- See `docs/operations-runbook.md` for the step-by-step operational guide.
- See `docs/environment-separation.md` for staging vs production commands and promotion flow.
