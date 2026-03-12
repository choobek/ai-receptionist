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
  vapi-structured-output.json
  vapi-structured-output.md
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
  webhook_vapi-call-ended-router.json
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
3. Open n8n, complete the owner account setup on first launch, and then import the workflow files from [`n8n/workflows/`](./n8n/workflows).
4. Create Google Calendar credentials in n8n and attach them to the Google Calendar nodes.
5. Set the Vapi custom tool server URLs to the two n8n webhook endpoints.
6. Paste [`prompts/system-prompt.md`](./prompts/system-prompt.md) and [`prompts/first-message.md`](./prompts/first-message.md) into your Vapi assistant.

## Deploy on a VPS

For a stable public HTTPS setup on a server, use the production bundle in [`deploy/vps/`](./deploy/vps/):

- [`deploy/vps/docker-compose.yml`](./deploy/vps/docker-compose.yml) runs n8n behind Caddy
- [`deploy/vps/Caddyfile`](./deploy/vps/Caddyfile) terminates HTTPS and proxies to n8n
- [`deploy/vps/.env.example`](./deploy/vps/.env.example) is the production env template
- [`docs/vps-deployment.md`](./docs/vps-deployment.md) is the step-by-step server guide

This path avoids temporary tunnel URLs and gives Vapi stable webhook endpoints.

### Start n8n locally

```bash
cd n8n
docker-compose up -d
```

Local editor URL:

- `http://localhost:5680`

Local HTTP basic auth credentials are defined in `n8n/.env`.
After that, n8n still requires its own owner account in the web UI.
If the browser lands on the login page instead of setup, open `/setup` directly.
The local instance runs on port `5680` to avoid the existing n8n already using `5678` on this machine.
The default Google Calendar ID for workflow execution is read from `n8n/.env` via `GOOGLE_CALENDAR_ID`.

## Suggested webhook paths

- `POST /webhook/ai-receptionist/check-availability`
- `POST /webhook/ai-receptionist/create-event`

The exported workflows already use these paths.

Structured output webhook router path:

- `POST /webhook/ai-receptionist/vapi-call-ended`

## Vapi setup

Vapi must be able to reach your n8n webhook URLs over public HTTPS. `localhost` will not work from Vapi.

For local testing, expose n8n with a tunnel such as:

```bash
cloudflared tunnel --url http://localhost:5680
```

or `ngrok http 5680`.

Then configure two Vapi custom tools:

### Tool: `checkAvailability`

- Tool type: custom tool / server URL
- Method: `POST`
- URL: `https://YOUR-PUBLIC-URL/webhook/ai-receptionist/check-availability`
- Parameters: use [`schemas/checkAvailability.request.json`](./schemas/checkAvailability.request.json)

### Tool: `createEvent`

- Tool type: custom tool / server URL
- Method: `POST`
- URL: `https://YOUR-PUBLIC-URL/webhook/ai-receptionist/create-event`
- Parameters: use [`schemas/createEvent.request.json`](./schemas/createEvent.request.json)

Recommended assistant wiring in Vapi:

- assistant language: `pl-PL`
- system prompt: [`prompts/system-prompt.md`](./prompts/system-prompt.md)
- first message: [`prompts/first-message.md`](./prompts/first-message.md)
- enable both tools on the assistant
- let Vapi collect arguments and call the tools only when the prompt says to

Optional post-call setup:

- add a Structured Output using [`docs/vapi-structured-output.json`](./docs/vapi-structured-output.json)
- follow the setup notes in [`docs/vapi-structured-output.md`](./docs/vapi-structured-output.md)
- use [`docs/vapi-structured-output-consumption.md`](./docs/vapi-structured-output-consumption.md) to read outputs from webhooks or the Call API
- import [`n8n/workflows/webhook_vapi-call-ended-router.json`](./n8n/workflows/webhook_vapi-call-ended-router.json) to route `call.ended` events inside n8n
- or run [`scripts/create-vapi-structured-output.sh`](./scripts/create-vapi-structured-output.sh) with your Vapi API key and assistant ID

When the Cloudflare tunnel URL changes:

- run [`scripts/update-n8n-public-url.sh`](./scripts/update-n8n-public-url.sh) with the new public base URL
- update the Vapi tool URLs and webhook target URLs to the new tunnel base
- follow [`docs/testing.md`](./docs/testing.md) to re-verify the setup end to end

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
