# Real Call Evaluation: Scenario A

Source file: local Vapi export `calls-export-df0880e1-cc65-492c-8c20-f6878278c5ad-2026-03-13-22-02-15.json` (kept outside the repo)

Call ID: `019ce904-206e-733b-a903-24d4d5338764`

Date: `2026-03-13`

## Outcome

Scenario A passed on business flow:

- `checkAvailability` was called with `requestedDate: 2026-03-16`, `timePreference: morning`, `service.id: consultation`
- `createEvent` was called successfully
- the booking was created for `2026-03-16T09:30:00+01:00`
- structured output classified the call as `appointment_booked`
- structured output marked `successfulForAssistantScope: true`

The weak spot was spoken conversation quality, not tool execution.

## What worked

- The assistant recognized the intent correctly.
- It treated the caller as a new patient and used the first-consultation path.
- It clarified the ambiguous relative date before booking.
- It offered real slots returned by the availability tool.
- It collected name and phone number before calling `createEvent`.
- It mentioned the first-visit price after a successful booking.

## Problems observed

1. Relative date handling was unstable.
   The assistant first said "najblizszy poniedzialek, 17 marca" and then switched to `16 marca`. On Friday, 13 March 2026, the next Monday is 16 March 2026.

2. There were broken assistant utterances.
   The transcript contains raw fragments like `roz` and `Rozumiem, dziekuje za...`.

3. Spoken formatting still leaked raw numeric forms.
   The assistant said `9:30` instead of a fully spoken form like "o dziewiatej trzydziesci".

4. Slot offering and final confirmation sounded fragmented.
   The phrasing "Moge zaproponowac... O osmej?" and "Pierwsza konsultacja To mam nazwisko..." is not production quality.

5. The assistant guessed gendered forms too early.
   It used `pani` before it had reliable grounding for how to address the caller.

## Repo changes made after this review

- Tightened [`prompts/system-prompt.md`](../../prompts/system-prompt.md) with a new spoken-output hygiene section.
- Added stricter rules for relative date resolution and for not reopening an already confirmed date.
- Added slot-offering guidance to keep options in one clean sentence.
- Tightened pre-booking and post-booking confirmation phrasing.
- Added explicit guidance to avoid gender guessing before the caller's preferred form is known.

## Regression checklist for the next real call

- No partial assistant tokens or cut-off phrases.
- Relative dates are resolved once and then kept consistent.
- Spoken dates and hours use natural Polish, not raw digits.
- Slot options are read as one smooth sentence.
- Final confirmation repeats the booked slot and patient name cleanly.
