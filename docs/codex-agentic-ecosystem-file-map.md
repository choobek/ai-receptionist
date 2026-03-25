# Codex Agentic Ecosystem File Map

Paths below are the recommended layout for the future control plane. They are intentionally split between:

- hidden Codex config in `.codex/`
- repo skills in `.agents/skills/`
- MCP server code in `codex/mcp/`
- thin wrapper scripts in `scripts/codex/`
- evidence and runbooks under `autonomy/` and `docs/`

This map assumes Python-based MCP wrappers so the control plane can stay thin and call the repo's existing Bash and Node scripts instead of reimplementing them.

## Core config

| Path | Phase | Purpose / planned contents |
| --- | --- | --- |
| `.codex/config.toml` | 1 | Project-scoped Codex defaults: model, reasoning level, project trust, enabled MCP servers, multi-agent on/off, production disabled by default |
| `.codex/agents/repo-auditor.toml` | 3 | Read-only repo auditor role definition |
| `.codex/agents/runtime-auditor.toml` | 3 | Read-only Vapi/n8n runtime drift investigator |
| `.codex/agents/patch-worker.toml` | 3 | Repo editor for canonical files only |
| `.codex/agents/staging-verifier.toml` | 3 | Independent verifier for repo and staging gates |
| `.codex/agents/staging-sync-operator.toml` | 3 | Staging-only sync role using guarded write MCPs |
| `.codex/agents/post-sync-evaluator.toml` | 3 | Independent post-sync evaluator |
| `.codex/agents/release-reviewer.toml` | 3 | Production packet reviewer and exact-ref checker |

## Skills

| Path | Phase | Purpose / planned contents |
| --- | --- | --- |
| `.agents/skills/repo-operating-model/SKILL.md` | 1 | Source-of-truth files, mirror rules, env model, staging/prod rules, canonical commands |
| `.agents/skills/staging-verification/SKILL.md` | 1 | Release-gate ordering, artifact locations, when to use each lane |
| `.agents/skills/runtime-drift-audit/SKILL.md` | 1 | How to compare rendered repo state with Vapi/n8n runtime state |
| `.agents/skills/vapi-config-ops/SKILL.md` | 2 | How to edit and sync Vapi configs, observability resources, prompt mirrors, and tool definitions |
| `.agents/skills/n8n-runtime-ops/SKILL.md` | 2 | How to edit workflow JSON, sync embedded data, import/reconcile staging, and inspect duplicate workflow state |
| `.agents/skills/call-triage/SKILL.md` | 2 | How to use live autoeval, run artifacts, and scenario files to derive bounded fixes |
| `.agents/skills/production-promotion-guard/SKILL.md` | 5 | Exact-ref production release policy and stop conditions |

## MCP servers

| Path | Phase | Purpose / planned contents |
| --- | --- | --- |
| `codex/mcp/shared/` | 1 | Shared helpers for env loading, redaction, artifact writing, and command execution |
| `codex/mcp/repo_read/server.py` | 1 | Read-only access to repo files, git state, docs search, and rendered config helpers |
| `codex/mcp/repo_verify/server.py` | 1 | Non-mutating access to repo health, regression suites, and autoeval runners |
| `codex/mcp/vapi_read/server.py` | 2 | Read-only Vapi API access for assistants, tools, calls, and observability resources |
| `codex/mcp/n8n_read/server.py` | 2 | Read-only runtime inventory for active workflows, duplicate workflows, and direct webhook probes |
| `codex/mcp/vapi_stage_write/server.py` | 4 | Staging-only wrapper around repo-backed Vapi sync scripts |
| `codex/mcp/n8n_stage_write/server.py` | 4 | Staging-only wrapper around workflow import and reconcile scripts |
| `codex/mcp/ops_guard/server.py` | 4 | Environment allowlists, clean-tree checks, backup requirements, and staged orchestration rules |

## Wrapper scripts

| Path | Phase | Purpose / planned contents |
| --- | --- | --- |
| `scripts/codex/check-mcp-health.sh` | 1 | Smoke-check every configured MCP server |
| `scripts/codex/run-staging-release-gate.sh` | 1 | One-command wrapper for repo health, backend regressions, chat gate, and live-call review evidence |
| `scripts/codex/runtime-drift-report.sh` | 2 | Produce a concise repo-vs-runtime drift packet for staging or production |
| `scripts/codex/staging-sync-with-evidence.sh` | 4 | Run staging deploy/sync plus capture before/after evidence paths |
| `scripts/codex/prepare-production-packet.sh` | 5 | Assemble exact-ref production release packet without mutating production by default |

## Evidence and reports

| Path | Phase | Purpose / planned contents |
| --- | --- | --- |
| `autonomy/runs/generated/codex/` | 2 | Git-ignored JSON outputs for runtime audits, release gates, sync reports, and promotion packets |
| `autonomy/reports/generated/codex/` | 2 | Git-ignored Markdown summaries for the same Codex control-plane runs |
| `docs/codex-agentic-ecosystem-plan.md` | 0 | Main architecture and rollout plan |
| `docs/codex-agentic-ecosystem-rollout-checklist.md` | 0 | Actionable implementation checklist |
| `docs/codex-agentic-ecosystem-risk-register.md` | 0 | Risks, mitigations, blockers, and containment rules |
| `docs/codex-agentic-ecosystem-file-map.md` | 0 | Proposed folder/file layout and responsibilities |

## Notes

- Do not add all of these paths at once. Follow the phases.
- Do not add a standalone production write server in the initial rollout.
- Keep MCP server code separate from app runtime code so the control plane stays understandable.
