# Codex Handoff: Safe Function Reintroduction

Use this prompt for the next Codex agent that should add back backend-ready
assistant functions without reintroducing the March 20-21, 2026 regression.

```text
You are Codex working in /home/choobek/repos/ai-receptionist.

Current state you must start from:
- The shared Vapi assistant was rolled back to the March 18, 2026 23:06-era
  behavior and committed as 1112a45 ("Rollback assistant prompt to March 18 baseline").
- Staging Vapi assistant sync was completed on 2026-03-21 and staging VPS was
  deployed at commit 1112a45.
- The user made a fresh Vapi web-call test after that rollback and reported
  that it sounds good again.
- Do not assume later prompt additions were improvements. The recent regression
  came from prompt/config accretion plus overfitted tests.
- There are unrelated local changes in the worktree that are not part of this
  rollback:
  - knowledge-base/clinic-knowledge.json
  - n8n/workflows/tool_search-knowledge-base.json
  - docs/real-call-evaluation-2026-03-21-first-visit-booking.md
  Do not revert them unless the user explicitly asks.

What we know about the good baseline:
- The best real-call reference point is around March 18, 2026 23:06.
- The closest repo snapshot is commit 22beee4.
- Two important real call logs from that era are:
  - 019d02fc-0455-7000-8fc9-8c0db3b598c8
  - 019d02f4-a8c8-7442-bac6-21fe28b113b6
- Those calls were not perfect, but the assistant behavior was clearly simpler
  and better overall than the later overfitted state.

Your goal:
- Add back backend-ready assistant functions carefully, one at a time, while
  preserving the restored March 18 conversation quality.
- Work on staging only.
- Do not broaden the assistant prompt in one shot.
- After each meaningful runtime change, sync staging and validate with a real
  Vapi web call before moving on.

Important repository context:
- Shared assistant config:
  - configs/vapi/assistant.v1.json
- Staging bindings:
  - configs/vapi/environments/staging.json
- Prompt mirrors:
  - prompts/system-prompt.md
  - prompts/first-message.md
- Vapi render/sync scripts:
  - scripts/render-vapi-assistant-config.sh
  - scripts/update-vapi-assistant.sh
  - scripts/update-vapi-tool-bindings.sh
  - scripts/update-vapi-tool-definition.sh
  - scripts/sync-vapi-environment.sh
- Deploy scripts:
  - scripts/deploy-vps.sh
  - scripts/import-n8n-workflows-vps.sh
- Tool contracts and schemas:
  - docs/tool-contracts.md
  - schemas/
  - n8n/workflows/tool_*.json
- Regression checks:
  - scripts/check-workflow-regressions.js
- Call-log inspection helpers:
  - docs/vapi-structured-output-consumption.md
  - scripts/autonomy/ingest-vapi-call-log.js

Likely candidates for reintroduction:
- sendSmsToReceptionists
- sendSmsToPatient
- Any other tool behavior that is already implemented and stable in backend,
  but is not currently part of the restored assistant behavior

Required approach:
1. Inventory which backend functions are truly ready in staging now.
2. Separate "tool exists in backend" from "assistant should actively use it".
3. Reintroduce only one feature slice at a time.
4. Keep prompt additions minimal and narrowly scoped.
5. Avoid adding sprawling high-priority instructions unless there is direct
   real-call evidence that they improve behavior.
6. Update or add tests only for durable invariants, not for brittle prompt
   wording.
7. Use staging only for Vapi sync/deploy.

Verification expectations:
- Run node scripts/check-workflow-regressions.js
- Run any focused direct tool checks that prove backend readiness
- Sync staging Vapi if assistant config or tool bindings/definitions changed
- Deploy staging if runtime/backend code changed
- Inspect the latest Vapi web-call log if behavior is ambiguous

Deliverables:
- A short readiness inventory of candidate functions
- The minimal implementation for the first safe reintroduction
- Updated tests that validate the reintroduced behavior without overfitting
- Commit, push, Vapi staging sync, and staging deploy

Be skeptical of synthetic success. Real web-call behavior is the tie-breaker.
```
