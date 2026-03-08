# Orchestrator Requirements

## Why this exists

This document captures requirements for a **meta-orchestrator layer** in T3 Code that manages concurrent worker chat instances, upgrades user prompts into high-signal execution plans, and continuously improves its own operating prompt/process over time.

The primary goal is to turn ad-hoc multi-agent work into a reliable, reviewable, and evolvable system.

## Product intent

- Add a strategic orchestration chat that can coordinate multiple worker threads/sessions.
- Keep humans in control while reducing cognitive load from context switching.
- Convert raw user intents into structured, enforceable worker instructions.
- Require artifact-first deliverables (evidence) instead of self-reported completion.
- Let the orchestrator improve its own process docs (including AGENTS-style instructions) via explicit governance and checkpoints.

## UX vision (explicit)

- Add a new orchestrator chat pane on the left.
- Shift the existing project/worker selector pane to the right by one pane width.
- Keep direct user control over all worker chats (no lockout behind orchestrator).
- Allow both user and orchestrator to:
  - message existing worker threads
  - fork worker chats
  - spawn new worker chats
- Treat orchestrator as a peer control surface, not a replacement for direct worker interaction.

## Scope (v1)

- Orchestrator runs inside this repo's existing server/web architecture.
- Orchestrator can target multiple existing thread sessions as workers.
- Orchestrator supports planning, dispatch, monitoring, verification, and synthesis.
- Orchestrator can propose and apply changes to an orchestrator prompt file and process memory files.
- Orchestrator supports optional remote chat control over Nostr direct messaging.

## Non-goals (v1)

- Fully autonomous operation with no human override.
- Arbitrary self-modification with no audit trail.
- Perfect task decomposition in first implementation.
- Replacing provider adapters or provider protocol internals.
- Deep coupling to Marmot/WhiteNoise MLS internals as a hard dependency.

## Functional requirements

### 1) Workstream orchestration

- The system MUST support one orchestrator chat coordinating N worker threads.
- The orchestrator MUST have visibility into active/running worker threads, including current activity and recent outputs.
- A formal lane state machine is OPTIONAL in v1.
- If implemented, lane/workstream states SHOULD remain lightweight and implementation-driven.

### 2) Prompt funneling and prompt upgrading

- User prompts intended for workers MUST pass through a prompt-enhancement pipeline.
- The pipeline MUST produce a structured worker brief containing at minimum:
  - objective and success criteria
  - hard requirements (non-negotiable)
  - ordered execution phases (design -> implement -> verify -> report)
  - mandatory artifacts to return
  - constraints and boundaries
  - failure/uncertainty handling instructions
- The orchestrator MUST separate:
  - strategic context (why, priorities, tradeoffs)
  - implementation context (how, code-level details)
- The orchestrator SHOULD support reusable prompt templates per task type (research, implementation, migration, debugging, release).
- The orchestrator MUST be able to target any selected worker thread and dispatch upgraded prompts into that thread.

### 3) Artifact-first completion protocol

- Workers MUST return artifacts suitable for human review and automated checks.
- The orchestrator MUST treat self-reported completion as insufficient without artifact checks.
- Required artifact classes (task-dependent):
  - change manifest (files/functions changed)
  - acceptance checklist mapped to requirements
  - verification outputs (lint/typecheck/build/tests as applicable)
  - optional visuals/diagrams for design-heavy work
  - evaluation function/results for quality-sensitive tasks
- The orchestrator MUST mark lane completion only after artifact validation.

### 4) Verification and gating

- The orchestrator MUST run a verification protocol before merging lane outputs.
- Verification protocol MUST include:
  - command-level checks for required gates
  - artifact presence checks
  - contradiction checks between claims and observed results
- In this repo, orchestrator completion gates MUST include:
  - `bun lint`
  - `bun typecheck`

### 5) Meta-process evolution (self-improvement)

- The orchestrator MUST maintain explicit process memory files (patterns, failures, decisions).
- The orchestrator MUST support a recurring meta-retrospective loop:
  - capture surprising outcome
  - name the failure/pattern
  - extract rule/template change
  - apply change proposal
  - verify impact in later runs
- The orchestrator MUST be able to edit its own prompt/instruction file(s) (AGENTS-style) through a governed flow, not direct silent mutation.

### 6) Governed prompt self-editing

- Prompt self-edits MUST create a versioned patch artifact including:
  - rationale
  - expected behavior delta
  - risk level
  - rollback instruction
- Prompt self-edits MUST be logged as first-class orchestration events.
- All self-edits MUST require an explicit human approval button press before apply.
- The orchestrator MUST support rollback to previous prompt versions.

### 7) Human control surface

- Human operator MUST be able to:
  - chat directly with the orchestrator in its own pane
  - inspect all active lanes and dependencies
  - approve/reject major strategy shifts
  - approve/reject prompt self-edits
  - pause/resume/terminate lanes
  - request synthesis at any time
- The system SHOULD support configurable autonomy levels per lane.

### 8) Reliability and recoverability

- Orchestrator state MUST survive process restart.
- Lane state, checkpoints, and decision logs MUST be replayable from persisted events.
- The orchestrator MUST handle partial worker failure without losing global state.
- The orchestrator MUST tolerate delayed/out-of-order worker updates.

### 9) Nostr remote orchestrator access (experimental)

- The system MUST support an optional Nostr transport for orchestrator chat.
- Nostr transport MUST be disabled by default and explicitly enabled via config.
- v1 transport mode MUST be direct Nostr DM bridge (NIP-17-compatible where available).
- The bridge MUST use encrypted direct-message handling abstraction so encryption mode can evolve without changing orchestrator core logic.
- The bridge MUST map inbound authorized Nostr messages into orchestrator intents/commands.
- The bridge MUST map orchestrator replies/status updates back to Nostr outbound messages.
- The bridge MUST enforce an operator pubkey allowlist.
- The bridge MUST include replay/dedup protection (event-id idempotency).
- The bridge MUST require explicit approval for destructive actions initiated from Nostr.
- The bridge SHOULD support compact command-style prompts for mobile control (status, synth, send, spawn, fork).
- The bridge SHOULD persist ingress/egress audit records as orchestration artifacts.

## Data and state requirements

- Add orchestration domain entities for:
  - orchestrator run
  - lane/workstream
  - lane dependency
  - artifact
  - verification report
  - process rule/template version
- All critical transitions MUST be event-sourced or equivalently auditable.
- Snapshot/read-model queries MUST support fast dashboard rendering.

## UX requirements (minimum)

- Show a dedicated orchestrator view with:
  - orchestrator chat pane (left)
  - existing worker selector pane shifted right
  - worker thread visibility with running status/activity
  - quick actions to message/fork/spawn worker threads
  - optional lane/workstream board
  - dependency map
  - blocked reasons
  - verification status
  - prompt upgrade preview (before dispatch)
  - self-edit proposals and approvals
- Enable one-click "dispatch to worker lane" from orchestrator briefs.
- Enable one-click "synthesize across lanes" summary for human review.

## Worktree behavior requirements

- Worktree support is a soft requirement in v1.
- Default worker spawn behavior MUST be:
  - no worktree
  - same branch as current project context
- Worker spawn API MUST support enabling worktree mode via explicit config.
- When worktree mode is enabled, bootstrap behavior SHOULD include optional environment carry-over (e.g. `.env` and related local config) with clear, user-visible controls.
- Worktree setup SHOULD prioritize predictable local dev experience over strict isolation for v1.

## Safety and policy requirements

- Orchestrator MUST enforce repository safety constraints from AGENTS.md.
- Orchestrator MUST prevent unreviewed destructive actions.
- Orchestrator MUST keep clear separation between:
  - operational memory (state)
  - strategic memory (process/patterns)
  - implementation details (code-level lane context)
- Remote transport safety:
  - Nostr-originated actions MUST pass the same policy checks as in-app actions.
  - Unauthorized pubkeys MUST be rejected and logged.
  - Remote control MUST be disableable at runtime/config level without affecting local UI control.

## Nostr transport strategy

- v1: direct Nostr DM bridge (experimental, feature-flagged).
- v2: optional Marmot/WhiteNoise MLS transport adapter once dependency/API stability is acceptable.
- Orchestrator core interfaces MUST be transport-agnostic so Nostr/Marmot are adapters, not core coupling.

## Suggested implementation approach for this codebase

### Phase 1: Thin orchestration overlay

- Implement orchestrator lane management on top of existing thread model.
- Implement orchestrator chat pane and worker pane shift in the web layout.
- Add orchestrator command/event types without breaking existing flows.
- Reuse existing `orchestration.dispatchCommand` transport for new command variants.
- Store lane metadata and artifact records in persistence projections.

### Phase 2: Prompt-upgrade engine + artifact contract

- Add prompt template registry and requirement compiler.
- Enforce worker brief schema and artifact schema.
- Add verification gate service that validates artifact claims and command outputs.
- Add Nostr gateway service skeleton (ingress mapping, egress publishing, allowlist checks).

### Phase 3: Governed self-edit loop

- Add process memory store and pattern extraction flow.
- Add AGENTS-style prompt patch proposal/apply/rollback workflow.
- Add approval policies for self-edit categories.

### Phase 4: UX hardening + scale

- Add orchestrator dashboard and dependency visualization.
- Add stalled-lane detection and automated check-ins.
- Add run-level analytics (lead time, failure causes, verification pass rate).
- Add stronger worktree spawn UX with env import controls and defaults.
- Add remote-ops UX (Nostr bridge status, linked pubkeys, last remote activity).

## Acceptance criteria (v1)

- A user can create an orchestrator run and dispatch at least 3 concurrent worker lanes.
- The UI shows an orchestrator chat pane on the left and keeps direct user access to worker chats.
- Both user and orchestrator can message, fork, and spawn worker threads.
- Raw user prompts are automatically upgraded into structured worker briefs.
- Workers cannot be marked done without required artifacts and verification checks.
- Orchestrator state survives restart and can replay to current status.
- Orchestrator can propose, apply, and roll back its own instruction-file edits with audit history.
- Self-edits cannot apply without an approval button click.
- Worker spawn defaults to no-worktree/same-branch, with explicit worktree config available.
- A configured authorized pubkey can send a Nostr DM and receive orchestrator replies.
- Nostr-originated orchestrator actions can dispatch work to worker threads.
- Unauthorized pubkeys are rejected with auditable event logs.
- Nostr transport can be turned off without impacting core local app behavior.
- `bun lint` and `bun typecheck` pass after orchestrator-layer changes.

## Open questions

- Should orchestrator lanes map 1:1 to existing threads, or allow sub-lanes per thread?
- Which prompt self-edits are always human-gated vs auto-mergeable?
- What is the minimum artifact schema that balances speed and rigor?
- Should synthesis be model-specific or provider-agnostic from day one?
- Should orchestrator metrics be persisted locally only or exposed for remote telemetry?
- Should v1 target strict NIP-17 only, or support fallback encrypted DM compatibility modes?
- When should Marmot/WhiteNoise adapter move from experimental to supported?
