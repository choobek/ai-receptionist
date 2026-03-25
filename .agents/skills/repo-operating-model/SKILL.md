---
name: "repo-operating-model"
description: "Use for source-of-truth questions, file targeting, prompt mirror handling, and staging-vs-production repo rules in ai-receptionist."
---

# Repo Operating Model

Use this skill whenever the task touches source-of-truth files, mirror files, environment bindings, or deployment boundaries in this repo.

## Source Of Truth

- Root `.env.example` is the only env template.
- Root `.env` is the only local env file automation should read by default.
- Shared Vapi assistant behavior lives in `configs/vapi/assistant.v2.json`.
- Vapi environment bindings live in `configs/vapi/environments/staging.json` and `configs/vapi/environments/production.json`.
- Vapi observability resources live in:
  - `configs/vapi/structured-outputs/`
  - `configs/vapi/scorecards/`
  - `configs/vapi/evals/`
  - `configs/vapi/autoevaluation-policy.v1.json`
- n8n workflow authority lives in `n8n/workflows/`.
- Embedded workflow source data lives in:
  - `configs/services/catalog.v1.json`
  - `mock-data/mock-patients.json`
  - `knowledge-base/clinic-knowledge.json`

## Mirror Rules

- `prompts/system-prompt.md` and `prompts/first-message.md` are readable mirrors by default.
- If the readable mirror was intentionally edited first, run `./scripts/import-vapi-prompt-mirrors.sh` before syncing.
- Otherwise edit `configs/vapi/assistant.v2.json` and run `./scripts/sync-vapi-prompt-mirrors.sh`.
- `docs/vapi-structured-output.json` mirrors `configs/vapi/structured-outputs/dental-call-intake.v1.json`.

## Hard Rules

- Do not treat Vapi dashboard edits as final truth.
- Do not treat n8n UI state as source control.
- Do not add per-directory env templates or env files.
- Do not bypass existing repo scripts for deploy, sync, import, or reconcile flows.
- Keep staging as the default write target.
- Keep production explicit and exact-ref based.

## Command Map

- Vapi full sync: `./scripts/sync-vapi-environment.sh staging|production`
- Vapi observability-only sync: `./scripts/sync-vapi-observability.sh staging|production`
- Render effective Vapi config: `./scripts/render-vapi-assistant-config.sh staging|production`
- Workflow data sync check: `./scripts/sync-n8n-workflow-data.sh --check`
- Workflow import: `./scripts/import-n8n-workflows-vps.sh staging|production`
- Workflow reconcile: `./scripts/reconcile-n8n-workflows-vps.sh staging|production`
- Full environment sync: `./scripts/sync-environment.sh staging|production`
- Deploy repo to VPS: `./scripts/deploy-vps.sh staging|production`
- Promote exact ref to production: `./scripts/promote-to-production.sh <ref>`

## Decision Rules

- When a task changes Vapi behavior, inspect both `configs/vapi/assistant.v2.json` and the target environment binding.
- When a task changes workflow behavior, inspect `n8n/workflows/` and check whether embedded data sources also changed.
- When source data changes, run `./scripts/sync-n8n-workflow-data.sh` before import or deploy.
- When the question is "what is live", Git alone is not enough; use runtime inspection and rendered config comparison.
