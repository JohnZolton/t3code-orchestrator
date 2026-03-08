# Orchestrator Build Reference

Purpose: turn `ORCHESTRATOR_REQUIREMENTS.md` into an execution reference we can build against without re-deciding core scope every session.

Primary source docs:
- `ORCHESTRATOR_REQUIREMENTS.md`
- `AGENTS.md`

Current repo baseline:
- We already have event-sourced project/thread orchestration, projections, replay, and snapshot queries.
- We do not yet have the meta-orchestrator domain described in `ORCHESTRATOR_REQUIREMENTS.md`.
- This document assumes we build on top of the existing orchestration system rather than replacing it.

## 1. Source-of-Truth Rules

- `ORCHESTRATOR_REQUIREMENTS.md` remains the product source of truth.
- This file is the implementation source of truth for build sequencing, concrete v1 decisions, and known risks.
- If this file conflicts with `ORCHESTRATOR_REQUIREMENTS.md`, update one of them explicitly; do not silently drift.
- For task completion, `bun lint` and `bun typecheck` must pass.

## 2. What Already Exists

- Shared orchestration contracts and websocket methods exist in `packages/contracts/src/orchestration.ts`.
- Server-side event sourcing and command dispatch exist in `apps/server/src/orchestration/Layers/OrchestrationEngine.ts`.
- DB-backed projections and snapshot queries exist in:
  - `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`
  - `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`
- Provider runtime dispatch/ingestion already exists in:
  - `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
  - `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`
- Web app already has direct worker-thread control and plan-mode scaffolding in:
  - `apps/web/src/components/Sidebar.tsx`
  - `apps/web/src/components/ChatView.tsx`
  - `apps/web/src/proposedPlan.ts`

## 3. Core Gap Summary

Not yet implemented:
- Orchestrator run model.
- Lane/workstream model.
- Lane dependency model.
- Artifact model.
- Verification report model.
- Prompt-upgrade engine with structured worker briefs.
- Governed prompt self-edit proposal/apply/rollback flow.
- Orchestrator-specific approvals.
- Orchestrator UI pane and dashboard.
- Nostr bridge.

Important nuance:
- Current `orchestration` means project/thread/session orchestration.
- Planned orchestrator is a higher-level meta-orchestrator that coordinates worker threads.
- We should treat worker-thread orchestration as the substrate and meta-orchestration as an additional domain layer.

## 4. Locked v1 Decisions

These decisions remove ambiguity so implementation can start.

### 4.1 Domain boundary

- Keep existing thread/project orchestration intact as the worker runtime substrate.
- Add a distinct orchestrator domain on top of it.
- Do not overload thread state to implicitly represent orchestrator runs or lanes.

### 4.2 Lane mapping

- v1 lanes map 1:1 to worker threads.
- No sub-lanes inside a thread in v1.
- A lane may be re-targeted only through explicit user/orchestrator actions, not implicit reuse.

Reason:
- This keeps replay, UI, verification, and remote commands simpler.

### 4.3 Artifact model

- Artifacts are first-class persisted entities.
- v1 artifact kinds:
  - `change-manifest`
  - `acceptance-checklist`
  - `verification-output`
  - `summary`
  - `prompt-patch`
  - `audit-log`
- A lane can reference existing thread outputs, but completion logic must read artifact records, not infer completion from free-form messages.

### 4.4 Verification model

- Verification is server-owned.
- v1 lane completion requires:
  - required artifact presence
  - contradiction checks between claims and observed results
  - required command gate results
- Required repo-level gates for implementation work:
  - `bun lint`
  - `bun typecheck`
- Verification results are persisted as first-class verification reports.

### 4.5 Approval model

- Provider tool approvals remain separate from orchestrator approvals.
- v1 orchestrator approvals must cover:
  - major strategy shifts
  - prompt self-edit apply
  - destructive remote actions
- Approval state must be first-class shared state, not only UI-derived state.

### 4.6 Nostr scope

- Nostr is explicitly out of Phase 1.
- Nostr is allowed in v1 overall, but only after local orchestrator flows are stable.
- Build the orchestrator core behind a transport-agnostic command interface before adding Nostr.

### 4.7 Worktree defaults

- Default worker spawn behavior remains:
  - no worktree
  - same branch as current project context
- Worktree mode stays explicit and opt-in.

## 5. v1 Minimal Data Model

Add first-class entities for:
- orchestrator run
- lane
- lane dependency
- artifact
- verification report
- process rule/template version
- orchestrator approval item

Minimum entity expectations:

### 5.1 Orchestrator run

- Owns the top-level orchestration session.
- Tracks status, goal, selected project context, created/updated timestamps, and latest synthesis.

### 5.2 Lane

- Belongs to one orchestrator run.
- Maps to exactly one worker `threadId` in v1.
- Tracks objective, status, blocked reason, assigned brief, artifact requirements, and verification status.

### 5.3 Lane dependency

- Stores `fromLaneId -> toLaneId` relationships.
- Supports blocked/unblocked reasoning in the UI and synthesis logic.

### 5.4 Artifact

- Belongs to either a lane or orchestrator run.
- Stores kind, status, producer, structured payload or reference payload, timestamps.
- Must be auditable and replayable.

### 5.5 Verification report

- Belongs to a lane.
- Stores required checks, observed command outputs, pass/fail status, contradictions, and completion timestamp.

### 5.6 Process rule/template version

- Stores prompt/template/process memory revisions.
- Supports proposal, approval, apply, and rollback.

### 5.7 Orchestrator approval item

- Stores approval type, target entity, rationale, status, requester, approver, and timestamps.

## 6. Prompt Upgrade Contract

Every worker dispatch generated by the orchestrator must produce a structured worker brief.

Minimum v1 brief fields:
- objective
- success criteria
- hard requirements
- ordered phases
- required artifacts
- constraints and boundaries
- failure and uncertainty handling
- strategic context
- implementation context

Required behavior:
- Keep strategic context separate from implementation context.
- Preview the upgraded brief before dispatch.
- Persist the brief payload on the lane so replay and audit work.

Non-goal for v1:
- Perfect automatic task decomposition.

## 7. Artifact-First Completion Contract

Workers are not complete because they say they are complete.

Lane completion in v1 requires all of:
- required artifacts exist
- verification report exists
- verification report passes required checks
- no unresolved contradictions between claims and evidence

Minimum required artifact payloads:

### 7.1 Change manifest

- Files changed.
- Key functions/modules touched.
- Short explanation of why each area changed.

### 7.2 Acceptance checklist

- Requirement-to-status mapping.
- Explicit unchecked or partial items.

### 7.3 Verification output

- Commands run.
- Exit status.
- Key output summary.
- Timestamp.

### 7.4 Summary

- Human-readable lane outcome.
- Follow-up risks or unresolved edge cases.

## 8. Reliability Requirements to Preserve

- Orchestrator state must survive restart.
- Critical state must be replayable from persisted events or equivalently auditable records.
- Partial worker failure must not destroy run-level state.
- Out-of-order or delayed worker updates must not corrupt lane state.
- Existing thread UX must remain usable even if the orchestrator feature is disabled or incomplete.

## 9. Architectural Risks to Watch

### 9.1 Namespace collision risk

- Reusing the existing `orchestration` namespace for both worker-runtime state and orchestrator-run state may blur responsibilities.
- Recommendation: keep one transport namespace if convenient, but use explicit entity names and event names for orchestrator concepts.

### 9.2 Read-model scalability risk

- The web currently refetches the full orchestration snapshot after each domain event in `apps/web/src/routes/__root.tsx`.
- This is simple and reliable now, but may get too expensive for multi-lane dashboards.
- Recommendation: tolerate this in early Phase 1, then add targeted read-model queries before scale work.

### 9.3 Approval-state mismatch risk

- Current pending approval handling is provider-oriented.
- Orchestrator approvals must become first-class shared state instead of being inferred from activity logs.

### 9.4 Concurrency risk

- Provider runtime ingestion and UI assumptions were built for thread-centric interaction.
- Multi-lane orchestration increases the chance of shared-state leakage or sequence confusion.
- We should prefer explicit per-thread/per-lane correlation IDs and persisted status over transient UI heuristics.

### 9.5 Self-edit safety risk

- Prompt self-editing is the highest-risk product feature in this plan.
- Restrict v1 self-edits to approved prompt/process files only.
- Require patch artifact, rationale, expected behavior delta, risk level, and rollback instruction.

### 9.6 Nostr complexity risk

- Nostr is not a thin adapter.
- Auth, replay protection, allowlists, audit logs, and destructive-action approvals must be part of the initial design before shipping it.

## 10. Phase Plan

## Phase 1 - Local Orchestrator Overlay

Goal:
- Create a usable local orchestrator without Nostr or self-edit apply.

Must ship:
- Orchestrator run entity.
- Lane entity with 1:1 thread mapping.
- Lane dependency entity.
- Orchestrator chat pane in the UI.
- Worker visibility and quick actions from orchestrator UI.
- Prompt upgrade preview and dispatch flow.
- Basic lane status and blocked-reason rendering.
- Persistent orchestrator state and replay.

Can defer:
- Fancy lane board.
- Advanced analytics.
- Remote control.

Exit criteria:
- A user can create an orchestrator run and dispatch at least 3 concurrent worker lanes.
- Direct worker access still works.

## Phase 2 - Artifact and Verification Contract

Goal:
- Make orchestrator completion evidence-based.

Must ship:
- Artifact entity and artifact persistence.
- Verification report entity and persistence.
- Required artifact presence checks.
- `bun lint` and `bun typecheck` gating for implementation tasks.
- Contradiction detection between lane claims and observed results.
- Verification status in UI.

Exit criteria:
- Lanes cannot be marked complete without required artifacts and passing verification.

## Phase 3 - Governed Self-Edit Loop

Goal:
- Allow orchestrator process improvement without silent mutation.

Must ship:
- Process memory store.
- Prompt patch proposal artifact.
- Approval flow for self-edit apply.
- Apply and rollback workflow.
- Self-edit events in orchestration history.

Exit criteria:
- Self-edits cannot apply without explicit approval.
- Rollback is supported and auditable.

## Phase 4 - Remote Transport and Hardening

Goal:
- Add experimental remote ops and improve operator UX.

Must ship:
- Transport-agnostic remote command boundary.
- Nostr allowlist and replay/dedup.
- Remote-action approval requirements.
- Audit logging for remote ingress/egress.
- Stalled-lane detection and richer dashboard state.

Exit criteria:
- Authorized pubkey can drive orchestrator chat remotely.
- Unauthorized access is rejected and logged.

## 11. Must Decide Early During Build

These are implementation decisions we should not keep punting.

- Exact event and projection split for orchestrator entities: same store/projections vs separate orchestrator-specific tables.
- Whether orchestrator entities live inside `packages/contracts/src/orchestration.ts` or in a new contracts module.
- Whether prompt templates are stored as files, persisted records, or both.
- How verification command execution is sandboxed, timed out, and canceled.
- Which file set is eligible for self-editing in v1.

Current recommendation:
- Reuse the existing event store and projection pipeline patterns.
- Add orchestrator-specific shared contracts in a separate module if `packages/contracts/src/orchestration.ts` starts becoming mixed-responsibility.

## 12. Safe Deferrals

Okay to defer until after the first local orchestrator loop works:
- autonomy levels beyond a basic setting
- advanced dependency visualization
- run-level analytics
- worktree env import UX polish
- Nostr compatibility modes beyond the simplest supported path
- sub-lanes or multi-thread lanes

## 13. Implementation Checklist

Use this as the active build checklist.

### 13.1 Contracts and domain

- Add shared schemas for orchestrator runs, lanes, dependencies, artifacts, verification reports, process rule versions, and approval items.
- Add command/event types for orchestrator lifecycle, lane lifecycle, artifact recording, verification, synthesis, and approvals.
- Define stable status enums for run, lane, artifact, verification, and approval.

### 13.2 Persistence and projections

- Add persisted write-side support for new orchestrator events.
- Add projection tables/read models for orchestrator entities.
- Add snapshot or read-query support for orchestrator UI needs.
- Ensure replay/bootstrap brings orchestrator projections current on restart.

### 13.3 Server logic

- Add orchestrator command decider paths.
- Add prompt-upgrade service.
- Add verification gate service.
- Add synthesis service.
- Add approval service for orchestrator-level approvals.

### 13.4 Web UX

- Add orchestrator pane on the left.
- Shift worker selector/layout accordingly.
- Make the orchestrator pane collapsible.
- Keep orchestrator chat visuals and composer behavior aligned with the main chat UX unless there is a deliberate product reason not to.
- Add lane list/status rendering.
- Add dependency and blocked-state visibility.
- Add prompt brief preview before dispatch.
- Add self-edit proposal and approval UI later in the planned phase.

### 13.4.1 Orchestrator context discipline

- Inject workspace inventory for the orchestrator only into the latest provider-bound message when needed.
- Do not persist repeated project/thread inventory into older visible chat messages.
- Prefer ephemeral provider input augmentation over storing duplicated context in thread history.

### 13.5 Safety and policy

- Enforce AGENTS.md safety constraints in orchestrator-generated worker briefs.
- Prevent destructive actions without explicit approval.
- Keep local and remote policy checks aligned.

### 13.6 Verification

- Persist command-level verification results.
- Surface pass/fail and contradiction details in the UI.
- Keep lane completion blocked until required verification passes.

### 13.7 Remote transport

- Add remote transport abstraction only after local command boundary is stable.
- Add Nostr bridge behind explicit config.

## 14. Working Rules for This Build Session

- Prefer thin vertical slices over broad scaffolding.
- When adding orchestrator functionality, first ask whether shared logic belongs in `packages/shared` or a reusable server module.
- Do not bolt orchestrator-only assumptions directly into existing thread UI if they should be reusable state or contracts.
- Keep restart/replay correctness ahead of UX polish.
- Favor explicit persisted state over derived heuristics where correctness matters.
- Default to execution, not confirmation-seeking. When the desired direction is already clear from the latest user feedback, continue building instead of asking for reaffirmation.
- Do not introduce temporary UX/protocol hacks if the user has already rejected that direction; move to the intended architecture directly when feasible.

## 15. Definition of Done for the Overall v1

v1 is only done when all of the following are true:
- orchestrator run exists and persists across restart
- at least 3 concurrent worker lanes can be dispatched
- user retains direct worker-thread control
- prompts are upgraded into structured worker briefs
- workers cannot be marked done without artifacts and verification
- self-edit proposal/apply/rollback is governed and auditable
- Nostr can be disabled without affecting local orchestrator behavior
- `bun lint` passes
- `bun typecheck` passes
