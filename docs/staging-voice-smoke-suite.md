# Staging Voice Smoke Suite

Status: the default runnable voice lane is limited to broad active smoke scenarios. Narrow booking reproductions stay in `draft` until repeated real-call evidence shows they are durable enough to promote.

This document defines where the automated staging voice lane will live, how its artifacts will be shaped, and how it should fit beside the existing chat regression suite.

For lane boundaries and promotion rules, see [Testing Strategy](./testing-strategy.md).

## Current status

What exists today:

- manual Vapi web-call test instructions in [`docs/testing.md`](./testing.md)
- manual voice regression scripts such as [`docs/test-scenario-2026-03-17-implant-inquiry-to-booking.md`](./test-scenario-2026-03-17-implant-inquiry-to-booking.md)
- chat-based automated regression through [`./scripts/run-staging-regression-suite.sh`](../scripts/run-staging-regression-suite.sh)
- post-call ingestion into normalized autonomy runs

What the current slice adds:

- a dedicated voice scenario schema
- a dedicated voice run schema
- a dedicated voice suite schema
- dedicated generated artifact paths for staging voice runs and reports
- a standalone staging-only web-call runner
- on-demand ElevenLabs-backed fixture generation from scenario transcripts
- deterministic voice scoring and Markdown report generation
- failure classification across runner, transport, and assistant-behavior failures
- a default Polish smoke lane plus English companion scenarios
- one draft booking scenario that passes in isolation but still drifts under full-suite conditions

What is still pending:

- promotion of the booking-flow scenario from `draft` to `active`
- follow-up assertions for post-booking confirmation quality and language consistency

## Planned location

Voice scenarios:

- `autonomy/scenarios/staging-voice/`

Generated machine-readable artifacts:

- `autonomy/runs/generated/staging-voice/<suite-run-id>/`

Generated Markdown reports:

- `autonomy/reports/generated/staging-voice/<suite-run-id>.md`

Current command:

```bash
./scripts/run-staging-voice-smoke-suite.sh
```

Run a draft voice scenario intentionally:

```bash
./scripts/run-staging-voice-smoke-suite.sh --include-draft --scenario <scenario-id>
```

Generate or refresh caller fixtures explicitly:

```bash
./scripts/autonomy/generate-staging-voice-fixtures.sh --language all
```

List the active scenarios:

```bash
./scripts/run-staging-voice-smoke-suite.sh --list
./scripts/run-staging-voice-smoke-suite.sh --language en --list
```

## Schemas

Voice scenario:

- [`../autonomy/schemas/staging-voice-scenario.v1.json`](../autonomy/schemas/staging-voice-scenario.v1.json)

Voice run:

- [`../autonomy/schemas/staging-voice-run.v1.json`](../autonomy/schemas/staging-voice-run.v1.json)

Voice suite:

- [`../autonomy/schemas/staging-voice-suite.v1.json`](../autonomy/schemas/staging-voice-suite.v1.json)

Shared normalized run:

- [`../autonomy/schemas/run.v1.json`](../autonomy/schemas/run.v1.json)

The current runner fetches the final Vapi call artifact and normalizes it into `run.v1` so automated voice runs, ingested real calls, and future evaluator tooling stay comparable.

## Voice scenario shape

The voice scenario schema is separate from the chat schema on purpose.

Key differences from chat:

- runner provider is `vapi_web_call`, not `vapi_chat`
- scenarios are step-based, not just turn-based
- pause windows can be named and referenced by assertions
- assertions can target final call fields, structured output, and voice timing behavior

Supported step types in the current schema:

- `play_clip`
- `pause`
- `wait_for_assistant`
- `wait_for_call_end`
- `hangup`

The current runner actively executes `play_clip`, `pause`, and `wait_for_call_end`. The other step types are reserved in the schema but are not yet used by the seeded scenarios.

Currently implemented scoring families:

- tool usage
- tool arguments and results
- assistant text checks
- structured output path checks
- final call path checks
- no-speech / speech-after-window timing checks tied to scenario windows
- ended-reason checks
- selected-slot preservation checks for `createEvent`

## Runner shape

The standalone runner lives at:

- [`../scripts/autonomy/run-staging-voice-smoke-suite.js`](../scripts/autonomy/run-staging-voice-smoke-suite.js)
- [`../scripts/run-staging-voice-smoke-suite.sh`](../scripts/run-staging-voice-smoke-suite.sh)

It uses:

- the Vapi Web SDK in Chrome
- a browser-side Vapi web token or public key for `POST /call/web`
- the private Vapi API key only for server-side post-call fetches
- Chrome fake microphone input backed by a synthesized WAV file built from the scenario `play_clip` transcripts
- the existing [`../scripts/autonomy/ingest-vapi-call-log.js`](../scripts/autonomy/ingest-vapi-call-log.js) path to normalize the fetched call artifact into `run.v1`

Required env for the current runner:

- `STAGING_VAPI_API_KEY` or `VAPI_API_KEY` for post-call fetches
- `STAGING_VAPI_WEB_TOKEN`, `STAGING_VAPI_PUBLIC_KEY`, `VAPI_WEB_TOKEN`, or `VAPI_PUBLIC_KEY` for browser-side web call creation
- `ELEVENLABS_API_KEY` only when the referenced caller fixtures are not already present on disk

## Voice run shape

The future voice runner should write one scenario result per file using `staging-voice-run.v1`.

The run format reserves space for:

- call metadata
- artifact file paths
- step execution status
- raw event trace
- normalized tool trace
- criteria results
- a compact summary with transcript and event excerpts
- failure type
- tool summary
- structured output summary

This is meant to capture failures that the final transcript alone cannot explain, such as:

- barge-in during a pause window
- unexpected silence timeout
- client or browser transport failure
- call ending before structured output becomes available

## Safety rules

- staging only
- never use production bindings
- prefer Vapi web calls over real phone-number execution
- keep generated raw call artifacts under git-ignored paths
- use synthetic patient names and phone numbers only

## How to interpret this lane

- Active voice scenarios should stay broad and repeatable: silence handling, pause handling, low-confidence recovery, transport sanity.
- Draft voice scenarios are experimental reproductions. They are useful for evaluation, but they should not broaden the shared prompt on their own.
- A failing voice smoke run should lead to artifact review and comparison against real calls before any shared prompt change is made.

## Current seeded coverage

Active today:

- [`../autonomy/scenarios/staging-voice/silence-timeout-safe-end.v1.json`](../autonomy/scenarios/staging-voice/silence-timeout-safe-end.v1.json)
- [`../autonomy/scenarios/staging-voice/mid-sentence-pause-no-barge-in.v1.json`](../autonomy/scenarios/staging-voice/mid-sentence-pause-no-barge-in.v1.json)
- [`../autonomy/scenarios/staging-voice/low-confidence-transcript-recovery.v1.json`](../autonomy/scenarios/staging-voice/low-confidence-transcript-recovery.v1.json)
- [`../autonomy/scenarios/staging-voice/mid-sentence-pause-no-barge-in-en.v1.json`](../autonomy/scenarios/staging-voice/mid-sentence-pause-no-barge-in-en.v1.json)
- [`../autonomy/scenarios/staging-voice/low-confidence-transcript-recovery-en.v1.json`](../autonomy/scenarios/staging-voice/low-confidence-transcript-recovery-en.v1.json)

Draft today:

- [`../autonomy/scenarios/staging-voice/implant-inquiry-to-booking-voice.v1.json`](../autonomy/scenarios/staging-voice/implant-inquiry-to-booking-voice.v1.json)

As of 2026-03-19, the booking scenario passes in isolation on staging, including `createEvent`, selected-slot preservation, and `successfulForAssistantScope=true` in [staging-voice-20260319T231612643Z.md](../autonomy/reports/generated/staging-voice/staging-voice-20260319T231612643Z.md). It still drifts under full-suite conditions in [staging-voice-20260319T232815489Z.md](../autonomy/reports/generated/staging-voice/staging-voice-20260319T232815489Z.md), mainly on doctor-name rendering in the offered slot, so it remains `draft`.

By default, `./scripts/run-staging-voice-smoke-suite.sh` runs only the active Polish scenarios. Use `--language en` for the English companion lane or `--language all` to execute both. Add `--include-draft` only when you intentionally want experimental booking evals in the run.

## Promotion rule for booking voice cases

Before a booking-focused voice scenario moves from `draft` back to `active`, it should clear all of these:

- the same issue appears across multiple real calls, not just one synthetic run
- the required criteria can be expressed as durable invariants instead of wording snapshots
- the scenario stays useful as a smoke/eval tool without encouraging prompt accretion
