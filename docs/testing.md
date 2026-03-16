# Manual Test Plan

This checklist verifies the full flow against the permanent hosted n8n instance:

- `https://vps-2c8bbf65.vps.ovh.net`

If `AI_RECEPTIONIST_WEBHOOK_SECRET` is configured on the target instance, include one of these on every webhook request in this guide:

- `-H "X-AI-Receptionist-Secret: $AI_RECEPTIONIST_WEBHOOK_SECRET"`
- or the URL fallback `?secret=$AI_RECEPTIONIST_WEBHOOK_SECRET`

## 1. Verify the configured public URL

Confirm that your deployed n8n instance is reachable at the permanent public hostname:

```bash
curl -I https://vps-2c8bbf65.vps.ovh.net
```

You should get an HTTP response from the server. A 404 is acceptable here; connection failures are not.

## 2. Confirm the public endpoints used in Vapi

These are the URLs that should be configured in Vapi:

- `https://vps-2c8bbf65.vps.ovh.net/webhook/ai-receptionist/lookup-patient`
- `https://vps-2c8bbf65.vps.ovh.net/webhook/ai-receptionist/check-availability`
- `https://vps-2c8bbf65.vps.ovh.net/webhook/ai-receptionist/create-event`
- `https://vps-2c8bbf65.vps.ovh.net/webhook/ai-receptionist/search-knowledge-base`
- `https://vps-2c8bbf65.vps.ovh.net/webhook/ai-receptionist/create-reception-task`
- `https://vps-2c8bbf65.vps.ovh.net/webhook/ai-receptionist/vapi-call-ended`

Confirm them in:
- Vapi custom tool `lookupPatient`
- Vapi custom tool `checkAvailability`
- Vapi custom tool `createEvent`
- Vapi custom tool `searchKnowledgeBase`
- Vapi custom tool `createReceptionTask`
- any Vapi webhook/server configuration that sends `call.ended` events to n8n

Nothing in the Google Calendar credentials should need to change if the workflows are already connected correctly in n8n.

## 3. Verify the hosted instance is alive

## 4. Direct tool test: `lookupPatient`

Run a direct webhook test against n8n through the public URL:

```bash
curl -sS -X POST https://vps-2c8bbf65.vps.ovh.net/webhook/ai-receptionist/lookup-patient \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "test_lookup_001",
    "fullName": "Anna Kowalska",
    "phoneRaw": "500111001"
  }' | jq .
```

Expected:
- HTTP 200
- `found: true`
- `patient.patientId` present

## 5. Direct tool test: `searchKnowledgeBase`

Run a direct webhook test against n8n through the public URL:

```bash
curl -sS -X POST https://vps-2c8bbf65.vps.ovh.net/webhook/ai-receptionist/search-knowledge-base \
  -H "Content-Type: application/json" \
  -d '{
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

## 6. Direct tool test: `checkAvailability`

Run a direct webhook test against n8n through the public URL:

```bash
curl -sS -X POST https://vps-2c8bbf65.vps.ovh.net/webhook/ai-receptionist/check-availability \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "test_check_001",
    "service": {
      "id": "consultation",
      "name": "Konsultacja",
      "durationMinutes": 30
    },
    "requestedDate": "2026-03-16",
    "timePreference": "morning",
    "timezone": "Europe/Warsaw",
    "limit": 3,
    "patient": {
      "isExistingPatient": false
    }
  }' | jq .
```

Expected:
- HTTP 200
- `available` present
- `slots` array present
- `message` present

Multi-day first-available smoke test:

```bash
curl -sS -X POST https://vps-2c8bbf65.vps.ovh.net/webhook/ai-receptionist/check-availability \
  -H "Content-Type: application/json" \
  -d '{
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
- the request succeeds without `requestedDate`
- `normalizedRequest.searchDays` is present
- returned slots stay within clinic working hours

Failure indicators:
- connection error: hosting or DNS problem
- auth or HTML response: wrong target or n8n basic auth issue
- validation error: payload shape issue

## 7. Direct tool test: `createEvent`

Use one slot returned from `checkAvailability`.

```bash
curl -sS -X POST https://vps-2c8bbf65.vps.ovh.net/webhook/ai-receptionist/create-event \
  -H "Content-Type: application/json" \
  -d '{
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

## 8. Direct tool test: `createReceptionTask`

```bash
curl -sS -X POST https://vps-2c8bbf65.vps.ovh.net/webhook/ai-receptionist/create-reception-task \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "test_task_001",
    "taskType": "existing_patient_booking",
    "patient": {
      "fullName": "Anna Kowalska",
      "phoneE164": "+48500111001",
      "isExistingPatient": true
    },
    "summary": "Pacjentka chce umowic kolejna wizyte.",
    "notes": "Preferuje kontakt rano."
  }' | jq .
```

Expected:
- HTTP 200
- `accepted: true`
- `taskId` present

## 9. Structured output webhook router test

Test the n8n router directly with a synthetic `call.ended` payload:

```bash
curl -sS -X POST https://vps-2c8bbf65.vps.ovh.net/webhook/ai-receptionist/vapi-call-ended \
  -H "Content-Type: application/json" \
  -d '{
    "type": "call.ended",
    "call": {
      "id": "call_test_001",
      "artifact": {
        "structuredOutputs": {
          "6e7726fb-32da-42c6-a7f4-731c4e2d6a0d": {
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
- add `followUp.receptionFollowUpNeeded` set to `true`

Expected:
- HTTP 200
- `route: "needs_reception_follow_up"`

For a payload shape closer to Vapi Server URL events, you can also test with `message.type: "end-of-call-report"` and `message.artifact.structuredOutputs`.

## 10. End-to-end Vapi call test

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
- Vapi calls `createEvent`
- the event appears in Google Calendar
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
- router returns follow-up if the structured output says human review is needed

### Scenario D: general knowledge-base question

Say something like:
- "Czym rozni sie bonding od licowek?"

Verify:
- the assistant calls `searchKnowledgeBase`
- the answer stays within the ODT-derived source material
- the assistant does not invent unsupported pricing or medical advice

## 11. What to inspect if something fails

If tool calls fail:
- Vapi tool request logs
- n8n workflow executions
- VPS-side n8n and reverse proxy logs
- Google Calendar credential status in n8n

If the assistant speaks but no booking happens:
- verify the Vapi tool URLs use `https://vps-2c8bbf65.vps.ovh.net`
- verify the schema names in Vapi still match `lookupPatient`, `checkAvailability`, `searchKnowledgeBase`, `createEvent`, and `createReceptionTask`
- verify the system prompt is the current file from this repo

If structured output exists but router does not classify it:
- verify `VAPI_STRUCTURED_OUTPUT_ID` matches the current output ID
- verify the Vapi event actually includes `call.artifact.structuredOutputs`
- inspect the raw event in n8n execution data

## 12. Minimal acceptance criteria

Consider the setup healthy when all of these are true:
- public `lookupPatient` works through the hosted URL
- public `searchKnowledgeBase` works through the hosted URL
- public `checkAvailability` works through the hosted URL
- public `createEvent` works through the hosted URL
- public `createReceptionTask` works through the hosted URL
- a real Vapi call creates a Google Calendar event
- the call produces structured output
- the `call.ended` n8n router returns the expected route
