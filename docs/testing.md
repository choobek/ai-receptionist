# Manual Verification Plan

Automation lane boundaries live in [Testing Strategy](./testing-strategy.md). This file covers direct-tool checks, core end-to-end smoke, and a broader manual edge-case sweep for behaviors that still need human review.

## How to use this plan

Run the automated gate first:

- `node scripts/check-workflow-regressions.js`
- `./scripts/run-staging-regression-suite.sh`

Then use this file in layers:

- sections `1` through `10` verify the hosted endpoints and direct tool contracts
- section `11` is the baseline live-call smoke pass
- sections `10a`, `11a`, and `11b` are the broader manual edge-case sweep for release candidates, prompt/config changes, voice-quality checks, and post-incident validation

## Evidence and cleanup

For any scenario that writes data or exercises live telephony, capture:

- environment name, date, and the assistant binding you tested
- Vapi transcript or call export with tool calls and structured output
- n8n execution IDs for `createEvent`, `createReceptionTask`, and SMS tools
- Google Calendar event IDs for booking tests
- the final `vapi-call-ended` route when the structured-output router is involved

Use clearly synthetic names such as `TEST Manual <scenario>` and only use a real test recipient phone when you intentionally want SMS delivery to leave the system.

After each write-path test:

- delete created calendar events
- record any created reception task IDs so they remain recognizable as test artifacts
- restore the prior SMS provider mode if you changed it for a probe

## Setup

Run against one environment at a time. Source root `.env` first if you want to reuse the repo values:

```bash
set -a
source .env
set +a
```

Then set the target you want to probe:

```bash
export TARGET_BASE_URL="${STAGING_N8N_PUBLIC_BASE_URL}"
# or:
# export TARGET_BASE_URL="${PRODUCTION_N8N_PUBLIC_BASE_URL}"

export WEBHOOK_BASE="$TARGET_BASE_URL/webhook/ai-receptionist"
export WEBHOOK_SECRET="${STAGING_AI_RECEPTIONIST_WEBHOOK_SECRET:-}"
# or:
# export WEBHOOK_SECRET="${PRODUCTION_AI_RECEPTIONIST_WEBHOOK_SECRET:-}"

export FUTURE_CLINIC_DAY="2030-03-18"

HEADER_ARGS=(-H "Content-Type: application/json")
if [ -n "${WEBHOOK_SECRET:-}" ]; then
  HEADER_ARGS+=(-H "X-AI-Receptionist-Secret: $WEBHOOK_SECRET")
fi
```

If the target does not require a webhook secret, leave `WEBHOOK_SECRET` empty.

If you also want to verify the Google connection page for the same target, prepare the calendar connect URL separately:

```bash
./scripts/print-calendar-connect-url.sh staging clinic-default
# or:
./scripts/print-calendar-connect-url.sh production clinic-default
```

## 1. Verify the configured public URL

```bash
curl -I "$TARGET_BASE_URL"
```

You should get an HTTP response from the server. A `404` is acceptable here; connection failures are not.

## 2. Confirm the public endpoints used in Vapi

These are the URLs that should be configured in Vapi for the selected target:

- `$WEBHOOK_BASE/lookup-patient`
- `$WEBHOOK_BASE/check-availability`
- `$WEBHOOK_BASE/create-event`
- `$WEBHOOK_BASE/search-knowledge-base`
- `$WEBHOOK_BASE/create-reception-task`
- `$WEBHOOK_BASE/send-sms-to-receptionists`
- `$WEBHOOK_BASE/send-sms-to-patient`
- `$WEBHOOK_BASE/vapi-call-ended`

Confirm them in:

- Vapi custom tool `lookupPatient`
- Vapi custom tool `checkAvailability`
- Vapi custom tool `createEvent`
- Vapi custom tool `searchKnowledgeBase`
- Vapi custom tool `createReceptionTask`
- optional Vapi custom tool `sendSmsToReceptionists`
- optional direct/manual webhook `sendSmsToPatient` for SMS-provider probes
- any Vapi webhook or server URL that sends `call.ended` events to n8n

## 2a. Verify the public Google connection page

Open the `/calendar/connect` URL generated above in a browser.

Expected:

- the page renders on the same host as the webhooks
- it is not blocked by the n8n editor login
- it clearly shows whether the calendar is connected, disconnected, or needs reconnection

## 3. Direct tool test: `lookupPatient`

```bash
curl -sS -X POST "$WEBHOOK_BASE/lookup-patient" \
  "${HEADER_ARGS[@]}" \
  --data '{
    "requestId": "test_lookup_001",
    "phoneRaw": "500111001"
  }' | jq .
```

Expected:

- HTTP 200
- `phone.normalizedE164` present
- `phone.readbackPrompt` present
- the readback text contains spoken words, not digits

## 4. Direct tool test: `searchKnowledgeBase`

```bash
curl -sS -X POST "$WEBHOOK_BASE/search-knowledge-base" \
  "${HEADER_ARGS[@]}" \
  --data '{
    "requestId": "test_kb_001",
    "query": "Czym rozni sie bonding od licowek?",
    "limit": 2,
    "language": "pl"
  }' | jq .
```

Expected:

- HTTP 200
- `found: true`
- `answer` present
- `matches[0].sourceDocument` present

## 5. Direct tool test: `checkAvailability`

Specific-day probe:

```bash
curl -sS -X POST "$WEBHOOK_BASE/check-availability" \
  "${HEADER_ARGS[@]}" \
  --data '{
    "requestId": "test_check_001",
    "service": {
      "id": "consultation",
      "name": "Konsultacja",
      "durationMinutes": 30
    },
    "requestedDate": "'"$FUTURE_CLINIC_DAY"'",
    "timePreference": "morning",
    "timezone": "Europe/Warsaw",
    "limit": 3,
    "patient": {
      "isExistingPatient": false
    }
  }' | jq .
```

Multi-day first-available probe:

```bash
curl -sS -X POST "$WEBHOOK_BASE/check-availability" \
  "${HEADER_ARGS[@]}" \
  --data '{
    "requestId": "test_check_002",
    "service": {
      "id": "consultation",
      "name": "Konsultacja",
      "durationMinutes": 30
    },
    "timePreference": "first_available",
    "timezone": "Europe/Warsaw",
    "limit": 3,
    "searchDays": 5,
    "patient": {
      "isExistingPatient": false
    }
  }' | jq .
```

Expected:

- the request succeeds
- `available` present
- `slots` array present
- `message` present
- the first-available probe succeeds without `requestedDate`
- returned slots stay within clinic working hours

Failure indicators:

- connection error: hosting, DNS, or TLS problem
- auth or HTML response: wrong target or n8n auth issue
- validation error: payload shape issue

## 6. Direct tool test: `createEvent`

Use one slot returned from `checkAvailability`.

```bash
curl -sS -X POST "$WEBHOOK_BASE/create-event" \
  "${HEADER_ARGS[@]}" \
  --data '{
    "requestId": "test_create_001",
    "service": {
      "id": "consultation",
      "name": "Konsultacja",
      "durationMinutes": 30
    },
    "slotStart": "REPLACE_WITH_SLOT_START",
    "slotEnd": "REPLACE_WITH_SLOT_END",
    "timezone": "Europe/Warsaw",
    "patient": {
      "fullName": "Jan Testowy",
      "phoneE164": "+48500100200",
      "isExistingPatient": false
    },
    "source": "manual"
  }' | jq .
```

Expected:

- HTTP 200
- `created: true`
- `appointment.start` and `appointment.end` present

After the test:

- confirm the event exists in Google Calendar
- delete the test event manually so later tests stay clean

## 7. Direct tool test: `createReceptionTask`

```bash
curl -sS -X POST "$WEBHOOK_BASE/create-reception-task" \
  "${HEADER_ARGS[@]}" \
  --data '{
    "requestId": "test_task_001",
    "taskType": "existing_patient_booking",
    "patient": {
      "fullName": "Anna Kowalska",
      "phoneE164": "+48500111001",
      "isExistingPatient": true
    },
    "serviceBucket": "hygiene",
    "preferredCallbackWindow": "morning",
    "telephony": {
      "callerPhoneE164": "+48500111001",
      "callerPhoneSource": "customer.number"
    }
  }' | jq .
```

Expected:

- HTTP 200
- `accepted: true`
- `taskId` present
- `task.phoneContext.callerPhoneE164` present when telephony metadata was provided

## 8. Direct tool test: `sendSmsToReceptionists`

For a safe first pass, keep `AI_RECEPTIONIST_SMS_PROVIDER=mock` in the target environment.

```bash
curl -sS -X POST "$WEBHOOK_BASE/send-sms-to-receptionists" \
  "${HEADER_ARGS[@]}" \
  --data '{
    "requestId": "test_sms_reception_001",
    "taskId": "task_20260320_001",
    "taskType": "existing_patient_booking",
    "patient": {
      "fullName": "Anna Kowalska",
      "phoneE164": "+48500111001",
      "isExistingPatient": true
    },
    "serviceBucket": "hygiene",
    "preferredCallbackWindow": "morning",
    "telephony": {
      "callerPhoneE164": "+48500111001",
      "callerPhoneSource": "customer.number"
    }
  }' | jq .
```

Expected:

- HTTP 200
- `accepted: true`
- `delivery.status: "simulated"` in `mock` mode
- `notification.body` present
- `notification.body` contains both the declared number and the caller number
- `notification.body` does not contain a free-text summary or notes
- `phoneContext.callerPhoneE164` present when telephony metadata was provided

## 8a. Required real-call validation before production rollout

Run these on staging first, then repeat on production only after staging behavior is stable:

1. Call from a real handset and keep the callback number identical to the calling number.
2. Confirm the assistant asks to use the number the caller is calling from instead of forcing a full digit-by-digit readback.
3. Confirm the booking or handoff flow continues normally after a simple yes/no confirmation.
4. For a receptionist-handoff case, verify the internal SMS contains both the declared callback number and the telephony caller number.
5. Repeat with a caller who explicitly asks to use a different callback number and verify the receptionist SMS shows both numbers as different.

## 9. Direct tool test: `sendSmsToPatient`

For a safe first pass, keep `AI_RECEPTIONIST_SMS_PROVIDER=mock` in the target environment. This endpoint remains useful for direct SMS-provider probes even though the normal assistant booking flow now sends the patient SMS inside `createEvent`.

```bash
curl -sS -X POST "$WEBHOOK_BASE/send-sms-to-patient" \
  "${HEADER_ARGS[@]}" \
  --data '{
    "requestId": "test_sms_patient_001",
    "calendarEventId": "evt_test_001",
    "consentConfirmed": true,
    "language": "pl",
    "patient": {
      "phoneE164": "+48500100200"
    },
    "appointment": {
      "start": "2030-03-18T10:30:00+01:00",
      "timezone": "Europe/Warsaw",
      "service": {
        "id": "consultation",
        "name": "Konsultacja"
      }
    }
  }' | jq .
```

Expected:

- HTTP 200
- `accepted: true`
- `delivery.status: "simulated"` in `mock` mode
- `recipientClass: "declared_phone"` when no live caller metadata is present
- `sms.kind` and `sms.language` present
- response does not echo phone numbers or the SMS body text

If `AI_RECEPTIONIST_SMS_PROVIDER=twilio` is enabled instead, expect `delivery.status` to move to `queued` or `sent`. Set `TWILIO_PHONE_NUMBER` explicitly; the workflows no longer rely on Twilio number auto-discovery.

If `AI_RECEPTIONIST_SMS_PROVIDER=webhook` is enabled instead, expect `delivery.status` to move to `queued` or `sent` and verify the downstream gateway receives the posted payload.

## 9a. Automated staging SMS delivery suite

```bash
./scripts/run-staging-sms-delivery-suite.sh --provider mock
./scripts/run-staging-sms-delivery-suite.sh --provider twilio --patient-phone-e164 +48500100200
./scripts/run-staging-sms-delivery-suite.sh --provider webhook --patient-phone-e164 +48500100200
```

Notes:

- the helper is staging-only
- by default it restores the staging stack to the provider configured in the remote root `.env` after the run
- use `--keep-provider` only if you intentionally want staging to stay in the selected mode
- in `twilio` or `webhook` mode the patient phone must be a real test recipient

## 10. Structured output webhook router test

If `VAPI_STRUCTURED_OUTPUT_ID` is set in the target environment, replace the sample structured-output key below with that value before running the probe.

```bash
curl -sS -X POST "$WEBHOOK_BASE/vapi-call-ended" \
  "${HEADER_ARGS[@]}" \
  --data '{
    "type": "call.ended",
    "call": {
      "id": "call_test_001",
      "artifact": {
        "structuredOutputs": {
          "REPLACE_WITH_STRUCTURED_OUTPUT_ID_OR_KEEP_SAMPLE_KEY": {
            "name": "Dental Call Intake",
            "result": {
              "callOutcome": "appointment_booked",
              "successfulForAssistantScope": true,
              "language": "pl",
              "caseCategory": "new_patient_first_visit",
              "serviceBucket": "consultation",
              "booking": {
                "bookingCreated": true,
                "serviceId": "consultation"
              }
            }
          }
        }
      }
    }
  }' | jq .
```

Expected:

- HTTP 200
- `route: "booked"`

Then test a follow-up case by changing:

- `callOutcome` to `needs_reception_follow_up`
- `booking.bookingCreated` to `false`
- `followUp.receptionFollowUpNeeded` to `true`

Expected:

- HTTP 200
- `route: "needs_reception_follow_up"`

## 10a. Negative direct-tool probes

Run at least these before production rollouts or after auth, schema, or calendar changes:

- auth rejection: repeat one direct webhook request without the secret header when `WEBHOOK_SECRET` is configured. Expect the request to be rejected cleanly, not accepted silently and not redirected to editor HTML
- knowledge-base no-match: ask a clearly unsupported or diagnostic-only question. Expect a no-match or safe fallback response, not invented pricing, diagnosis, or treatment advice
- stale-slot booking: try to create the same slot twice, or occupy the slot manually in Google Calendar before the second `create-event` call. Expect the second attempt to fail cleanly and only one real event to exist
- handoff validation: send `create-reception-task` without `patient.fullName` or without a phone. Expect a structured validation failure and no accepted task
- phone normalization repair: send `lookup-patient` with a partial or messy number, then with the corrected value. Expect the corrected request to normalize cleanly and the readback text to stay speech-safe

## 11. End-to-end Vapi call test

After direct webhook tests pass, test the assistant in Vapi with a real call.

### Scenario A: successful booking

Say something like:

- "Chce umowic pierwsza konsultacje w przyszlym tygodniu rano."

Verify:

- the assistant speaks normally
- the assistant resolves the relative date once and does not backtrack to a different day
- the assistant avoids raw numeric speech and cut-off filler fragments
- Vapi calls `checkAvailability`
- the assistant offers 2-3 real slots
- after you choose one, it collects name and phone
- if the caller confirms using the live caller number, later tools reuse that confirmed number instead of a placeholder
- Vapi calls `createEvent`
- the event appears in Google Calendar
- the calendar event description includes patient full name plus both the callback number and the live caller number when available
- the calendar event description does not include notes, email, or booking-SMS targeting metadata
- the call produces the structured output

### Scenario B: no booking, receptionist follow-up

Say something like:

- "Chce przelozyc istniejaca wizyte."

Verify:

- the assistant does not claim it can reschedule directly
- if the caller already gives name and phone, the assistant does not ask for them again without reason
- the assistant only says the request was saved after `createReceptionTask` succeeds
- the call ends without `createEvent`
- Vapi calls `createReceptionTask`
- the assistant does not ask for a swobodny opis sprawy or generate its own summary note
- structured output indicates follow-up is needed
- `call.ended` router returns `needs_reception_follow_up`

### Scenario C: urgent symptoms

Say something like:

- "Mam silny bol i opuchlizne, potrzebuje szybkiego terminu."

Verify:

- the assistant stays within non-medical scope
- it tries to find a fast consultation path
- structured output flags urgent symptoms
- the router returns follow-up if the structured output says human review is needed

### Scenario D: general knowledge-base question

Say something like:

- "Czym rozni sie bonding od licowek?"

Verify:

- the assistant calls `searchKnowledgeBase`
- the answer stays within the curated source material
- the assistant does not invent unsupported pricing or medical advice

## 11a. Extended end-to-end edge-case scenarios

Run these on staging for release candidates, prompt/config changes, or after any live-call regression. Keep the call export and tool traces for each scenario.

### E1. First-visit gate only once

Say:

- "Chcialabym umowic sie na najblizszy wolny termin."
- after the assistant asks whether this is the first visit: "Tak, to moja pierwsza wizyta."

Verify:

- the first assistant turn only resolves the first-visit split
- it does not also ask for the day, hour, problem, or service
- the next turn immediately calls `checkAvailability`
- the lookup uses `service.id: consultation` and `timePreference: first_available`
- the assistant does not ask for name or phone before any slot is chosen

### E2. First visit plus explicit date and evening stays bounded

Say:

- "Chcialabym umowic sie na najblizszy wolny termin."
- after the first-visit gate: "Tak, to moja pierwsza wizyta. Prosze sprawdzic 9 kwietnia 2027 wieczorem."

Verify:

- the second turn goes straight to `checkAvailability`
- the lookup keeps the explicit `requestedDate`
- the lookup uses `timePreference: evening`
- the lookup stays bounded with `searchDays: 1`
- the assistant does not widen the request back to a broad nearest-slot search

### E3. Alternative-day ambiguity waits for clarification

Say:

- "Chcialbym umowic pierwsza konsultacje, to moja pierwsza wizyta, najlepiej we wtorek albo srode po lunchu."
- "To srode po poludniu."

Verify:

- the assistant clarifies the day instead of spending an avoidable first lookup on the ambiguous request
- once the caller picks Wednesday, it performs one fresh `checkAvailability`
- the clarified lookup keeps the afternoon window
- no `createEvent` happens in this clarification-only path

### E4. Corrected day triggers a refreshed second availability lookup

Say:

- "Chcialbym umowic pierwsza konsultacje, to moja pierwsza wizyta, najlepiej w najblizszy wtorek po lunchu."
- after the assistant replies with Tuesday availability or begins acting on Tuesday: "Jednak nie, prosze sprawdzic najblizsza srode po poludniu."

Verify:

- the assistant performs a second `checkAvailability`
- the second lookup changes `requestedDate` instead of reusing the Tuesday result
- the corrected lookup keeps the afternoon window
- no booking is created before the caller chooses a concrete slot

### E5. Follow-up on an offered day keeps that date

Say:

- "Chcialbym umowic pierwsza konsultacje. To moja pierwsza wizyta. Jakie sa najblizsze wolne terminy w ciagu najblizszego miesiaca?"
- after the assistant offers slots: "A czy pierwszy z tych terminow, tego samego dnia, o dwudziestej tez jest wolne?"

Verify:

- the second turn performs a fresh `checkAvailability`
- the follow-up lookup uses `timePreference: specific_time`
- the lookup passes `requestedTime: 20:00`
- the lookup keeps the `requestedDate` from the first offered slot and sets `searchDays: 1`
- the assistant does not turn this into a time-only search across multiple days

### E6. Working-hours boundaries

Say:

- "Chcialabym umowic pierwsza konsultacje. To moja pierwsza wizyta. Obojetnie jaki dzien, byle po godzinie osiemnastej."
- repeat with: "Czy macie cos w sobote?" or "Czy macie cos po dwudziestej pierwszej?"

Verify:

- the after-hours request triggers `checkAvailability` with `timePreference: evening`
- the spoken answer contains no raw digits
- weekend or out-of-hours requests do not produce invented slots
- the assistant states the clinic works Monday through Friday from `09:00` to `21:00` Europe/Warsaw and offers valid alternatives

### E7. Existing-patient booking handoff does not enter scheduling

Say:

- "Dzien dobry, chce umowic kolejna wizyte na higienizacje. To nie jest moja pierwsza wizyta, bylem juz u was. Mam na imie TEST Manual Existing Patient, moj numer to siedem zero dwa, zero zero trzy, zero zero dziewiec."

Verify:

- the assistant does not call `checkAvailability` or `createEvent`
- it can create `createReceptionTask` immediately once the identity data is complete
- `taskType` stays `existing_patient_booking`
- the payload contains no free-text `summary` or `notes`
- if `sendSmsToReceptionists` is bound in that environment, it is called only after `createReceptionTask` succeeds and reuses the returned `taskId`

### E8. Post-handoff meta question does not reopen the flow

Say:

- start with the existing-patient or reschedule handoff path and provide complete identity details
- after the task is accepted: "Dobrze. A skad pan ma moj numer? Prosze juz tylko przekazac sprawe do recepcji."

Verify:

- the assistant answers the caller-number question briefly and directly
- it does not create a second `createReceptionTask`
- it does not send a second internal receptionist SMS
- it does not drift back into scheduling or new intake questions

### E9. First visit for another specialist becomes a reception handoff

Say:

- "Chcialbym umowic pierwsza wizyte do ortodonty. Mam na imie TEST Manual Specialist, moj numer to siedem zero dwa, zero zero trzy, zero zero osiem."

Verify:

- the assistant does not call `checkAvailability` or `createEvent`
- it routes through `createReceptionTask`
- `taskType` stays `general_follow_up`
- the payload contains no free-text `summary` or `notes`
- the patient-facing response only promises a reception follow-up after the handoff succeeds

### E10. Urgent symptoms trigger urgent first-available lookup without diagnosis

Say:

- "Bardzo boli mnie zab i mam opuchlizne. Jaki jest najszybszy mozliwy termin? Musze tylko sprawdzic opcje."

Verify:

- the assistant immediately calls `checkAvailability`
- the lookup uses `service.id: urgent_consultation`
- the lookup uses `timePreference: first_available`
- the assistant avoids diagnosis or treatment advice
- if the caller only asked to inspect options, the flow stops short of `createEvent`

### E11. Contact-number capture behaves correctly

Run both variants:

- real caller-number exposed: use a real handset and reach a booking or handoff branch that needs a callback number
- caller-number hidden or overridden: use a web call or explicitly say "Prosze uzyc innego numeru do kontaktu"

Verify:

- when a live caller number is exposed, the assistant asks whether to use that number as the contact number instead of forcing full digit capture
- when the contact number is still unresolved, the assistant does not replace that question with a generic "Czy wszystko sie zgadza?"
- when the caller gives a different number or corrects a wrong one, later tools reuse the corrected number
- the assistant does not ask for the contact number again once it has been explicitly confirmed

### E12. Language, respectful form, and speech hygiene

Run these variants:

- masculine reveal: "Chcialbym umowic sie na pierwsza wizyte."
- feminine reveal: "Chcialabym umowic sie na pierwsza wizyte."
- English start: "Hello, I'd like to book a first consultation."

Verify:

- after `chcialbym`, the next direct question uses natural masculine respectful wording such as `pan`, `pana`, or `panu`
- after `chcialabym`, the next direct question uses `pani`
- English stays in English, Polish stays in Polish, unless the caller explicitly switches
- the assistant avoids fillers, raw digits, clipped fragments, and wording such as `salon`

### E13. Knowledge-base answer versus advice boundary

Run both variants:

- supported question: "Ile kosztuje higienizacja?" or "Czym rozni sie bonding od licowek?"
- unsupported medical or diagnostic question: "Czy ten bol oznacza, ze potrzebuje leczenia kanalowego?"

Verify:

- supported questions call `searchKnowledgeBase`
- the answer stays inside the curated repo-backed content
- unsupported medical questions do not produce diagnosis or treatment recommendations
- when the KB does not support the answer, the assistant says so clearly and offers the next safe step such as booking or reception follow-up

### E14. Booking artifact audit after success

Run one successful booking with a clearly synthetic patient name and, if possible, a real exposed caller number.

Verify:

- `createEvent` is called exactly once and only after the final booking confirmation
- the created Google Calendar event contains the patient full name
- the event description includes both the declared callback number and the live caller number when both are available
- the event description does not contain free-text notes, email, or booking-SMS targeting metadata
- the booking path produces structured output with the expected booking outcome
- the `vapi-call-ended` router returns the expected route for the final structured output

## 11b. Cross-scenario transcript and artifact checks

Apply these checks to every live-call scenario above:

- no repeated question in the same form when the caller already answered
- partial answers are handled by confirming what was understood and asking only for the missing piece
- if the caller says "juz to podalem" or corrects a number, the assistant reuses the collected data instead of restarting the flow
- when a tool result includes a ready-made `message`, the next assistant utterance uses that `message`
- no raw digits appear in speech-facing text for dates, times, or phone readback
- no promise of booking, callback, or reception takeover is made before the relevant tool succeeds
- when the caller changes the day, date, or hour, the next lookup refreshes availability instead of reusing stale slots
- if the caller chooses the first, second, or third offered slot, `createEvent` reuses the exact `slotStart` and `slotEnd` from the chosen option
- the transcript does not drift into unsupported medical advice, invented pricing, or invented staff names
- structured output matches the real outcome, including booking versus follow-up routing, `successfulForAssistantScope`, and any urgent or callback-related flags

## 12. What to inspect if something fails

If tool calls fail:

- Vapi tool request logs
- n8n workflow executions
- calendar-gateway logs and `/calendar/status` page output
- VPS-side n8n and reverse proxy logs
- Google Calendar connection status in the calendar gateway

See [`operations-runbook.md`](./operations-runbook.md) section `Google Calendar Connected-Account Recovery` for the standard repair path.

If the assistant speaks but no booking happens:

- verify the Vapi tool URLs use `$WEBHOOK_BASE`
- verify the schema names in Vapi still match `lookupPatient`, `checkAvailability`, `searchKnowledgeBase`, `createEvent`, and `createReceptionTask`
- if SMS is enabled in that environment, also verify `sendSmsToReceptionists` and the embedded booking-SMS result returned by `createEvent`
- verify the system prompt is the current file from this repo

If structured output exists but the router does not classify it:

- verify `VAPI_STRUCTURED_OUTPUT_ID` matches the current output ID
- verify the Vapi event actually includes `call.artifact.structuredOutputs`
- inspect the raw event in n8n execution data

## 13. Minimal acceptance criteria

Consider the setup healthy when all of these are true:

- public `lookupPatient` works through the hosted URL
- public `searchKnowledgeBase` works through the hosted URL
- public `checkAvailability` works through the hosted URL
- public `createEvent` works through the hosted URL
- public `createReceptionTask` works through the hosted URL
- public `sendSmsToReceptionists` works through the hosted URL
- public `sendSmsToPatient` direct webhook works through the hosted URL
- a real Vapi call creates a Google Calendar event
- the call produces structured output
- the `call.ended` n8n router returns the expected route
