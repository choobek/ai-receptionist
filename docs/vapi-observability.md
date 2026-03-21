# Vapi Observability

This repo now keeps a repo-backed Vapi observability pack beside the assistant config.

## Source of truth

- structured outputs: [`../configs/vapi/structured-outputs/`](../configs/vapi/structured-outputs/)
- scorecards: [`../configs/vapi/scorecards/`](../configs/vapi/scorecards/)
- evals: [`../configs/vapi/evals/`](../configs/vapi/evals/)
- environment bindings: [`../configs/vapi/environments/`](../configs/vapi/environments/)
- readable call-intake schema mirror: [`./vapi-structured-output.json`](./vapi-structured-output.json)

## What the pack includes

- one full post-call extraction output: `Dental Call Intake`
- eight primitive QA outputs used for scoring
- two scorecards attached to each assistant:
  - `Core Call Quality`
  - `Conversation Discipline`
- five saved Vapi chat evals for urgent routing, handoff behavior, phone capture, and medical-safety refusal

## Sync commands

Full environment sync:

```bash
./scripts/sync-vapi-environment.sh staging
./scripts/sync-vapi-environment.sh production
```

Observability-only sync:

```bash
./scripts/sync-vapi-observability.sh staging
./scripts/sync-vapi-observability.sh production
```

Mirror-only sync for the readable call-intake schema:

```bash
./scripts/sync-vapi-observability-mirrors.sh
```

## Running the saved eval pack

```bash
./scripts/run-vapi-eval-suite.sh staging
./scripts/run-vapi-eval-suite.sh staging --eval-key urgentFirstAvailableLookup
./scripts/run-vapi-eval-suite.sh staging --list
```

Artifacts are written to:

- `autonomy/runs/generated/vapi-evals/<suite-run-id>/`
- `autonomy/reports/generated/vapi-evals/<suite-run-id>.md`

## Reading live-call scorecards

After a real Vapi call ends, inspect:

- `call.artifact.structuredOutputs`
- `call.artifact.scorecards`

Example:

```bash
curl -sS "https://api.vapi.ai/call/YOUR_CALL_ID" \
  -H "Authorization: Bearer $VAPI_API_KEY" | \
jq '.artifact.scorecards'
```

As of 2026-03-21, this setup was verified on a real staging web call through the voice smoke lane: the raw Vapi call artifact contained both the new primitive structured outputs and both new scorecards.

## Current limitation

As of 2026-03-21, the saved Vapi `chat.mockConversation` eval lane is configured and versioned in this repo, but the current staging assistant can still time out before returning the assistant turn inside Vapi's saved eval runner. The local runner records those timeouts as failed findings instead of hanging indefinitely.

Treat the saved Vapi eval pack as an experimental fast lane for now. The repo-local staging regression suite and staging voice smoke suite remain the release gate.
