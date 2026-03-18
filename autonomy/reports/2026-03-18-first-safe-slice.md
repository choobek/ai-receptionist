# First Safe Slice Report

Date: `2026-03-18`

## What I Found

Reusable pieces already existed:

- repo-owned Vapi assistant config plus environment bindings
- staging-safe deploy, import, reconcile, and sync scripts
- regression checks for repo health and workflow logic
- a post-call structured output schema and `call.ended` router workflow
- several manual real-call review documents and one-off test scenarios

Important gap:

- there was no normalized, versioned format for storing real calls or synthetic tests as machine-usable eval inputs

Important staging note from read-only inspection:

- staging Vapi matches repo bindings
- staging n8n contains duplicate historical workflow copies, which reinforces why the existing reconcile step is required after imports

## What I Added

New autonomy workspace:

- `autonomy/schemas/`
- `autonomy/scenarios/`
- `autonomy/prompts/`
- `autonomy/templates/`
- `autonomy/runs/`
- `autonomy/reports/`
- `autonomy/examples/`

New design and operating docs:

- `docs/autonomy-loop.md`
- `autonomy/README.md`

New versioned schemas:

- `autonomy/schemas/run.v1.json`
- `autonomy/schemas/evaluator-result.v1.json`
- `autonomy/schemas/scenario.v1.json`

New sample scenarios from current project scope:

- implant inquiry to booking
- existing-patient reschedule handoff
- urgent pain first available
- bonding vs veneers question

New future-agent assets:

- evaluator prompt stub
- fix-planner prompt stub
- eval report template
- scenario derivation template

New ingestion entry point:

- `scripts/autonomy/ingest-vapi-call-log.js`

## What Remains For The Next Take

- fetch staging calls directly from the Vapi API instead of relying on manual exports
- add an evaluator runner that prompts an LLM and validates the output against `evaluator-result.v1`
- add scenario derivation from failing runs
- add PII redaction helpers for shareable reports
- add a gated staging orchestration script that stops before deploy unless checks are green
- decide how much autonomy should be allowed to update staging automatically versus only preparing a review packet

## Exact Commands

Normalize a synthetic sample:

```bash
node scripts/autonomy/ingest-vapi-call-log.js \
  --input autonomy/examples/vapi-call-ended-sample-booking.json \
  --output autonomy/runs/samples/sample-booked.run.v1.json \
  --scenario-id implant-inquiry-to-booking \
  --environment staging
```

Normalize every call from a Vapi export:

```bash
node scripts/autonomy/ingest-vapi-call-log.js \
  --input /path/to/calls-export.json \
  --output-dir autonomy/runs/generated \
  --all \
  --environment staging
```

Run the existing repo checks:

```bash
./scripts/check-repo-health.sh
./scripts/check-workflow-regressions.js
./scripts/sync-n8n-workflow-data.sh --check
```

Render the current staging assistant from repo state:

```bash
./scripts/render-vapi-assistant-config.sh staging >/tmp/ai-receptionist-staging-rendered.json
```

If a future fix is approved for staging:

```bash
./scripts/deploy-vps.sh staging
./scripts/sync-environment.sh staging
```
