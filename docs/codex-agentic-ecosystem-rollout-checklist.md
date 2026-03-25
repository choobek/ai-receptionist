# Codex Agentic Ecosystem Rollout Checklist

## Phase 0

- [ ] Confirm [`../scripts/check-repo-health.sh`](../scripts/check-repo-health.sh) passes.
- [ ] Record a runtime audit snapshot for staging and production:
  - Vapi assistant summary
  - active n8n workflow IDs
  - duplicate legacy n8n workflow IDs
- [ ] Confirm the generated artifact root for Codex reports:
  - `autonomy/runs/generated/codex/`
  - `autonomy/reports/generated/codex/`
- [ ] Confirm Python is acceptable for the new MCP wrappers and adjust the file map only if the team wants a different runtime.
- [ ] Keep this phase docs-only and read-only.

## Phase 1

- [ ] Add `.codex/config.toml` with project defaults and no write MCPs enabled.
- [ ] Add `repo-operating-model` skill.
- [ ] Add `staging-verification` skill.
- [ ] Add `runtime-drift-audit` skill.
- [ ] Add `codex/mcp/repo_read/`.
- [ ] Add `codex/mcp/repo_verify/`.
- [ ] Add `scripts/codex/check-mcp-health.sh`.
- [ ] Add `scripts/codex/run-staging-release-gate.sh`.
- [ ] Prove a fresh Codex session can answer source-of-truth questions and run the release gate without mutating runtime.

## Phase 2

- [ ] Add `vapi-config-ops` skill.
- [ ] Add `n8n-runtime-ops` skill.
- [ ] Add `call-triage` skill.
- [ ] Add `codex/mcp/vapi_read/`.
- [ ] Add `codex/mcp/n8n_read/`.
- [ ] Add `codex/mcp/browser_voice/`.
- [ ] Add `scripts/codex/runtime-drift-report.sh`.
- [ ] Redact secrets and PII in all MCP outputs and Codex-generated reports.
- [ ] Prove Codex can render a staging drift report without manual SSH or ad-hoc curl commands.

## Phase 3

- [ ] Add `.codex/agents/repo-auditor.toml`.
- [ ] Add `.codex/agents/runtime-auditor.toml`.
- [ ] Add `.codex/agents/patch-worker.toml`.
- [ ] Add `.codex/agents/staging-verifier.toml`.
- [ ] Add `.codex/agents/staging-sync-operator.toml`.
- [ ] Add `.codex/agents/post-sync-evaluator.toml`.
- [ ] Add `.codex/agents/release-reviewer.toml`.
- [ ] Verify no agent has both patch and staging-write authority.
- [ ] Verify a patched change can be audited and verified by agents that did not author it.

## Phase 4

- [ ] Add `codex/mcp/vapi_stage_write/`.
- [ ] Add `codex/mcp/n8n_stage_write/`.
- [ ] Add `codex/mcp/ops_guard/`.
- [ ] Add `scripts/codex/staging-sync-with-evidence.sh`.
- [ ] Require `ops_guard` to refuse `production`.
- [ ] Require `ops_guard` to enforce backup-before-import for n8n.
- [ ] Require post-sync verification before the task is considered complete.
- [ ] Prove a staging workflow change still routes through import + reconcile, not direct n8n mutation.
- [ ] Prove a staging Vapi change still routes through repo-backed sync scripts, not dashboard edits.

## Phase 5

- [ ] Decide whether Codex should ever mutate production directly.
- [ ] Add `production-promotion-guard` skill only if that answer is yes.
- [ ] Add `scripts/codex/prepare-production-packet.sh`.
- [ ] Extend `ops_guard` with production preflight checks:
  - clean worktree
  - exact approved ref checked out
  - latest staging evidence packet attached
- [ ] Keep actual production mutation routed through [`../scripts/promote-to-production.sh`](../scripts/promote-to-production.sh).
- [ ] Require explicit human instruction for every production promotion.

## Stop Conditions

- [ ] Stop rollout if write wrappers begin bypassing existing repo scripts.
- [ ] Stop rollout if one agent can both patch and certify its own runtime change.
- [ ] Stop rollout if reports or MCP outputs expose secrets or real-call PII.
- [ ] Stop rollout if production becomes a default target in any config or MCP server.
