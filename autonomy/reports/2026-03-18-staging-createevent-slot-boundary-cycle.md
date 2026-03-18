# Staging Improvement Cycle: createEvent Slot Boundary

Date: `2026-03-18`

## Targeted Failure Cluster

- Repeated staging booking regressions around `all-on-four-inquiry-to-booking`
- Root issue: the assistant kept sending `createEvent.slotEnd` as `10:00` after selecting a `09:30-10:15` slot
- The old suite could miss this when downstream workflow normalization rewrote the end time

## Before

- Current staging with stricter eval: `autonomy/reports/generated/staging/staging-regression-20260318T203941988Z.md`
- Result: `0/1` passed
- Failure: `createEvent did not send the exact selected slot boundaries`
- Evidence: selected slot `2026-03-19T09:30:00+01:00 -> 2026-03-19T10:15:00+01:00`, tool call sent `slotEnd=2026-03-19T10:00:00+01:00`

## Change Applied

- Tightened the repo-owned Vapi prompt with an explicit selected-slot copy rule and concrete `09:30 -> 10:15` example
- Added a repo-backed staging Vapi tool-definition sync for `createEvent`
- Switched that tool-definition sync to a simplified Vapi-facing schema
- Tightened the local regression evaluator so it checks the actual `createEvent` arguments, not only the normalized result
- Updated repo contract docs and schema examples to make slot-boundary precedence explicit

## Staging Sync

- Ran `./scripts/sync-vapi-environment.sh staging`
- Ran `./scripts/update-vapi-tool-definition.sh staging createEvent`
- Production was not touched
- No phone binding was changed

## After

- Full staging suite: `autonomy/reports/generated/staging/staging-regression-20260318T205009589Z.md`
- Result: `6/7` passed
- The original slot-boundary defect is fixed: later booking attempts sent `slotEnd=2026-03-19T10:15:00+01:00`
- Remaining failure: `all-on-four-inquiry-to-booking` still fails because Vapi reports `No result returned` for `createEvent`, even though the staging webhook succeeds when replayed directly with the same wrapped payload

## Conclusion

- Improvement landed: the highest-value repo-backed failure cluster was corrected at the prompt/tool-contract layer
- Remaining blocker appears to be a staging Vapi tool-runtime issue rather than the original slot-boundary regression
