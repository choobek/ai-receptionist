# Real-Call Evaluation: Implant Inquiry → Booking (2026-03-17)

Call ID: `019cfd99-5084-7bbd-8c72-49e88c4b418f`
Date/time: 2026-03-17 22:00 (Europe/Warsaw)
Duration: ~5 min 22 s
Outcome: **Appointment booked** (Wojciech Czub, 2026-03-18 10:30, Konsultacja)
Cost: $0.275

---

## Scenario alignment

This call maps directly to the planned scenario
[`test-scenario-2026-03-17-implant-inquiry-to-booking.md`](../manual-test-scenarios/test-scenario-2026-03-17-implant-inquiry-to-booking.md).
The caller ran the same opening (All-on-4 inquiry, own-teeth question, cost question)
and proceeded to a confirmed booking.

---

## Check results

### Check 1 — TTS chunk coherence

**FAIL.**

The All-on-4 explanation was split across 6 separate bot turns:

```
"Chodzi o metodę all-on-minus-four."
"To rozwiązanie dla osób z bezzębiem, w którym stały most opiera się…"
"Zaletą jest mniejsza inwazyjność… Atlantów. Często brak konieczności…"
"oraz możliwość uzyskania efektu nawet tego samego dnia."
"Zapewnia też dobrą stabilność i estetykę. Ty."
"Czy chciałby pan umówić się na konsultację implantologiczną?"
```

Root causes:
- **"all-on-minus-four"**: model wrote "All-on-4" with a hyphen; TTS reads `-` as "minus".
- **"Atlantów." / "Ty."**: STT (gpt-4o-transcribe) hallucinations that appear only in the
  transcript, not in the actual audio.
- **Fragmentation**: `chunkPlan.minCharacters: 80` and `punctuationBoundaries: [".","?","!"]`
  caused short sentences to be sent as individual TTS chunks.

Fix deployed: prompt rule added — write "All on four" / "All on cztery", never "All-on-4".

### Check 2 — Mid-sentence patience

**FAIL.**

Caller said `"A co jeśli… Mam"` (incomplete). Bot responded with `"Chętnie odpowiem."`.
The STT delivered this as a complete utterance before the caller finished.
`onNoPunctuationSeconds: 3.0` did not help because the STT segment closed early.

No config change deployed for this — the `onNoPunctuationSeconds` is already at 3.0 s
and pushing it higher risks introducing dead air in normal turns. Noted for monitoring.

### Check 3 — Correct service ID for implant consultation

**FAIL.**

`checkAvailability` called with `service.id: "consultation"` instead of `"implant_consultation"`.
The prompt's fallback rule `"jesli nie masz pewnosci, wybierz consultation"` was too broad.

Fix deployed: explicit rule added — implants / All-on-4 topics → `implant_consultation`.
The `createEvent` call also used `consultation` (same root cause).

### Check 4 — Doctor name in slot offer

**PARTIAL PASS.**

Doctor was mentioned (`"U doktor Magdaleny Scheiner"`) but in a separate sentence fragment,
not in the same utterance as the slot list. The KRYTYCZNE rule was not followed.

Transcript:
```
"Mam wolne terminy. U doktor Magdaleny Scheiner. Środa. Osiemnastego marca o dziewiątej rano."
"O 9:45 oraz o 10:30."
"Który termin panu odpowiada?"
```

Root cause: model used periods between doctor/day/time fragments, causing chunkPlan to split.
Slot times were also raw digits ("9:45", "10:30") instead of spoken words.

Fixes deployed:
- New rule: no periods between doctor/day/time — use colon and commas.
- Explicit bad/good example added to the prompt.
- Slot time rule: must write times as Polish words ("o dziewiątej czterdzieści pięć").

### Check 5 — Phone number readback

**FAIL.**

First readback: `"793 385 53 Jeden"` — model split "531" incorrectly.
Second attempt: `"855. 3:1"` — STT mangled the input and model couldn't recover cleanly.
Third attempt: `"Siedem dziewięć trzy. 385531"` — last segment still written as digits.
Patient confirmed after 3 rounds.

Root cause: model wrote digit characters ("793 385 531") in its output;
TTS then rendered them inconsistently as integers or split numbers.

Fix deployed: new KRYTYCZNE rule — when writing phone readback in output,
use Polish words for each digit, never digit characters.
Example added: write "siedem dziewięć trzy, trzy osiem pięć, pięć trzy jeden".

### Check 6 — Single confirmation round

**PASS.** `createEvent` was called exactly once, after the patient said "Proszę".
`booking.bookingCreated: true`. No flow restart after booking.

### Check 7 — Structured output classification

**PARTIAL.**

| Field | Expected | Actual |
|---|---|---|
| `callOutcome` | `booking_created` | `appointment_booked` |
| `intent.primaryReason` | `implants` | `implants` ✓ |
| `intent.visitType` | `implant_consultation` | `first_consultation` |
| `booking.availabilityChecked` | `true` | `true` ✓ |
| `booking.bookingCreated` | `true` | `true` ✓ |
| `successfulForAssistantScope` | `true` | `true` ✓ |

The `callOutcome` enum value differs (`booking_created` vs `appointment_booked`) — this is
a schema naming discrepancy, not a functional failure. The `visitType` reflects that
`consultation` service.id was used (fix deployed).

---

## Summary of fixes deployed (commit f66e83f)

| # | Issue | Fix |
|---|---|---|
| 1 | `implant_consultation` not used | Explicit routing rule in prompt |
| 2 | "all-on-minus-four" TTS | Write "All on four" / "All on cztery" |
| 3 | Slots split into fragments | No periods between doctor/day/time; colon+commas format |
| 4 | Slot times as raw digits | Rule: write spoken words ("o dziesiątej trzydzieści") |
| 5 | Phone digits in text output | Rule: write Polish words, not digit characters |

`chunkPlan.minCharacters` increase was attempted but Vapi API caps it at 80.
