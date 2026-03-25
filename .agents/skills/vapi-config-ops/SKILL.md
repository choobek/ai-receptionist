---
name: "vapi-config-ops"
description: "Use for shared Vapi config edits, prompt mirrors, environment bindings, observability resources, and repo-backed sync commands in ai-receptionist."
---

# Vapi Config Ops

Use this skill whenever the task changes Vapi assistant behavior, tool bindings, prompt mirrors, observability resources, or environment-specific Vapi state.

## Canonical Files

- Shared assistant behavior: `configs/vapi/assistant.v2.json`
- Environment bindings: `configs/vapi/environments/staging.json` and `configs/vapi/environments/production.json`
- Structured outputs: `configs/vapi/structured-outputs/`
- Scorecards: `configs/vapi/scorecards/`
- Evals: `configs/vapi/evals/`
- Live-call autoevaluation policy: `configs/vapi/autoevaluation-policy.v1.json`

## Mirror Rules

- Prompt mirrors in `prompts/` are readable mirrors by default.
- If the mirror was intentionally edited first, run `./scripts/import-vapi-prompt-mirrors.sh` before syncing.
- Otherwise edit the canonical JSON config and run `./scripts/sync-vapi-prompt-mirrors.sh`.
- If the call-intake schema changed, run `./scripts/sync-vapi-observability-mirrors.sh`.

## Read Before Write

- Render effective environment state with `./scripts/render-vapi-assistant-config.sh staging|production`.
- Runtime drift checks must compare the rendered environment config to live Vapi state, not only the shared assistant JSON.
- Tool existence in the repo does not guarantee tool exposure to the model; the rendered `toolIds` order is what matters.

## Sync Commands

- Full Vapi environment sync: `./scripts/sync-vapi-environment.sh staging|production`
- Observability-only sync: `./scripts/sync-vapi-observability.sh staging|production`
- Assistant update only: `./scripts/update-vapi-assistant.sh staging|production`
- Tool server URL bindings: `./scripts/update-vapi-tool-bindings.sh staging|production`
- Tool function definitions: `./scripts/update-vapi-tool-definition.sh staging|production <tool-name>`
- Production phone number binding: `./scripts/sync-vapi-phone-number.sh production`

## Guardrails

- Do not treat Vapi dashboard edits as the final state.
- If Vapi rejects a field, update the stored repo config before retrying.
- Keep production explicit; staging is the default mutation target.
- Treat `./scripts/run-vapi-eval-suite.sh staging` as diagnostic, not release-gate authority.
