# Test Scenario: Implant inquiry converting to booking

Date designed: `2026-03-17`

Status: **planned — not yet run**

## Motivation

The real call from 2026-03-17 showed the complete inquiry side of an implant conversation
(All-on-4 explanation, own-teeth question, cost question) but the caller did not book.
This scenario runs the same opening and then continues to a confirmed booking.

It also directly validates the two fixes deployed on 2026-03-17:

- `chunkPlan` (voice) — the All-on-4 explanation must arrive as complete sentences,
  not as mid-sentence TTS fragments like `Polega ona na tym,`
- `onNoPunctuationSeconds` 3.0 — the bot must not take the turn when the caller
  pauses mid-sentence for 2–3 seconds before finishing the thought

## Conversation script

Run this as a Vapi web call. Speak each line in the order shown.
Pauses marked with `[pause Ns]` are intentional; hold silence for that long.

| # | Caller says | Notes |
|---|-------------|-------|
| 1 | `Dzień dobry, chciałam zapytać o te implanty w jeden dzień, co reklamujecie.` | Opening question — triggers `searchKnowledgeBase` |
| 2 | *(listen)* | Validate: smooth All-on-4 explanation — see check 1 |
| 3 | `A co jeśli` [pause 2.5s] `mam jeszcze kilka własnych zębów, to też mogę?` | Mid-sentence pause — validates endpointing fix |
| 4 | *(listen)* | Validate: bot did not speak during the 2.5 s gap — see check 2 |
| 5 | `I ile ta konsultacja kosztuje?` | Cost question |
| 6 | *(listen)* | Validate: 200 zł + tomography policy stated correctly |
| 7 | `No dobrze, to chciałabym się umówić na tę konsultację.` | Triggers `checkAvailability` with `implant_consultation` |
| 8 | *(listen, pick first slot offered)* | Validate: slot offered with doctor name — see check 3 |
| 9 | `Ten pierwszy termin mi odpowiada.` | Slot selection |
| 10 | *(listen — bot asks for name)* | |
| 11 | `Anna Kowalska` | |
| 12 | *(listen — bot asks for phone or reads it back)* | |
| 13 | `sześć zero cztery, jeden dwa trzy, czterysta pięćdziesiąt sześć` | Provide phone as spoken digits |
| 14 | *(listen — bot reads phone back digit-by-digit and asks to confirm)* | Validate: each digit group spoken separately, not as integer |
| 15 | `Tak, zgadza się.` | |
| 16 | *(listen — bot summarises booking without phone number, asks for confirmation)* | Validate: summary is one utterance, no phone repeated |
| 17 | `Tak, proszę potwierdzić.` | Final confirmation — triggers `createEvent` |
| 18 | *(listen)* | Validate: booking confirmed once, no restart of scheduling flow |
| 19 | `Dziękuję, do widzenia.` | End of call |

## Checks

### Check 1 — TTS chunk coherence (chunkPlan fix)

**Pass:** Every assistant utterance during the All-on-4 explanation is a complete,
grammatically finished sentence ending in `.`, `?`, or `!`. No utterance ends
mid-clause like `Polega ona na tym,` or `A w niektórych przypadkach`.

**Fail:** Any fragment visible in the Vapi transcript where the bot utterance ends
without sentence-ending punctuation while the explanation is still in progress.

### Check 2 — Mid-sentence patience (endpointing fix)

**Pass:** The bot does not produce any utterance between the caller saying `A co jeśli`
and the caller finishing `mam jeszcze kilka własnych zębów, to też mogę?`. The Vapi
`messages` log shows no bot turn inside that gap.

**Fail:** A bot utterance appears between the two halves of the caller's sentence —
same failure mode as the `A jeśli ja mam` incident in the 2026-03-17 real call.

### Check 3 — Correct service ID for implant consultation

**Pass:** The `checkAvailability` tool call in the export uses `service.id: implant_consultation`.

**Fail:** `service.id` is `consultation` or any other value.

### Check 4 — Doctor name in slot offer

**Pass:** The bot names `doktor Magdaleny Szajnar` in the same utterance as the slot
options, without waiting for the caller to ask.

**Fail:** Slots are offered without a doctor name, or the doctor is mentioned only
after the caller asks.

### Check 5 — Phone number readback

**Pass:** After step 13, the bot repeats the phone as individual digit groups
(e.g. `sześć zero cztery, jeden dwa trzy, czterysta pięćdziesiąt sześć`) and asks
only for yes/no confirmation. The phone does not reappear in the booking summary.

**Fail:** Bot reads the number as a large integer, skips the readback, asks for it
again after step 15, or includes it in the final summary.

### Check 6 — Single confirmation round

**Pass:** `createEvent` is called exactly once, after step 17. The structured output
`booking.bookingCreated` is `true`. No second booking summary or scheduling prompt
appears after the booking is confirmed.

**Fail:** `createEvent` is not called, is called twice, or the bot reopens scheduling
after a successful confirmation.

### Check 7 — Structured output classification

Inspect `artifact.structuredOutputs` in the call export.

Expected values:

```json
{
  "callOutcome": "booking_created",
  "intent": {
    "primaryReason": "implants",
    "visitType": "implant_consultation"
  },
  "booking": {
    "availabilityChecked": true,
    "bookingCreated": true
  },
  "riskFlags": {
    "callerHungUpBeforeCompletion": false
  },
  "successfulForAssistantScope": true
}
```

## What to log after the test

After running, copy the Vapi call export JSON to a local review folder
outside the repo and create a real-call evaluation document at
`docs/archive/real-call-evaluations/real-call-evaluation-2026-03-17-implant-booking.md`
following the format of earlier evaluation files. Note which checks
passed, which failed, and what prompt or config changes (if any) were made.
