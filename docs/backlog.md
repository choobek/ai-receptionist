# PDF Alignment Backlog

This backlog maps the current proof-of-concept implementation to the target conversation flow from `Schemat blokowy - scenariusz rozmowy test01.pdf`.

## Status summary

- Implemented before this backlog:
  - `checkAvailability`
  - `createEvent`
  - post-call structured output router
- Implemented in this slice:
  - proof-of-concept receptionist task creation
  - proof-of-concept local knowledge base from ODT files
  - optional SMS tool contracts/workflows with `mock` mode and webhook handoff mode
- Still missing after this slice:
  - concrete production SMS provider selection and credential wiring
  - doctor-specific scheduling
  - real clinic CRM integration

## Phase 0: Core Booking

Status: done

- Answer calls and classify caller intent.
- Offer appointment slots from Google Calendar.
- Create calendar bookings after explicit confirmation.

## Phase 1: Existing Patient And Reception Branch

Status: in progress

- Keep `lookupPatient` limited to phone normalization and speech-safe readback support.
- Add `createReceptionTask` so the assistant can queue cases for human follow-up instead of only refusing unsupported requests.
- Update the prompt so existing patients, reschedules, and urgent/manual cases route into the receptionist path when tooling requires it.

Acceptance criteria:

- The assistant can create a receptionist follow-up task during the call.
- The assistant only promises a callback after `createReceptionTask` succeeds.

## Phase 2: Knowledge Base From PDFs

Status: in progress

- Extract, chunk, and normalize the clinic source documents into a retrieval-ready knowledge base.
- Add a retrieval path that the assistant can use for general non-medical clinic questions.
- Define curation rules for pricing, policy, and doctor/service descriptions.
- Replace keyword-based search with a stronger retrieval approach when the corpus grows.

Acceptance criteria:

- Questions about clinic organization and basic service information are answered from source material.
- When the answer is missing, the assistant says so and optionally creates a receptionist follow-up task.

## Phase 3: SMS Automations

Status: in progress

- Add `sendSmsToReceptionists` using a real SMS provider or clinic communication system.
- Add `sendSmsToPatient` for booking confirmations after successful appointment creation.
- Keep explicit delivery status handling and failure messaging.

Acceptance criteria:

- Existing-patient/manual cases trigger a receptionist SMS or task in a real downstream system.
- Booked patients can receive a confirmation SMS after `createEvent`.

## Phase 4: Doctor-Specific Routing

Status: not started

- Model doctor-specific calendars or doctor assignment rules.
- Support the PDF rule that first-visit patients should default to dr Magdalena Szajnar.
- Make doctor assignment explicit in tool output so the assistant never implies confirmation without system support.

Acceptance criteria:

- First-visit bookings can be checked against the correct doctor availability.
- The assistant only states doctor assignment when the tool confirms it.

## Open inputs needed from clinic

- Preferred SMS provider or existing clinic communication tool.
- Whether existing patients should always route to reception or only for specific request types.
