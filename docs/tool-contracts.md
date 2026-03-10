# Tool Contracts

## Purpose

This project exposes two Vapi custom tools backed by n8n webhooks:

- `checkAvailability`
- `createEvent`

The JSON schemas in [`schemas/`](../schemas) describe the tool arguments and result objects.

## Transport model

### What Vapi sends

In production, Vapi sends a custom-tool webhook request that includes a `toolCallId` plus the function arguments for the tool call.

For local testing, the workflows also accept the schema payload directly as the HTTP body.

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

## Tool: `checkAvailability`

### Intent

Find a few valid appointment slots for a requested service and date/time preference.

### Input shape

Defined in [`schemas/checkAvailability.request.json`](../schemas/checkAvailability.request.json).

Key fields:

- `service.id`
- `requestedDate`
- `requestedTime` or `timePreference`
- `timezone`
- optional `limit`

### Workflow behavior

1. Parse Vapi wrapper or direct body.
2. Validate required fields.
3. Normalize service duration and search window.
4. Read busy events from Google Calendar.
5. Build up to `limit` valid slots.
6. Return a short structured response.

### Success response

Defined in [`schemas/checkAvailability.response.json`](../schemas/checkAvailability.response.json).

Important fields:

- `available`
- `slots`
- `normalizedRequest`
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

### Workflow behavior

1. Parse Vapi wrapper or direct body.
2. Validate required fields and patient details.
3. Re-check availability for the requested slot.
4. Create the Google Calendar event only if the slot is still free.
5. Return confirmation data.

### Success response

Defined in [`schemas/createEvent.response.json`](../schemas/createEvent.response.json).

Important fields:

- `created`
- `calendarEventId`
- `appointment`
- `message`

## Error contract

Both workflows return short, deterministic error objects.

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
