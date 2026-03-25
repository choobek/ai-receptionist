# Codex Agentic Ecosystem Rollout Checklist

Status as of March 25, 2026:

- Phases 0 through 4 are implemented in the repo.
- Phase 5 remains intentionally unimplemented until the team explicitly decides to allow any Codex-assisted production path.

## Phase 0

- [x] Confirm [`../scripts/check-repo-health.sh`](../scripts/check-repo-health.sh) passes.
- [x] Record a runtime audit snapshot for staging and production:
  - Vapi assistant summary
  - active n8n workflow IDs
  - duplicate legacy n8n workflow IDs
- [x] Confirm the generated artifact root for Codex reports:
  - `autonomy/runs/generated/codex/`
  - `autonomy/reports/generated/codex/`
- [x] Confirm Python is acceptable for the new MCP wrappers and adjust the file map only if the team wants a different runtime.
- [x] Keep this phase docs-only and read-only.

## Phase 1

- [x] Add `.codex/config.toml` with project defaults and no write MCPs enabled.
- [x] Add `repo-operating-model` skill.
- [x] Add `staging-verification` skill.
- [x] Add `runtime-drift-audit` skill.
- [x] Add `codex/mcp/repo_read/`.
- [x] Add `codex/mcp/repo_verify/`.
- [x] Add `scripts/codex/check-mcp-health.sh`.
- [x] Add `scripts/codex/run-staging-release-gate.sh`.
- [x] Prove a fresh Codex session can answer source-of-truth questions and run the release gate without mutating runtime.

## Phase 2

- [x] Add `vapi-config-ops` skill.
- [x] Add `n8n-runtime-ops` skill.
- [x] Add `call-triage` skill.
- [x] Add `codex/mcp/vapi_read/`.
- [x] Add `codex/mcp/n8n_read/`.
- [x] Add `scripts/codex/runtime-drift-report.sh`.
- [x] Redact secrets and PII in all MCP outputs and Codex-generated reports.
- [x] Prove Codex can render a staging drift report without manual SSH or ad-hoc curl commands.

## Phase 3

- [x] Add `.codex/agents/repo-auditor.toml`.
- [x] Add `.codex/agents/runtime-auditor.toml`.
- [x] Add `.codex/agents/patch-worker.toml`.
- [x] Add `.codex/agents/staging-verifier.toml`.
- [x] Add `.codex/agents/staging-sync-operator.toml`.
- [x] Add `.codex/agents/post-sync-evaluator.toml`.
- [x] Add `.codex/agents/release-reviewer.toml`.
- [x] Verify no agent has both patch and staging-write authority.
- [x] Verify a patched change can be audited and verified by agents that did not author it.

## Phase 4

- [x] Add `codex/mcp/vapi_stage_write/`.
- [x] Add `codex/mcp/n8n_stage_write/`.
- [x] Add `codex/mcp/ops_guard/`.
- [x] Add `scripts/codex/staging-sync-with-evidence.sh`.
- [x] Require `ops_guard` to refuse `production`.
- [x] Require `ops_guard` to enforce backup-before-import for n8n.
- [x] Require post-sync verification before the task is considered complete.
- [x] Prove a staging workflow change still routes through import + reconcile, not direct n8n mutation.
- [x] Prove a staging Vapi change still routes through repo-backed sync scripts, not dashboard edits.

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

These remain ongoing monitoring conditions, not completed rollout tasks.

- [ ] Stop rollout if write wrappers begin bypassing existing repo scripts.
- [ ] Stop rollout if one agent can both patch and certify its own runtime change.
- [ ] Stop rollout if reports or MCP outputs expose secrets or real-call PII.
- [ ] Stop rollout if production becomes a default target in any config or MCP server.
