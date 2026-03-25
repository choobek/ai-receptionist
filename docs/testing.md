# Manual Test Plan

Automation lane boundaries live in [Testing Strategy](./testing-strategy.md). This file is the direct-tool and end-to-end smoke checklist.

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

## 3. Direct tool test: `lookupPatient`

```bash
curl -sS -X POST "$WEBHOOK_BASE/lookup-patient" \
  "${HEADER_ARGS[@]}" \
  --data '{
    "requestId": "test_lookup_001",
    "fullName": "Anna Kowalska",
    "phoneRaw": "500111001"
  }' | jq .
```

Expected:

- HTTP 200
- `found: true`
- `patient.patientId` present

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
    "notes": "Manual webhook test",
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
    "summary": "Pacjentka chce umowic kolejna wizyte.",
    "notes": "Preferuje kontakt rano.",
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
    "summary": "Pacjentka chce umowic kolejna wizyte.",
    "notes": "Preferuje kontakt rano.",
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
      "fullName": "Jan Testowy",
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
- `sms.body` present

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
              "booking": {
                "bookingCreated": true,
                "serviceName": "Pierwsza konsultacja"
              },
              "summary": {
                "shortSummaryPl": "Pacjent umowil pierwsza konsultacje."
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
- the calendar event description includes both the callback number and the live caller number when available
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

## 12. What to inspect if something fails

If tool calls fail:

- Vapi tool request logs
- n8n workflow executions
- VPS-side n8n and reverse proxy logs
- Google Calendar credential status in n8n

See [`operations-runbook.md`](./operations-runbook.md) section `Google Calendar Credential Recovery` for the standard repair path.

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
