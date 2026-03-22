# Real Call Evaluation: Latest Three Staging Calls

Source suite run: `/home/choobek/repos/ai-receptionist/autonomy/reports/generated/vapi-live-autoeval/staging-vapi-live-autoeval-20260322T182634Z.md`

Reviewed calls:

- `019d15a0-61be-7ddb-a10c-faed6228ffc5`
- `019d157d-363a-7001-85e1-a0e34c94a7f3`
- `019d1578-f22d-777f-a4a9-55f638f34879`

Date reviewed: `2026-03-22`

## Summary

All three calls on 22 March 2026 reached the intended business flow.
Two bookings were created cleanly and one urgent booking was also created.
The weak spots were spoken UX and turn-finishing discipline, not data collection or tool binding.

Cross-call themes:

- gendered address should stay neutral until the caller reveals the right form
- hardcoded `pani/panu` examples are still nudging the model too early
- spoken output still leaks raw numeric hour forms like `17:30`, `10:00`, and `13:45`
- two calls ended after a tool returned but before a spoken follow-up was captured

## Call 1

Call ID: `019d15a0-61be-7ddb-a10c-faed6228ffc5`

Outcome:

- first consultation implant booking created successfully for `2026-03-24T17:30:00+01:00`
- caller then asked a follow-up question about All on four

What worked:

- intent was recognized immediately
- slot selection and patient data collection were clean
- phone readback was correct
- male form was only used after the caller clearly said `Chcialbym`

Problems observed:

1. Final spoken confirmation still leaked raw numeric time.
   The assistant said `17:30` instead of a fully spoken form.

2. The follow-up knowledge-base answer was not spoken in the captured message log.
   `searchKnowledgeBase` ran successfully, but the raw call messages stop after the tool result and the call ended with `silence-timed-out`.

## Call 2

Call ID: `019d157d-363a-7001-85e1-a0e34c94a7f3`

Outcome:

- implant consultation booking created successfully for `2026-03-26T10:00:00+01:00`

What worked:

- the assistant handled multiple availability lookups without losing the booking thread
- corrected phone-number readback was accurate after the caller added the missing last digit
- female form was grounded by the caller's own phrasing before the assistant used it

Problems observed:

1. The assistant hallucinated the caller's name.
   It said `Pani Aniu`, even though the caller never introduced herself as Anna.

2. Spoken hour formatting still leaked raw numeric forms.
   The assistant offered `9:45` and `10:00` instead of fully spoken times.

3. The booking succeeded, but no spoken post-booking confirmation was captured.
   `createEvent` returned `created=true`, then the call ended with `silence-timed-out` before any bot confirmation message appeared in the raw message list.

4. The scorecard flag `QA: Phone Readback Wrong` looks like a false positive for this call.
   The transcript shows the assistant corrected the number and repeated the final version correctly.

## Call 3

Call ID: `019d1578-f22d-777f-a4a9-55f638f34879`

Outcome:

- urgent consultation booking created successfully for `2026-03-25T13:45:00+01:00`

What worked:

- urgent intent was recognized and routed to `urgent_consultation`
- the assistant eventually found a valid Wednesday slot and completed the booking
- male form stayed aligned with the caller after `Chcialbym`

Problems observed:

1. The first availability lookup was too early.
   The assistant started proposing slots before the caller finished describing the problem.

2. Phone confirmation looped after an explicit confirmation.
   The caller said `Tak`, and the assistant still repeated the number and asked again.

3. Final booking consent was weaker than the prompt allows.
   The assistant treated `Serwis, no ale Dobrze` as enough to finalize the booking. That is riskier than a clear confirmation.

4. Spoken output still leaked raw numeric time and awkward name grammar.
   The assistant said `13:45` and then `dla Wojciech Czub` instead of a natural spoken form.

## Repo Changes Made After This Review

- Added an explicit `Forma zwracania sie` section to the canonical assistant prompt.
- Neutralized hardcoded `pani/panu` examples in booking, urgency, and phone-number flows.
- Added a rule to lock onto the revealed form once the caller makes it clear.
- Added a rule to never invent first-name forms like `Pani Aniu`.
