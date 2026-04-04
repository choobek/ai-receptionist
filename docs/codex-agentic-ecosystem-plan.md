# Codex Agentic Ecosystem Plan

## Intent

Add a Codex-centered control plane around this repo without changing the repo's authority model:

- Git stays authoritative.
- Existing repo scripts stay the only sanctioned mutation path.
- Staging remains the default write target.
- Production remains explicit, human-gated, and exact-ref based.
- Diagnosis, patching, syncing, and grading are separated so one agent does not certify its own work.

## Current Status

As of March 25, 2026:

- Phase 0 through Phase 4 are implemented in the repo.
- The control plane now includes project-local Codex config, repo-native skills, read-only MCP inspection, named agent roles, guarded staging-write MCPs, and evidence-backed staging sync wrappers.
- Phase 5 remains intentionally deferred. Production mutation is still disabled by default and still routes through the existing human-gated promotion model.

## Audit Summary

### Real operating model

- Repo authority already lives in a small set of canonical files:
  - Vapi shared behavior in [`../configs/vapi/assistant.v2.json`](../configs/vapi/assistant.v2.json)
  - Vapi environment bindings in [`../configs/vapi/environments/`](../configs/vapi/environments/)
  - Vapi observability resources in [`../configs/vapi/structured-outputs/`](../configs/vapi/structured-outputs/), [`../configs/vapi/scorecards/`](../configs/vapi/scorecards/), [`../configs/vapi/evals/`](../configs/vapi/evals/), and [`../configs/vapi/autoevaluation-policy.v1.json`](../configs/vapi/autoevaluation-policy.v1.json)
  - n8n workflow JSON in [`../n8n/workflows/`](../n8n/workflows/)
  - embedded workflow source data in [`../configs/services/catalog.v1.json`](../configs/services/catalog.v1.json) and [`../knowledge-base/clinic-knowledge.json`](../knowledge-base/clinic-knowledge.json)
  - one root env template in [`../.env.example`](../.env.example)
- Effective Vapi runtime state is rendered, not read from one file. The real comparison surface is:
  - shared assistant config
  - environment binding file
  - root `.env`
  - rendered output from [`../scripts/render-vapi-assistant-config.sh`](../scripts/render-vapi-assistant-config.sh)
- Effective n8n runtime state is also rendered and reconciled, not just imported:
  - workflow JSON is copied to the VPS
  - a backup is exported first
  - credentials are copied from donor workflows
  - repo-owned workflow IDs are published
  - webhook rows are rewired in sqlite during reconcile
- Current deploy/sync path is already environment-aware:
  - [`../scripts/deploy-vps.sh`](../scripts/deploy-vps.sh) deploys repo code to a named VPS target
  - [`../scripts/sync-environment.sh`](../scripts/sync-environment.sh) checks embedded data drift, imports workflows, reconciles runtime state, then syncs Vapi
  - [`../scripts/promote-to-production.sh`](../scripts/promote-to-production.sh) requires a clean worktree and the exact promoted ref checked out locally
- Existing verification surfaces are strong and already repo-native:
  - [`../scripts/check-repo-health.sh`](../scripts/check-repo-health.sh)
  - [`../scripts/check-workflow-regressions.js`](../scripts/check-workflow-regressions.js)
  - [`../scripts/run-staging-regression-suite.sh`](../scripts/run-staging-regression-suite.sh)
  - [`../scripts/run-vapi-eval-suite.sh`](../scripts/run-vapi-eval-suite.sh) as a diagnostic lane
  - [`../scripts/run-vapi-live-autoeval.sh`](../scripts/run-vapi-live-autoeval.sh) as live-call review and drift monitoring
- Existing autonomy surfaces are already close to what an agentic layer needs:
  - normalized run schemas under [`../autonomy/schemas/`](../autonomy/schemas/)
  - reusable scenarios under [`../autonomy/scenarios/`](../autonomy/scenarios/)
  - generated evidence under git-ignored `autonomy/runs/generated/*` and `autonomy/reports/generated/*`
  - a guarded staging-only loop in [`../scripts/run-staging-autonomy-loop.sh`](../scripts/run-staging-autonomy-loop.sh)

### Runtime findings from this audit

- Read-only n8n inspection on March 25, 2026 showed both staging and production still contain duplicate historical workflow copies alongside the repo-owned `aiReceptionist*` IDs.
- The active workflows in both staging and production are the repo-owned `aiReceptionist*` IDs, which confirms the reconcile step is doing real work and should stay mandatory.
- Read-only Vapi inspection on March 25, 2026 showed staging intentionally differs from shared Vapi defaults through `assistantOverrides` in [`../configs/vapi/environments/staging.json`](../configs/vapi/environments/staging.json), especially around transcriber and speaking behavior.
- The shared assistant config includes `sendSmsToPatient`, but the rendered assistant tool order does not expose that tool to the model. Any agentic logic that assumes "workflow exists" means "assistant can call it" will be wrong.

### What is already aligned with an agentic workflow

- Canonical config is already file-backed and script-applied.
- Staging and production are already separated in both docs and automation.
- The repo already has an evidence mindset: regression suites, live autoeval, generated artifacts, and committed design reports.
- The autonomy subsystem already clusters failures into categories that map well to agent routing: prompt issue, tool contract mismatch, schema gap, workflow bug, environment issue, false failure.

### What remains intentionally unimplemented

- No production write MCP server is enabled by default.
- No `production-promotion-guard` skill exists yet.
- No Codex-triggered production promotion packet or exact-ref preflight exists yet.
- Production mutation still requires an explicit human decision and the existing [`../scripts/promote-to-production.sh`](../scripts/promote-to-production.sh) path.

### Where plain Codex helps today

- Reading repo docs and scripts.
- Editing canonical configs and workflow JSON.
- Running local checks and staging-safe runners.
- Producing targeted docs, plans, and diffs.

### Where plain Codex is blind today

- Dashboard drift unless it explicitly queries Vapi.
- n8n active/draft/duplicate workflow state unless it explicitly queries the VPS.
- Credential attachment state inside n8n.
- Timing or interruption behavior unless it inspects raw call artifacts or live-call review outputs.
- Environment-specific effective Vapi state if it reads only the shared assistant JSON.
- Whether a repo patch was actually promoted to runtime unless it inspects staging after sync.

## Target Ecosystem

### Design principles

- Keep the control plane thin. Add wrappers around current scripts instead of inventing a second deployment system.
- Split read from write. Investigation should be cheap and common; mutation should be narrow and explicit.
- Make staging the only default write target.
- Keep production mutation disabled by default.
- Make evidence first-class. Every sync or release decision should point to artifacts under `autonomy/*/generated`.
- Prefer a small set of named roles over a swarm of generic agents.

### Recommended MCP server split

| Server | Mode | Backing surfaces | Why it exists | Hard boundary |
| --- | --- | --- | --- | --- |
| `repo-read` | read-only | repo files, git read commands, render helpers, local docs search | Lets Codex understand canonical repo state quickly and safely | No writes, no deploy, no sync |
| `repo-verify` | read/exec | repo health, workflow regressions, staging chat suite, saved Vapi eval lane, live autoeval lane | Central evidence surface for both humans and agents | No file edits, no runtime mutation |
| `vapi-read` | read-only | Vapi API GETs for assistants, tools, calls, scorecards, structured outputs, eval resources | Detects dashboard drift and gathers live-call evidence | No PATCH/POST/DELETE |
| `n8n-read` | read-only | SSH + `n8n list:workflow`, active workflow inventory, duplicate detection, optional direct webhook probes | Exposes runtime workflow truth that Git alone cannot show | No import, publish, unpublish, or credential mutation |
| `vapi-stage-write` | staging write | [`../scripts/sync-vapi-observability.sh`](../scripts/sync-vapi-observability.sh), [`../scripts/sync-vapi-environment.sh`](../scripts/sync-vapi-environment.sh), [`../scripts/update-vapi-tool-definition.sh`](../scripts/update-vapi-tool-definition.sh) | Applies repo-backed Vapi changes to staging through current scripts | Must refuse production |
| `n8n-stage-write` | staging write | [`../scripts/import-n8n-workflows-vps.sh`](../scripts/import-n8n-workflows-vps.sh) and [`../scripts/reconcile-n8n-workflows-vps.sh`](../scripts/reconcile-n8n-workflows-vps.sh) | Applies repo-backed workflow changes to staging with mandatory backup and reconcile | Must refuse production |
| `ops-guard` | policy/gate | git state checks, environment allowlists, backup requirements, release-gate ordering | Stops Codex from skipping required human and repo rules | No direct vendor API mutation; orchestration only |

Notes:

- Keep docs search inside `repo-read` in Phase 1. A separate docs-only MCP server is not justified yet for a small team.
- Do not add a production write MCP server by default. Phase 5 should extend `ops-guard`, not normalize direct production mutation.

### Recommended skill set

| Skill | Responsibility boundary | Why it exists |
| --- | --- | --- |
| `repo-operating-model` | Source-of-truth files, mirror rules, env model, deploy model, staging/production separation | Prevents edits to the wrong files and stops dashboard-only thinking |
| `staging-verification` | Repo health, contract tests, chat gate, and autoeval evidence order | Makes verification repeatable and keeps saved Vapi evals in the right diagnostic role |
| `runtime-drift-audit` | Compare rendered repo state against staging or production runtime state | Captures the real blind spots of plain Codex |
| `vapi-config-ops` | Shared assistant config, prompt mirrors, environment bindings, observability resources, tool definition sync | Encodes Vapi-specific repo rules and environment override handling |
| `n8n-runtime-ops` | Workflow JSON authority, embedded data sync, VPS import/reconcile, active workflow inspection | Encodes the repo's most fragile operational path |
| `call-triage` | Review `run.v1`, staging failures, live autoeval reports, and real-call evidence | Turns observability into bounded repo changes instead of prompt bloat |
| `production-promotion-guard` | Exact-ref production promotion and release-packet assembly | Keeps production promotion rare, explicit, and auditable |

### Recommended subagent set

| Subagent | Primary duty | Allowed surfaces | Must not do |
| --- | --- | --- | --- |
| `repo-auditor` | Map affected source-of-truth files and verification requirements | `repo-read`, repo skills | No edits, no runtime writes |
| `runtime-auditor` | Inspect Vapi/n8n staging or production for drift | `vapi-read`, `n8n-read`, `runtime-drift-audit` | No edits, no sync |
| `patch-worker` | Edit canonical repo files only | `repo-read`, repo skills, normal file editing | No deploy, no sync, no final grading |
| `staging-verifier` | Run local and staging evidence lanes before any sync | `repo-verify` | No edits, no deploy |
| `staging-sync-operator` | Apply staging runtime changes through existing scripts | `vapi-stage-write`, `n8n-stage-write`, `ops-guard` | No repo edits, no production writes |
| `post-sync-evaluator` | Independently re-check staging after sync | `repo-verify`, `vapi-read`, `n8n-read` | No edits, no sync |
| `release-reviewer` | Prepare production release packet and exact-ref validation | `repo-read`, `repo-verify`, `runtime-drift-audit`, `production-promotion-guard` | No production mutation unless user explicitly requests it |

### Parent/child delegation model

1. The parent agent classifies the task as read-only, repo-write, or runtime-affecting.
2. The parent spawns `repo-auditor` and `runtime-auditor` in parallel when runtime context matters.
3. The parent decides the bounded write set and verification plan.
4. `patch-worker` edits only canonical repo files.
5. `staging-verifier` runs the required gates and records artifact paths.
6. If and only if verification is green and runtime-owned files changed, `staging-sync-operator` applies staging sync through `ops-guard`.
7. `post-sync-evaluator` reruns the relevant staging evidence surfaces so the syncing agent does not grade itself.
8. The parent synthesizes the result and only involves `release-reviewer` when the user explicitly asks for a production path.

Rule: no single agent should be the only actor for all four of diagnosis, patching, syncing, and grading on the same change.

### Guardrails

- No dashboard-only edits as final truth. Runtime changes must be back-propagated into repo files before they count.
- No n8n UI state as source control. Workflow JSON remains authoritative.
- No silent production mutation. Production stays opt-in and exact-ref based.
- No write path may bypass backups where the current repo already requires them.
- Compare rendered, environment-specific Vapi state to runtime, not the shared assistant JSON alone.
- Treat saved Vapi evals as diagnostic only until the current timeout limitation is resolved.
- Keep live-call and voice artifacts under git-ignored generated paths.
- Never log secrets from root `.env`; MCP responses should redact secrets by default.
- Any agent that edits repo files must not be the only verifier or sync operator for that change.

### Verification model

Make the future agentic layer reuse the repo's current verification surfaces in this order:

1. Repo health: [`../scripts/check-repo-health.sh`](../scripts/check-repo-health.sh)
2. Backend regression checks: [`../scripts/check-workflow-regressions.js`](../scripts/check-workflow-regressions.js)
3. Staging chat gate: [`../scripts/run-staging-regression-suite.sh`](../scripts/run-staging-regression-suite.sh)
4. Saved Vapi eval lane: diagnostic only
5. Live-call autoeval: staging as a drift monitor and triage queue; production as monitoring only
6. Runtime drift check: Vapi rendered-vs-live plus n8n active/duplicate workflow inventory
7. MCP health checks for the control plane itself

Recommended evidence output paths:

- `autonomy/runs/generated/codex/`
- `autonomy/reports/generated/codex/`

Use these for:

- runtime audit snapshots
- pre-sync and post-sync verification packets
- drift reports
- promotion packets

### Mapping the current repo to the future ecosystem

#### Existing scripts -> future guarded tools

| Existing script | Future role |
| --- | --- |
| [`../scripts/render-vapi-assistant-config.sh`](../scripts/render-vapi-assistant-config.sh) | `repo-read` render helper and `runtime-drift-audit` input |
| [`../scripts/update-vapi-assistant.sh`](../scripts/update-vapi-assistant.sh) | `vapi-stage-write` implementation detail |
| [`../scripts/update-vapi-tool-bindings.sh`](../scripts/update-vapi-tool-bindings.sh) | `vapi-stage-write` implementation detail |
| [`../scripts/update-vapi-tool-definition.sh`](../scripts/update-vapi-tool-definition.sh) | `vapi-stage-write` implementation detail |
| [`../scripts/sync-vapi-observability.sh`](../scripts/sync-vapi-observability.sh) | `vapi-stage-write` observability-only path |
| [`../scripts/sync-vapi-environment.sh`](../scripts/sync-vapi-environment.sh) | `vapi-stage-write` full staging sync |
| [`../scripts/sync-n8n-workflow-data.sh`](../scripts/sync-n8n-workflow-data.sh) | `n8n-runtime-ops` preflight and drift detector |
| [`../scripts/import-n8n-workflows-vps.sh`](../scripts/import-n8n-workflows-vps.sh) | `n8n-stage-write` import step |
| [`../scripts/reconcile-n8n-workflows-vps.sh`](../scripts/reconcile-n8n-workflows-vps.sh) | `n8n-stage-write` reconcile step |
| [`../scripts/deploy-vps.sh`](../scripts/deploy-vps.sh) | `ops-guard` controlled staging deploy primitive |
| [`../scripts/sync-environment.sh`](../scripts/sync-environment.sh) | higher-level staging sync path under `ops-guard` |
| [`../scripts/promote-to-production.sh`](../scripts/promote-to-production.sh) | exact-ref production mutation path, still human-gated |
| [`../scripts/run-staging-autonomy-loop.sh`](../scripts/run-staging-autonomy-loop.sh) | evidence and triage helper, not the main mutation engine |

#### Existing docs -> future operational references

| Existing doc | Future use |
| --- | --- |
| [`../AGENTS.md`](../AGENTS.md) | hard repo rules that every skill and MCP server should inherit |
| [`./architecture.md`](./architecture.md) | system topology reference |
| [`./operations-runbook.md`](./operations-runbook.md) | human operator contract |
| [`./environment-separation.md`](./environment-separation.md) | staging-first release model |
| [`./testing-strategy.md`](./testing-strategy.md) | lane boundaries and release-gate policy |
| [`./staging-regression-suite.md`](./staging-regression-suite.md) | assistant invariant gate |
| [`./vapi-observability.md`](./vapi-observability.md) | observability sync and live review policy |
| [`./autonomy-loop.md`](./autonomy-loop.md) | current guarded autonomy controller and safe-fixer model |

#### Existing autonomy loop -> future orchestration path

Current path:

- run suite
- ingest calls
- cluster failures
- apply narrow safe fixer
- optionally sync staging
- rerun suite

Future path:

- audit repo and runtime in parallel
- patch canonical repo files
- verify locally and on staging
- sync staging through guarded write MCPs only when needed
- run independent post-sync evaluation
- use the existing autonomy loop and live autoeval as evidence inputs, not as the only controller

#### Existing staging/prod flow -> future guarded release path

Current path:

- deploy staging
- sync staging
- validate staging
- check out approved ref
- promote exact ref to production

Future guarded path:

- repo audit
- bounded repo patch
- release gate packet
- guarded staging sync
- independent post-sync evaluation
- release reviewer packet
- explicit human request
- exact-ref production promotion through the existing script

## Phased Implementation Plan

### Phase 0: Audit and prerequisites

Status: Implemented.

- Objective:
  Stabilize the baseline and capture the real runtime state before adding any new control-plane code.
- Deliverables:
  - this planning package
  - a green repo-health baseline
  - a committed note of current runtime realities: duplicate n8n workflows, active IDs, env-specific Vapi overrides
  - naming conventions for skills, MCP servers, agents, and generated artifact roots
- Files/folders to add or modify:
  - [`./codex-agentic-ecosystem-plan.md`](./codex-agentic-ecosystem-plan.md)
  - [`./codex-agentic-ecosystem-rollout-checklist.md`](./codex-agentic-ecosystem-rollout-checklist.md)
  - [`./codex-agentic-ecosystem-risk-register.md`](./codex-agentic-ecosystem-risk-register.md)
  - [`./codex-agentic-ecosystem-file-map.md`](./codex-agentic-ecosystem-file-map.md)
  - small doc fixes surfaced by repo-health
- Dependencies:
  - existing repo docs and scripts
  - root `.env` for read-only inspection
- Risks:
  - designing against stale or incorrect runtime assumptions
  - building a new layer while baseline verification is already red
- Acceptance criteria:
  - repo health passes
  - audit findings are documented
  - no new runtime mutation path exists yet
- Rollback / containment:
  - docs-only changes can be reverted with no runtime effect

### Phase 1: Lowest-risk, highest-ROI additions

Status: Implemented.

- Objective:
  Make Codex reliably repo-aware and verification-aware without giving it new mutation power.
- Deliverables:
  - `.codex/config.toml`
  - `.agents/skills/repo-operating-model/SKILL.md`
  - `.agents/skills/staging-verification/SKILL.md`
  - `.agents/skills/runtime-drift-audit/SKILL.md`
  - `codex/mcp/repo_read/`
  - `codex/mcp/repo_verify/`
  - `scripts/codex/check-mcp-health.sh`
  - `scripts/codex/run-staging-release-gate.sh`
- Files/folders to add or modify:
  - `.codex/`
  - `.agents/skills/`
  - `codex/mcp/repo_read/`
  - `codex/mcp/repo_verify/`
  - `scripts/codex/`
- Dependencies:
  - Phase 0
  - stable local Node or Python choice for new control-plane code
- Risks:
  - duplicating existing shell scripts instead of wrapping them
  - over-designing config before proving the workflow
- Acceptance criteria:
  - a new Codex session can answer repo-specific questions without rereading the whole repo
  - Codex can run the standard release gate in one step
  - no staging or production write capability is added
- Rollback / containment:
  - disable project config and MCP registration; underlying repo scripts remain unchanged

### Phase 2: Repo-native skills and read-only investigation flows

Status: Implemented.

- Objective:
  Give Codex direct, read-only visibility into staging/production runtime state and live-call evidence.
- Deliverables:
  - `.agents/skills/vapi-config-ops/SKILL.md`
  - `.agents/skills/n8n-runtime-ops/SKILL.md`
  - `.agents/skills/call-triage/SKILL.md`
  - `codex/mcp/vapi_read/`
  - `codex/mcp/n8n_read/`
  - `scripts/codex/runtime-drift-report.sh`
  - artifact roots under `autonomy/runs/generated/codex/` and `autonomy/reports/generated/codex/`
- Files/folders to add or modify:
  - `.agents/skills/`
  - `codex/mcp/vapi_read/`
  - `codex/mcp/n8n_read/`
  - `autonomy/runs/generated/codex/`
  - `autonomy/reports/generated/codex/`
- Dependencies:
  - Phase 1
  - working read credentials in root `.env`
- Risks:
  - leaking secrets or PII into logs
  - false drift reports if the read path compares shared config instead of rendered env config
- Acceptance criteria:
  - Codex can render a runtime audit packet for staging or production
  - Codex can explain active vs duplicate n8n workflows
  - Codex can pull live-call review evidence without manual shell work
- Rollback / containment:
  - disable read MCPs and keep the skill docs as passive references

### Phase 3: Subagent orchestration

Status: Implemented.

- Objective:
  Formalize separation of duties and parallel audit work.
- Deliverables:
  - `.codex/agents/repo-auditor.toml`
  - `.codex/agents/runtime-auditor.toml`
  - `.codex/agents/patch-worker.toml`
  - `.codex/agents/staging-verifier.toml`
  - `.codex/agents/staging-sync-operator.toml`
  - `.codex/agents/post-sync-evaluator.toml`
  - `.codex/agents/release-reviewer.toml`
- Files/folders to add or modify:
  - `.codex/agents/`
  - `.codex/config.toml`
- Dependencies:
  - Phase 1 and Phase 2
- Risks:
  - role overlap
  - agent sprawl
  - too much duplicated prompt text between agents and skills
- Acceptance criteria:
  - audit, patch, verify, sync, and post-sync evaluation can be delegated to different named roles
  - no agent definition has both patch and staging-write authority
- Rollback / containment:
  - turn off multi-agent use in `.codex/config.toml` and fall back to the Phase 1 read-only layer

### Phase 4: Guarded staging-write flows

Status: Implemented.

- Objective:
  Allow Codex to sync staging safely through the repo's existing scripts and gates.
- Deliverables:
  - `codex/mcp/vapi_stage_write/`
  - `codex/mcp/n8n_stage_write/`
  - `codex/mcp/ops_guard/`
  - `scripts/codex/staging-sync-with-evidence.sh`
- Files/folders to add or modify:
  - `codex/mcp/vapi_stage_write/`
  - `codex/mcp/n8n_stage_write/`
  - `codex/mcp/ops_guard/`
  - `scripts/codex/`
- Dependencies:
  - Phase 1 through Phase 3
  - stable runtime audit and release-gate artifacts
- Risks:
  - a write wrapper pretending local repo edits are already deployed
  - skipping post-sync verification
  - bypassing backup or reconcile steps
- Acceptance criteria:
  - staging writes are only possible through `ops-guard`
  - Vapi staging sync still routes through [`../scripts/sync-vapi-environment.sh`](../scripts/sync-vapi-environment.sh)
  - n8n staging sync still routes through backup + import + reconcile
  - every staging write emits a before/after report under `autonomy/reports/generated/codex/`
- Rollback / containment:
  - disable the write MCPs and fall back to manual staging scripts immediately

### Phase 5: Optional production promotion controls

Status: Not started by design.

- Objective:
  Add a production path only if it preserves the repo's current exact-ref, clean-worktree release model.
- Deliverables:
  - `.agents/skills/production-promotion-guard/SKILL.md`
  - `scripts/codex/prepare-production-packet.sh`
  - `ops-guard` production gate extension
- Files/folders to add or modify:
  - `.agents/skills/`
  - `scripts/codex/`
  - `codex/mcp/ops_guard/`
- Dependencies:
  - Phase 4
  - a team decision that production mutation through Codex is acceptable at all
- Risks:
  - pressure to normalize production writes as "just another agent action"
  - skipping explicit human review
- Acceptance criteria:
  - production mutation remains disabled by default
  - Codex can prepare a release packet, validate exact-ref and clean-tree requirements, and then call the existing promotion script only after explicit user instruction
- Rollback / containment:
  - keep production support disabled and use Codex for release prep only

## Current Next Cut

The next cut is optional Phase 5 only if the team explicitly wants a Codex-assisted production path.

Until then, the recommended operating model is:

- Keep production mutation disabled in Codex config and MCP surfaces.
- Use the current control plane for repo edits, staging verification, staging sync, and post-sync evaluation only.
- Keep exact-ref production promotion routed through the existing human-controlled script.
