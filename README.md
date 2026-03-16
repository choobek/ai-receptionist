# AI Receptionist

Production-minded starter for a Polish dental receptionist powered by Vapi and n8n.

The repo keeps responsibilities separate:

- Vapi handles the conversation, prompt, first message, and tool calling.
- n8n handles validation, normalization, calendar lookup, booking, and external integrations.

## What is in this repo

```text
configs/
  services/
    catalog.v1.json
  vapi/
    assistant.v1.json
docs/
  architecture.md
  backlog.md
  knowledge-base.md
  tool-contracts.md
  vapi-structured-output.json
  vapi-structured-output.md
prompts/
  system-prompt.md
  first-message.md
schemas/
  lookupPatient.request.json
  lookupPatient.response.json
  checkAvailability.request.json
  checkAvailability.response.json
  searchKnowledgeBase.request.json
  searchKnowledgeBase.response.json
  createReceptionTask.request.json
  createReceptionTask.response.json
  createEvent.request.json
  createEvent.response.json
knowledge-base/
  clinic-knowledge.json
mock-data/
  mock-patients.json
n8n/workflows/
  tool_lookup-patient.json
  tool_check-availability.json
  tool_search-knowledge-base.json
  tool_create-reception-task.json
  tool_create-event.json
  webhook_vapi-call-ended-router.json
.env.example
```

## Default scope

This first version is intentionally small:

- one clinic
- one Google Calendar
- Polish language
- appointment lookup and booking
- proof-of-concept patient lookup against a mock registry
- proof-of-concept knowledge base derived from clinic ODT materials
- proof-of-concept receptionist task queue inside n8n
- no real CRM, SMS, payments, or patient history sync yet

## Request flow

### `lookupPatient`

1. Vapi gathers the patient's full name and/or phone number.
2. Vapi calls the `lookupPatient` tool.
3. n8n normalizes the identifiers and checks the proof-of-concept patient registry.
4. n8n returns whether the patient was matched.

### `checkAvailability`

1. Vapi gathers the service and the patient's preferred day/time.
2. Vapi calls the `checkAvailability` tool.
3. n8n normalizes the date/time request.
4. n8n checks the clinic calendar and builds up to a few valid slots.
5. n8n returns structured slot data for Vapi to speak back naturally.

### `searchKnowledgeBase`

1. Vapi gathers the caller's question.
2. Vapi calls the `searchKnowledgeBase` tool.
3. n8n searches the local curated knowledge base derived from the clinic ODT files.
4. n8n returns the best supported answer and matching KB entries, or a no-match result.

### `createEvent`

1. Vapi confirms the chosen slot and patient details.
2. Vapi calls the `createEvent` tool.
3. n8n validates required fields.
4. n8n re-checks the slot to avoid double-booking.
5. n8n creates the event in Google Calendar.
6. n8n returns confirmation data.

### `createReceptionTask`

1. Vapi collects the patient details and a short follow-up summary.
2. Vapi calls the `createReceptionTask` tool.
3. n8n validates the payload and creates a queued proof-of-concept reception task.
4. n8n returns confirmation data.

## Quick start

1. Copy [`.env.example`](./.env.example) to root `.env`.
2. Start n8n with Docker Compose from [`n8n/docker-compose.yml`](./n8n/docker-compose.yml).
3. Open n8n, complete the owner account setup on first launch, and then import the workflow files from [`n8n/workflows/`](./n8n/workflows).
4. Create Google Calendar credentials in n8n and attach them to the Google Calendar nodes.
5. Set the Vapi custom tool server URLs to the five n8n webhook endpoints.
6. If you set `AI_RECEPTIONIST_WEBHOOK_SECRET`, configure the same secret in Vapi using the `X-AI-Receptionist-Secret` header or a `?secret=` query parameter fallback.
7. Keep the Vapi assistant source of truth in [`configs/vapi/assistant.v1.json`](./configs/vapi/assistant.v1.json).
8. Apply the config with [`scripts/update-vapi-assistant.sh`](./scripts/update-vapi-assistant.sh).

Operational reference:

- [`AGENTS.md`](./AGENTS.md) for future Codex sessions
- [`docs/operations-runbook.md`](./docs/operations-runbook.md) for human step-by-step operations

## Deploy on a VPS

For a stable public HTTPS setup on a server, use the production bundle in [`deploy/vps/`](./deploy/vps/):

- [`deploy/vps/docker-compose.yml`](./deploy/vps/docker-compose.yml) runs n8n behind Caddy
- [`deploy/vps/Caddyfile`](./deploy/vps/Caddyfile) terminates HTTPS and proxies to n8n
- [`docs/vps-deployment.md`](./docs/vps-deployment.md) is the step-by-step server guide

This path avoids temporary tunnel URLs and gives Vapi stable webhook endpoints.
Use one root [`.env.example`](./.env.example) template for local n8n, VPS deploy, and Vapi API scripts.

### Start n8n locally

```bash
cp .env.example .env
docker compose --env-file .env -f n8n/docker-compose.yml up -d
```

Local editor URL:

- `http://localhost:5680`

Local HTTP basic auth credentials are defined in root `.env`.
After that, n8n still requires its own owner account in the web UI.
If the browser lands on the login page instead of setup, open `/setup` directly.
The local instance runs on port `5680` to avoid the existing n8n already using `5678` on this machine.
The default Google Calendar ID for workflow execution is read from root `.env` via `GOOGLE_CALENDAR_ID`.

## Suggested webhook paths

- `POST /webhook/ai-receptionist/check-availability`
- `POST /webhook/ai-receptionist/create-event`
- `POST /webhook/ai-receptionist/lookup-patient`
- `POST /webhook/ai-receptionist/search-knowledge-base`
- `POST /webhook/ai-receptionist/create-reception-task`

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

Then configure five Vapi custom tools:

### Tool: `lookupPatient`

- Tool type: custom tool / server URL
- Method: `POST`
- URL: `https://YOUR-PUBLIC-URL/webhook/ai-receptionist/lookup-patient`
- Parameters: use [`schemas/lookupPatient.request.json`](./schemas/lookupPatient.request.json)

### Tool: `checkAvailability`

- Tool type: custom tool / server URL
- Method: `POST`
- URL: `https://YOUR-PUBLIC-URL/webhook/ai-receptionist/check-availability`
- Parameters: use [`schemas/checkAvailability.request.json`](./schemas/checkAvailability.request.json)
- If Vapi has trouble with the full schema, use the simpler variant [`schemas/checkAvailability.vapi.request.json`](./schemas/checkAvailability.vapi.request.json) and the description in [`docs/vapi-checkAvailability-tool.md`](./docs/vapi-checkAvailability-tool.md)

### Tool: `searchKnowledgeBase`

- Tool type: custom tool / server URL
- Method: `POST`
- URL: `https://YOUR-PUBLIC-URL/webhook/ai-receptionist/search-knowledge-base`
- Parameters: use [`schemas/searchKnowledgeBase.request.json`](./schemas/searchKnowledgeBase.request.json)

### Tool: `createEvent`

- Tool type: custom tool / server URL
- Method: `POST`
- URL: `https://YOUR-PUBLIC-URL/webhook/ai-receptionist/create-event`
- Parameters: use [`schemas/createEvent.request.json`](./schemas/createEvent.request.json)

### Tool: `createReceptionTask`

- Tool type: custom tool / server URL
- Method: `POST`
- URL: `https://YOUR-PUBLIC-URL/webhook/ai-receptionist/create-reception-task`
- Parameters: use [`schemas/createReceptionTask.request.json`](./schemas/createReceptionTask.request.json)

Recommended assistant wiring in Vapi:

- assistant config source of truth: [`configs/vapi/assistant.v1.json`](./configs/vapi/assistant.v1.json)
- service catalog source of truth: [`configs/services/catalog.v1.json`](./configs/services/catalog.v1.json)
- assistant language: `pl-PL`
- mirrored prompt copy: [`prompts/system-prompt.md`](./prompts/system-prompt.md)
- mirrored first message copy: [`prompts/first-message.md`](./prompts/first-message.md)
- enable all five tools on the assistant
- let Vapi collect arguments and call the tools only when the prompt says to

To apply the versioned config to the existing assistant:

```bash
cp .env.example .env
$EDITOR .env
./scripts/sync-vapi-prompt-mirrors.sh
./scripts/update-vapi-assistant.sh
```

The script reads `VAPI_API_KEY` from `.env` or the current shell and patches the assistant referenced by `assistantId` in the config file.

Optional post-call setup:

- add a Structured Output using [`docs/vapi-structured-output.json`](./docs/vapi-structured-output.json)
- follow the setup notes in [`docs/vapi-structured-output.md`](./docs/vapi-structured-output.md)
- use [`docs/vapi-structured-output-consumption.md`](./docs/vapi-structured-output-consumption.md) to read outputs from webhooks or the Call API
- import [`n8n/workflows/webhook_vapi-call-ended-router.json`](./n8n/workflows/webhook_vapi-call-ended-router.json) to route `call.ended` events inside n8n
- or run [`scripts/create-vapi-structured-output.sh`](./scripts/create-vapi-structured-output.sh) with your Vapi API key and assistant ID

Before deploys or repo cleanup, run:

```bash
./scripts/check-repo-health.sh
```

When the Cloudflare tunnel URL changes:

- run [`scripts/update-n8n-public-url.sh`](./scripts/update-n8n-public-url.sh) with the new public base URL
- update the Vapi tool URLs and webhook target URLs to the new tunnel base
- follow [`docs/testing.md`](./docs/testing.md) to re-verify the setup end to end

## Contracts

- Tool payloads live in [`schemas/`](./schemas).
- Tool behavior and Vapi wrapping are documented in [`docs/tool-contracts.md`](./docs/tool-contracts.md).
- System boundaries and defaults are documented in [`docs/architecture.md`](./docs/architecture.md).
- Knowledge-base source and curation notes live in [`docs/knowledge-base.md`](./docs/knowledge-base.md).
- Implementation backlog lives in [`docs/backlog.md`](./docs/backlog.md).

## Assumptions baked into this starter

- clinic timezone is `Europe/Warsaw`
- calendar slot duration defaults to 30 minutes unless the service says otherwise
- slot suggestions are returned in small batches, default `3`
- secrets belong in n8n credentials or deployment config, not in this repo

## What is intentionally not included yet

- cancellation and rescheduling
- multi-location routing
- dentist-specific availability
- reminders or real SMS delivery
- real patient database lookup

Those can be added later without changing the basic contract.

## Proof-of-concept data

The current patient registry for `lookupPatient` is a static demo list in [`mock-data/mock-patients.json`](./mock-data/mock-patients.json).

For now this stands in for the clinic CRM. After changing it, run [`scripts/sync-n8n-workflow-data.sh`](./scripts/sync-n8n-workflow-data.sh) so the embedded n8n workflow snapshot stays in sync.

The current local knowledge base for `searchKnowledgeBase` is curated in [`knowledge-base/clinic-knowledge.json`](./knowledge-base/clinic-knowledge.json) from the ODT source files documented in [`docs/knowledge-base.md`](./docs/knowledge-base.md).

After changing either proof-of-concept dataset, run:

```bash
./scripts/sync-n8n-workflow-data.sh
```
