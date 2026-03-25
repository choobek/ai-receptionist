---
name: "staging-verification"
description: "Use for release-gate ordering, artifact expectations, and staging evidence collection in ai-receptionist."
---

# Staging Verification

Use this skill whenever the task needs verification, release-gate ordering, or staging evidence.

## Required Lane Order

1. `./scripts/check-repo-health.sh`
2. `node scripts/check-workflow-regressions.js`
3. `./scripts/run-staging-regression-suite.sh`
4. `./scripts/run-vapi-eval-suite.sh staging` as diagnostic only
5. `./scripts/run-vapi-live-autoeval.sh staging`

Do not swap the order casually. Repo health stays first and the saved Vapi eval lane stays advisory.

## Artifact Roots

- Codex control-plane artifacts: `autonomy/runs/generated/codex/` and `autonomy/reports/generated/codex/`
- Staging chat suite artifacts: `autonomy/runs/generated/staging/` and `autonomy/reports/generated/staging/`
- Saved Vapi eval artifacts: `autonomy/runs/generated/vapi-evals/` and `autonomy/reports/generated/vapi-evals/`
- Live autoeval artifacts: `autonomy/runs/generated/vapi-live-autoeval/` and `autonomy/reports/generated/vapi-live-autoeval/`

## Interpretation Rules

- `check-repo-health.sh` is blocking.
- `check-workflow-regressions.js` is blocking.
- `run-staging-regression-suite.sh` is blocking.
- Saved Vapi evals are useful diagnostics but not the release gate.
- Live autoeval is evidence and drift monitoring, not a replacement for invariant checks.

## Common Failure Handling

- Repo-health failure: stop and fix the repo baseline before runtime work.
- Workflow regression failure: treat it as a durable contract break, not a prompt tweak request.
- Staging chat regression failure: tighten the invariant or patch the canonical config/workflow, then rerun.
- Live autoeval review items: use them to form bounded fixes and repeated-evidence checks, not one-off prompt growth.

## Wrapper

- Use `./scripts/codex/run-staging-release-gate.sh` for the Codex-facing Phase 1 wrapper.
- The wrapper should collect lane logs and point to generated evidence paths under the Codex artifact roots.
