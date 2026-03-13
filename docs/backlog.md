# PDF Alignment Backlog

This backlog maps the current proof-of-concept implementation to the target conversation flow from `Schemat blokowy - scenariusz rozmowy test01.pdf`.

## Status summary

- Implemented before this backlog:
  - `checkAvailability`
  - `createEvent`
  - post-call structured output router
- Implemented in this slice:
  - proof-of-concept mock patient registry
  - proof-of-concept receptionist task creation
  - proof-of-concept local knowledge base from ODT files
- Still missing after this slice:
  - real receptionist SMS sending
  - patient confirmation SMS sending
  - doctor-specific scheduling
  - real clinic CRM integration

## Phase 0: Core Booking

Status: done

- Answer calls and classify caller intent.
- Offer appointment slots from Google Calendar.
- Create calendar bookings after explicit confirmation.

## Phase 1: Existing Patient And Reception Branch

Status: in progress

- Add `lookupPatient` as a mock CRM lookup against a static proof-of-concept patient list.
- Add `createReceptionTask` so the assistant can queue cases for human follow-up instead of only refusing unsupported requests.
- Update the prompt so existing patients, reschedules, and urgent/manual cases route into the receptionist path when tooling requires it.

Acceptance criteria:

- The assistant can identify a known test patient by phone or full name.
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

Status: not started

- Add `sendSmsToReceptionists` using a real SMS provider or clinic communication system.
- Add `sendSmsToPatient` for booking confirmations after successful appointment creation.
- Add explicit delivery status handling and failure messaging.

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

## Phase 5: Real CRM Integration

Status: not started

- Replace the mock patient registry with the real clinic software integration.
- Replace proof-of-concept receptionist task storage with real task creation or CRM notes.
- Map clinic-specific patient IDs, appointment references, and follow-up statuses.

Acceptance criteria:

- Patient lookup uses the clinic system instead of static mock data.
- Reception tasks and booking context are visible to clinic staff in their production workflow.

## Open inputs needed from clinic

- Preferred SMS provider or existing clinic communication tool.
- Real CRM/vendor details and access model.
- Whether existing patients should always route to reception or only for specific request types.
