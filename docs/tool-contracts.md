# Tool Contracts

## Purpose

This project exposes five core Vapi custom tools backed by n8n webhooks, plus two optional SMS tools:

- `lookupPatient`
- `checkAvailability`
- `searchKnowledgeBase`
- `createEvent`
- `createReceptionTask`
- `sendSmsToReceptionists`
- `sendSmsToPatient`

The JSON schemas in [`schemas/`](../schemas) describe the tool arguments and result objects.

## Transport model

### Webhook authentication

If `AI_RECEPTIONIST_WEBHOOK_SECRET` is set in the runtime environment, every public webhook in this repo requires the same secret on inbound requests.

Supported transport options:

- preferred: `X-AI-Receptionist-Secret` header
- supported fallback: `Authorization: Bearer <secret>`
- last-resort fallback when the caller UI cannot set headers: `?secret=<value>` query parameter

### What Vapi sends

In production, Vapi sends a custom-tool webhook request that includes a `toolCallId` plus the function arguments for the tool call.

For local testing, the workflows also accept the schema payload directly as the HTTP body.

### SMS delivery modes

The SMS workflows support three runtime modes:

- default `mock` mode via `AI_RECEPTIONIST_SMS_PROVIDER=mock`
- native `twilio` mode via `AI_RECEPTIONIST_SMS_PROVIDER=twilio` plus `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`
- optional `webhook` mode via `AI_RECEPTIONIST_SMS_PROVIDER=webhook` plus `AI_RECEPTIONIST_SMS_WEBHOOK_URL`

In `mock` mode the workflows return `delivery.status: simulated` so end-to-end testing can cover the SMS step safely before a real provider is chosen.

In `twilio` mode the workflows send through Twilio's Messages API. `TWILIO_PHONE_NUMBER` is recommended as the explicit sender number. If it is omitted and the Twilio account has exactly one incoming number, the workflows auto-discover that number and use it as the sender.

## Response model

n8n should respond with a Vapi-compatible wrapper:

```json
{
  "results": [
    {
      "toolCallId": "call_123",
      "result": {
        "message": "Najblizsze terminy sa gotowe.",
        "available": true,
        "slots": []
      }
    }
  ]
}
```

If the request is sent directly without the Vapi envelope, the workflows return the raw `result` object instead.

## Tool: `lookupPatient`

### Intent

Identify whether the caller already exists in the proof-of-concept patient registry before a real CRM integration exists.

### Input shape

Defined in [`schemas/lookupPatient.request.json`](../schemas/lookupPatient.request.json).

Key fields:

- `fullName`
- `phoneE164` or `phoneRaw`

### Workflow behavior

1. Parse Vapi wrapper or direct body.
2. Validate that at least one identifier is present.
3. Normalize phone and name values.
4. Search the proof-of-concept registry by phone first, then by full name.
5. Return a compact patient match result.

### Success response

Defined in [`schemas/lookupPatient.response.json`](../schemas/lookupPatient.response.json).

Important fields:

- `found`
- `matchedBy`
- `patient`
- `message`

## Tool: `checkAvailability`

### Intent

Find a few valid appointment slots for a requested service and date/time preference.

### Input shape

Defined in [`schemas/checkAvailability.request.json`](../schemas/checkAvailability.request.json).

Key fields:

- `service.id`
- `requestedDate` in `YYYY-MM-DD` for date-specific searches, optional for `first_available`
- `requestedTime` in `HH:MM` or `timePreference`
- `timezone`
- optional `searchDays` for multi-day `first_available` lookup
- optional `limit`

### Workflow behavior

1. Parse Vapi wrapper or direct body.
2. Validate required fields.
3. Reject malformed dates, times, and timezones with a validation error.
4. Normalize service duration and search window.
5. For `first_available`, start from the requested date or from today in the clinic timezone if the date was omitted.
6. Search across one or more working days while skipping overnight hours and past slots on the current day.
7. Read busy events from Google Calendar.
8. Build up to `limit` valid slots.
9. Return a short structured response.

### Success response

Defined in [`schemas/checkAvailability.response.json`](../schemas/checkAvailability.response.json).

Important fields:

- `available`
- `slots`
- `normalizedRequest`
- `message`

## Tool: `searchKnowledgeBase`

### Intent

Answer supported general clinic questions from the local proof-of-concept knowledge base derived from clinic ODT source files.

### Input shape

Defined in [`schemas/searchKnowledgeBase.request.json`](../schemas/searchKnowledgeBase.request.json).

Key fields:

- `query`
- optional `language`
- optional `limit`

### Workflow behavior

1. Parse Vapi wrapper or direct body.
2. Validate that a question is present.
3. Validate the requested language.
4. Score the curated local KB entries against the query.
5. Return the best supported answer and matching entries in the requested language when available, or a no-match result.

### Success response

Defined in [`schemas/searchKnowledgeBase.response.json`](../schemas/searchKnowledgeBase.response.json).

Important fields:

- `found`
- `answer`
- `matches`
- `message`

## Tool: `createEvent`

### Intent

Book a confirmed appointment for a patient after Vapi has already collected the final slot and patient details.

### Input shape

Defined in [`schemas/createEvent.request.json`](../schemas/createEvent.request.json).

Key fields:

- `service.id`
- `slotStart`
- `slotEnd`
- `timezone`
- `patient.fullName`
- `patient.phoneE164`
- optional `service.durationMinutes` metadata, but the selected slot boundary must win over any inferred duration

### Workflow behavior

1. Parse Vapi wrapper or direct body.
2. Validate required fields and patient details.
3. Keep the exact `slotStart` and `slotEnd` from the selected availability option.
4. Re-check availability for the requested slot.
5. Create the Google Calendar event only if the slot is still free.
6. Return confirmation data.

### Success response

Defined in [`schemas/createEvent.response.json`](../schemas/createEvent.response.json).

Important fields:

- `created`
- `calendarEventId`
- `appointment`
- `message`

## Tool: `createReceptionTask`

### Intent

Queue a proof-of-concept receptionist follow-up task for cases that should not be completed fully by the assistant.

### Input shape

Defined in [`schemas/createReceptionTask.request.json`](../schemas/createReceptionTask.request.json).

Key fields:

- `taskType`
- `patient.fullName`
- `patient.phoneE164`
- `summary`

### Workflow behavior

1. Parse Vapi wrapper or direct body.
2. Validate the patient and task payload.
3. Reject unknown task types and malformed phone numbers.
4. Create a queued proof-of-concept task in the n8n execution payload.
5. Return task confirmation data.

### Success response

Defined in [`schemas/createReceptionTask.response.json`](../schemas/createReceptionTask.response.json).

Important fields:

- `accepted`
- `taskId`
- `task`
- `message`

## Tool: `sendSmsToReceptionists`

### Intent

Send an internal receptionist SMS alert only after `createReceptionTask` already succeeded.

### Input shape

Defined in [`schemas/sendSmsToReceptionists.request.json`](../schemas/sendSmsToReceptionists.request.json).

Key fields:

- `taskId` from `createReceptionTask`
- `taskType`
- `patient.fullName`
- `patient.phoneE164`
- `summary`

### Workflow behavior

1. Parse Vapi wrapper or direct body.
2. Validate that the receptionist task context is complete.
3. Build a concise internal SMS body from the task payload.
4. In `mock` mode, return a simulated delivery result.
5. In `webhook` mode, POST the SMS payload to the configured downstream SMS gateway or clinic webhook.

### Success response

Defined in [`schemas/sendSmsToReceptionists.response.json`](../schemas/sendSmsToReceptionists.response.json).

Important fields:

- `accepted`
- `delivery.status`
- `delivery.provider`
- `notification`
- `message`

## Tool: `sendSmsToPatient`

### Intent

Send a booking confirmation SMS only after `createEvent` already succeeded and the caller explicitly agreed to receive the SMS.

### Input shape

Defined in [`schemas/sendSmsToPatient.request.json`](../schemas/sendSmsToPatient.request.json).

Key fields:

- `calendarEventId` from `createEvent`
- `consentConfirmed`
- `patient.fullName`
- `patient.phoneE164`
- `appointment.start`
- `appointment.timezone`
- `appointment.service`

### Workflow behavior

1. Parse Vapi wrapper or direct body.
2. Validate patient fields, booking context, consent, language, and timezone.
3. Build a concise SMS body in Polish or English.
4. In `mock` mode, return a simulated delivery result.
5. In `webhook` mode, POST the SMS payload to the configured downstream SMS gateway or clinic webhook.

### Success response

Defined in [`schemas/sendSmsToPatient.response.json`](../schemas/sendSmsToPatient.response.json).

Important fields:

- `accepted`
- `delivery.status`
- `delivery.provider`
- `sms`
- `message`

## Error contract

All workflows return short, deterministic error objects.
Tool and router webhooks also return matching HTTP statuses:

- `400` for validation errors or unsupported webhook payloads
- `401` for missing or invalid webhook secrets
- `409` for booking conflicts when the requested slot is no longer available

Example:

```json
{
  "message": "Brakuje wymaganych danych do rezerwacji.",
  "created": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "details": [
      "patient.fullName is required"
    ]
  }
}
```

## Naming convention

- tool names use camelCase because that maps cleanly to Vapi function names
- workflow filenames use kebab-style suffixes because they are easier to scan in the repo
- schemas pair request and response files one-to-one
