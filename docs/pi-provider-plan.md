# Pi Provider Integration Plan

## Goal

Add `pi` as a first-class T3 Code provider so T3 threads can run against Pi RPC while preserving the user's existing Pi behavior layer:

- `~/.pi/agent/settings.json`
- `~/.pi/agent/mcp.json`
- user/project extensions
- user/project skills
- MCP adapter packages
- keyword-based prompt injection

This integration should treat Pi as a real provider runtime, not as a thin model alias or a special-case OpenCode wrapper.

## Non-Goals for MVP

- Full parity with every Pi interactive/TUI-only feature
- Rebuilding Pi's native extension UX inside T3
- Slash-command-centric workflows
- Perfect rollback/fork parity on day one
- Project-specific Pi config management UI in T3

## What We Already Verified

Using Pi RPC directly in `traci`, we confirmed:

1. User-level extensions and skills load in RPC mode
2. Keyword-based injection works in RPC mode
3. MCP tool execution works in RPC mode
4. Pi emits usable JSONL events for streaming, tools, and extension UI

This is enough to proceed with a provider-based integration in T3.

## Key Product Requirement

The value of Pi in this setup is not just model access. The value is the preserved runtime behavior:

- workspace-aware prompt injection
- skill-driven routing
- MCP access and routing
- repo-specific operational memory

The implementation must preserve those behaviors automatically when T3 launches Pi.

## Architecture Decision

Implement Pi as a new provider:

- provider kind: `pi`
- transport: Pi RPC over stdio (`--mode rpc`)
- lifecycle: one Pi subprocess per T3 thread/session
- session cwd: use the thread/worktree cwd
- model control: use Pi RPC model APIs where available

Do not route Pi through OpenCode or treat it as a generic external model.

## MVP Scope

### 1. Contracts and Settings

Add `pi` to T3 shared contracts and server settings.

Files likely affected:

- `packages/contracts/src/orchestration.ts`
- `packages/contracts/src/provider.ts`
- `packages/contracts/src/settings.ts`
- provider/model contracts that enumerate provider kinds or model selections

Changes:

- add `pi` to `ProviderKind`
- add `PiModelSelection` branch to `ModelSelection`
- add `providers.pi` settings
- add `PiSettings` with at least:
  - `enabled: boolean`
  - `binaryPath: string`
  - optional future fields for custom agent dir or extra args

Suggested default local config for this user:

- `binaryPath: /Users/johnzolton/Documents/pi-mono/pi-test.sh`

That preserves the source-run Pi setup already in use.

### 2. Provider Snapshot / Probe Layer

Expose Pi in provider discovery and the model picker.

Add:

- `PiProvider`
- `PiProviderLive`

Behavior:

- spawn Pi in RPC mode for a short probe
- call `get_available_models`
- translate returned Pi models into `ServerProviderModel`
- report provider readiness based on probe success
- keep auth reporting minimal for MVP (`unknown` is acceptable if Pi does not expose better state)

This should make Pi appear alongside existing providers.

### 3. Pi RPC Runtime Module

Create a dedicated runtime module, similar in role to `opencodeRuntime.ts`.

Suggested file:

- `apps/server/src/provider/piRuntime.ts`

Responsibilities:

- spawn Pi subprocess
- enforce strict JSONL framing
- correlate request/response ids
- stream runtime events
- manage process shutdown and interruption
- expose typed helper methods for common RPC commands

Minimum helper coverage:

- `get_state`
- `get_available_models`
- `prompt`
- `abort`
- `set_model`
- `get_messages` (for readback/snapshots)

Future helper coverage if needed:

- `follow_up`
- `steer`
- `new_session`
- `get_commands`

### 4. Pi Adapter

Add a provider adapter implementing `ProviderAdapterShape`.

Suggested service files:

- `apps/server/src/provider/Services/PiAdapter.ts`
- `apps/server/src/provider/Layers/PiAdapter.ts`

Capabilities:

- `sessionModelSwitch: "in-session"`

Required adapter methods:

- `startSession`
- `sendTurn`
- `interruptTurn`
- `stopSession`
- `listSessions`
- `hasSession`
- `readThread`
- `rollbackThread`
- `stopAll`
- `streamEvents`

### 5. Adapter Registry Wiring

Register Pi in the provider adapter registry.

Likely file:

- `apps/server/src/provider/Layers/ProviderAdapterRegistry.ts`

Result:

- T3 provider routing can resolve `pi` like any other provider

### 6. Provider Registry / Snapshot Wiring

Register Pi in provider snapshot services so the UI can discover it.

Likely files:

- provider registry layers
- any provider snapshot builders that enumerate provider implementations
- UI/provider picker surfaces if provider kinds are manually listed

## RPC Event Mapping Plan

Pi RPC emits its own event protocol. T3 needs canonical `ProviderRuntimeEvent` output.

### Minimum mapping for MVP

#### Turn lifecycle

- `agent_start` -> `turn.started`
- `agent_end` -> `turn.completed`
- `turn_start` / `turn_end` -> preserve as raw metadata or map where useful

#### Assistant text streaming

- `message_update` with `assistantMessageEvent.type === "text_delta"`
  - -> `content.delta` with `streamKind: "assistant_text"`

#### Tool lifecycle

- `tool_execution_start` -> `item.started`
- `tool_execution_update` -> `item.updated`
- `tool_execution_end` -> `item.completed`

Suggested item type mapping:

- Pi `mcp` tool -> `mcp_tool_call`
- Pi `bash` tool -> `command_execution`
- Pi `edit` / `write` tools -> `file_change`
- Pi `read` and unknown tools -> `dynamic_tool_call` or `unknown`

#### Errors / warnings

- `extension_error` -> `runtime.error`
- failed command responses -> `runtime.error`
- parse/protocol/process failures -> `runtime.error`

#### MCP and extension UI signals

Pi emits `extension_ui_request` for things like status updates.

For MVP:

- treat fire-and-forget requests such as `setStatus` as informational
- optionally map MCP-related status to `mcp.status.updated`
- safely ignore unsupported UI-only notifications if they are not required for T3 behavior

## Session and State Model

### Start session

On T3 thread start:

- spawn Pi RPC process
- pass thread/worktree cwd
- optionally set requested model if one was chosen
- keep one Pi subprocess per active T3 thread

### Send turn

On T3 turn send:

- issue Pi `prompt`
- stream events back into T3 canonical provider events

### Interrupt

On T3 interrupt:

- issue Pi `abort`

### Stop session

On T3 stop:

- terminate the Pi process cleanly
- force kill only if needed

## Critical Preservation Requirements

These must hold for the integration to be worth shipping:

1. Pi runs with the correct `cwd`
2. Pi uses the user's normal `~/.pi/agent` setup
3. user skills/extensions stay active
4. MCP adapter packages remain available
5. keyword-based injections work without slash commands
6. MCP tool execution works through T3

If any of those are broken, the integration is not delivering the intended Pi workflow.

## Known Gaps / Risks

### 1. Rollback semantics

T3 expects adapter support for thread readback and rollback.

Pi RPC offers:

- `get_messages`
- `fork`
- `new_session`

But this may not map cleanly to T3's rollback model.

Plan:

- implement `readThread` from `get_messages`
- implement `rollbackThread` conservatively
- if exact rollback parity is not possible, return a clear unsupported error instead of inventing semantics

Do not block the initial integration on perfect rollback support.

### 2. Interactive extension UI

Pi RPC can request:

- `select`
- `confirm`
- `input`
- `editor`

For MVP:

- handle or surface them only if they appear in normal T3 usage
- otherwise fail loudly and visibly rather than ignoring a blocking request silently

Given the target workflow is full-access and mostly automatic routing, this likely does not block the first implementation.

### 3. Session recovery/resume

Pi has session concepts, but T3's persisted resume model may not line up perfectly.

For MVP, prefer:

- reliable fresh sessions
- correct streaming
- correct tool behavior
- clean interruption

Resume/recovery can be improved after the first working provider path is in place.

## Validation Checklist

The first working Pi provider should pass these manual checks:

### Injection-only checks

In `traci`, using provider `pi`:

1. ask which MCP server to use for traces/evals
2. verify the answer prefers Arize
3. verify no tool calls occur

4. ask whether to use prod or integration OpenSearch indices
5. verify the answer prefers `prod_`
6. verify no tool calls occur

### MCP execution checks

1. ask Pi to use MCP to list CloudWatch log groups
2. verify T3 shows tool lifecycle events
3. verify Pi actually invokes the `mcp` tool
4. verify the final answer contains the tool result

### Workspace/cwd checks

1. run in `traci`
2. verify workspace-sensitive routing still matches `traci` assumptions
3. confirm behavior differs appropriately in another repo if relevant

### Session control checks

1. start a thread
2. stream assistant text
3. interrupt a running turn
4. stop the session
5. ensure no orphan Pi process remains

## Testing Strategy

### Unit / adapter tests

Add tests covering:

- JSONL parsing and request correlation
- process startup failure handling
- event mapping from Pi RPC to T3 canonical runtime events
- tool lifecycle mapping
- interrupt/stop behavior
- unsupported rollback behavior if applicable

### Integration-style smoke tests

If T3 has provider integration tests or adapter harnesses, add a Pi-focused set that uses mocked RPC output rather than a real LLM where possible.

For manual validation, use the real local Pi source runner.

## Suggested Implementation Order

1. Add `pi` to shared contracts and settings
2. Add Pi provider snapshot/probe
3. Build `piRuntime.ts`
4. Build `PiAdapter`
5. Register Pi in adapter and provider registries
6. Wire provider discovery/UI surfaces
7. Manually validate in `traci`
8. Tighten recovery/rollback and richer UI request handling only after MVP works

## Definition of Done for MVP

Pi integration is good enough for first use when:

- T3 shows Pi as an available provider
- a T3 thread can start with provider `pi`
- Pi uses the correct cwd
- keyword-based routing survives through T3
- MCP tool execution survives through T3
- assistant streaming renders correctly
- interrupt works
- no slash-command dependency is introduced

## Follow-Up Work After MVP

- richer mapping of Pi extension UI requests into T3 UI
- Pi-specific settings in T3 server config UI
- better auth/provider health reporting
- stronger session resume/recovery support
- optional diagnostics panel for active Pi skills/MCP status
- rollback/fork parity improvements if needed
