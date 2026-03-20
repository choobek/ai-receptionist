# Automated Voice / E2E Execution Lane Plan

## Goal

Add a staging-only automated voice smoke lane that exercises the real voice path end to end:

1. start a real staging Vapi voice session
2. drive a scripted caller through the session
3. wait for the call to end
4. fetch the completed call artifact
5. score the run against deterministic checks
6. write JSON artifacts and a Markdown report
7. exit non-zero on regression

This lane should complement the existing chat regression suite, not replace it.

## Current implementation status

Completed so far:

- Phase 1: schema and generated-artifact surface
- Phase 2: staging web-call launcher and artifact capture
- Phase 3: deterministic evaluator, failure classification, and Markdown smoke report
- Phase 4: seeded interruption, silence, transcript-recovery, and draft booking scenarios

Still pending:

- Phase 5: nightly integration
- booking-flow promotion from `draft` to default active coverage

## Current repo state

What already exists:

- A runnable staging chat regression suite built on `POST /chat`.
- A guarded staging autonomy loop that can ingest recent or exported call logs.
- A normalized offline run format for real calls and synthetic artifacts.
- A `call.ended` router and structured output flow for post-call triage.
- Manual voice scripts for Vapi web calls, including pause-sensitive checks.
- Shared assistant config already contains voice, transcription, interruption, and timeout settings.

What is still missing:

- Promotion of the booking flow from a draft regression target into the default active suite.
- Nightly or scheduled execution wiring for the voice lane.
- Final booking-quality checks around redundant confirmation and language consistency.

## Scope for the first lane

Keep the first slice intentionally small:

- staging only
- Vapi web call only
- 4 smoke scenarios max
- deterministic checks first, LLM grading later if needed
- synthetic caller identities only
- reversible staging writes only

Do not start with PSTN, SIP, or production phone-number automation. The repo already uses Vapi web-call instructions in manual scenarios, so web call is the shortest path to an automated voice lane.

## Recommended architecture

### 1. Add a separate voice scenario schema

Do not overload `staging-chat-scenario.v1`.

Create:

- `autonomy/schemas/staging-voice-scenario.v1.json`
- `autonomy/schemas/staging-voice-run.v1.json`
- `autonomy/schemas/staging-voice-suite.v1.json`

Reason:

- the current chat schema hardcodes `runner.provider: vapi_chat`
- voice scenarios need pauses, clip playback, silence windows, lifecycle events, and post-call expectations
- voice runs need call IDs, timing windows, event traces, and fetched call artifacts

### 2. Reuse the current autonomy normalization path

The voice runner should fetch the completed Vapi call artifact and pass it through the existing normalization path so chat runs, real calls, and automated voice runs stay comparable.

Target flow:

1. execute a staging voice scenario
2. fetch the finished Vapi call by call ID
3. store the raw call payload under a generated voice run directory
4. normalize it into `run.v1`
5. score voice-specific assertions
6. render a voice smoke report

This keeps the new lane compatible with the existing autonomy workspace instead of creating another one-off artifact format.

### 3. Use a browser-driven web-call harness

Prefer a browser harness over telephony for the first slice.

Recommended shape:

- `scripts/autonomy/run-staging-voice-smoke-suite.js`
- `scripts/run-staging-voice-smoke-suite.sh`
- a small browser automation dependency only if the call cannot be driven reliably with the Vapi web-call flow alone

The harness should:

1. start a staging Vapi web call
2. join the call in a browser
3. play prerecorded caller clips in sequence
4. hold explicit silence windows where the scenario says to pause
5. capture client/server call events during execution
6. detect end-of-call
7. fetch the final call object from the Vapi API

Use prerecorded WAV or MP3 fixtures for repeatability. Do not depend on browser TTS for the caller side.

### 4. Score from events, tools, and final artifact

Do not score voice behavior from the final transcript alone.

Use three evidence layers:

- live event stream during the call
- fetched final call artifact
- normalized tool trace and structured output

The current assistant config already exposes useful signals such as `speech-update`, `transcript`, `user-interrupted`, `voice-input`, and `end-of-call-report`. The voice runner should capture and persist them.

## Scenario format for v1

Each voice scenario should include:

- metadata
- source references
- call transport: `vapi_web_call`
- ordered caller steps
- pause durations
- expected tool calls
- expected post-call fields
- expected live-event assertions

Suggested step types:

- `play_clip`
- `pause`
- `expect_no_assistant_speech`
- `expect_tool_call`
- `expect_call_end`

Suggested assertion types:

- `tool_called`
- `tool_arg_equals`
- `tool_not_called`
- `structured_output_path_equals`
- `call_path_equals`
- `assistant_did_not_speak_during_window`
- `assistant_spoke_after_window`
- `ended_reason_equals`
- `create_event_matches_selected_slot`

## Initial scenario set

The first automated voice lane should cover only these four scenarios:

1. `implant-inquiry-to-booking-voice`
   Convert the existing planned manual web-call scenario into an executable smoke test.
   This covers TTS chunk quality, pause handling, `searchKnowledgeBase`, `checkAvailability`, `createEvent`, and structured output.

2. `mid-sentence-pause-no-barge-in`
   Caller pauses for 2-3 seconds mid-sentence.
   Pass only if the assistant does not take the turn during the pause window.

3. `silence-timeout-safe-end`
   Caller goes silent after the assistant asks a question.
   Pass only if the call ends cleanly with the expected timeout reason and without false booking or follow-up claims.

4. `low-confidence-transcript-recovery`
   Caller provides a noisy or awkwardly chunked phrase.
   Pass only if the assistant either recovers safely or asks a narrow clarification instead of calling the wrong tool.

Keep booking coverage to one happy-path scenario in v1. Add more voice scenarios only after the harness is stable.

## Implementation phases

### Phase 1: schema and report surface

Add:

- voice scenario schema
- voice run schema
- voice suite schema
- `docs/staging-voice-smoke-suite.md`

Acceptance:

- repo has a stable file format for machine-runnable voice scenarios and reports
- voice artifacts have a dedicated generated path

### Phase 2: voice launcher and artifact capture

Add:

- staging-only voice runner CLI
- web-call harness
- raw event capture
- final call fetch by call ID

Acceptance:

- one command can execute a single voice scenario and persist raw artifacts
- run output includes call ID, timestamps, event trace, and fetched call payload

### Phase 3: evaluator and smoke report

Add:

- deterministic scorer for voice assertions
- Markdown report renderer
- suite exit code behavior

Acceptance:

- failures clearly distinguish runner failure, transport failure, and assistant behavior failure
- reports show transcript excerpt, event excerpt, tool summary, ended reason, and structured output summary

### Phase 4: first 4 scenarios

Add the four initial scenarios and their voice fixtures.

Acceptance:

- each scenario is runnable by itself
- the suite can run all active voice scenarios in one command

### Phase 5: nightly integration

Integrate the voice smoke suite as an optional lane in the staging autonomy loop or as a separate scheduled command.

Acceptance:

- voice lane can run independently from the chat lane
- autonomy reports can link to the most recent voice suite output

## Generated artifact layout

Recommended paths:

- `autonomy/scenarios/staging-voice/`
- `autonomy/runs/generated/staging-voice/<suite-run-id>/`
- `autonomy/reports/generated/staging-voice/<suite-run-id>.md`

Inside each run directory:

- `suite.result.v1.json`
- `scenarios/<scenario-id>.result.v1.json`
- `raw-calls/<scenario-id>.call.json`
- `normalized/<scenario-id>.run.v1.json`
- `events/<scenario-id>.events.json`

## Guardrails

- staging only
- refuse production bindings
- never attach a production number
- prefer web call over phone-number execution
- synthetic patient names and phone numbers only
- capture created staging event IDs for cleanup
- keep generated raw call artifacts under git-ignored paths

## Acceptance criteria for lane v1

The lane is complete when all of these are true:

- `./scripts/run-staging-voice-smoke-suite.sh` exists
- it can run one scenario or the full active suite
- it starts a real staging voice session, not `POST /chat`
- it fetches the completed Vapi call artifact
- it writes machine-readable artifacts and a Markdown report
- it exits non-zero on regression
- it covers interruption, silence timeout, low-confidence recovery, and one booking confirmation path
- it stays staging-only and repo-backed

## Open decisions

1. Browser automation dependency

The repo currently has no Node package manifest. If browser automation is required, add the smallest practical dependency surface and commit the lockfile with it.

2. Voice fixture strategy

Prefer committed prerecorded fixtures over runtime TTS generation so failures stay reproducible.

3. Cleanup policy

The booking scenario should either target a clearly synthetic staging slot range or add an explicit cleanup helper for created staging events.

4. Autonomy-loop integration timing

Do not block the first voice lane on autonomy-loop integration. Ship the standalone runner first, then wire it into the broader loop.

## Recommended next move

Build this in the same order the repo already uses elsewhere:

1. define the voice schema
2. add the staging-only runner
3. make one booking scenario pass
4. add the 3 failure-oriented smoke scenarios
5. only then connect it to the autonomy loop
