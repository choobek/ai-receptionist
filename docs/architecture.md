# Architecture

## Goal

Deliver a first working version of an AI receptionist for a Polish dental clinic with clean boundaries:

- Vapi owns conversation behavior.
- n8n owns business logic and integrations.
- Google Calendar is the appointment source of truth.
- a mock patient registry stands in for CRM during the proof-of-concept phase
- a local curated knowledge base stands in for clinic content retrieval during the proof-of-concept phase

## Components

### Vapi

- answers the call
- follows the receptionist prompt
- gathers missing information from the caller
- can identify known patients through `lookupPatient`
- can answer supported general clinic questions through `searchKnowledgeBase`
- calls `checkAvailability` and `createEvent`
- can queue human follow-up through `createReceptionTask`
- speaks the returned result in natural language

### n8n

- exposes webhook endpoints for all assistant tools
- accepts either direct JSON payloads or the Vapi tool-call envelope
- validates required fields
- normalizes date, time, duration, and timezone values
- talks to Google Calendar
- keeps proof-of-concept patient registry data for known patients
- keeps a proof-of-concept curated knowledge base derived from clinic ODT files
- returns a tool result in Vapi-compatible format

### Google Calendar

- stores booked appointments
- acts as the availability source for the first version

### Mock patient registry

- stores a small static list of test patients for proof-of-concept CRM lookup
- lets the assistant branch between new-patient and existing-patient flows before a real clinic integration exists

### Local knowledge base

- stores curated clinic knowledge derived from the provided ODT files
- supports general non-diagnostic questions during the proof-of-concept phase

## Data flow

### Availability check

1. Caller asks for a dental appointment.
2. Vapi collects `service` and either a concrete date/time or a broader preference such as `first_available`.
3. Vapi calls `checkAvailability`.
4. n8n converts the request into a search window.
5. For `first_available`, n8n can start from today and search across multiple working days.
6. n8n fetches busy events from Google Calendar.
7. n8n returns a short list of available slots.

### Knowledge-base search

1. Caller asks a general clinic question.
2. Vapi calls `searchKnowledgeBase`.
3. n8n scores the local curated entries against the query.
4. n8n returns the best supported answer or a no-match result.

### Patient lookup

1. Caller says they are already a patient or gives identifying data.
2. Vapi calls `lookupPatient`.
3. n8n searches the proof-of-concept patient registry by phone first and full name second.
4. n8n returns a compact match result for conversation branching.

### Event creation

1. Caller selects one of the proposed slots.
2. Vapi collects patient details.
3. Vapi calls `createEvent`.
4. n8n validates the patient payload.
5. n8n re-checks slot availability.
6. n8n creates the calendar event.
7. n8n returns a confirmation object.

### Reception follow-up

1. Caller needs a human path such as existing-patient scheduling or rescheduling.
2. Vapi collects patient details and a short summary.
3. Vapi calls `createReceptionTask`.
4. n8n creates a queued proof-of-concept task in the workflow execution payload.
5. n8n returns a task confirmation object.

## Design choices

### Keep prompts out of workflows

The assistant prompt stays in [`prompts/`](../prompts). n8n workflows should not contain conversational policy or long speech text.

### Keep payloads small and explicit

All tools use a consistent, predictable shape:

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
- mock patient registry: static proof-of-concept data
- local knowledge base: curated static proof-of-concept data

## Failure handling

- Missing required fields return a short structured error.
- Unavailable slots return `created: false` or `available: false` with a human-usable message.
- Booking always re-checks availability before creating the event.

## Non-goals for v1

- multi-calendar balancing
- real patient record sync
- treatment pricing logic
- voicemail workflows
- outbound reminders and real SMS delivery

These can be added as separate workflows once the core booking loop is stable.
