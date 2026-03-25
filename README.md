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
    assistant.v2.json
    evals/
    scorecards/
    structured-outputs/
    environments/
      production.json
      staging.json
autonomy/
  examples/
  prompts/
  reports/
  runs/
  scenarios/
  schemas/
  templates/
docs/
  architecture.md
  backlog.md
  environment-separation.md
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
  sendSmsToReceptionists.request.json
  sendSmsToReceptionists.response.json
  sendSmsToPatient.request.json
  sendSmsToPatient.response.json
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
  tool_send-sms-to-receptionists.json
  tool_send-sms-to-patient.json
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
- optional SMS workflows with `mock` mode by default plus native Twilio or webhook delivery when configured
- no real CRM, payments, or patient history sync yet

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

### `sendSmsToReceptionists`

1. After `createReceptionTask` succeeds, Vapi can call `sendSmsToReceptionists` for an internal receptionist alert.
2. n8n builds a short SMS body from the saved task context.
3. In `mock` mode it returns a simulated delivery result; in `twilio` mode it sends through the Twilio Messages API; in `webhook` mode it posts the SMS payload to the configured downstream gateway.

### `sendSmsToPatient`

1. After `createEvent` succeeds and the caller explicitly agreed to SMS, Vapi can call `sendSmsToPatient`.
2. n8n builds a booking confirmation SMS in Polish or English.
3. In `mock` mode it returns a simulated delivery result; in `twilio` mode it sends through the Twilio Messages API; in `webhook` mode it posts the SMS payload to the configured downstream gateway.

## Quick start

1. Copy [`.env.example`](./.env.example) to root `.env`.
2. Start n8n with Docker Compose from [`n8n/docker-compose.yml`](./n8n/docker-compose.yml).
3. Open n8n, complete the owner account setup on first launch, and then import the workflow files from [`n8n/workflows/`](./n8n/workflows).
4. Create Google Calendar credentials in n8n and attach them to the Google Calendar nodes.
5. Set the Vapi custom tool server URLs to the five core n8n webhook endpoints, plus the optional SMS endpoints if you create those extra Vapi tool resources. The repo now includes [`scripts/create-vapi-tool.sh`](./scripts/create-vapi-tool.sh) for that.
6. If you set `AI_RECEPTIONIST_WEBHOOK_SECRET`, configure the same secret in Vapi using the `X-AI-Receptionist-Secret` header or a `?secret=` query parameter fallback.
7. Keep the Vapi assistant source of truth in [`configs/vapi/assistant.v2.json`](./configs/vapi/assistant.v2.json).
8. Apply the config with [`scripts/sync-vapi-environment.sh`](./scripts/sync-vapi-environment.sh) for the target environment. If Twilio is configured, that sync also keeps the environment's Vapi phone number bound to the assistant.

Operational reference:

- [`AGENTS.md`](./AGENTS.md) for future Codex sessions
- [`docs/environment-separation.md`](./docs/environment-separation.md) for staging vs production
- [`docs/operations-runbook.md`](./docs/operations-runbook.md) for human step-by-step operations
- [`docs/vapi-observability.md`](./docs/vapi-observability.md) for the repo-backed Vapi observability pack
- [`docs/staging-regression-suite.md`](./docs/staging-regression-suite.md) for the staging synthetic suite
- [`docs/staging-voice-smoke-suite.md`](./docs/staging-voice-smoke-suite.md) for the staged voice smoke-lane surface
- [`docs/voice-e2e-execution-lane.md`](./docs/voice-e2e-execution-lane.md) for the staged plan to add automated voice validation

## Staging Regression Suite

Run the staging-only synthetic regression suite with:

```bash
./scripts/run-staging-regression-suite.sh
```

It executes scripted multi-turn chat scenarios against the staging Vapi assistant, captures tool activity, scores the runs locally, writes JSON artifacts under `autonomy/runs/generated/staging/`, renders a Markdown report under `autonomy/reports/generated/staging/`, and exits non-zero when a regression is detected.

Run the guarded staging-only autonomous improvement loop with:

```bash
./scripts/run-staging-autonomy-loop.sh
```

The controller reuses the existing staging regression runner plus the existing deploy/sync scripts, clusters failures into bounded categories, derives draft regression scenarios from failures, applies only repo-backed targeted fixes that have an explicit safe fixer, optionally syncs staging if runtime files changed, reruns the suite, and writes a release-style report plus index under the git-ignored `autonomy/*/generated/staging-loop/` paths.

Today the safe auto-fixer catalog is intentionally narrow: it can split the ambiguous-day false failure coverage and tighten the staging booking prompt around exact selected-slot reuse for `createEvent`. Workflow or VPS-affecting fixes are still reported, but they are blocked from pretending they deployed unless the repo state has been promoted through the existing git-backed staging path.

## Staging Voice Smoke Suite

Run the staging-only automated voice smoke suite with:

```bash
./scripts/run-staging-voice-smoke-suite.sh
```

The default run executes the active Polish voice scenarios. Use `--language en` for the English companion lane or `--language all` to run both.

This lane starts a real staging Vapi web call in Chrome through the Vapi Web SDK, feeds a synthesized fake-microphone WAV built from the scenario steps, waits for the call to end, fetches the final call artifact from the Vapi API, normalizes it through the existing autonomy ingester, writes JSON artifacts under `autonomy/runs/generated/staging-voice/`, renders a Markdown report under `autonomy/reports/generated/staging-voice/`, and exits non-zero when a required voice smoke criterion fails. If a referenced caller clip is missing, the runner can synthesize it on demand through ElevenLabs and cache it under `autonomy/scenarios/staging-voice/fixtures/`.

The current runner needs both:

- a private staging Vapi API key for server-side call fetches
- a browser-side Vapi public key or public JWT token for web-call creation
- `ELEVENLABS_API_KEY` only when voice fixtures still need to be synthesized locally

## Staging And Production

The repo now supports one shared codebase with explicit staging and production bindings:

- shared assistant behavior: [`configs/vapi/assistant.v2.json`](./configs/vapi/assistant.v2.json)
- environment-specific Vapi IDs: [`configs/vapi/environments/staging.json`](./configs/vapi/environments/staging.json) and [`configs/vapi/environments/production.json`](./configs/vapi/environments/production.json)
- environment-specific automation values in root [`.env.example`](./.env.example) via `STAGING_*` and `PRODUCTION_*`
- optional same-host staging: production keeps the shared Caddy edge, while staging can use [`deploy/vps/docker-compose.n8n-only.yml`](./deploy/vps/docker-compose.n8n-only.yml) behind that edge

Primary commands:

```bash
./scripts/deploy-vps.sh staging
./scripts/sync-environment.sh staging
./scripts/deploy-vps.sh production
./scripts/sync-environment.sh production
./scripts/promote-to-production.sh HEAD
```

Keep the live production phone number bound to the production assistant only. Do not reuse that assistant or number for staging.

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
- `POST /webhook/ai-receptionist/send-sms-to-receptionists`
- `POST /webhook/ai-receptionist/send-sms-to-patient`

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

Then configure the five core Vapi custom tools, and optionally add the two SMS tools once you create those Vapi tool resources:

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

### Optional Tool: `sendSmsToReceptionists`

- Tool type: custom tool / server URL
- Method: `POST`
- URL: `https://YOUR-PUBLIC-URL/webhook/ai-receptionist/send-sms-to-receptionists`
- Parameters: use [`schemas/sendSmsToReceptionists.request.json`](./schemas/sendSmsToReceptionists.request.json)

### Optional Tool: `sendSmsToPatient`

- Tool type: custom tool / server URL
- Method: `POST`
- URL: `https://YOUR-PUBLIC-URL/webhook/ai-receptionist/send-sms-to-patient`
- Parameters: use [`schemas/sendSmsToPatient.request.json`](./schemas/sendSmsToPatient.request.json)

Recommended assistant wiring in Vapi:

- assistant config source of truth: [`configs/vapi/assistant.v2.json`](./configs/vapi/assistant.v2.json)
- service catalog source of truth: [`configs/services/catalog.v1.json`](./configs/services/catalog.v1.json)
- assistant language: `pl-PL`
- mirrored prompt copy: [`prompts/system-prompt.md`](./prompts/system-prompt.md)
- mirrored first message copy: [`prompts/first-message.md`](./prompts/first-message.md)
- enable the five core tools on the assistant
- add the optional SMS tools only after their Vapi tool resources exist and their IDs are present in [`configs/vapi/environments/`](./configs/vapi/environments/)
- let Vapi collect arguments and call the tools only when the prompt says to

To apply the versioned config to the existing assistant:

```bash
cp .env.example .env
$EDITOR .env
./scripts/sync-vapi-prompt-mirrors.sh
./scripts/sync-vapi-environment.sh production
```

If you prefer editing the readable prompt mirror first, you can explicitly import it back into the canonical JSON config:

```bash
$EDITOR prompts/system-prompt.md
./scripts/import-vapi-prompt-mirrors.sh --system-only
./scripts/sync-vapi-environment.sh staging
```

The sync path reads shared behavior from [`configs/vapi/assistant.v2.json`](./configs/vapi/assistant.v2.json), environment IDs from [`configs/vapi/environments/`](./configs/vapi/environments/), and the target public base URL plus webhook secret from root `.env`.

Repo-backed observability setup:

- canonical Vapi observability configs live in [`configs/vapi/structured-outputs/`](./configs/vapi/structured-outputs/), [`configs/vapi/scorecards/`](./configs/vapi/scorecards/), [`configs/vapi/evals/`](./configs/vapi/evals/), and [`configs/vapi/autoevaluation-policy.v1.json`](./configs/vapi/autoevaluation-policy.v1.json)
- the readable call-intake schema mirror lives in [`docs/vapi-structured-output.json`](./docs/vapi-structured-output.json)
- sync the pack with [`scripts/sync-vapi-observability.sh`](./scripts/sync-vapi-observability.sh) or via the full [`scripts/sync-vapi-environment.sh`](./scripts/sync-vapi-environment.sh) path
- use [`docs/vapi-observability.md`](./docs/vapi-observability.md) for scorecard and eval workflow notes
- use [`docs/vapi-structured-output.md`](./docs/vapi-structured-output.md) and [`docs/vapi-structured-output-consumption.md`](./docs/vapi-structured-output-consumption.md) to read outputs and scores from webhooks or the Call API
- import [`n8n/workflows/webhook_vapi-call-ended-router.json`](./n8n/workflows/webhook_vapi-call-ended-router.json) to route `call.ended` events inside n8n
- run the saved Vapi eval pack with [`scripts/run-vapi-eval-suite.sh`](./scripts/run-vapi-eval-suite.sh)
- run live-call autoevaluation with [`scripts/run-vapi-live-autoeval.sh`](./scripts/run-vapi-live-autoeval.sh)

Before deploys or repo cleanup, run:

```bash
./scripts/check-repo-health.sh
./scripts/run-vapi-eval-suite.sh staging
./scripts/run-vapi-live-autoeval.sh staging --since-hours 24 --limit 15
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

## Autonomy Scaffold

The repo now also includes an offline-first autonomy workspace for ingesting raw Vapi call artifacts, storing normalized runs, and defining reusable eval scenarios:

- design doc: [`docs/autonomy-loop.md`](./docs/autonomy-loop.md)
- workspace overview: [`autonomy/README.md`](./autonomy/README.md)
- ingestion CLI: [`scripts/autonomy/ingest-vapi-call-log.js`](./scripts/autonomy/ingest-vapi-call-log.js)
- voice smoke suite surface: [`docs/staging-voice-smoke-suite.md`](./docs/staging-voice-smoke-suite.md)
- planned voice lane: [`docs/voice-e2e-execution-lane.md`](./docs/voice-e2e-execution-lane.md)

## Assumptions baked into this starter

- clinic timezone is `Europe/Warsaw`
- calendar slot duration defaults to 30 minutes unless the service says otherwise
- slot suggestions are returned in small batches, default `3`
- secrets belong in n8n credentials or deployment config, not in this repo

## What is intentionally not included yet

- cancellation and rescheduling
- multi-location routing
- dentist-specific availability
- scheduled reminders or multi-step notification campaigns
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
