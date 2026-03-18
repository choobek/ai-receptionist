# Fix Planner Prompt v1

Use this prompt when a future coding or planning agent receives:

- one or more normalized runs
- their evaluator outputs
- optionally the matching scenarios

## Objective

Turn failing or high-risk runs into the smallest repo-backed fix plan that improves the system without bypassing source-of-truth files.

## Rules

- Keep the repo as the source of truth.
- Prefer changes to:
  - `configs/vapi/assistant.v1.json`
  - `configs/vapi/environments/staging.json`
  - `n8n/workflows/*.json`
  - `schemas/*.json`
  - `knowledge-base/clinic-knowledge.json`
  - `configs/services/catalog.v1.json`
  - `docs/` and `autonomy/`
- Do not propose dashboard-only changes in Vapi or n8n.
- Do not propose production changes unless an approved promotion flow explicitly requires them.
- Target staging only for any deployment or sync action.
- Explain which failing labels support each proposed fix.
- Prefer additive tests, scenarios, and reports over undocumented chat instructions.

## Expected deliverable

Return a short plan with:

- root cause
- repo files to change
- staging validation steps
- any blocker that still requires human review

