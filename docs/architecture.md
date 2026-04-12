# Architecture

## Goal

Deliver a first working version of an AI receptionist for a Polish dental clinic with clean boundaries:

- Vapi owns conversation behavior.
- n8n owns business logic and integrations.
- a small calendar gateway owns Google OAuth, token storage, and Calendar API calls
- Google Calendar is the appointment source of truth.
- a local curated knowledge base stands in for clinic content retrieval during the proof-of-concept phase

## Components

### Vapi

- answers the call
- follows the receptionist prompt
- gathers missing information from the caller
- can normalize and confirm spoken phone numbers through `lookupPatient`
- can answer supported general clinic questions through `searchKnowledgeBase`
- calls `checkAvailability` and `createEvent`
- can queue human follow-up through `createReceptionTask`
- can optionally alert reception through `sendSmsToReceptionists`
- speaks the returned result in natural language

### n8n

- exposes webhook endpoints for all assistant tools
- accepts either direct JSON payloads or the Vapi tool-call envelope
- validates required fields
- normalizes date, time, duration, and timezone values
- normalizes phone numbers and builds speech-safe readback text
- talks to the calendar gateway over HTTP for connected-account calendar access
- keeps a proof-of-concept curated knowledge base derived from clinic ODT files
- can simulate SMS delivery safely in `mock` mode or hand off to an external SMS webhook
- returns a tool result in Vapi-compatible format

### Calendar gateway

- exposes a simple Google login flow for the calendar owner
- exchanges the OAuth code for long-lived refresh-token access
- stores the connected account server-side with encrypted token material at rest
- refreshes Google access tokens automatically when n8n needs calendar data
- can list writable calendars and remember which one should receive bookings
- keeps staging and production calendar connections fully separate

### Google Calendar

- stores booked appointments
- acts as the availability source for the first version

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
6. n8n asks the calendar gateway for busy events from the connected Google account.
7. n8n returns a short list of available slots.

### Knowledge-base search

1. Caller asks a general clinic question.
2. Vapi calls `searchKnowledgeBase`.
3. n8n scores the local curated entries against the query.
4. n8n returns the best supported answer or a no-match result.

### Phone confirmation helper

1. Caller gives a phone number.
2. Vapi calls `lookupPatient`.
3. n8n normalizes the number and prepares speech-safe readback text.
4. n8n returns the helper fields for confirmation and downstream tool payloads.

### Event creation

1. Caller selects one of the proposed slots.
2. Vapi collects patient details.
3. Vapi calls `createEvent`.
4. n8n validates the patient payload.
5. n8n re-checks slot availability through the calendar gateway.
6. n8n asks the calendar gateway to create the calendar event.
7. n8n deterministically attempts the booking-confirmation SMS to the live caller number from telephony metadata.
8. n8n returns a confirmation object that includes booking-SMS audit data.

### Reception follow-up

1. Caller needs a human path such as existing-patient scheduling or rescheduling.
2. Vapi collects patient details and a short summary.
3. Vapi calls `createReceptionTask`.
4. n8n creates a queued proof-of-concept task in the workflow execution payload.
5. n8n returns a task confirmation object.

### Reception SMS alert

1. After `createReceptionTask` succeeds, Vapi can call `sendSmsToReceptionists`.
2. n8n builds a short internal SMS body from the saved task payload.
3. In `mock` mode it returns a simulated delivery result.
4. In `webhook` mode it POSTs the SMS payload to the configured downstream gateway.

### Patient confirmation SMS

1. `createEvent` builds a short confirmation SMS in Polish or English as part of the booking workflow.
2. The SMS destination is the live caller number from telephony metadata when that ground-truth number is available.
3. In `mock` mode it returns a simulated delivery result.
4. In `webhook` mode it POSTs the SMS payload to the configured downstream gateway.

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
- calendar connection: `GOOGLE_CALENDAR_CONNECTION_ID` selects the connected account to use
- calendar: selected during the Google connection flow, or `GOOGLE_CALENDAR_ID` as a fallback
- slot increment: 30 minutes
- max suggestions: 3
- working hours: controlled through environment variables
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
- outbound reminder campaigns beyond the transactional SMS tools

These can be added as separate workflows once the core booking loop is stable.
