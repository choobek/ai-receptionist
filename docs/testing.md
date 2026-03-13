# Manual Test Plan

This checklist verifies the full flow after reconnecting a Cloudflare tunnel.

## 1. Update n8n to the new public URL

If your tunnel domain changed, update n8n:

```bash
./scripts/update-n8n-public-url.sh https://YOUR-NEW-TUNNEL.trycloudflare.com
cd n8n
docker-compose up -d
```

This updates:
- `WEBHOOK_URL` in `n8n/.env`
- `N8N_EDITOR_BASE_URL` in `n8n/.env`

## 2. Update external URLs that depend on the tunnel

When the tunnel URL changes, these public endpoints change too:

- `https://YOUR-NEW-TUNNEL/webhook/ai-receptionist/lookup-patient`
- `https://YOUR-NEW-TUNNEL/webhook/ai-receptionist/check-availability`
- `https://YOUR-NEW-TUNNEL/webhook/ai-receptionist/create-event`
- `https://YOUR-NEW-TUNNEL/webhook/ai-receptionist/search-knowledge-base`
- `https://YOUR-NEW-TUNNEL/webhook/ai-receptionist/create-reception-task`
- `https://YOUR-NEW-TUNNEL/webhook/ai-receptionist/vapi-call-ended`

Update them in:
- Vapi custom tool `lookupPatient`
- Vapi custom tool `checkAvailability`
- Vapi custom tool `createEvent`
- Vapi custom tool `searchKnowledgeBase`
- Vapi custom tool `createReceptionTask`
- any Vapi webhook/server configuration that sends `call.ended` events to n8n

Nothing in the Google Calendar credentials needs to change because the tunnel only affects the public HTTP ingress.

## 3. Verify the tunnel is alive

Quick smoke check:

```bash
curl -I https://YOUR-NEW-TUNNEL.trycloudflare.com
```

You should get an HTTP response from the tunnel. A 404 is acceptable here; connection failures are not.

## 4. Direct tool test: `lookupPatient`

Run a direct webhook test against n8n through the public URL:

```bash
curl -sS -X POST https://YOUR-NEW-TUNNEL.trycloudflare.com/webhook/ai-receptionist/lookup-patient \
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
curl -sS -X POST https://YOUR-NEW-TUNNEL.trycloudflare.com/webhook/ai-receptionist/search-knowledge-base \
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
curl -sS -X POST https://YOUR-NEW-TUNNEL.trycloudflare.com/webhook/ai-receptionist/check-availability \
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

Failure indicators:
- Cloudflare or connection error: tunnel problem
- auth or HTML response: wrong target or n8n basic auth issue
- validation error: payload shape issue

## 7. Direct tool test: `createEvent`

Use one slot returned from `checkAvailability`.

```bash
curl -sS -X POST https://YOUR-NEW-TUNNEL.trycloudflare.com/webhook/ai-receptionist/create-event \
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
curl -sS -X POST https://YOUR-NEW-TUNNEL.trycloudflare.com/webhook/ai-receptionist/create-reception-task \
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
curl -sS -X POST https://YOUR-NEW-TUNNEL.trycloudflare.com/webhook/ai-receptionist/vapi-call-ended \
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
- use your real tunnel URL instead of `YOUR-NEW-TUNNEL`
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
- the call ends without `createEvent`
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
- Cloudflare tunnel process output
- Google Calendar credential status in n8n

If the assistant speaks but no booking happens:
- verify the Vapi tool URLs use the new tunnel base
- verify the schema names in Vapi still match `lookupPatient`, `checkAvailability`, `searchKnowledgeBase`, `createEvent`, and `createReceptionTask`
- verify the system prompt is the current file from this repo

If structured output exists but router does not classify it:
- verify `VAPI_STRUCTURED_OUTPUT_ID` matches the current output ID
- verify the Vapi event actually includes `call.artifact.structuredOutputs`
- inspect the raw event in n8n execution data

## 12. Minimal acceptance criteria

Consider the setup healthy when all of these are true:
- public `lookupPatient` works through the tunnel
- public `searchKnowledgeBase` works through the tunnel
- public `checkAvailability` works through the tunnel
- public `createEvent` works through the tunnel
- public `createReceptionTask` works through the tunnel
- a real Vapi call creates a Google Calendar event
- the call produces structured output
- the `call.ended` n8n router returns the expected route
