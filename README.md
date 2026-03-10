# AI Receptionist

Production-minded starter for a Polish dental receptionist powered by Vapi and n8n.

The repo keeps responsibilities separate:

- Vapi handles the conversation, prompt, first message, and tool calling.
- n8n handles validation, normalization, calendar lookup, booking, and external integrations.

## What is in this repo

```text
docs/
  architecture.md
  tool-contracts.md
prompts/
  system-prompt.md
  first-message.md
schemas/
  checkAvailability.request.json
  checkAvailability.response.json
  createEvent.request.json
  createEvent.response.json
n8n/workflows/
  tool_check-availability.json
  tool_create-event.json
.env.example
```

## Default scope

This first version is intentionally small:

- one clinic
- one Google Calendar
- Polish language
- appointment lookup and booking only
- no CRM, SMS, payments, or patient history sync yet

## Request flow

### `checkAvailability`

1. Vapi gathers the service and the patient's preferred day/time.
2. Vapi calls the `checkAvailability` tool.
3. n8n normalizes the date/time request.
4. n8n checks the clinic calendar and builds up to a few valid slots.
5. n8n returns structured slot data for Vapi to speak back naturally.

### `createEvent`

1. Vapi confirms the chosen slot and patient details.
2. Vapi calls the `createEvent` tool.
3. n8n validates required fields.
4. n8n re-checks the slot to avoid double-booking.
5. n8n creates the event in Google Calendar.
6. n8n returns confirmation data.

## Quick start

1. Copy `.env.example` into your deployment environment.
2. Start n8n with Docker Compose from [`n8n/docker-compose.yml`](./n8n/docker-compose.yml).
3. Sign in to n8n and import both workflow files from [`n8n/workflows/`](./n8n/workflows).
4. Create Google Calendar credentials in n8n and attach them to the Google Calendar nodes.
5. Set the Vapi custom tool server URLs to the two n8n webhook endpoints.
6. Paste [`prompts/system-prompt.md`](./prompts/system-prompt.md) and [`prompts/first-message.md`](./prompts/first-message.md) into your Vapi assistant.

### Start n8n locally

```bash
cd n8n
docker-compose up -d
```

Local editor URL:

- `http://localhost:5680`

Local basic auth credentials are defined in `n8n/.env`.
The local instance runs on port `5680` to avoid the existing n8n already using `5678` on this machine.

## Suggested webhook paths

- `POST /webhook/ai-receptionist/check-availability`
- `POST /webhook/ai-receptionist/create-event`

The exported workflows already use these paths.

## Contracts

- Tool payloads live in [`schemas/`](./schemas).
- Tool behavior and Vapi wrapping are documented in [`docs/tool-contracts.md`](./docs/tool-contracts.md).
- System boundaries and defaults are documented in [`docs/architecture.md`](./docs/architecture.md).

## Assumptions baked into this starter

- clinic timezone is `Europe/Warsaw`
- calendar slot duration defaults to 30 minutes unless the service says otherwise
- slot suggestions are returned in small batches, default `3`
- secrets belong in n8n credentials or deployment config, not in this repo

## What is intentionally not included yet

- cancellation and rescheduling
- multi-location routing
- dentist-specific availability
- reminders or follow-up automations
- patient database lookup

Those can be added later without changing the basic contract.
