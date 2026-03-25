# Test Scenario: Implant inquiry → booking (retry after 2026-03-17 fixes)

Date designed: `2026-03-17`

Status: **planned — not yet run**

## Motivation

The 2026-03-17 real call exposed five failures (see
[`real-call-evaluation-2026-03-17-implant-booking.md`](../real-call-evaluations/real-call-evaluation-2026-03-17-implant-booking.md)).
All five have been addressed in commit `f66e83f`.
This scenario re-runs the same conversation to verify:

1. `service.id` is `implant_consultation`, not `consultation`
2. All-on-4 explanation arrives without "minus" in the name
3. Slots offered in one utterance with colon+commas format and spoken times
4. Phone readback uses Polish words, not digit characters
5. Mid-sentence patience is maintained (secondary — no config change)

## Conversation script

Run as a Vapi web call. Speak each line in the order shown.
Pauses marked `[pause Ns]` are intentional.

| # | Caller says | Notes |
|---|-------------|-------|
| 1 | `Dzień dobry, chciałbym zapytać o te implanty w jeden dzień, co reklamujecie.` | Triggers `searchKnowledgeBase` |
| 2 | *(listen)* | **Check 1** — explanation in one coherent turn; no "minus" in "All-on-4" |
| 3 | `A co jeśli` [pause 2.5 s] `mam jeszcze kilka własnych zębów, to też mogę?` | Mid-sentence pause |
| 4 | *(listen)* | **Check 2** — no bot utterance during the 2.5 s gap |
| 5 | `I ile ta konsultacja kosztuje?` | Cost question |
| 6 | *(listen)* | Validate: 200 zł + tomography policy |
| 7 | `No dobrze, to chciałbym się umówić na tę konsultację.` | Should trigger `checkAvailability` with `implant_consultation` |
| 8 | *(listen — pick first slot offered)* | **Check 3** — one utterance, doctor named, times as words |
| 9 | `Ten pierwszy termin mi odpowiada.` | Slot selection |
| 10 | *(listen — bot asks for name)* | |
| 11 | `Anna Kowalska` | |
| 12 | *(listen — bot asks for phone)* | |
| 13 | `sześć zero cztery, jeden dwa trzy, czterysta pięćdziesiąt sześć` | Provide phone as spoken digits |
| 14 | *(listen)* | **Check 4** — bot reads back each digit group as words, not integers |
| 15 | `Tak, zgadza się.` | Phone confirmed |
| 16 | *(listen — one booking summary, no phone repeated)* | **Check 5** — summary in one turn |
| 17 | `Tak, proszę potwierdzić.` | Final confirmation → triggers `createEvent` |
| 18 | *(listen)* | **Check 6** — booking confirmed once, no flow restart |
| 19 | `Dziękuję, do widzenia.` | End of call |

## Checks

### Check 1 — TTS coherence and "All-on-4" pronunciation

**Pass:** The All-on-4 explanation arrives as complete sentences in at most 2 turns.
No utterance contains "minus". The service name is spoken as "All on four"
or "All on cztery" — never "all-on-minus-four".

**Fail:** Bot says "minus", or explanation fragments into 4+ short turns.

### Check 2 — Mid-sentence patience

**Pass:** No bot utterance appears between "A co jeśli" and the completion
"mam jeszcze kilka własnych zębów, to też mogę?". The Vapi `messages` log
shows no bot turn during the 2.5 s gap.

**Fail:** A bot utterance ("Chętnie odpowiem." or similar) appears before
the caller finishes.

### Check 3 — implant_consultation service.id + one-utterance slot offer

**Pass (both required):**
- `checkAvailability` call in the export uses `service.id: "implant_consultation"`.
- All slot options are presented in **one** bot utterance using colon+commas format,
  with doctor name in the same sentence, and times written as Polish words
  (e.g. "o dziewiątej", "o dziesiątej trzydzieści").

**Fail:** `service.id` is `consultation`; or slots split across 2+ turns;
or times appear as raw digits ("9:00", "10:30").

### Check 4 — Phone readback as Polish words

**Pass:** After step 13, the bot's text output contains Polish words for digits
(e.g. "sześć zero cztery, jeden dwa trzy, cztery pięć sześć"), not digit characters.
Confirmation requested in the same turn. Phone does not reappear in summary.

**Fail:** Bot writes digit characters in readback output, reads number as large integer,
asks for number again after step 15, or includes it in the booking summary.

### Check 5 — One-turn booking summary

**Pass:** The pre-`createEvent` summary is delivered in one bot utterance containing:
visit type, day of week, full date, time, patient name, and doctor name.
The question "Czy wszystko się zgadza i czy mam potwierdzić rezerwację?" is
in the same utterance.

**Fail:** Summary split across 2+ turns, or confirmation question in a separate turn.

### Check 6 — Single booking confirmation

**Pass:** `createEvent` called exactly once, after step 17.
`booking.bookingCreated: true`. No scheduling flow restart after success.

**Fail:** `createEvent` not called, called twice, or bot reopens scheduling loop.

### Check 7 — Structured output classification

Inspect `artifact.structuredOutputs` in the call export.

Expected values:

```json
{
  "callOutcome": "appointment_booked",
  "intent": {
    "primaryReason": "implants",
    "visitType": "implant_consultation"
  },
  "booking": {
    "availabilityChecked": true,
    "bookingCreated": true,
    "serviceId": "implant_consultation"
  },
  "qualityFlags": {
    "phoneNumberRepeatedIncorrectly": false
  },
  "successfulForAssistantScope": true
}
```

## What to log after the test

Copy the Vapi call export JSON to a local review folder outside the repo and create a
real-call evaluation document at
`docs/archive/real-call-evaluations/real-call-evaluation-2026-03-17-implant-booking-retry.md`
following the format of
[`real-call-evaluation-2026-03-17-implant-booking.md`](../real-call-evaluations/real-call-evaluation-2026-03-17-implant-booking.md).
Note which checks passed, which failed, and what changes (if any) were made.
