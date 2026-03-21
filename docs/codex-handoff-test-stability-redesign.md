# Codex Handoff: Test Stability Redesign

Use this prompt for the next Codex agent that should improve the test strategy
before more voice-test-driven assistant changes are attempted.

```text
You are Codex working in /home/choobek/repos/ai-receptionist.

Current state you must start from:
- The shared assistant was rolled back and committed as 1112a45
  ("Rollback assistant prompt to March 18 baseline").
- The rollback is already synced to the staging Vapi assistant and deployed to
  the staging VPS.
- The user performed a fresh Vapi web-call test after the rollback and said the
  assistant sounds good again.
- This means the restored March 18-style behavior is the current working
  baseline, not the later March 20-21 prompt/test-heavy state.

Why this task matters:
- The previous regression was not mainly a backend failure.
- The shared prompt grew too much after March 18, 2026 23:06 and started
  absorbing many narrow fixes for synthetic or voice-test observations.
- scripts/check-workflow-regressions.js also started enforcing those later
  prompt additions, which made the suite part of the problem.
- The user explicitly does not want more voice tests driving changes until the
  testing approach is made useful and stabilizing.

Known-good reference points:
- Best real-call period: March 18, 2026 around 23:06 Europe/Warsaw
- Closest repo snapshot: commit 22beee4
- Useful real-call IDs from that period:
  - 019d02fc-0455-7000-8fc9-8c0db3b598c8
  - 019d02f4-a8c8-7442-bac6-21fe28b113b6
- The rollback commit now live on staging: 1112a45

Important repository context:
- Main regression suite:
  - scripts/check-workflow-regressions.js
- Staging regression tooling:
  - scripts/run-staging-regression-suite.sh
  - scripts/autonomy/run-staging-regression-suite.js
- Staging voice tooling:
  - scripts/run-staging-voice-smoke-suite.sh
  - scripts/autonomy/run-staging-voice-smoke-suite.js
- Testing docs:
  - docs/testing.md
  - docs/staging-regression-suite.md
  - docs/staging-voice-smoke-suite.md
- Real-call evaluation docs:
  - docs/real-call-evaluation-2026-03-17-implant-booking.md
  - docs/real-call-evaluation-2026-03-17-implant-booking-retry.md
  - docs/real-call-evaluation-2026-03-21-first-visit-booking.md
    Note: this file is currently uncommitted local context, not part of the rollback commit.
- Assistant config and mirrors:
  - configs/vapi/assistant.v1.json
  - prompts/system-prompt.md

Your goal:
- Redesign the testing strategy so tests increase stability instead of pushing
  the assistant toward overfitted behavior.
- Do not start by adding more voice scenarios.
- First decide what should be tested as durable invariant, what should be
  treated as observational signal, and what should be quarantined as
  experimental.

What to audit:
- Which tests validate backend/tool contracts vs assistant behavior
- Which tests assert durable booking invariants
- Which tests are brittle prompt-shaping assertions
- Which tests are tied to one recent failure and should not drive the entire
  assistant prompt
- How real-call evaluations are or are not fed back into automated checks

Recommended direction:
- Keep hard automated checks for durable invariants such as:
  - no booking before explicit confirmation
  - exact slotStart/slotEnd reuse from checkAvailability into createEvent
  - clinic hours and weekday boundaries
  - valid patient phone normalization
  - tool authorization and response-shape contracts
- Reduce or remove brittle checks that lock in huge prompt fragments or
  over-specific conversational micro-rules unless those rules are proved
  essential across multiple real calls.
- Treat voice tests as smoke/evaluation tools, not as prompt-authoring
  engines.
- Require real-call review before broadening the shared assistant prompt.
- Consider splitting tests into layers such as:
  - backend contract tests
  - assistant invariant tests
  - optional experimental evals
  - real-call review docs / fixtures

Constraints:
- Do not revert unrelated local changes in:
  - knowledge-base/clinic-knowledge.json
  - n8n/workflows/tool_search-knowledge-base.json
  - docs/real-call-evaluation-2026-03-21-first-visit-booking.md
- Prefer additive docs and clear rationale over hidden assumptions.
- If you change runtime behavior, sync Vapi staging and deploy staging.
- If you only change tests/docs, do not claim runtime improvement without real
  validation.

Suggested deliverables:
1. A concise testing-strategy note inside the repo
2. A first cleanup pass on brittle or overfit checks
3. A clearer separation between "must pass" invariants and "experimental"
   evaluation signals
4. Commit and push; deploy only if runtime behavior changed

The standard is not "more tests". The standard is "tests that protect the good
real-call behavior restored by 1112a45".
```
