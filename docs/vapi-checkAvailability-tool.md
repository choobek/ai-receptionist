# Vapi Tool Setup: `checkAvailability`

Use this when you want a paste-ready description and a simpler schema for the Vapi tool definition.

## Recommended description

```text
Check real appointment availability for the dental clinic and return up to a few valid slots. Use this only when the visit type is known and you already know either a preferred date, a preferred time window, or that the caller wants the first available appointment. For first-time patients or when unsure about the exact procedure, use service.id = consultation. Always use timezone = Europe/Warsaw. Use timePreference = specific_time when the caller gave an exact hour, morning/afternoon/evening for broad preferences, and first_available for the nearest available term. If the caller asks for the nearest available appointment and gives no date, requestedDate may be omitted.
```

## Recommended simplified schema

File: [checkAvailability.vapi.request.json](/home/choobek/repos/ai-receptionist/schemas/checkAvailability.vapi.request.json)

This version is intentionally simpler than the full contract:

- no conditional `allOf`
- fewer optional fields
- better suited for Vapi parameter collection

## Notes for Vapi

- Keep the tool name exactly `checkAvailability`.
- Point the server URL to your hosted n8n webhook.
- If Vapi struggles with the full schema, use the simplified schema from this doc.
- The backend still accepts the fuller request shape from [checkAvailability.request.json](/home/choobek/repos/ai-receptionist/schemas/checkAvailability.request.json).

## Mapping guidance

- first visit or uncertain treatment: `service.id = consultation`
- exact hour like `09:30`: `timePreference = specific_time` and `requestedTime = 09:30`
- broad preference like `rano`: `timePreference = morning`
- nearest free appointment: `timePreference = first_available`
- clinic timezone: `Europe/Warsaw`
