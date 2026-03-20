# Autonomy Workspace

This directory holds the repo-local assets for the receptionist auto-improvement loop.

## Layout

- `examples/`
  Synthetic raw Vapi payloads used to test the ingester.
- `prompts/`
  Prompt stubs for future evaluator and fix-planning agents.
- `reports/`
  Audit notes and generated regression reports.
- `runs/`
  Normalized run artifacts.
- `scenarios/`
  Versioned eval scenarios derived from project scope or real-call regressions.
- `schemas/`
  Versioned offline schemas for runs, evaluations, and scenarios.
- `templates/`
  Markdown templates for future reports and scenario writeups.

## Primary command

Run the staging synthetic regression suite:

```bash
./scripts/run-staging-regression-suite.sh
```

Run the guarded staging-only improvement loop:

```bash
./scripts/run-staging-autonomy-loop.sh
```

Nightly-friendly staging iteration:

```bash
./scripts/run-staging-autonomy-loop.sh --nightly
```

Pull recent staging calls into the same loop run before triage:

```bash
./scripts/run-staging-autonomy-loop.sh --fetch-recent-calls 10
```

Focused reference:

- [`../docs/staging-regression-suite.md`](../docs/staging-regression-suite.md)
- [`../docs/autonomy-loop.md`](../docs/autonomy-loop.md)
- [`../docs/staging-voice-smoke-suite.md`](../docs/staging-voice-smoke-suite.md)

## Voice smoke lane

The repo now also has a dedicated staging voice smoke lane surface:

- scenarios: `autonomy/scenarios/staging-voice/`
- scenario schema: [`../autonomy/schemas/staging-voice-scenario.v1.json`](../autonomy/schemas/staging-voice-scenario.v1.json)
- run schema: [`../autonomy/schemas/staging-voice-run.v1.json`](../autonomy/schemas/staging-voice-run.v1.json)
- suite schema: [`../autonomy/schemas/staging-voice-suite.v1.json`](../autonomy/schemas/staging-voice-suite.v1.json)
- guide: [`../docs/staging-voice-smoke-suite.md`](../docs/staging-voice-smoke-suite.md)
- runner: [`../scripts/run-staging-voice-smoke-suite.sh`](../scripts/run-staging-voice-smoke-suite.sh)

Run the current voice smoke suite with:

```bash
./scripts/run-staging-voice-smoke-suite.sh
```

The default suite runs the active Polish scenarios. Use `--language en` for the English companion scenarios or `--language all` to run both. Missing caller clips can be generated locally from scenario transcripts through [`../scripts/autonomy/generate-staging-voice-fixtures.sh`](../scripts/autonomy/generate-staging-voice-fixtures.sh).

## Historical ingestion command

Normalize a raw Vapi call payload:

```bash
node scripts/autonomy/ingest-vapi-call-log.js \
  --input autonomy/examples/vapi-call-ended-sample-booking.json \
  --output autonomy/runs/samples/sample-booked.run.v1.json \
  --scenario-id implant-inquiry-to-booking \
  --environment staging
```

Batch-ingest every call in a Vapi export file:

```bash
node scripts/autonomy/ingest-vapi-call-log.js \
  --input /path/to/calls-export.json \
  --output-dir autonomy/runs/generated \
  --all \
  --environment staging
```

## Safety defaults

- Commit only synthetic samples unless you have explicitly redacted the artifact.
- Keep generated staging and real-call outputs under git-ignored paths inside `runs/` and `reports/`.
- Keep generated scenario drafts under git-ignored paths inside `scenarios/generated/`.
- Keep operational changes routed through the existing repo scripts, not through this workspace.
- The autonomous loop is staging-only and refuses `production`.
- The loop records its fix attempts, changed files, derived scenarios, and before/after suite results under git-ignored generated artifacts.
- The loop may sync Vapi-backed fixes directly from local repo state, but it will block workflow or VPS-affecting fixes until they are ready for the existing git-backed staging deploy path.
