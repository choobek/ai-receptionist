# Testing Strategy

This repo protects the restored `1112a45` / March 18 booking baseline with layered checks. The goal is stability, not prompt growth.

## Layers

### 1. Backend contract tests

Command:

```bash
node scripts/check-workflow-regressions.js
```

This lane must stay green by default. It is for:

- webhook auth, validation, and response-shape contracts
- booking boundary invariants such as clinic hours, weekdays, and slot reuse
- phone normalization and workflow payload contracts
- local evaluator helpers that encode durable assistant invariants without snapshotting the prompt

It is not the place to lock in large prompt fragments or one-off observations.

Use this only for intentional audits of quarantined checks:

```bash
node scripts/check-workflow-regressions.js --include-experimental
```

That experimental lane is for prompt/config snapshots that should not block routine repo health.

### 2. Staging chat assistant invariants

Command:

```bash
./scripts/run-staging-regression-suite.sh
```

Active staging chat scenarios are must-pass assistant invariants. They should focus on durable behavior such as:

- no booking before explicit confirmation
- correct tool choice and ordering
- exact slot reuse from `checkAvailability` into `createEvent`
- correct handoff behavior for non-self-serve cases

If a criterion is useful as a signal but too brittle to block releases, mark it with `"required": false` so it reports as a warning instead of a failure.

Keep experimental or one-off reproductions in `draft` and run them explicitly:

```bash
./scripts/run-staging-regression-suite.sh --include-draft --scenario <scenario-id>
```

### 3. Real-call review docs

Real-call evaluations are the source of truth for deciding whether a new rule deserves automation. A new prompt rule or required scenario criterion should clear all of these:

1. The issue appears in more than one real call or is otherwise clearly systemic.
2. The fix can be expressed as a durable invariant, not a wording snapshot.
3. The resulting automated check can fail for a real regression without forcing prompt bloat.

If those conditions are not met, keep the observation in docs or in a draft scenario instead of widening the shared assistant prompt.
