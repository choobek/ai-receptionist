# Real Call Evaluation: Scenario B

Source file: local Vapi export `calls-export-df0880e1-cc65-492c-8c20-f6878278c5ad-2026-03-13-22-50-28.json` (kept outside the repo)

Call ID: `019ce961-eb31-7ee0-940e-3ae358873dea`

Date: `2026-03-13`

## Outcome

Scenario B passed only partially.

What passed:

- `createEvent` was not called
- `createReceptionTask` was called
- `createReceptionTask` returned success with `accepted: true`

What failed:

- the assistant claimed the receptionist request was already saved before the tool result arrived
- the assistant asked again for name and phone even though they were already present in the first user utterance
- the structured output object existed but `result` was empty, so this call cannot yet be treated as a healthy Scenario B pass

## What happened

On Friday, March 13, 2026, at about 23:47 Warsaw time, the caller opened with the full request:

- reschedule an existing appointment
- full name: `Wojciech Czub`
- phone: `793 385 531`

The assistant then produced one long reply that bundled:

- the opening line
- a request for name
- a request for phone
- a promise that the request had already been saved
- a callback promise to reception

Only after that long spoken turn did Vapi call `createReceptionTask`.

## Main findings

1. Tool-order violation in spoken behavior.
   The assistant said the request "zostala zapisana w systemie" before `createReceptionTask` returned. This directly breaks the prompt rule that follow-up promises are allowed only after tool success.

2. Redundant data collection.
   The caller gave both full name and phone number in the first utterance, but the assistant still asked for them again.

3. Overpacked single response.
   The assistant compressed the whole flow into one response instead of acknowledging the request, using the provided data, then speaking again after tool success.

4. Structured output failure.
   The structured output entry `Dental Call Intake` was present, but its `result` object was empty. That means post-call classification for Scenario B failed or did not complete.

5. Transcript quality issue.
   The phrase `przerodzenie wizyty` appears in the assistant transcript, which suggests another speech-generation or transcription quality issue.

## Repo changes made after this review

- Tightened [`prompts/system-prompt.md`](../../prompts/system-prompt.md) so the assistant should not repeat the full opening when the caller already starts with a complete request.
- Added a rule to reuse name and phone when the caller already provided them clearly.
- Added stricter wording for reschedule/cancel flows so the assistant must wait for `createReceptionTask` success before promising reception follow-up.

## Remaining risk

This export alone does not prove whether the `call.ended` router returned `needs_reception_follow_up`.

Because the structured output `result` is empty, router classification is still at risk even though `createReceptionTask` itself succeeded.
