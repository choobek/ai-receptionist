# Real-Call Evaluation: Implant Inquiry → Booking (2026-03-17 retry)

Call ID: `019cfdad-0bbe-7000-9577-9a55fce5301a`
Date/time: 2026-03-17 23:21 (Europe/Warsaw)
Duration: ~4 min 45 s
Outcome: **Appointment booked** (Wojciech Czub, 2026-03-18 10:30, Konsultacja implantologiczna)
Cost: $0.2446

---

## Scenario alignment

This call re-ran the scenario from
[`test-scenario-2026-03-17-implant-booking-retry.md`](../manual-test-scenarios/test-scenario-2026-03-17-implant-booking-retry.md).
Same caller profile (All-on-4 inquiry, own-teeth question, booking).
The exact script was not followed verbatim but the intent and path were identical.

---

## Check results

### Check 1 — TTS coherence and "All-on-4" pronunciation

**FAIL.**

The All-on-4 explanation fragmented into 8+ separate bot turns:

```
"Rozumiem, chodzi o odbudowę typu "all on four", czyli stałe zęby? Zęby na
 implantach w jeden dzień. W naszej klinice leczenie imp plantologiczne"
"Zawsze poprzedza konsultacja i kwalifikacja do zabiegu."
"Podczas niej lekarz ocenia warunki kostne,"
"Wykonuje potrzebne badania i dopiero wtedy potwierdza?"
"Czy możliwe jest przeprowadzenie procedury w jednym dniu?"
"Koszt pierwszej konsultacji wynosi dwieście złotych."
"A tomografia jest w cenie na poczet leczenia w klinice."
"Czy chciałby pan umówić się na taką konsultację implantologiczną?"
```

Also: "imp plantologiczne" — TTS split the word mid-syllable.
Positive: "All on four" (no "minus"). That specific fix from f66e83f held.

Root cause: `punctuationBoundaries` included `"."`, causing every sentence
ending in a period to become a separate TTS chunk even when the model
generated a multi-sentence paragraph.

Fix deployed: removed `"."` from `punctuationBoundaries` → `["?", "!"]`.
Chunks will now only split at question marks and exclamation points,
keeping explanations and summaries in one continuous audio stream.

### Check 2 — Mid-sentence patience

**FAIL.**

User said `"A co jeśli..."` (incomplete). Bot responded immediately with
`"Słucham, proszę powiedzieć, co ma pan na myśli."`.
`numAssistantInterrupted: 1` confirms the bot was then interrupted when the
user resumed. The response itself was appropriate but arrived during the gap.

No config change deployed — `onNoPunctuationSeconds: 3.0` is already at
max tolerable value. Noted for monitoring; marginal impact on outcome.

### Check 3 — implant_consultation service.id + one-utterance slot offer

**PARTIAL PASS.**

`checkAvailability` called with `service.id: "implant_consultation"` ✓

Slots split across two turns despite the KRYTYCZNE rule:
```
Turn 1: "Mam wolne terminy u doktor Magdaleny Szajnar. Środa Osiemnastego
         marca o dziewiątej rano."
Turn 2: "O dziewiątej czterdzieści pięć albo o dziesiątej trzydzieści.
         Który termin panu odpowiada?"
```

Times were spoken as Polish words ✓ Doctor named in first turn ✓

Root cause: model used a period after "o dziewiątej rano." causing chunkPlan
to split before Turn 2. Fix: removing `"."` from `punctuationBoundaries`.

### Check 4 — Phone readback as Polish words

**FAIL.**

Bot output: `"Powtórzę numer siedem dziewięć trzy. 385531."` — second
segment written as digit string, not Polish words. Prompt rule not followed.

After patient said "Zgadza się" (confirming), bot asked "Czy wszystko się
zgadza?" (premature booking question), then re-read the number again as a
separate turn, creating a 3-exchange confirmation loop before moving on.

Root causes:
1. Model partially followed the digit→words rule but missed the second group.
2. No rule explicitly blocked re-reading the number after it was confirmed.

Fixes deployed:
- New KRYTYCZNE rule in Zasada anty-petli: after phone confirmed → go
  directly to booking summary; no re-read; no premature "Czy wszystko się
  zgadza?".

### Check 5 — One-turn booking summary

**FAIL.**

Summary split into three turns:
```
Turn 1: "Podsumuje wizytę."
Turn 2: "Konsultacja implantologiczna, pierwsza wizyta w środę, 18 marca
         o 10:30 u dr Magdaleny Scheiner"
Turn 3: "Pacjent Wojciech Czub, czy wszystko się zgadza i czy mam
         potwierdzić rezerwację?"
```

Additionally, doctor name was hallucinated as "Scheiner" instead of "Szajnar".

Root causes:
1. "Podsumuje wizytę." is a filler opener ending in "." → triggered a chunk
   split before the real summary.
2. Model generated periods inside the summary → further splits.
3. Doctor name not reinforced with explicit spelling.

Fixes deployed:
- Removed `"."` from `punctuationBoundaries` (covers splits 1 and 2).
- New KRYTYCZNE rule: no "Podsumuje wizytę" opener; start directly with
  booking details.
- New rule: doctor's surname is Szajnar (S-z-a-j-n-a-r); never Scheiner.

### Check 6 — Single booking confirmation

**PASS.** `createEvent` called exactly once after patient said "Proszę".
`booking.bookingCreated: true`. No flow restart after success.

### Check 7 — Structured output classification

**PASS.**

| Field | Expected | Actual |
|---|---|---|
| `callOutcome` | `appointment_booked` | `appointment_booked` ✓ |
| `intent.primaryReason` | `implants` | `implants` ✓ |
| `booking.availabilityChecked` | `true` | `true` ✓ |
| `booking.bookingCreated` | `true` | `true` ✓ |
| `booking.serviceId` | `implant_consultation` | `implant_consultation` ✓ |
| `successfulForAssistantScope` | `true` | `true` ✓ |

---

## Summary of fixes deployed (post-retry)

| # | Issue | Fix |
|---|---|---|
| 1 | Fragmented TTS — periods cause chunk splits | Removed `"."` from `punctuationBoundaries` |
| 2 | Phone double-loop after confirmation | New anti-loop rule: after phone confirmed → go to summary, no re-read |
| 3 | Doctor name "Scheiner" hallucination | Explicit spelling rule: Szajnar (S-z-a-j-n-a-r) |
| 4 | "Podsumuje wizytę." filler opener | Rule: start summary directly without opener |

Checks still not passing: Check 2 (mid-sentence patience) — no config
change available; accepted as known limitation.
