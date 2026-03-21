# Vapi Structured Output

This repo now includes a post-call extraction schema for the dental assistant:

- canonical config: [`../configs/vapi/structured-outputs/dental-call-intake.v1.json`](../configs/vapi/structured-outputs/dental-call-intake.v1.json)
- readable schema mirror: [`docs/vapi-structured-output.json`](./vapi-structured-output.json)
- consumption guide: [`docs/vapi-structured-output-consumption.md`](./vapi-structured-output-consumption.md)

Use it when you want Vapi to produce a structured JSON record after each call for:
- booking analytics
- receptionist follow-up
- QA checks
- CRM or webhook integrations

## What it is for

This schema is designed for **post-call analysis**, not in-call booking logic.

Keep this split:
- use `checkAvailability` and `createEvent` during the call
- use Structured Outputs after the call ends

The schema extracts:
- overall call outcome
- patient identity fields if mentioned
- visit intent
- requested timing
- booking result
- risk and quality flags
- conversation-quality QA flags for loops, stacked questions, premature tool use, missing booking confirmation, and phone-number playback mistakes
- receptionist follow-up recommendation
- short internal Polish summary

## Recommended Vapi setup

### Repo-backed sync

Preferred path:

```bash
./scripts/sync-vapi-observability.sh staging
./scripts/sync-vapi-observability.sh production
```

This sync path:
- upserts the canonical call-intake structured output
- updates the environment binding file with the resulting output IDs
- keeps the assistant `artifactPlan.structuredOutputIds` aligned through the normal assistant sync path

The readable JSON schema mirror is generated from the canonical config:

```bash
./scripts/sync-vapi-observability-mirrors.sh
```

### Dashboard

1. Open **Structured Outputs** in Vapi.
2. Create a new structured output.
3. Use a short name such as `Dental Call Intake`.
4. Set `type` to `ai`.
5. Paste the JSON Schema from [`docs/vapi-structured-output.json`](./vapi-structured-output.json).
6. Attach it to the assistant.
7. If you attach it directly during creation, confirm the assistant link is present on the structured output resource.
8. If you manage attachment from the assistant side, confirm the assistant has this structured output in `artifactPlan.structuredOutputIds`.

### API example

Create the structured output:

```bash
jq -n \
  --arg assistant_id "YOUR_ASSISTANT_ID" \
  --slurpfile schema docs/vapi-structured-output.json \
  '{
    name: "Dental Call Intake",
    type: "ai",
    description: "Post-call extraction for the Ipokrzyku.pl dental receptionist assistant",
    assistantIds: [$assistant_id],
    schema: $schema[0]
  }' | \
curl -X POST https://api.vapi.ai/structured-output \
  -H "Authorization: Bearer YOUR_VAPI_API_KEY" \
  -H "Content-Type: application/json" \
  -d @-
```

If you prefer to attach from the assistant side instead:

```json
{
  "artifactPlan": {
    "structuredOutputIds": [
      "YOUR_STRUCTURED_OUTPUT_ID"
    ]
  }
}
```

### Repo helper script

This repo also includes a helper script that creates the structured output and links it to the assistant:

```bash
export VAPI_API_KEY=your_api_key
./scripts/create-vapi-structured-output.sh YOUR_ASSISTANT_ID
```

It will:
- create the structured output from the canonical config in [`../configs/vapi/structured-outputs/dental-call-intake.v1.json`](../configs/vapi/structured-outputs/dental-call-intake.v1.json)
- attach it to the assistant during the `POST /structured-output` call via `assistantIds`
- print the Vapi error body if creation fails

## Reading the result back

Use [`docs/vapi-structured-output-consumption.md`](./vapi-structured-output-consumption.md) for:
- webhook payload examples
- call API examples
- `jq` extraction snippets
- Node.js and n8n extraction examples

## Suggested interpretation

- `callOutcome` is the main business result.
- `successfulForAssistantScope` should still be `true` when the bot correctly refuses unsupported actions like cancellation or rescheduling.
- `booking.bookingCreated` should be `true` only if the tool actually created the visit.
- `riskFlags.medicalAdviceGiven` should almost always be `false`. If it turns `true`, treat that as a QA issue.
- `qualityFlags.*` are for transcript QA. They should stay `false` on clean calls and flip to `true` when the assistant loops, stacks questions, books without explicit confirmation, or mangles the phone readback.
- `followUp.receptionFollowUpNeeded` helps separate calls that need a human next step.

## Practical notes

- Do not make too many fields required. Extraction quality drops when the schema is over-constrained.
- This schema intentionally keeps most details optional and requires only the top-level outcome and summary fields.
- If you want separate outputs for QA and CRM, create two structured outputs instead of one very large schema.
- This repo already does that split for scorecard-compatible QA booleans under [`../configs/vapi/structured-outputs/`](../configs/vapi/structured-outputs/).

## Privacy note

This schema can capture personal and health-adjacent data such as:
- patient name
- phone number
- urgent symptom mentions

If your Vapi organization uses HIPAA mode or stricter privacy controls, do **not** enable forced storage for this output unless you have explicitly reviewed the compliance impact.
