# Test Scenario: Implant inquiry → booking (retry-2 after 2026-03-17 fixes)

Date designed: `2026-03-17`

Status: **planned — not yet run**

## Motivation

The retry call (2026-03-17 23:21) exposed four remaining failures:

1. TTS fragmentation — "." in `punctuationBoundaries` split every sentence
2. Phone double-loop — bot re-read number and asked premature confirmation
3. Doctor name hallucination — "Scheiner" instead of "Szajnar"
4. Summary filler — "Podsumuje wizytę." as a separate opener turn

All four addressed in the post-retry commit (90f98be).

This scenario re-runs the same conversation to verify:

1. All-on-4 explanation delivered in ≤ 2 TTS chunks (no fragmentation)
2. Phone readback: all digits as Polish words, no digit characters; confirmed
   in one turn; bot proceeds directly to summary — no re-read, no loop
3. Doctor name "Szajnar" in both slot offer and booking summary
4. Pre-booking summary: no "Podsumuje wizytę." opener; delivered in one turn
5. Booking confirmed once; no flow restart

## Conversation script

Run as a Vapi web call. Speak each line in the order shown.

| # | Caller says | Notes |
|---|-------------|-------|
| 1 | `Dzień dobry, chciałbym zapytać o te implanty, w jeden dzień, co reklamujecie.` | Triggers `searchKnowledgeBase` |
| 2 | *(listen)* | **Check 1** — explanation in ≤ 2 turns; no "minus"; no fragmented sentences |
| 3 | `A co jeśli` [pause 2.5 s] `mam jeszcze kilka własnych zębów?` | Mid-sentence pause |
| 4 | *(listen)* | Note behavior during gap; call succeeds regardless |
| 5 | `No dobrze, to chciałbym się umówić na tę konsultację.` | Triggers `checkAvailability` |
| 6 | *(listen — pick first slot offered)* | **Check 2** — one utterance; "Szajnar"; times as words |
| 7 | `Ten pierwszy termin mi odpowiada.` | Slot selection |
| 8 | *(listen — bot asks for name)* | |
| 9 | `Anna Kowalska` | |
| 10 | *(listen — bot asks for phone)* | |
| 11 | `sześć zero cztery, jeden dwa trzy, czterysta pięćdziesiąt sześć` | Phone as spoken digits |
| 12 | *(listen)* | **Check 3** — readback as Polish words; confirmed in one turn |
| 13 | `Tak, zgadza się.` | Phone confirmed |
| 14 | *(listen)* | **Check 4** — summary starts immediately; no re-read; no "Podsumuje wizytę."; one turn; "Szajnar" |
| 15 | `Tak, proszę potwierdzić.` | Final confirmation → triggers `createEvent` |
| 16 | *(listen)* | **Check 5** — booking confirmed once, no restart |
| 17 | `Dziękuję, do widzenia.` | End of call |

## Checks

### Check 1 — TTS coherence (no fragmentation)

**Pass:** The All-on-4 explanation arrives in at most 2 bot turns.
No sentence fragment appears as a standalone turn. No "minus".
No word split mid-syllable (e.g. "imp lantologiczne").

**Fail:** 3+ separate bot turns for the explanation, or any fragment turn
of < 10 words that is not a question.

### Check 2 — One-utterance slot offer with Szajnar

**Pass (all required):**
- `checkAvailability` uses `service.id: "implant_consultation"`.
- All slots presented in **one** bot utterance with colon+commas format.
- Doctor "Szajnar" (not "Scheiner" or any other spelling) in the same utterance.
- Times written as Polish words.

**Fail:** Slots split across 2+ turns; wrong doctor name; raw digit times.

### Check 3 — Phone readback as Polish words, confirmed in one turn

**Pass:** Bot's text output contains only Polish words for all digit groups
(e.g. "sześć zero cztery, jeden dwa trzy, cztery pięć sześć").
Confirmation request is in the same turn as the readback.
No digit characters in the readback.

**Fail:** Any digit character in the readback output; confirmation in a
separate turn; or bot asks for the number again after step 13.

### Check 4 — Summary: no loop, no filler, one turn, Szajnar

**Pass (all required):**
- After "Tak, zgadza się." (step 13) bot moves directly to booking summary.
- No "Podsumuje wizytę." or equivalent opener.
- Summary is one bot turn containing: visit type, first visit, day of week,
  full date, time, patient name, doctor "Szajnar".
- "Czy wszystko się zgadza i czy mam potwierdzić rezerwację?" in the same turn.
- Phone number NOT mentioned in summary.

**Fail:** Summary split into 2+ turns; "Podsumuje wizytę." opener; bot
re-reads the phone number; wrong doctor name; premature "Czy wszystko się
zgadza?" before the summary.

### Check 5 — Single booking confirmation

**Pass:** `createEvent` called exactly once after step 15.
`booking.bookingCreated: true`. No scheduling flow restart.

**Fail:** `createEvent` not called, called twice, or bot reopens loop.

### Check 6 — Structured output classification

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

Copy the Vapi call export JSON to `/home/choobek/Downloads/` and create a
real-call evaluation document at
`docs/real-call-evaluation-2026-03-17-implant-booking-retry2.md`
following the format of `docs/real-call-evaluation-2026-03-17-implant-booking-retry.md`.
Note which checks passed, which failed, and what changes (if any) were made.
