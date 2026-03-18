# Autonomy Loop Design

## Goal

Add the first safe slice of an auto-improvement loop for the AI receptionist without introducing new infrastructure or bypassing the repo's existing source-of-truth rules.

This take focuses on four things:

- normalize real-call and synthetic-test artifacts into one offline format
- define stable evaluator outputs for future agentic review
- create a versioned place for scenarios, prompts, templates, runs, and reports
- keep the path compatible with existing staging deploy and sync scripts

This take does **not** automate repo writes, staging deploys, or Vapi/n8n mutations on its own.

## Audit Summary

### Reusable pieces already in the repo

- Vapi assistant source of truth:
  [`configs/vapi/assistant.v1.json`](../configs/vapi/assistant.v1.json)
- environment bindings:
  [`configs/vapi/environments/staging.json`](../configs/vapi/environments/staging.json) and
  [`configs/vapi/environments/production.json`](../configs/vapi/environments/production.json)
- staging-safe sync/deploy flow:
  [`scripts/deploy-vps.sh`](../scripts/deploy-vps.sh),
  [`scripts/import-n8n-workflows-vps.sh`](../scripts/import-n8n-workflows-vps.sh),
  [`scripts/reconcile-n8n-workflows-vps.sh`](../scripts/reconcile-n8n-workflows-vps.sh),
  [`scripts/sync-environment.sh`](../scripts/sync-environment.sh)
- regression and repo health checks:
  [`scripts/check-repo-health.sh`](../scripts/check-repo-health.sh),
  [`scripts/check-workflow-regressions.js`](../scripts/check-workflow-regressions.js),
  [`scripts/sync-n8n-workflow-data.sh`](../scripts/sync-n8n-workflow-data.sh)
- post-call structured output contract:
  [`docs/vapi-structured-output.json`](./vapi-structured-output.json)
- post-call routing workflow:
  [`n8n/workflows/webhook_vapi-call-ended-router.json`](../n8n/workflows/webhook_vapi-call-ended-router.json)
- manually curated real-call reviews and test scenarios:
  [`docs/real-call-evaluation-2026-03-17-implant-booking.md`](./real-call-evaluation-2026-03-17-implant-booking.md),
  [`docs/real-call-evaluation-2026-03-17-implant-booking-retry.md`](./real-call-evaluation-2026-03-17-implant-booking-retry.md),
  [`docs/test-scenario-2026-03-17-implant-inquiry-to-booking.md`](./test-scenario-2026-03-17-implant-inquiry-to-booking.md)

### Gaps

- No normalized run artifact format exists for real calls or synthetic tests.
- Real-call reviews live as prose documents, not machine-usable eval inputs.
- There is no scenario registry that future coding/eval agents can consume directly.
- There is no CLI for turning raw Vapi exports into a stable offline record.
- There is no repo-local evaluator output schema for labels such as `wrong_tool_usage` or `repeated_question`.

### Staging observations

Read-only inspection during this audit showed:

- staging Vapi assistant bindings match the repo-backed staging config
- the staging structured output is attached and current
- the staging n8n instance contains duplicate historical workflow copies alongside the repo-owned workflow IDs

That duplicate workflow state already explains why the repo ships a reconcile step after imports. The autonomy slice added in this take stays file-based and does not depend on runtime workflow cleanup.

## First Safe Slice

The new autonomy subsystem is intentionally offline-first and file-based.

### Core loop

1. Capture a raw Vapi artifact.
   Sources can be a Vapi calls export, a single call API response, or a synthetic fixture.
2. Normalize it into a versioned run record.
3. Attach or derive a scenario ID.
4. Populate a conservative first-pass evaluation result.
5. Review the failing dimensions and convert them into repo-backed changes.
6. Run the existing repo health and regression checks.
7. Optionally deploy and sync **staging** using the existing scripts, outside this scaffold.
8. Store a report that links runs, scenarios, fixes, and remaining work.

### Why file-based first

- It matches the repo's current operating model.
- It stays reversible and easy to inspect.
- It avoids introducing a new database or service before the evaluation format is stable.
- It works with real call exports that already exist on the local machine.

## New Repo Surface

The autonomy workspace lives in [`../autonomy/`](../autonomy/):

- [`../autonomy/schemas/`](../autonomy/schemas/) for versioned offline schemas
- [`../autonomy/scenarios/`](../autonomy/scenarios/) for reusable eval scenario definitions
- [`../autonomy/prompts/`](../autonomy/prompts/) for future evaluator/fix-agent prompts
- [`../autonomy/templates/`](../autonomy/templates/) for report and scenario drafting templates
- [`../autonomy/runs/`](../autonomy/runs/) for normalized artifacts
- [`../autonomy/reports/`](../autonomy/reports/) for committed design/audit reports and future generated reports
- [`../autonomy/examples/`](../autonomy/examples/) for synthetic raw fixtures

The ingestion CLI lives at:

- [`../scripts/autonomy/ingest-vapi-call-log.js`](../scripts/autonomy/ingest-vapi-call-log.js)

## Data Model

### `run.v1`

[`../autonomy/schemas/run.v1.json`](../autonomy/schemas/run.v1.json) stores:

- source metadata
- call metadata
- normalized message stream
- normalized tool trace
- extracted structured output
- first-pass evaluator result

The run format intentionally uses stable offline fields and keeps raw tool or structured-output payload fragments only where they are useful for later review.

### `evaluator-result.v1`

[`../autonomy/schemas/evaluator-result.v1.json`](../autonomy/schemas/evaluator-result.v1.json) defines the minimum labels needed for the first agentic review loop:

- `task_completed`
- `booking_succeeded`
- `wrong_tool_usage`
- `missing_required_data`
- `repeated_question`
- `unsupported_claim`
- `needs_human_handoff`
- `failure_category`
- `summary`

The schema also allows:

- `confidence`
- `evidence`
- `recommended_next_action`

### `scenario.v1`

[`../autonomy/schemas/scenario.v1.json`](../autonomy/schemas/scenario.v1.json) defines:

- scenario metadata
- origin and derivation history
- a caller script
- tool expectations
- expected evaluator output

This lets future runs compare against a scenario without relying on free-form markdown alone.

## Ingestion Rules

The ingester is designed around the raw Vapi export shape already used in this repo:

- Vapi export files may be arrays of call objects
- call details sit at the top level
- normalized conversational events come from `artifact.messages`
- structured outputs live under `artifact.structuredOutputs`
- tool calls appear as `role: "tool_calls"`
- tool results appear as `role: "tool_call_result"`

Normalization choices:

- omit system-prompt text from the normalized conversation body
- keep bot/user/tool events in chronological order
- pair tool results with the most recent unresolved tool call
- derive first-pass evaluation conservatively from structured outputs and tool results
- leave uncertain labels as `null` rather than inventing certainty

## Safety Guardrails

- Real-call artifacts are expected to contain PII. Generated real-call runs are therefore kept under git-ignored paths by default.
- Only synthetic samples are committed in this take.
- The autonomy subsystem does not modify Vapi, n8n, or staging state.
- Future automation must continue to route any deploy or sync step through the existing staging scripts.
- Production is out of scope unless an explicit promotion flow is approved.

## Recommended Next Steps

1. Add a fetch CLI that reads call exports directly from the Vapi API for the staging assistant.
2. Add a scenario-derivation script that turns failed runs into new `scenario.v1` files.
3. Add a local evaluator runner that feeds normalized runs plus scenarios into an LLM and validates the output against `evaluator-result.v1`.
4. Add a redaction pass for reports that may be shared outside the repo owner.
5. Add a gated orchestration script that can:
   - ingest recent staging calls
   - run evaluator prompts
   - propose repo changes
   - stop before deploy unless the repo checks are green

