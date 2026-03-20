# Vapi Tool Setup: `checkAvailability`

Use this when you want a paste-ready description and a simpler schema for the Vapi tool definition.

## Recommended description

```text
Check real appointment availability for the dental clinic and return up to a few valid slots. The clinic books visits only Monday-Friday between 09:00 and 21:00 in Europe/Warsaw. Use this only when the visit type is known and you already know either a preferred date, a preferred time window, or that the caller wants the first available appointment. Use only these service.id values: consultation, urgent_consultation, implant_consultation, orthodontic_consultation, aesthetic_consultation, hygiene. For first-time patients or when unsure about the exact procedure, use service.id = consultation. Always use timezone = Europe/Warsaw. Use timePreference = specific_time when the caller gave an exact hour, morning/afternoon/evening for broad preferences, and first_available for the nearest available term. Use searchDays when the caller described a multi-day range such as next week or Tuesday-or-Wednesday afternoon. If requestedDate lands on a closed clinic day, the backend rolls the search forward to the next open clinic day. If the caller asks for the nearest available appointment and gives no date, requestedDate may be omitted.
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
- If you enable `AI_RECEPTIONIST_WEBHOOK_SECRET`, send the same secret to the webhook with the `X-AI-Receptionist-Secret` header or a `?secret=` query parameter fallback.
- If Vapi struggles with the full schema, use the simplified schema from this doc.
- The backend still accepts the fuller request shape from [checkAvailability.request.json](/home/choobek/repos/ai-receptionist/schemas/checkAvailability.request.json).

## Mapping guidance

- first visit or uncertain treatment: `service.id = consultation`
- exact hour like `09:30`: `timePreference = specific_time` and `requestedTime = 09:30`
- broad preference like `rano`: `timePreference = morning`
- broad multi-day preference like `w przyszlym tygodniu po poludniu`: `timePreference = afternoon`, `requestedDate = first acceptable day`, and `searchDays = clinic-day span`
- nearest free appointment: `timePreference = first_available`
- clinic timezone: `Europe/Warsaw`
