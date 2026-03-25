# Real Call Evaluation: Scenario A

Source file: local Vapi export `calls-export-df0880e1-cc65-492c-8c20-f6878278c5ad-2026-03-15-16-03-23.json` (kept outside the repo)

Call ID: `019cf238-1827-7ffa-8f0a-870cd123d4c1`

Date: `2026-03-15`

## Outcome

The booking path succeeded technically:

- `checkAvailability` was called
- `createEvent` was called
- the event was created for `2026-03-17T09:30:00+01:00`

The weak spot was conversation control.

## What worked

- The assistant stayed on the first-consultation path.
- The tool layer normalized the patient phone to `+48793385531`.
- The booked slot matched one of the returned availability options.

## Problems observed

1. The caller front-loaded almost the whole booking, but the assistant still replayed the discovery script.
   The transcript shows the caller gave the reason for the call, relative date, morning preference, preferred hour, full name, phone number, and a direct confirmation cue. The assistant still asked for visit purpose, date window, slot choice, and patient details as if nothing had been provided yet.

2. The assistant asked again for data that was already present.
   Name and phone number were repeated even though they had already been spoken clearly earlier in the call.

3. The post-booking flow drifted back into scheduling.
   After a successful booking confirmation, the transcript shows another assistant line: `Oczywiście, chętnie pomogę. Na jaki dzień i porę dnia mam sprawdzić dostępne terminy na pierwszą konsultację?`

4. Spoken formatting still leaked raw numeric forms.
   The assistant said forms like `17 marca`, `8:45`, `9:30`, and `200 zł` instead of fully spoken Polish.

5. The final confirmation appears duplicated and cut off in the artifact transcript.
   The payload ends with another partial confirmation line: `Panie Wojciechu, potwierdzam. Pierwsza konsultacja została umówiona na wtorek 17 marca`

## Repo changes made after this review

- Tightened [`prompts/system-prompt.md`](../../../prompts/system-prompt.md) so the assistant must reuse front-loaded booking data instead of replaying the full flow.
- Added a stronger rule that explicit hours override broad preferences like `rano` when calling `checkAvailability`.
- Added a stop-condition after successful `createEvent` so the assistant does not restart scheduling unless the caller starts a new request.
- Added an explicit rule not to ask again for name or phone if they were already clearly provided earlier in the call.

## Regression checklist for the next real call

- If the caller gives multiple booking details in one burst, the assistant uses them instead of restarting the script.
- If the caller already gave full name and phone, the assistant does not ask again unless something is ambiguous.
- After `createEvent` succeeds, the assistant confirms the booking once and does not reopen the scheduling flow.
- Spoken dates, hours, phone numbers, and prices use natural Polish rather than raw digits.
