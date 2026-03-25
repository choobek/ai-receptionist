# Real Call Evaluation: Scenario B

Source file: local Vapi export `calls-export-df0880e1-cc65-492c-8c20-f6878278c5ad-2026-03-15-16-24-18.json` (kept outside the repo)

Call ID: `019cf24b-bd84-7000-9a48-db8c164d0596`

Date: `2026-03-15`

## Outcome

This scenario failed on tool execution.

What happened:

- the caller reported pain and swelling
- the caller said it was a first visit
- the caller asked for the nearest available appointment
- the assistant said it would check availability
- no `checkAvailability` call appears anywhere in the export
- the call ended with `endedReason: silence-timed-out`

## Main findings

1. False tool-action promise.
   The assistant said `Chwileczkę, już sprawdzam dostępność`, but the payload contains no `tool_calls`, `tool_call_result`, or `checkAvailability` string outside the prompt text itself.

2. The assistant over-clarified a case that was already actionable.
   For an urgent first visit with a request like `To najbliższy termin po prostu`, the assistant already had enough to start a first-available search.

3. The missing date fallback blocked the flow.
   At the time of this call, the tool contract effectively expected `requestedDate`. When the caller asked for the first available slot without naming a day, the assistant had no strong fallback for using the clinic-local current date as the search starting point.

4. The call never reached a recoverable next step.
   Because the tool was not called, the user got no slot options and the conversation died in silence.

## Repo changes made after this review

- Tightened [`prompts/system-prompt.md`](../../../prompts/system-prompt.md) so the assistant cannot claim it is checking availability unless it is actually calling `checkAvailability`.
- Added a rule that `najbliższy termin`, `pierwszy wolny termin`, and similar requests default to today’s clinic-local date with `timePreference: first_available`.
- Added a specific urgent-care rule to call `checkAvailability` immediately for a first-visit urgent request instead of asking extra narrowing questions.

## Regression checklist for the next real call

- If the caller asks for the nearest available slot without a date, the assistant uses today as the search start date.
- In urgent first-visit calls, the assistant calls `checkAvailability` promptly instead of only saying that it will.
- No spoken promise to “check availability” appears without a matching tool call in the log.
