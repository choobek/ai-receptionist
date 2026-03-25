---
name: "runtime-drift-audit"
description: "Use for comparing rendered repo intent with runtime evidence and for avoiding false repo-vs-runtime drift conclusions."
---

# Runtime Drift Audit

Use this skill whenever the task asks what staging or production is actually running, or whether runtime has drifted from the repo.

## Comparison Surfaces

Vapi runtime truth is not the shared assistant JSON alone. Compare runtime against:

- `configs/vapi/assistant.v2.json`
- `configs/vapi/environments/<environment>.json`
- root `.env`
- `./scripts/render-vapi-assistant-config.sh <environment>`

n8n runtime truth is not imported JSON alone. Compare runtime against:

- `n8n/workflows/`
- the embedded data sources if relevant
- VPS workflow inventory
- active workflow IDs
- duplicate historical workflow IDs
- post-import reconcile state

## Known False-Positive Trap

- Staging intentionally overrides shared Vapi defaults through `assistantOverrides` in `configs/vapi/environments/staging.json`.
- A drift audit that compares runtime only to `configs/vapi/assistant.v2.json` will be wrong.

## Minimum Audit Packet

- Rendered Vapi config for the target environment
- Active repo-owned n8n workflow IDs
- Duplicate legacy n8n workflow IDs if present
- Git SHA being evaluated
- Paths to the evidence used

## Current Phase Boundary

- In Phase 1, use repo render helpers and verification artifacts to frame the audit.
- In Phase 2, pair this skill with read-only `vapi-read` and `n8n-read` MCP servers for direct runtime inspection.

## Containment Rules

- Never certify a runtime change from repo inspection alone.
- Never assume credential attachment state is versioned in Git.
- Never treat dashboard-only or UI-only state as enough evidence.
