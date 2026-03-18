# Autonomy Workspace

This directory holds the first repo-local scaffold for an offline-first auto-improvement loop.

## Layout

- `examples/`
  Synthetic raw Vapi payloads used to test the ingester.
- `prompts/`
  Prompt stubs for future evaluator and fix-planning agents.
- `reports/`
  Audit notes and future generated autonomy reports.
- `runs/`
  Normalized run artifacts.
- `scenarios/`
  Versioned eval scenarios derived from project scope or real-call regressions.
- `schemas/`
  Versioned offline schemas for runs, evaluations, and scenarios.
- `templates/`
  Markdown templates for future reports and scenario writeups.

## Primary command

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
- Keep real-call outputs under git-ignored paths inside `runs/`.
- Keep operational changes routed through the existing repo scripts, not through this workspace.

