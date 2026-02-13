---
summary: "26-week ticketized execution board for a self-augmenting autonomous engine"
owner: "openclaw"
status: "draft"
last_updated: "2026-02-13"
title: "Autonomy Self Augmentation Execution Board"
---

# Autonomy Self Augmentation Execution Board

## Purpose

This document converts the autonomy roadmap into an execution board that can be split across many
subagents without merge collisions. It is designed to be concrete enough to create GitHub issues
directly from each ticket.

The target is a production-grade autonomous system that can:

1. Run continuously with strong safety boundaries.
2. Discover its own capability gaps.
3. Propose and verify new skills and code changes.
4. Promote only improvements that pass policy, quality, and canary gates.

## Program scope and non negotiables

- Timeline: **26 weeks** (minimum two months requirement is exceeded).
- Delivery model: **parallel lane execution** with strict path ownership.
- Safety first:
  - No destructive actions without explicit policy approval.
  - No uncontrolled self-modifying behavior outside sandbox/canary lanes.
  - Every promoted change must pass lint, build, tests, and policy checks.
- Backward compatibility:
  - Existing cron autonomy behavior must remain functional while new flows are introduced.
  - All new state fields require migration-safe defaults in the store.

## Parallel subagent lanes and ownership

| Lane | Focus | Primary ownership paths | Shared contracts |
| --- | --- | --- | --- |
| AG0 | Program governor | `src/autonomy/board/*`, `src/autonomy/runtime.ts` | `src/autonomy/types.ts` |
| AG1 | State and runtime | `src/autonomy/store.ts`, `src/autonomy/types.ts` | `src/cron/types.ts` |
| AG2 | Policy and security | `src/autonomy/policy/*`, `src/infra/exec-approvals*`, `src/infra/exec-safety.ts` | `src/agents/tool-policy.ts` |
| AG3 | Skill Forge | `src/autonomy/skill-forge/*`, `src/agents/skills*` | `src/plugin-sdk/index.ts` |
| AG4 | Code Forge | `src/autonomy/code-forge/*`, `src/cron/isolated-agent/*` | `src/infra/git-commit.ts` |
| AG5 | Eval and canary | `src/autonomy/eval/*`, `src/autonomy/canary/*` | `src/infra/diagnostic-events.ts` |
| AG6 | Observability and ledger | `src/autonomy/ledger/*`, `src/infra/diagnostic-events.ts` | `ui/src/ui/controllers/cron.ts` |
| AG7 | CLI and UI | `src/cli/cron-cli/*`, `ui/src/ui/views/cron.ts`, `ui/src/ui/views/overview.ts` | `src/gateway/server-methods/cron.ts` |
| AG8 | Channels and extensions | `src/channels/*`, `extensions/*` | `src/routing/*`, `src/infra/outbound/*` |
| AG9 | Monolith refactors | `src/memory/*`, `src/tts/*`, `src/agents/bash-tools.exec.ts`, `src/gateway/server/ws-connection/message-handler.ts`, `src/infra/outbound/message-action-runner.ts` | owning lane for each touched contract |
| AG10 | Docs and release readiness | `docs/*`, `README.md` | all lanes for signoff |

### Merge collision rules

1. A lane can edit only its primary ownership paths unless a ticket explicitly marks a shared contract.
2. Shared contracts must land in dedicated contract tickets first.
3. Tickets that touch `src/autonomy/types.ts` and `src/infra/diagnostic-events.ts` are serialized.
4. Large refactor tickets must keep a facade file to preserve imports until migration is complete.

## Stage gates (must pass before next phase)

1. **Gate A (end week 4):** Augmentation FSM runs with persisted state and safety pause semantics.
2. **Gate B (end week 8):** Gap registry + Skill Forge prototype with verification pipeline.
3. **Gate C (end week 12):** Policy runtime + immutable augmentation ledger + canary runner.
4. **Gate D (end week 18):** Code Forge can produce reversible patches with sandbox verification.
5. **Gate E (end week 22):** Channel/extension parity and long-horizon resilience suite.
6. **Gate F (end week 26):** GA readiness, runbooks, and operational health dashboards.

## Epic board (ticketized)

Each ticket contains: intent, files, and acceptance tests.

## Epic AUT-E00: Autonomy governor and FSM foundation (weeks 1-4)

### AUT-001 - Persist augmentation FSM state

- Lane: AG1
- Files:
  - `src/autonomy/types.ts`
  - `src/autonomy/store.ts`
  - `src/autonomy/store.test.ts`
- Tasks:
  - Add augmentation FSM fields (`stage`, `candidates`, `activeExperiments`, `policyVersion`).
  - Add migration-safe defaults in `loadAutonomyState`.
  - Cap and prune augmentation arrays to avoid state blow-up.
- Acceptance tests:
  - Loading old state snapshots auto-fills new augmentation fields.
  - State save/load roundtrip preserves augmentation records.
  - Existing autonomy tests remain green.

### AUT-002 - Phase executor in runtime

- Lane: AG1
- Files:
  - `src/autonomy/runtime.ts`
  - `src/autonomy/runtime.test.ts`
  - `src/autonomy/runtime.phase-machine.ts` (new)
- Tasks:
  - Split runtime flow into explicit phases:
    `DISCOVER -> DESIGN -> SYNTHESIZE -> VERIFY -> CANARY -> PROMOTE -> OBSERVE -> LEARN -> RETIRE`.
  - Add invalid-transition guard failures and pause reasons.
- Acceptance tests:
  - Invalid phase transitions are rejected and logged.
  - Phase progression resumes correctly after process restart.
  - Lock acquisition/release remains correct during phase errors.

### AUT-003 - Augmentation event taxonomy

- Lane: AG6
- Files:
  - `src/autonomy/events.ts` (new)
  - `src/autonomy/runtime.ts`
  - `src/infra/diagnostic-events.ts`
- Tasks:
  - Define canonical event names and payload schemas for each FSM phase.
  - Emit events for phase enter/exit and policy denials.
- Acceptance tests:
  - Event payload validation fails on malformed fields.
  - Diagnostic stream contains phase correlation ids.

### AUT-004 - CLI inspect for augmentation state

- Lane: AG7
- Files:
  - `src/cli/cron-cli/register.cron-autonomous.ts`
  - `src/cli/cron-cli.test.ts`
- Tasks:
  - Extend `cron autonomous-inspect` and `cron autonomous-health` with augmentation section.
  - Add JSON output schema for machine parsing.
- Acceptance tests:
  - CLI JSON output includes stage, candidate queue depth, and active experiment ids.
  - Human output renders warnings when phase is stalled.

## Epic AUT-E01: Discovery and gap registry (weeks 3-6)

### AUT-010 - Signal normalization pipeline

- Lane: AG0
- Files:
  - `src/autonomy/discovery/signal-normalizer.ts` (new)
  - `src/autonomy/runtime.ts`
  - `src/autonomy/runtime.test.ts`
- Tasks:
  - Normalize incoming events into capability-gap signals.
  - Add dedupe key strategy tied to gap class and source.
- Acceptance tests:
  - Duplicate signals collapse within dedupe window.
  - Distinct channels produce separate gap keys.

### AUT-011 - Gap registry with ranking

- Lane: AG0
- Files:
  - `src/autonomy/discovery/gap-registry.ts` (new)
  - `src/autonomy/discovery/gap-registry.test.ts` (new)
  - `src/autonomy/store.ts`
- Tasks:
  - Implement severity/confidence scoring and aging.
  - Persist top-ranked gaps into augmentation state.
- Acceptance tests:
  - Ranking is deterministic for fixed input.
  - Aged, unresolved gaps escalate priority.

### AUT-012 - Plugin hook for discovery signals

- Lane: AG8
- Files:
  - `src/plugin-sdk/index.ts`
  - `src/plugins/hooks.ts`
  - `src/plugins/registry.ts`
  - `src/plugins/runtime/types.ts`
- Tasks:
  - Add optional hook for plugins to emit structured autonomy signals.
  - Validate plugin signal payloads at registration time.
- Acceptance tests:
  - Invalid plugin signals are rejected with actionable errors.
  - Valid plugin signals appear in discovery queue.

### AUT-013 - Channel and extension signal adapters

- Lane: AG8
- Files:
  - `src/channels/plugins/status.ts`
  - `src/channels/plugins/status-issues/shared.ts`
  - `extensions/*/src/**/*.ts` (incremental adapters)
- Tasks:
  - Add adapters that convert channel-specific failures into discovery signals.
  - Cover built-in channels and extension channels consistently.
- Acceptance tests:
  - Each supported channel emits at least one known signal class.
  - Unknown channel errors map to a generic but typed fallback signal.

## Epic AUT-E02: Skill Forge (weeks 5-10)

### AUT-020 - Skill candidate schema and planner

- Lane: AG3
- Files:
  - `src/autonomy/skill-forge/schema.ts` (new)
  - `src/autonomy/skill-forge/planner.ts` (new)
  - `src/autonomy/skill-forge/planner.test.ts` (new)
- Tasks:
  - Define schema for generated skills (`name`, `intent`, `inputs`, `safety`, `tests`).
  - Convert gap registry entries into candidate skill plans.
- Acceptance tests:
  - Planner rejects candidates without explicit safety bounds.
  - Planner output is deterministic for same gap snapshot.

### AUT-021 - Skill synthesis writer

- Lane: AG3
- Files:
  - `src/autonomy/skill-forge/synthesizer.ts` (new)
  - `src/autonomy/skill-forge/io.ts` (new)
  - `src/agents/skills.ts`
- Tasks:
  - Generate workspace skill artifacts under a managed autonomy namespace.
  - Keep generated skills isolated from manually authored skills.
- Acceptance tests:
  - Generated skill bundle is valid and loadable by existing skills loader.
  - Regeneration is idempotent for unchanged plan input.

### AUT-022 - Skill verification pipeline

- Lane: AG5
- Files:
  - `src/autonomy/skill-forge/verify.ts` (new)
  - `src/autonomy/skill-forge/verify.test.ts` (new)
  - `src/agents/skills-status.ts`
- Tasks:
  - Add static checks, dry-run execution checks, and policy checks.
  - Emit verification report consumed by promotion phase.
- Acceptance tests:
  - Unsafe or failing skills are blocked from canary promotion.
  - Verification report includes machine-readable failure codes.

### AUT-023 - Skill lifecycle states

- Lane: AG3
- Files:
  - `src/autonomy/types.ts`
  - `src/autonomy/store.ts`
  - `src/autonomy/runtime.ts`
- Tasks:
  - Add skill lifecycle (`candidate`, `canary`, `active`, `deprecated`, `retired`).
  - Drive lifecycle transitions through FSM phases.
- Acceptance tests:
  - Invalid lifecycle transitions are rejected.
  - Retired skills are no longer exposed to tool resolver.

## Epic AUT-E03: Code Forge and reversible patching (weeks 8-14)

### AUT-030 - Patch proposal contract

- Lane: AG4
- Files:
  - `src/autonomy/code-forge/patch-contract.ts` (new)
  - `src/autonomy/code-forge/patch-contract.test.ts` (new)
- Tasks:
  - Define strict schema for code-change proposals, scope, risk, and rollback.
  - Enforce reversible patch metadata for every proposal.
- Acceptance tests:
  - Proposal validation fails when rollback metadata is missing.
  - Proposal scope enforces file allowlists.

### AUT-031 - Isolated verify runner

- Lane: AG4
- Files:
  - `src/autonomy/code-forge/verify-runner.ts` (new)
  - `src/cron/isolated-agent/run.ts`
  - `src/autonomy/code-forge/verify-runner.test.ts` (new)
- Tasks:
  - Run lint/build/test in isolated context before canary.
  - Capture structured command output and policy violations.
- Acceptance tests:
  - Failed verification blocks promotion and records failure reason.
  - Timeout and crash paths release locks and persist diagnostics.

### AUT-032 - Canary apply and rollback manager

- Lane: AG5
- Files:
  - `src/autonomy/canary/manager.ts` (new)
  - `src/autonomy/canary/manager.test.ts` (new)
  - `src/autonomy/runtime.ts`
- Tasks:
  - Apply candidate changes to a canary lane, monitor health, and auto-rollback on regressions.
  - Support explicit promotion criteria.
- Acceptance tests:
  - Canary regression triggers rollback within configured window.
  - Successful canary transitions proposal to promotable state.

### AUT-033 - Promotion orchestrator

- Lane: AG4
- Files:
  - `src/autonomy/code-forge/promote.ts` (new)
  - `src/autonomy/runtime.ts`
  - `src/autonomy/ledger/store.ts`
- Tasks:
  - Promote only proposals with passing verify/canary records.
  - Record immutable promotion audit entries.
- Acceptance tests:
  - Promotion is blocked without full gate evidence.
  - Promotion emits ledger event with exact commit hash and rollback pointer.

## Epic AUT-E04: Policy runtime and hard safety gates (weeks 6-12)

### AUT-040 - Execution class policy model

- Lane: AG2
- Files:
  - `src/autonomy/policy/types.ts` (new)
  - `src/autonomy/policy/runtime.ts` (new)
  - `src/autonomy/policy/runtime.test.ts` (new)
- Tasks:
  - Add execution classes (`read_only`, `reversible_write`, `destructive`).
  - Map autonomy actions and tools to mandatory approval levels.
- Acceptance tests:
  - Destructive class always requires explicit approval.
  - Policy fallback defaults to deny for unknown class/action pairs.

### AUT-041 - Tool policy integration

- Lane: AG2
- Files:
  - `src/agents/tool-policy.ts`
  - `src/agents/sandbox/tool-policy.ts`
  - `src/autonomy/policy/runtime.ts`
- Tasks:
  - Route autonomy decisions through shared tool policy expansion.
  - Prevent bypass when tool aliases/groups are used.
- Acceptance tests:
  - Denied tools cannot execute through aliases.
  - Sandbox policy and autonomy policy produce consistent allow/deny results.

### AUT-042 - Exec approval modularization and integration

- Lane: AG9 + AG2
- Files:
  - `src/infra/exec-approvals.ts` (facade)
  - `src/infra/exec-approvals/analysis.ts` (new)
  - `src/infra/exec-approvals/allowlist.ts` (new)
  - `src/infra/exec-approvals/socket.ts` (new)
  - `src/infra/exec-approvals.test.ts`
- Tasks:
  - Split large approval module into cohesive units.
  - Integrate autonomy policy runtime before exec approval request.
- Acceptance tests:
  - Existing approval behavior remains backward compatible.
  - New modules have focused tests and unchanged public API.

### AUT-043 - Outbound policy guard hardening

- Lane: AG2
- Files:
  - `src/infra/outbound/outbound-policy.ts`
  - `src/infra/outbound/message-action-runner.ts`
  - `src/infra/outbound/outbound-policy.test.ts`
- Tasks:
  - Add policy checks for autonomous outbound actions by channel/context.
  - Require explicit allow policies for cross-context sends.
- Acceptance tests:
  - Block unauthorized autonomous sends across channels.
  - Authorized sends remain unchanged for manual operator actions.

## Epic AUT-E05: Augmentation ledger and observability (weeks 8-14)

### AUT-050 - Immutable augmentation ledger

- Lane: AG6
- Files:
  - `src/autonomy/ledger/store.ts` (new)
  - `src/autonomy/ledger/types.ts` (new)
  - `src/autonomy/ledger/store.test.ts` (new)
- Tasks:
  - Add append-only ledger for discovery/design/synthesis/verify/canary/promote events.
  - Include actor, evidence, and correlation ids.
- Acceptance tests:
  - Ledger entries are append-only and tamper-evident.
  - Ledger recovery works after partial write interruption.

### AUT-051 - Diagnostic event expansion

- Lane: AG6
- Files:
  - `src/infra/diagnostic-events.ts`
  - `src/infra/diagnostic-events.test.ts`
  - `src/autonomy/runtime.ts`
- Tasks:
  - Add structured metrics for phase latency, candidate conversion, and rollback rates.
  - Tag events by lane and policy decision code.
- Acceptance tests:
  - Metrics include stage, status, and duration for all phase transitions.
  - Backward compatibility with existing diagnostic consumers.

### AUT-052 - CLI and UI ledger surfaces

- Lane: AG7
- Files:
  - `src/cli/cron-cli/register.cron-autonomous.ts`
  - `ui/src/ui/views/cron.ts`
  - `ui/src/ui/controllers/cron.ts`
  - `ui/src/ui/views/overview.ts`
- Tasks:
  - Add ledger summary panel and failed-ticket drilldown.
  - Add `cron autonomous-ledger` CLI command with filters.
- Acceptance tests:
  - UI shows latest promotions, rollbacks, and policy denials.
  - CLI filtering by stage/status/date works in text and JSON modes.

## Epic AUT-E06: Eval harness and long-horizon quality (weeks 10-18)

### AUT-060 - Eval scenario registry

- Lane: AG5
- Files:
  - `src/autonomy/eval/scenarios.ts` (new)
  - `src/autonomy/eval/scenarios.test.ts` (new)
  - `docs/testing.md`
- Tasks:
  - Define baseline, adversarial, and regression scenario packs.
  - Add scorecard metrics for quality, safety, and latency.
- Acceptance tests:
  - Scenario packs run deterministically with fixed seeds.
  - Scorecards are emitted as JSON artifacts.

### AUT-061 - Long-horizon simulation runner

- Lane: AG5
- Files:
  - `src/autonomy/eval/long-horizon-runner.ts` (new)
  - `src/autonomy/eval/long-horizon-runner.test.ts` (new)
- Tasks:
  - Simulate multi-day autonomy loops with synthetic signal streams.
  - Detect drift, failure loops, and budget exhaustion patterns.
- Acceptance tests:
  - Runner reports loop deadlocks and runaway growth.
  - State snapshots can be replayed for deterministic debugging.

### AUT-062 - Promotion quality gates

- Lane: AG5
- Files:
  - `src/autonomy/eval/gates.ts` (new)
  - `src/autonomy/runtime.ts`
  - `src/autonomy/eval/gates.test.ts` (new)
- Tasks:
  - Require eval pass thresholds before promotion.
  - Add gate policy for fail-fast rollback on post-promotion regression.
- Acceptance tests:
  - Promotion is denied when scorecards are below threshold.
  - Regression during observe phase triggers rollback and candidate demotion.

## Epic AUT-E07: Channel and extension parity (weeks 12-20)

### AUT-070 - Channel capability matrix and conformance tests

- Lane: AG8
- Files:
  - `src/channels/plugins/catalog.ts`
  - `src/channels/plugins/catalog.test.ts`
  - `docs/channels/index.md`
- Tasks:
  - Build explicit matrix for autonomy-safe operations per channel.
  - Add automated conformance tests for capability declarations.
- Acceptance tests:
  - Every built-in channel has a capability profile.
  - Missing capability declarations fail tests.

### AUT-071 - Extension channel parity contracts

- Lane: AG8
- Files:
  - `extensions/*/openclaw.plugin.json`
  - `extensions/*/src/**/*.ts`
  - `docs/channels/*.md` (incremental)
- Tasks:
  - Ensure extension channels expose same autonomy safety metadata.
  - Add adapters for extension-specific delivery restrictions.
- Acceptance tests:
  - Extension channels pass shared conformance suite.
  - Policy runtime can evaluate extension channels without fallback ambiguity.

### AUT-072 - Outbound runner refactor for maintainability

- Lane: AG9
- Files:
  - `src/infra/outbound/message-action-runner.ts` (facade)
  - `src/infra/outbound/message-action-runner/resolve.ts` (new)
  - `src/infra/outbound/message-action-runner/dispatch.ts` (new)
  - `src/infra/outbound/message-action-runner/payload.ts` (new)
  - `src/infra/outbound/message-action-runner.test.ts`
- Tasks:
  - Split resolver, payload mapping, and dispatch concerns.
  - Keep existing exports stable.
- Acceptance tests:
  - Existing runner tests pass unchanged.
  - New module-level tests cover edge cases currently in integration-only tests.

## Epic AUT-E08: Major file refactors to unblock long-term autonomy (weeks 1-22, rolling)

### AUT-080 - Memory manager decomposition

- Lane: AG9
- Files:
  - `src/memory/manager.ts` (facade)
  - `src/memory/manager/sync.ts` (new)
  - `src/memory/manager/embeddings.ts` (new)
  - `src/memory/manager/search.ts` (new)
  - `src/memory/manager/index.ts` (new)
- Tasks:
  - Split indexing, sync orchestration, embedding batching, and search concerns.
  - Preserve `MemoryIndexManager` public API via facade.
- Acceptance tests:
  - Existing memory tests pass.
  - No behavior regression in sync scheduling and fallback provider activation.

### AUT-081 - TTS stack decomposition

- Lane: AG9
- Files:
  - `src/tts/tts.ts` (facade)
  - `src/tts/config.ts` (new)
  - `src/tts/providers/openai.ts` (new)
  - `src/tts/providers/elevenlabs.ts` (new)
  - `src/tts/providers/edge.ts` (new)
  - `src/tts/pipeline.ts` (new)
- Tasks:
  - Split config resolution from provider clients and synthesis pipeline.
  - Add provider conformance tests.
- Acceptance tests:
  - Existing TTS behavior remains intact for all supported providers.
  - Provider-specific errors map to consistent failure codes.

### AUT-082 - Bash exec tool modularization

- Lane: AG9
- Files:
  - `src/agents/bash-tools.exec.ts` (facade)
  - `src/agents/bash-tools/exec-config.ts` (new)
  - `src/agents/bash-tools/exec-runner.ts` (new)
  - `src/agents/bash-tools/exec-session.ts` (new)
- Tasks:
  - Separate policy/config normalization, execution runner, and process session tracking.
  - Maintain tool schema compatibility.
- Acceptance tests:
  - Existing exec tool tests remain green.
  - Approval and safety behavior remains unchanged.

### AUT-083 - WS message handler decomposition

- Lane: AG9
- Files:
  - `src/gateway/server/ws-connection/message-handler.ts` (facade)
  - `src/gateway/server/ws-connection/auth.ts` (new)
  - `src/gateway/server/ws-connection/router.ts` (new)
  - `src/gateway/server/ws-connection/handlers/*.ts` (new)
- Tasks:
  - Split auth, routing, and per-method handling to improve isolation and testability.
  - Add explicit unknown-method fallback handler.
- Acceptance tests:
  - Existing websocket integration tests remain green.
  - Unknown method behavior is deterministic and logged.

## Epic AUT-E09: Resilience, recovery, and operator controls (weeks 16-24)

### AUT-090 - Chaos and failure-injection suite

- Lane: AG5
- Files:
  - `src/autonomy/runtime.chaos.test.ts` (new)
  - `src/autonomy/store.chaos.test.ts` (new)
- Tasks:
  - Inject failures in lock files, state writes, queue reads, and verify runner.
  - Validate automatic recovery paths.
- Acceptance tests:
  - Corrupted primary state recovers from backup without data loss of critical fields.
  - Stale lock scenarios self-heal under bounded retry windows.

### AUT-091 - Multi-day budget and quota controls

- Lane: AG1
- Files:
  - `src/autonomy/types.ts`
  - `src/autonomy/store.ts`
  - `src/autonomy/runtime.ts`
  - `src/autonomy/runtime.test.ts`
- Tasks:
  - Add rolling weekly and monthly budgets in addition to daily budgets.
  - Add explicit policy responses for quota exhaustion.
- Acceptance tests:
  - Daily/weekly/monthly windows roll correctly across timezone boundaries.
  - Budget pauses include machine-readable reason codes.

### AUT-092 - Operator overrides and emergency brakes

- Lane: AG7
- Files:
  - `src/cli/cron-cli/register.cron-autonomous.ts`
  - `src/gateway/server-methods/cron.ts`
  - `ui/src/ui/views/cron.ts`
- Tasks:
  - Add explicit freeze, drain, and resume controls for autonomy lanes.
  - Add read-only status snapshot export.
- Acceptance tests:
  - Freeze blocks synthesis/promote phases while preserving discovery logging.
  - Drain mode completes in-flight verifies and prevents new candidates.

## Epic AUT-E10: Docs, runbooks, and GA readiness (weeks 20-26)

### AUT-100 - Operator runbooks

- Lane: AG10
- Files:
  - `docs/gateway/doctor.md`
  - `docs/automation/cron-jobs.md`
  - `docs/testing.md`
  - `docs/gateway/troubleshooting.md`
- Tasks:
  - Document incident procedures for stuck phases, runaway proposals, and rollback loops.
  - Add exact CLI command sequences for diagnosis and recovery.
- Acceptance tests:
  - Runbook dry-run validated on a fresh environment.
  - Commands are copy/paste safe and include expected outputs.

### AUT-101 - Architecture and safety docs

- Lane: AG10
- Files:
  - `docs/concepts/agent-loop.md`
  - `docs/concepts/multi-agent.md`
  - `docs/gateway/security/index.md`
  - `docs/tools/subagents.md`
- Tasks:
  - Document the augmentation FSM, policy gates, and lane model.
  - Document hard safety boundaries and approval requirements.
- Acceptance tests:
  - Docs match shipped CLI and gateway behavior.
  - Internal links and anchors resolve correctly in Mintlify.

### AUT-102 - Release readiness checklist

- Lane: AG10
- Files:
  - `docs/reference/RELEASING.md`
  - `README.md`
- Tasks:
  - Add autonomy GA checklist with mandatory quality gates.
  - Add rollback and hotfix protocol for autonomy regressions.
- Acceptance tests:
  - Checklist is executable end-to-end in staging.
  - GA checklist includes objective pass/fail criteria.

## Sequencing for parallel execution

## Wave 1 (weeks 1-4)

- Must land first: `AUT-001`, `AUT-002`, `AUT-003`.
- Can run in parallel after contracts: `AUT-004`, `AUT-010`, `AUT-080`.

## Wave 2 (weeks 5-8)

- Must land first: `AUT-011`, `AUT-020`, `AUT-040`.
- Parallel tickets: `AUT-012`, `AUT-013`, `AUT-021`, `AUT-042`, `AUT-050`.

## Wave 3 (weeks 9-12)

- Must land first: `AUT-022`, `AUT-030`, `AUT-031`, `AUT-051`.
- Parallel tickets: `AUT-023`, `AUT-041`, `AUT-072`, `AUT-081`.

## Wave 4 (weeks 13-18)

- Must land first: `AUT-032`, `AUT-033`, `AUT-060`, `AUT-061`.
- Parallel tickets: `AUT-062`, `AUT-070`, `AUT-071`, `AUT-082`, `AUT-083`.

## Wave 5 (weeks 19-22)

- Must land first: `AUT-090`, `AUT-091`.
- Parallel tickets: `AUT-092`, `AUT-100`, `AUT-101`.

## Wave 6 (weeks 23-26)

- Must land first: `AUT-102`.
- Final hardening: unresolved refactor carryovers, policy tuning, and capacity burn-in.

## Definition of done for every ticket

Every ticket is complete only when all conditions are met:

1. Code merged with tests.
2. Lint and build pass.
3. Telemetry and error codes documented.
4. Rollback plan verified.
5. Changelog/docs update included when user-visible behavior changed.

## Risk register (top items)

- **R1: Self-modification drift**
  - Mitigation: immutable ledger + hard policy deny defaults + canary-only promotion.
- **R2: State growth over long runs**
  - Mitigation: strict caps, pruning, and periodic compaction tickets.
- **R3: Merge conflicts from parallel lanes**
  - Mitigation: path ownership rules + serialized shared contract tickets.
- **R4: Channel-specific regressions**
  - Mitigation: capability matrix + per-channel conformance tests before promotion.
- **R5: Operational overload**
  - Mitigation: operator freeze/drain controls and runbook-first rollout.

## Immediate next sprint kickoff (create these issues first)

1. `AUT-001` Persist augmentation FSM state.
2. `AUT-002` Runtime phase machine extraction.
3. `AUT-010` Signal normalization pipeline.
4. `AUT-020` Skill candidate schema and planner.
5. `AUT-040` Execution class policy model.
6. `AUT-050` Immutable augmentation ledger.
7. `AUT-080` Memory manager decomposition (phase 1 facade split).

These seven tickets unlock all downstream parallel work and should be treated as Sprint 1 critical
path.
