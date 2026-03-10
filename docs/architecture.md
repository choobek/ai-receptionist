# Architecture

## Goal

Deliver a first working version of an AI receptionist for a Polish dental clinic with clean boundaries:

- Vapi owns conversation behavior.
- n8n owns business logic and integrations.
- Google Calendar is the appointment source of truth.

## Components

### Vapi

- answers the call
- follows the receptionist prompt
- gathers missing information from the caller
- calls `checkAvailability` and `createEvent`
- speaks the returned result in natural language

### n8n

- exposes webhook endpoints for both tools
- accepts either direct JSON payloads or the Vapi tool-call envelope
- validates required fields
- normalizes date, time, duration, and timezone values
- talks to Google Calendar
- returns a tool result in Vapi-compatible format

### Google Calendar

- stores booked appointments
- acts as the availability source for the first version

## Data flow

### Availability check

1. Caller asks for a dental appointment.
2. Vapi collects `service`, `requestedDate`, and either `requestedTime` or a broader preference.
3. Vapi calls `checkAvailability`.
4. n8n converts the request into a search window.
5. n8n fetches busy events from Google Calendar.
6. n8n returns a short list of available slots.

### Event creation

1. Caller selects one of the proposed slots.
2. Vapi collects patient details.
3. Vapi calls `createEvent`.
4. n8n validates the patient payload.
5. n8n re-checks slot availability.
6. n8n creates the calendar event.
7. n8n returns a confirmation object.

## Design choices

### Keep prompts out of workflows

The assistant prompt stays in [`prompts/`](../prompts). n8n workflows should not contain conversational policy or long speech text.

### Keep payloads small and explicit

Both tools use a consistent, predictable shape:

- `requestId` for tracing
- `service` as an object
- `timezone` on every request
- structured `patient` data only when needed

### Support direct testing

The workflows accept:

- a direct JSON request body for local/manual testing
- the Vapi custom-tool request envelope in production

That makes debugging easier without adding a custom backend layer.

## Operational defaults

- timezone: `Europe/Warsaw`
- calendar: `primary` unless `GOOGLE_CALENDAR_ID` is set
- slot increment: 30 minutes
- max suggestions: 3
- working hours: controlled through environment variables

## Failure handling

- Missing required fields return a short structured error.
- Unavailable slots return `created: false` or `available: false` with a human-usable message.
- Booking always re-checks availability before creating the event.

## Non-goals for v1

- multi-calendar balancing
- patient record sync
- treatment pricing logic
- voicemail workflows
- outbound reminders

These can be added as separate workflows once the core booking loop is stable.
