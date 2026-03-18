# Staging Regression Suite

This repo now includes a staging-only synthetic regression loop for the receptionist assistant.

## One-command entrypoint

Run the full active suite:

```bash
./scripts/run-staging-regression-suite.sh
```

Run a single scenario:

```bash
./scripts/run-staging-regression-suite.sh --scenario all-on-four-inquiry-to-booking
```

List the active scenarios:

```bash
./scripts/run-staging-regression-suite.sh --list
```

## What it does

The runner uses the staging Vapi assistant through `POST /chat`.

For each scenario it:

1. sends the scripted user turns to the staging assistant
2. captures assistant messages, tool calls, and tool results
3. scores the run against a deterministic local rubric
4. writes normalized JSON artifacts
5. renders a Markdown regression report
6. exits non-zero if any required criterion fails

## Scenario format

Runnable staging scenarios live under:

- [`../autonomy/scenarios/staging/`](../autonomy/scenarios/staging/)

The schema lives at:

- [`../autonomy/schemas/staging-chat-scenario.v1.json`](../autonomy/schemas/staging-chat-scenario.v1.json)

Each scenario contains:

- metadata and source references
- a multi-turn caller script
- optional per-turn assertions
- a full-run rubric with deterministic rule types
- root-cause hints used in the report

Current seeded coverage:

- booking flow with real staging `createEvent` plus combined identity capture
- availability lookup without booking
- knowledge-base question
- reception follow-up task creation
- alternative-day ambiguity refresh with a second lookup
- corrected-day refresh with a second availability lookup
- urgent first-available lookup

## Generated artifacts

Machine-readable artifacts are written under a git-ignored run directory such as:

- `autonomy/runs/generated/staging/<suite-run-id>/suite.result.v1.json`
- `autonomy/runs/generated/staging/<suite-run-id>/scenarios/<scenario-id>.result.v1.json`

Readable reports are written under:

- `autonomy/reports/generated/staging/<suite-run-id>.md`

Schemas:

- [`../autonomy/schemas/staging-chat-run.v1.json`](../autonomy/schemas/staging-chat-run.v1.json)
- [`../autonomy/schemas/staging-chat-suite.v1.json`](../autonomy/schemas/staging-chat-suite.v1.json)

## Safety and staging-only rules

- The suite only reads the staging assistant binding from [`../configs/vapi/environments/staging.json`](../configs/vapi/environments/staging.json).
- It requires `STAGING_VAPI_API_KEY` or the fallback `VAPI_API_KEY` from root `.env`.
- It never writes to production resources.
- Some scenarios intentionally perform real staging writes:
  - `createEvent` creates a synthetic appointment in the staging calendar
  - `createReceptionTask` creates a synthetic follow-up task in staging n8n execution history

Those writes are kept reversible by design:

- synthetic caller names are clearly marked as test data
- created event IDs are captured in the JSON artifacts
- the report names the exact failing or passing scenario that produced them

## Interpreting failures

The report shows, per scenario:

- pass or fail status
- first failure reason
- suspected tool or flow root cause
- a short transcript excerpt

Examples of regressions the suite is designed to catch:

- wrong service ID passed to `checkAvailability`
- booking created without the expected tool sequence
- stale availability reused after the caller corrected the day
- `createEvent` booking a slot that does not match the selected availability option
- non-booking questions drifting into `createEvent` or `createReceptionTask`
