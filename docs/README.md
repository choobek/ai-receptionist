# Docs Guide

Top-level files in this directory mix current operating docs with background design notes.

Use these as the current working source of truth:

- [`operations-runbook.md`](./operations-runbook.md) for human operating procedure
- [`environment-separation.md`](./environment-separation.md) for staging versus production flow
- [`testing-strategy.md`](./testing-strategy.md) for automated gate boundaries
- [`testing.md`](./testing.md) for manual smoke checks
- [`staging-regression-suite.md`](./staging-regression-suite.md) for the active automated lane

Design and control-plane background:

- [`autonomy-loop.md`](./autonomy-loop.md) for the guarded staging autonomy design context
- [`codex-agentic-ecosystem-plan.md`](./codex-agentic-ecosystem-plan.md) and companion Codex ecosystem docs for the repo-local Codex control plane

Historical investigations and one-off reproductions live under [`archive/`](./archive/). They are useful evidence, but they are not the current operating contract.
