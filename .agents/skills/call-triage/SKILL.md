---
name: "call-triage"
description: "Use for turning staging failures, live autoeval evidence, and run.v1 artifacts into bounded fixes instead of prompt sprawl."
---

# Call Triage

Use this skill whenever the task starts from staging regression failures, live-call autoeval results, or `run.v1` artifacts.

## Evidence Sources

- Staging chat suite outputs under `autonomy/runs/generated/staging/`
- Staging chat reports under `autonomy/reports/generated/staging/`
- Live autoeval outputs under `autonomy/runs/generated/vapi-live-autoeval/`
- Live autoeval reports under `autonomy/reports/generated/vapi-live-autoeval/`
- Normalized `run.v1` data under the corresponding run directory

## Triage Rules

- Prefer durable fixes over one-off prompt wording changes.
- Ask whether the failure is:
  - prompt issue
  - tool contract mismatch
  - schema gap
  - workflow bug
  - environment issue
  - false failure
- Require repeated real-call evidence before widening shared prompt behavior.

## Fix Boundaries

- If the issue is a stable contract bug, patch workflow JSON or validation logic.
- If the issue is an environment-specific drift, patch bindings or sync state, not the shared prompt.
- If the issue is only visible in live calls, derive a narrow invariant and add it to the right verification lane before broadening behavior.

## Do Not

- Do not turn isolated call anecdotes into broad prompt growth.
- Do not treat the saved Vapi eval lane as the release gate.
- Do not certify a fix without rerunning the relevant invariant or evidence lane.
