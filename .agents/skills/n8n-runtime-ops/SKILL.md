---
name: "n8n-runtime-ops"
description: "Use for workflow JSON authority, embedded data sync, VPS import/reconcile, and runtime duplicate-workflow inspection in ai-receptionist."
---

# n8n Runtime Ops

Use this skill whenever the task changes workflow JSON, embedded workflow data, or needs to inspect staging or production n8n runtime state.

## Canonical Files

- Workflow source of truth: `n8n/workflows/`
- Embedded source data:
  - `configs/services/catalog.v1.json`
  - `mock-data/mock-patients.json`
  - `knowledge-base/clinic-knowledge.json`

## Preflight

- If embedded source data changed, run `./scripts/sync-n8n-workflow-data.sh`.
- To verify drift only, run `./scripts/sync-n8n-workflow-data.sh --check`.
- Workflow JSON in Git remains authoritative even if imported copies exist in n8n.

## Runtime Truth

- Git alone does not show the active workflow state.
- Always inspect both:
  - `n8n list:workflow`
  - `n8n list:workflow --active=true`
- Duplicate historical workflow copies are expected risk surfaces and must be reported explicitly.

## Sync Commands

- Import workflows to VPS: `./scripts/import-n8n-workflows-vps.sh staging|production`
- Reconcile credentials, publish state, and webhook ownership: `./scripts/reconcile-n8n-workflows-vps.sh staging|production`
- Combined environment sync: `./scripts/sync-environment.sh staging|production`

## Guardrails

- Never skip the backup-before-import step.
- Never assume imported workflows have credentials attached.
- Never treat n8n UI state as source control.
- A workflow change is not deployed just because the JSON changed locally.
