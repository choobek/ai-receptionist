# Consuming Vapi Structured Output

This guide shows how to read the minimized dental assistant structured output after a call ends.

Relevant Vapi paths:
- webhook event: `body.call.artifact.structuredOutputs`
- webhook event: `body.call.artifact.scorecards`
- call API response: `call.artifact.structuredOutputs`
- call API response: `call.artifact.scorecards`
- extracted payload for one output: `call.artifact.structuredOutputs[outputId].result`

## Expected payload shape

Vapi returns structured outputs as an object keyed by output ID.

Example:

```json
{
  "type": "call.ended",
  "call": {
    "id": "call_abc123",
    "artifact": {
      "structuredOutputs": {
        "dff8d16d-1f39-4d46-9f3d-370c8ecaeb40": {
          "name": "Dental Call Intake",
          "result": {
            "callOutcome": "appointment_booked",
            "successfulForAssistantScope": true,
            "language": "pl",
            "caseCategory": "new_patient_first_visit",
            "serviceBucket": "consultation",
            "booking": {
              "bookingCreated": true,
              "serviceId": "consultation",
              "firstVisit": true
            },
            "timing": {
              "selectedSlotStart": "2026-03-12T09:00:00+01:00"
            }
          }
        }
      }
    }
  }
}
```

## Read it in a webhook

### Node.js example

```js
function getStructuredOutputByIdOrName(call, outputId, outputName) {
  const outputs = call?.artifact?.structuredOutputs ?? {};

  if (outputId && outputs[outputId]?.result) {
    return outputs[outputId].result;
  }

  for (const [, output] of Object.entries(outputs)) {
    if (output?.name === outputName) {
      return output.result ?? null;
    }
  }

  return null;
}

export async function handleVapiWebhook(req, res) {
  const event = req.body;

  if (event?.type !== "call.ended") {
    return res.status(200).json({ ignored: true });
  }

  const result = getStructuredOutputByIdOrName(
    event.call,
    process.env.VAPI_STRUCTURED_OUTPUT_ID,
    "Dental Call Intake"
  );

  if (!result) {
    return res.status(200).json({
      ignored: true,
      reason: "structured_output_missing"
    });
  }

  const bookingCreated = result.booking?.bookingCreated === true;
  const urgent = result.riskFlags?.urgentSymptomsMentioned === true;
  const followUpNeeded = result.followUp?.receptionFollowUpNeeded === true;

  console.log("Structured output:", {
    callOutcome: result.callOutcome,
    caseCategory: result.caseCategory,
    serviceBucket: result.serviceBucket,
    bookingCreated,
    followUpNeeded
  });

  if (bookingCreated) {
    console.log("Booked call:", result.booking?.serviceId);
  }

  if (urgent || followUpNeeded) {
    console.log("Needs human review:", result.followUp?.reason);
  }

  return res.status(200).json({ ok: true });
}
```

### What to store downstream

Recommended minimum fields for automation:
- `call.id`
- structured output ID or `name`
- `result.callOutcome`
- `result.caseCategory`
- `result.serviceBucket`
- `result.booking.bookingCreated`
- `result.booking.serviceId`
- `result.followUp.receptionFollowUpNeeded`
- `result.followUp.reason`

Avoid treating this output as a free-text notes channel.

## Read it from the Call API

Get the full call object:

```bash
curl -sS "https://api.vapi.ai/call/YOUR_CALL_ID" \
  -H "Authorization: Bearer $VAPI_API_KEY" | jq .
```

Extract the dental structured output by ID:

```bash
curl -sS "https://api.vapi.ai/call/YOUR_CALL_ID" \
  -H "Authorization: Bearer $VAPI_API_KEY" | \
jq -r '.artifact.structuredOutputs["dff8d16d-1f39-4d46-9f3d-370c8ecaeb40"].result'
```

Extract by name when you do not want to hardcode the ID in logic:

```bash
curl -sS "https://api.vapi.ai/call/YOUR_CALL_ID" \
  -H "Authorization: Bearer $VAPI_API_KEY" | \
jq -r '
  .artifact.structuredOutputs
  | to_entries[]
  | select(.value.name == "Dental Call Intake")
  | .value.result
'
```

## n8n Code node example

If your Vapi webhook lands in n8n, a Code node can extract the result like this:

```js
const event = $json;
const outputs = event.call?.artifact?.structuredOutputs || {};
const outputId = 'dff8d16d-1f39-4d46-9f3d-370c8ecaeb40';

const result =
  outputs[outputId]?.result ||
  Object.values(outputs).find((item) => item?.name === 'Dental Call Intake')?.result ||
  null;

return [
  {
    json: {
      callId: event.call?.id || null,
      structuredOutputFound: Boolean(result),
      callOutcome: result?.callOutcome || null,
      caseCategory: result?.caseCategory || null,
      serviceBucket: result?.serviceBucket || null,
      bookingCreated: result?.booking?.bookingCreated === true,
      followUpNeeded: result?.followUp?.receptionFollowUpNeeded === true
    }
  }
];
```

## Ready-made n8n workflow

This repo includes an importable n8n workflow:

- [`n8n/workflows/webhook_vapi-call-ended-router.json`](../n8n/workflows/webhook_vapi-call-ended-router.json)

It exposes:
- `POST /webhook/ai-receptionist/vapi-call-ended`

What it does:
- accepts Vapi webhook events
- ignores non-`call.ended` events
- reads the structured output by `VAPI_STRUCTURED_OUTPUT_ID`
- falls back to the output named `Dental Call Intake`
- routes into:
  - `booked`
  - `needs_reception_follow_up`
  - `ignored`

Recommended environment variable:

```bash
VAPI_STRUCTURED_OUTPUT_ID=dff8d16d-1f39-4d46-9f3d-370c8ecaeb40
```

Example response for a booked call:

```json
{
  "accepted": true,
  "route": "booked",
  "reason": "booking_created",
  "callId": "call_abc123",
  "caseCategory": "new_patient_first_visit",
  "booking": {
    "serviceBucket": "consultation",
    "selectedSlotStart": "2026-03-12T09:00:00+01:00",
    "bookingCreated": true
  }
}
```

Example response for receptionist follow-up:

```json
{
  "accepted": true,
  "route": "needs_reception_follow_up",
  "reason": "structured_output_follow_up",
  "callId": "call_def456",
  "patient": {
    "fullName": "Jan Kowalski",
    "phone": "+48500100200"
  },
  "caseCategory": "reschedule_or_cancel",
  "serviceBucket": "unknown",
  "followUp": {
    "followUpNeeded": true,
    "followUpReason": "reschedule_or_cancel",
    "urgentSymptoms": false
  }
}
```

## Recommended automation branches

Suggested downstream routing:
- `callOutcome == "appointment_booked"`: mark as booked and archive
- `followUp.receptionFollowUpNeeded == true`: create receptionist task
- `riskFlags.urgentSymptomsMentioned == true`: prioritize review
- `callOutcome == "cancellation_or_reschedule_requested"`: route to human flow
- missing structured output: log and inspect tool results and scorecards

## Operational notes

- Structured output is produced after the call ends, so consume it from `call.ended` style events or by fetching the call after completion.
- The root object is keyed by output UUID, not by output name.
- In production, prefer matching by known output ID first and by name only as fallback.
- If HIPAA mode is enabled, Vapi docs say structured outputs may be available only through webhook flow unless storage is explicitly allowed for non-sensitive data.
