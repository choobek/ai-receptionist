# Autonomy Loop Design

## Goal

Add the first safe slice of an auto-improvement loop for the AI receptionist without introducing new infrastructure or bypassing the repo's existing source-of-truth rules.

The first slice focused on four things:

- normalize real-call and synthetic-test artifacts into one offline format
- define stable evaluator outputs for future agentic review
- create a versioned place for scenarios, prompts, templates, runs, and reports
- keep the path compatible with existing staging deploy and sync scripts

That first slice did **not** automate repo writes, staging deploys, or Vapi/n8n mutations on its own.

## Guarded Staging Loop

The repo now contains a guarded staging-only controller:

- [`../scripts/run-staging-autonomy-loop.sh`](../scripts/run-staging-autonomy-loop.sh)
- [`../scripts/autonomy/run-staging-improvement-loop.js`](../scripts/autonomy/run-staging-improvement-loop.js)

It is intentionally narrow:

1. Run the existing staging synthetic suite.
2. Optionally ingest recent or exported Vapi call logs.
3. Normalize failures into clustered triage categories:
   - prompt issue
   - tool contract mismatch
   - schema gap
   - workflow logic bug
   - environment/config issue
   - bad scenario / false failure
4. Generate draft regression scenarios under git-ignored generated paths.
5. Apply only repo-backed targeted fixes that have an explicit safe fixer.
6. Run repo checks.
7. Deploy/sync staging only if runtime-affecting files changed.
8. Rerun the staging suite.
9. Write a release-style report plus a compact index.

## Guardrails

- The controller refuses `production`.
- The controller never calls the production deploy or sync scripts.
- The controller never binds any live production number to staging.
- The controller records changed files and patch reasons under generated artifacts.
- Runtime sync is skipped unless the applied fix actually touched runtime-owned files.
- Runtime fixes that depend on the VPS git checkout, such as n8n workflow imports, are reported as blocked until the repo state is committed and pushed. The loop does not pretend local-only workflow edits were deployed.
- Iteration count is capped.
- The loop stops if the staging regression count increases.
- Generated real-call artifacts and generated scenario drafts stay under git-ignored paths by default.

## Current Auto-Fixer Coverage

The safe fixer catalog is intentionally small.

Currently supported automatic repo mutation:

- split a false-failing ambiguous-day scenario into:
  - an alternative-day refresh regression
  - a nearest-day correction refresh regression
- tighten the Vapi booking prompt for exact selected-slot reuse in `createEvent`, with matching contract docs, schema example, and regression checks

Unsupported findings are still triaged and reported, but they remain review-only unless a future fixer is added.

## Main Command

Run one guarded staging loop:

```bash
./scripts/run-staging-autonomy-loop.sh
```

Nightly-friendly single-iteration mode:

```bash
./scripts/run-staging-autonomy-loop.sh --nightly
```

Include recent staging Vapi call logs:

```bash
./scripts/run-staging-autonomy-loop.sh --fetch-recent-calls 10
```

## Audit Summary

### Reusable pieces already in the repo

- Vapi assistant source of truth:
  [`configs/vapi/assistant.v2.json`](../configs/vapi/assistant.v2.json)
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
  [`docs/archive/real-call-evaluations/real-call-evaluation-2026-03-17-implant-booking.md`](./archive/real-call-evaluations/real-call-evaluation-2026-03-17-implant-booking.md),
  [`docs/archive/real-call-evaluations/real-call-evaluation-2026-03-17-implant-booking-retry.md`](./archive/real-call-evaluations/real-call-evaluation-2026-03-17-implant-booking-retry.md),
  [`docs/archive/manual-test-scenarios/test-scenario-2026-03-17-implant-inquiry-to-booking.md`](./archive/manual-test-scenarios/test-scenario-2026-03-17-implant-inquiry-to-booking.md)

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

The run format intentionally uses stable offline fields. For real-call ingestion it keeps only minimized operational traces by default, while synthetic staging artifacts can still retain richer detail for debugging.

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
