# Privacy Data Minimization Plan

## 1. Executive summary

### What is happening today

The repo already avoids explicit medical advice, but it still spreads health-adjacent call context across too many persistence surfaces after the conversation ends.

The biggest current issues are:

- the assistant prompt explicitly asks existing-patient and handoff callers for a `krótki opis` / `krótki summary` in the canonical assistant config at `configs/vapi/assistant.v2.json`
- `createReceptionTask` and `sendSmsToReceptionists` are designed around free-text `summary` and optional `notes`
- `createEvent` writes a dense calendar description including callback phone, live caller phone, SMS target, email, and `notes`
- the canonical post-call structured output in `configs/vapi/structured-outputs/dental-call-intake.v1.json` persists free-text `shortReasonNote`, `recommendedNextAction`, `shortSummaryPl`, and `receptionistNotePl`
- the `call.ended` router and live-autoeval tooling preserve patient identity, summaries, raw artifacts, raw call JSON, transcripts, tool payloads, and recording metadata beyond the live call itself

### What should change

The target state should be:

- the assistant can still book, hand off urgent cases, and support existing-patient follow-up
- the assistant should not need detailed symptom or treatment narratives to do that
- persisted data should move from free text to closed operational categories wherever possible
- live caller number should remain available in receptionist-facing booking and handoff surfaces when it materially helps identify the patient, but it should not be copied into unrelated summaries, router echoes, or observability artifacts
- post-call observability should keep QA and routing signals, but not default to storing raw narrative summaries

### What benefit we get

- smaller health-data footprint across n8n, SMS providers, calendar text, router payloads, and review artifacts
- lower risk that staff-facing summaries restate symptoms or treatment history unnecessarily
- lower risk that observability and QA tooling quietly become a second medical-notes system
- better alignment with a realistic small-team rollout: fewer sensitive fields, same booking/handoff usefulness

### What risk remains

- live speech, transcript text, and normal call recordings can still contain symptoms or treatment discussion
- booked appointments still need a patient name, declared callback phone, live caller phone where receptionist identification depends on it, slot, and service bucket
- urgent handling still needs an urgency signal, which remains health-adjacent

Recording redesign, consent redesign, retention redesign, and storage-provider redesign remain out of scope here.

### Canonical edit points

- Edit canonical prompt/config in `configs/vapi/assistant.v2.json`, not `prompts/` first.
- Edit canonical structured output config in `configs/vapi/structured-outputs/dental-call-intake.v1.json`, not `docs/vapi-structured-output.json`.
- After prompt changes, run `./scripts/sync-vapi-prompt-mirrors.sh`.
- After structured-output changes, run `./scripts/sync-vapi-observability-mirrors.sh`.

## 2. Current-state data map

### End-to-end flow

1. Live call
- Caller may mention pain, swelling, implants, follow-up treatment, prior visits, cancellation reasons, or other health-adjacent details in live speech.
- The assistant prompt in `configs/vapi/assistant.v2.json` asks for visit purpose and, on handoff branches, a short description/summary.

2. In-call tool usage
- `checkAvailability` uses service ID, date/time preferences, and optional existing-patient status. This is relatively low-risk.
- `createEvent` collects booking identity data and optional `notes`.
- `createReceptionTask` requires free-text `summary` and accepts `notes` plus `preferredCallbackWindow`.
- `sendSmsToReceptionists` repeats the task summary and notes in an internal SMS.

3. Booking persistence
- `n8n/workflows/tool_create-event.json` creates a Google Calendar event.
- The event `summary` and especially `description` persist service name, patient name, callback phone, live caller phone, SMS target, email, notes, and source.
- The same workflow also generates and returns booking SMS audit data.

4. Handoff persistence
- `n8n/workflows/tool_create-reception-task.json` stores the task in n8n execution payload/history with patient identity, phone context, summary, notes, callback window, and source call ID.
- `n8n/workflows/tool_send-sms-to-receptionists.json` propagates the same context into internal SMS text and provider metadata.

5. Post-call extraction and routing
- `configs/vapi/structured-outputs/dental-call-intake.v1.json` extracts and persists caller identity, visit intent, timing text, risk flags, follow-up reason, internal next-step text, short summary, and receptionist note.
- `n8n/workflows/webhook_vapi-call-ended-router.json` reads that output and carries identity, summary, note, follow-up detail, raw structured output, raw Vapi artifact, and raw event through the workflow.

6. QA, eval, and review artifacts
- `scripts/autonomy/ingest-vapi-call-log.js` converts real call logs into `run.v1`.
- `autonomy/schemas/run.v1.json` includes transcript text, recording URL, full conversation messages, tool args/results, structured output, and evaluation summary.
- `autonomy/schemas/staging-chat-run.v1.json` keeps transcript text, tool results, and transcript excerpts for staging synthetic scenarios.
- `docs/vapi-observability.md` explicitly documents raw call JSON plus normalized run storage side by side.

### Where health-related data can enter

- live caller speech and transcript
- prompt-driven collection of `krótki opis` / `krótki summary`
- structured-output free-text reason and summary fields
- calendar `description`
- internal SMS body text
- router response payloads
- real-call review artifacts and normalized runs

### Transient vs persisted today

Transient only, when the system behaves minimally:

- spoken urgency cues during the live call
- service selection inference inside the assistant turn
- live caller number used only to route a same-call SMS

Persisted today:

- patient name and phone in multiple tool payloads
- free-text task summary and optional notes
- health-adjacent visit/service labels in calendar and SMS
- free-text post-call summaries and receptionist notes
- raw transcript and tool payloads in normalized review artifacts
- raw Vapi artifacts and raw call JSON in observability flows

## 3. Findings by surface

| Surface / file | Current collection / derivation / persistence | Why risky or unnecessary | Severity | Confidence |
| --- | --- | --- | --- | --- |
| `configs/vapi/assistant.v2.json` | Prompt tells the assistant to gather `krótki opis` for existing-patient and handoff flows, and to have `krótki summary` before `createReceptionTask`. | This directly trains the model to solicit free-text reason narratives that later flow into tasks and SMS. | High | High |
| `prompts/system-prompt.md` | Readable mirror repeats the same handoff collection behavior. | Mirror is not canonical, but it reflects the live instruction set and can mislead future edits if not updated from canonical JSON. | Medium | High |
| `schemas/createReceptionTask.request.json` and `schemas/createReceptionTask.response.json` | `summary` is required; `notes` and `preferredCallbackWindow` are available; response echoes them back. | This makes narrative persistence the default task contract. | High | High |
| `n8n/workflows/tool_create-reception-task.json` | Stores task data in n8n execution payload/history with `patient`, `phoneContext`, `summary`, `notes`, `preferredCallbackWindow`, and `sourceCallId`; task channel is `n8n_execution_log`. | The workflow itself treats execution history as the task store, so any extra text becomes persistent operational data by default. | High | High |
| `schemas/sendSmsToReceptionists.request.json` and `schemas/sendSmsToReceptionists.response.json` | SMS contract requires `summary`, accepts `notes`, and returns `notification.body`. | Sensitive narrative is deliberately copied into internal SMS and provider-facing payloads. | High | High |
| `n8n/workflows/tool_send-sms-to-receptionists.json` | SMS body includes task type, patient full name, declared callback number, live caller number, summary, callback window, notes, task ID, and call ID. | Keeping both phone numbers can be operationally justified for receptionist identification, but the workflow still spreads narrative context and extra metadata into internal SMS and possibly an external SMS webhook provider. | High | High |
| `schemas/createEvent.request.json` | Booking allows optional `notes`. | This invites free-text booking notes that are not needed for basic scheduling. | Medium | High |
| `n8n/workflows/tool_create-event.json` | Calendar description stores service, patient name, callback phone, caller phone, SMS target, phone note, email, notes, and source. | Patient name plus both phone numbers can be operationally justified for receptionist identification, but the workflow still overcaptures by persisting extra metadata and free-text notes in the calendar record. | High | High |
| `n8n/workflows/tool_send-sms-to-patient.json` and embedded SMS path in `tool_create-event.json` | Patient SMS body includes full name and service name; webhook metadata includes phone context and appointment details. | Patient-facing SMS does not need to restate full name plus service bucket to remain useful; service labels can be health-adjacent. | Medium | High |
| `configs/vapi/structured-outputs/dental-call-intake.v1.json` | Persists caller identity, `primaryReason`, `visitType`, `shortReasonNote`, requested date/time text, service name, doctor name, urgent symptom flag, free-text `recommendedNextAction`, `shortSummaryPl`, and `receptionistNotePl`; `summary` is required. | This is the main source of narrative post-call persistence and it incentivizes turning messy live speech into durable internal notes. | High | High |
| `docs/vapi-structured-output.json` | Generated mirror of the same schema. | Not canonical, but it documents and normalizes the broad data shape for future users. | Low | High |
| `n8n/workflows/webhook_vapi-call-ended-router.json` | Carries patient identity, summary, receptionist note, follow-up reason, urgency, scorecards, raw structured output, raw artifact, and raw event in workflow state; booked/follow-up responses echo patient and summaries. | Even if only part of this reaches the final webhook response, the full payload sits in workflow execution history and expands the observability footprint. | High | High |
| `docs/vapi-structured-output-consumption.md` | Recommends storing `result.summary.shortSummaryPl`, logs `recommendedNextAction`, shows booked/follow-up responses with patient identity and summary, and says the router carries the raw Vapi artifact through. | The docs institutionalize broad downstream persistence instead of a minimized contract. | Medium | High |
| `scripts/autonomy/ingest-vapi-call-log.js` and `autonomy/schemas/run.v1.json` | Normalized real-call runs include transcript, recording URL, full conversation messages, tool args/results, structured output, and evaluation summary derived from `shortSummaryPl` when present. | This turns QA artifacts into a durable copy of the call and its extracted health-adjacent content. | High | High |
| `docs/vapi-observability.md` | Explicitly states that the live runner stores raw call JSON and normalized `run.v1` side by side. | This is a direct repo-level commitment to expanded storage of real-call data. | High | High |
| `autonomy/schemas/staging-chat-run.v1.json` and `docs/staging-regression-suite.md` | Synthetic staging runs keep transcripts, tool arguments/results, and transcript excerpts. | Lower privacy risk because scenarios are synthetic, but the shape still normalizes broad capture and should stay clearly separated from real-call storage. | Low | High |
| `docs/testing.md` and `docs/tool-contracts.md` | Tests and contracts explicitly expect calendar descriptions with both callback and live caller numbers, and use free-text summary/notes in task and SMS examples. | The current operating docs will reintroduce broad persistence unless they change with the code. | Medium | High |
| `docs/archive/real-call-evaluations/*` and `autonomy/examples/vapi-call-ended-sample-booking.json` | Archive docs and sample artifacts contain call IDs, names, phone numbers, summaries, and detailed observations. | Some of this is historical or synthetic, but it shows the repo already contains narrative call evidence and should be treated as cleanup scope. | Medium | High |

## 4. Proposed target data model

### Global design rules

Preferred persisted enums:

- `caseCategory`: `new_patient_first_visit`, `existing_patient_follow_up`, `reschedule_or_cancel`, `general_question`, `urgent_needs_callback`
- `serviceBucket`: `consultation`, `implant_consultation`, `orthodontic_consultation`, `aesthetic_consultation`, `hygiene`, `urgent_consultation`, `unknown`
- `callbackWindow`: `asap`, `morning`, `afternoon`, `evening`, `any`
- `phoneMatchStatus`: `matches_caller`, `different_from_caller`, `caller_unknown`

Preferred persisted fields across the system:

- `patient.fullName`
- `patient.callbackPhoneE164`
- `patient.callerPhoneE164` only in receptionist-facing booking and handoff artifacts
- `language`
- `caseCategory`
- `serviceBucket` only when operationally useful
- `isExistingPatient` or `firstVisit`
- `selectedSlotStart`, `selectedSlotEnd`, `timezone` for booked calls
- `callbackWindow` only when actually stated
- `sourceCallId` if an internal trace is useful
- `phoneMatchStatus` for machine-readable logic, while receptionist-facing surfaces may still keep both declared and live caller numbers when that improves patient identification

Default rule:

- free text from the assistant should be considered forbidden for persistence unless a concrete operational consumer can justify it
- if a legacy text field must remain temporarily for compatibility, it should be generic and category-derived, not caller-derived

### By use case

| Use case | Allowed transient spoken content | Allowed persisted structured fields | Forbidden or discouraged persisted free text |
| --- | --- | --- | --- |
| First-visit booking | Caller may discuss symptoms, implants, aesthetics, pricing, or uncertainty while choosing the right booking bucket. | `fullName`, `callbackPhoneE164`, optional `callerPhoneE164`, `language`, `caseCategory=new_patient_first_visit`, `serviceBucket`, `firstVisit=true`, `slotStart`, `slotEnd`, `timezone`, optional `phoneMatchStatus`, optional `sourceCallId` | symptom narrative, diagnosis-like phrases, treatment history, `notes`, reason summaries, staff notes that restate what hurts |
| Existing-patient handoff | Caller may mention prior treatment or follow-up context during conversation. | `fullName`, `callbackPhoneE164`, optional `callerPhoneE164`, `language`, `caseCategory=existing_patient_follow_up`, optional `serviceBucket`, optional `callbackWindow`, `isExistingPatient=true`, optional `phoneMatchStatus`, `sourceCallId` | `short description`, `summary`, treatment-history narrative, clinician-specific notes, symptom prose |
| Reschedule / cancel | Caller may mention the affected visit in natural speech. | `fullName`, `callbackPhoneE164`, optional `callerPhoneE164`, `language`, `caseCategory=reschedule_or_cancel`, optional `callbackWindow`, `isExistingPatient=true`, optional `phoneMatchStatus`, `sourceCallId` | free-text explanation for why the visit is being moved/cancelled |
| General question | Caller may ask a service or policy question. | `language`, `caseCategory=general_question`, optional `callbackPhoneE164` only if human follow-up is requested | knowledge-base restatement as internal summary, treatment-interest prose |
| Urgent case | Caller may say pain, swelling, bleeding, infection, trauma, or similar urgent cues. | `fullName` and `callbackPhoneE164` only if handoff or booking requires them, `caseCategory=urgent_needs_callback` or booked `serviceBucket=urgent_consultation`, `callbackWindow=asap`, urgency boolean/category, slot fields if booked | symptom narrative, severity story, inferred diagnosis, free-text urgency summary |

## 5. Proposed changes

### Prompt changes

| File(s) likely affected | What to change | Why | Impact / risk | Phase |
| --- | --- | --- | --- | --- |
| `configs/vapi/assistant.v2.json` | Replace instructions to gather `krótki opis` / `krótki summary` with category-first capture. The handoff branch should ask only for identity plus, at most, `caseCategory`, optional `serviceBucket`, and optional `callbackWindow`. | Stops the model from collecting narrative medical context just to satisfy downstream text fields. | Low implementation risk; high behavior impact in the right direction. | Phase 1 |
| `configs/vapi/assistant.v2.json` | Add an explicit rule: do not ask for symptoms, treatment history, or detailed visit purpose unless required to choose between supported operational categories. | Keeps live conversation usable while preventing accidental “tell me more about the problem” loops. | Low risk. | Phase 1 |
| `configs/vapi/assistant.v2.json` | Tighten urgent behavior: once the caller gives an urgent cue, go straight to urgent lookup or urgent handoff without asking follow-up symptom questions. | Preserves urgency handling without turning the bot into a symptom collector. | Low risk; already aligned with current urgent-first design. | Phase 1 |
| `configs/vapi/assistant.v2.json` | Add a rule for acknowledgements and confirmations: never restate symptoms or treatment history in spoken summaries, only the operational branch and scheduling outcome. | Reduces the chance that structured outputs or transcripts echo sensitive details again. | Low risk. | Phase 1 |

### Schema changes

| File(s) likely affected | What to change | Why | Impact / risk | Phase |
| --- | --- | --- | --- | --- |
| `schemas/createReceptionTask.request.json`, `schemas/createReceptionTask.response.json` | Replace required `summary` with structured fields such as `caseCategory`, optional `serviceBucket`, optional `callbackWindow`, `isExistingPatient`, `phoneMatchStatus`. Deprecate `notes`. | Makes the task contract operational instead of narrative. | Medium because downstream workflows and tests must change together. | Phase 2 |
| `schemas/sendSmsToReceptionists.request.json`, `schemas/sendSmsToReceptionists.response.json` | Mirror the same minimized task shape; remove free-text `summary` / `notes` from the long-term contract. | Prevents SMS alerts from depending on narrative content. | Medium. | Phase 2 |
| `schemas/createEvent.request.json`, `schemas/createEvent.vapi.request.json` | Mark `notes` as deprecated for assistant-driven bookings and ignore it by default in workflows. Keep both declared callback and live caller number available for receptionist-facing booking flows, but avoid copying them into non-operational responses and artifacts. | Booking does not need prose notes, but the receptionist may still need both numbers for identification. | Medium. | Phase 2 |
| `schemas/createEvent.response.json`, `schemas/sendSmsToPatient.response.json` | Return delivery status and recipient class only; stop returning full SMS body by default. | Avoids persisting the outgoing SMS text in every tool result. | Medium. | Phase 2 |
| `configs/vapi/structured-outputs/dental-call-intake.v1.json` | Remove or replace `caller.phoneRaw`, `intent.shortReasonNote`, `timing.requestedDateText`, `timing.requestedTimeText`, `booking.serviceName`, `booking.doctorName`, `followUp.recommendedNextAction`, `summary.shortSummaryPl`, and `summary.receptionistNotePl`. Keep only minimized routing and QA fields. | This is the highest-value schema minimization step. | Medium-high because router/docs/tests depend on the current shape. | Phase 2 |

### n8n workflow changes

| File(s) likely affected | What to change | Why | Impact / risk | Phase |
| --- | --- | --- | --- | --- |
| `n8n/workflows/tool_create-reception-task.json` | Persist only minimal task fields in the execution payload: patient name, declared callback phone, optional live caller phone, case category, optional service bucket, optional callback window, optional phone-match status, source call ID. Do not persist AI-generated summary/notes. | n8n execution history is currently the proof-of-concept task store, so this surface must be minimal by default while still supporting receptionist identification. | Medium. | Phase 2 |
| `n8n/workflows/tool_send-sms-to-receptionists.json` | Build internal SMS from structured receptionist-facing data: case category, patient name, declared callback phone, live caller phone, callback window, and task ID. Remove free-text summary, notes, and non-essential metadata, but keep both numbers for identification. | Internal alerts should stay actionable without becoming sensitive mini-notes. | Medium. | Phase 1 |
| `n8n/workflows/tool_create-event.json` | Shrink Google Calendar description to receptionist-essential identity and scheduling data: patient full name, declared callback phone, live caller phone, source call ID, and optionally language/service bucket if the clinic truly needs them. Remove SMS target, email, notes, and phone note from the description. | Calendar is a persistent operational record and should keep receptionist-useful identity without carrying narrative or extra metadata. | Low-medium; high privacy benefit. | Phase 1 |
| `n8n/workflows/tool_send-sms-to-patient.json` and embedded SMS logic in `tool_create-event.json` | Make patient SMS generic: clinic name, date, time, and contact instruction. Remove patient full name and service name unless the owner explicitly wants them. Minimize provider webhook metadata. | Patient SMS does not need to restate health-adjacent visit details to be useful. | Low-medium. | Phase 1 |
| `n8n/workflows/webhook_vapi-call-ended-router.json` | Stop carrying `rawStructuredOutput`, `rawArtifact`, and `rawEvent` in normal flow. Return only the minimum needed for downstream routing. On booked routes, do not expose patient phone by default. On follow-up routes, include identity only if a downstream human action truly depends on it. | The router is a quiet replication surface today. | Medium. | Phase 1 |

### Structured output / eval / scorecard changes

| File(s) likely affected | What to change | Why | Impact / risk | Phase |
| --- | --- | --- | --- | --- |
| `configs/vapi/structured-outputs/dental-call-intake.v1.json` | Keep QA booleans and routing booleans/enums; remove free-text summary/note generation. Prefer `caseCategory`, `serviceBucket`, `followUpReasonCategory`, `urgentFlag`, `bookingCreated`. | Preserves utility for routing and QA while removing narrative persistence. | Medium-high. | Phase 2 |
| `configs/vapi/scorecards/*.json` | Update scorecards only as needed to follow renamed minimized structured-output keys. Do not add any metric that rewards richer summaries. | Scorecards should remain behavior-focused, not summary-focused. | Low. | Phase 2 |
| `configs/vapi/evals/*.json` and staging scenarios | Add checks that the assistant does not ask for detailed symptom/treatment descriptions on urgent and handoff flows, and that handoff tool args remain category-based. | Prevents regression back into over-collection. | Low-medium. | Phase 3 |
| `configs/vapi/autoevaluation-policy.v1.json` | Keep safety QA signals, but avoid any future policy that depends on narrative summary quality. Add privacy-focused QA signals only if they are transcript-detectable and durable. | Stops observability from incentivizing richer data capture. | Low. | Phase 3 |
| `scripts/autonomy/ingest-vapi-call-log.js`, `autonomy/schemas/run.v1.json`, `docs/vapi-observability.md` | For real calls, default to redacted or minimized normalized artifacts: no transcript text, no recording URL, no free-text summary import, no raw caller identity beyond what is operationally justified for review. Keep synthetic staging artifacts separate. | This is the main observability cleanup needed to avoid silent footprint growth. | Medium-high because triage habits will need to adjust. | Phase 3 |

### Calendar / SMS / task text changes

| File(s) likely affected | What to change | Why | Impact / risk | Phase |
| --- | --- | --- | --- | --- |
| `n8n/workflows/tool_create-event.json` | Calendar summary format should stay operational, for example `Konsultacja - Jan Kowalski`, and the description may keep full name plus both phone numbers for receptionist identification, but it should not include notes, email, SMS target, or narrative callback context. | Keeps front-desk usefulness while dropping excess detail. | Low-medium. | Phase 1 |
| `n8n/workflows/tool_send-sms-to-receptionists.json` | Internal SMS should read like a queue alert, not a case note. Example: case category, patient, declared callback phone, live caller phone, callback window, task ID. | Enough for actionability; avoids symptom/treatment narrative while keeping receptionist-identification data. | Low-medium. | Phase 1 |
| `n8n/workflows/tool_send-sms-to-patient.json` | Patient SMS should confirm an appointment generically without repeating service type or patient name unless explicitly retained by product decision. | Reduces health-adjacent disclosure through SMS providers and lock-screen previews. | Low-medium. | Phase 1 |
| `schemas/*`, `docs/tool-contracts.md`, `docs/testing.md` | If temporary compatibility requires a text field, populate it with fixed category-derived text such as `Recepcja: existing_patient_follow_up`. Do not let the model synthesize patient-specific prose. | Provides a low-risk transition path. | Low. | Phase 1 |

## 6. Prioritized rollout plan

### Phase 1: high-impact / low-risk quick wins

Scope:

- canonical prompt change in `configs/vapi/assistant.v2.json`
- minimize calendar description and both SMS templates without removing receptionist-critical identity fields
- stop propagating raw structured output / raw artifact / raw event through the router
- keep legacy text fields only as generic placeholders if compatibility is temporarily required

Acceptance criteria:

- assistant no longer asks for `krótki opis` / detailed symptom context on handoff flows
- urgent calls trigger urgent lookup or urgent handoff without extra symptom probing
- calendar description keeps patient full name plus declared and live caller phone numbers, but no longer stores SMS target, notes, or email by default
- internal receptionist SMS keeps both phone numbers for identification, but no longer includes summary/notes or other narrative context
- booked call router response no longer includes patient phone or free-text summary by default
- prompt mirror and structured-output mirror sync steps are documented and followed

### Phase 2: schema + workflow minimization

Scope:

- replace free-text task and alert contracts with enum-based structures
- deprecate `createEvent.notes` for assistant-driven bookings
- slim the canonical `dental-call-intake` structured output to routing and QA essentials
- update router parsing and any workflow consumers to the minimized schema

Acceptance criteria:

- no AI-generated free-text summary/note field is required anywhere in the main booking/handoff path
- task, SMS, router, and structured-output payloads rely on closed categories instead of prose
- existing-patient, urgent, reschedule, and first-visit flows still pass staging booking/handoff regressions
- mirror files are regenerated from canonical configs

### Phase 3: observability / evaluation cleanup

Scope:

- real-call autoeval artifacts become redacted/minimized by default
- docs stop recommending storage of `shortSummaryPl` or raw artifacts
- staging synthetic artifacts remain clearly synthetic and isolated
- add regression checks for “do not over-ask” behavior

Acceptance criteria:

- live autoeval no longer writes raw real-call transcript plus full normalized run by default
- normalized real-call runs no longer depend on structured-output summaries for evaluation text
- docs and scripts describe minimized storage expectations
- new privacy regressions fail when the assistant asks for symptom narratives or when workflows reintroduce free-text persistence

## 7. Testing and regression plan

### Verify booking usefulness is preserved

Keep the existing release gate and add privacy-focused assertions:

- `node scripts/check-workflow-regressions.js`
- `./scripts/run-staging-regression-suite.sh`
- `./scripts/run-vapi-eval-suite.sh staging`
- `./scripts/run-vapi-live-autoeval.sh staging --limit <small-number>` after the observability phase

### Staging checks to add

- `createEvent` contract check: calendar `description` keeps patient full name plus declared and live caller phone numbers, but does not contain notes, SMS target, or email by default.
- `createReceptionTask` contract check: task payload contains categories, not AI-generated summary prose.
- `sendSmsToReceptionists` contract check: internal SMS body contains operational category data plus patient-identification data, including both phone numbers, but no free-text summary or notes.
- `sendSmsToPatient` and embedded booking SMS check: body omits patient full name and service name unless explicitly approved.
- `webhook_vapi-call-ended-router` contract check: no `rawStructuredOutput`, `rawArtifact`, `rawEvent`, or free-text summary/note in normal routing outputs.
- real-call ingest check: redacted/minimized autoeval artifacts for real calls do not contain raw transcript text by default.

### Prompt / eval / regression scenarios to add

- Existing patient says: “to kontrola po leczeniu kanałowym” or similar. Expected: handoff category only, no detail-seeking, no narrative task note.
- Urgent caller says: “boli mnie ząb i mam opuchliznę”. Expected: immediate urgent lookup or urgent handoff, no follow-up symptom interrogation.
- Caller volunteers detailed implant/treatment history before first visit. Expected: service bucket selection without persisting the narrative.
- Reschedule caller gives appointment context. Expected: category-based task creation, no prose summary in task/SMS.
- Booking confirmation path. Expected: event and patient SMS stay operational and minimal.

### Edge cases

- urgent caller who wants a callback rather than immediate slot lookup
- existing patient whose requested service bucket is clear (`hygiene`) versus unclear (`kontrola po leczeniu`)
- caller phone differs from declared callback number
- general-question caller who later asks for human follow-up
- caller who volunteers health detail even when the assistant does not ask for it

## 8. Residual risk and explicit tradeoffs

What still remains sensitive:

- live speech and transcript text can still contain symptoms or treatment context
- call recordings and transcript providers still see raw conversational content
- booked events still need patient identity, declared callback phone, live caller phone, time slot, and service bucket
- urgent flags and some service buckets still reveal dental-treatment context at a high level

What we intentionally keep:

- full name
- declared callback phone
- live caller phone in receptionist-facing artifacts
- slot, timezone, and language
- first-visit / existing-patient routing
- high-level operational case category
- urgent routing signal

What becomes slightly less rich:

- reception loses AI-written narrative summaries and notes
- calendar entries become less self-explanatory as mini case notes
- some manual follow-up calls may need one extra clarifying question from staff

Why the tradeoff is worth it:

- the current design spreads the same call context into too many systems
- narrative summaries create little extra scheduling value compared with category + callback data
- reducing post-call prose materially lowers the chance that the project becomes a shadow clinical-notes system

## 9. Open questions / decisions for the human owner

- Should patient-facing SMS keep `serviceBucket`, or should it become fully generic appointment confirmation text?
- For existing-patient handoff, is `serviceBucket` operationally needed when the caller clearly says `hygiene`, or is `existing_patient_follow_up` enough?
- Should both phone numbers remain limited to receptionist-facing artifacts such as calendar descriptions, receptionist SMS, and handoff tasks, while staying out of router echoes and autoeval artifacts?
- Should real-call autoeval artifacts be redacted by default, or should raw-call retention remain available only behind an explicit debug flag?
- Do the historical real-call review docs need a one-time cleanup pass before a client rollout?

## Appendix

### Candidate replacement enums

```json
{
  "caseCategory": [
    "new_patient_first_visit",
    "existing_patient_follow_up",
    "reschedule_or_cancel",
    "general_question",
    "urgent_needs_callback"
  ],
  "serviceBucket": [
    "consultation",
    "implant_consultation",
    "orthodontic_consultation",
    "aesthetic_consultation",
    "hygiene",
    "urgent_consultation",
    "unknown"
  ],
  "callbackWindow": [
    "asap",
    "morning",
    "afternoon",
    "evening",
    "any"
  ],
  "phoneMatchStatus": [
    "matches_caller",
    "different_from_caller",
    "caller_unknown"
  ]
}
```

### Example minimized payload shapes

```json
{
  "calendarEvent": {
    "summary": "Konsultacja - Jan Kowalski",
    "description": "Patient: Jan Kowalski\nCallback phone: +48500100200\nCaller phone: +48500999888\nLanguage: pl\nSource call: call_123"
  }
}
```

```json
{
  "receptionTask": {
    "taskType": "existing_patient_follow_up",
    "patient": {
      "fullName": "Anna Kowalska",
      "phoneE164": "+48500111001",
      "callerPhoneE164": "+48500999111",
      "isExistingPatient": true
    },
    "caseCategory": "existing_patient_follow_up",
    "serviceBucket": "hygiene",
    "callbackWindow": "morning",
    "phoneMatchStatus": "matches_caller",
    "sourceCallId": "call_123"
  }
}
```

```json
{
  "receptionSms": "Nowa prosba recepcji: existing_patient_follow_up. Pacjent: Anna Kowalska. Telefon do kontaktu: +48500111001. Numer dzwoniacy: +48500999111. Usluga: hygiene. Kontakt: morning. Task ID: task_123."
}
```

```json
{
  "patientSms": "Ipokrzyku.pl: Potwierdzenie wizyty na wtorek, 24 marca, 10:30. W razie zmian prosimy o kontakt z recepcja."
}
```
