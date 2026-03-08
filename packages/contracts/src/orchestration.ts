import { Option, Schema, SchemaIssue, Struct } from "effect";
import { ClaudeModelOptions, CodexModelOptions } from "./model";
import {
  ApprovalRequestId,
  CheckpointRef,
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  OrchestratorApprovalId,
  OrchestratorArtifactId,
  OrchestratorLaneId,
  OrchestratorRunId,
  ProcessRuleVersionId,
  ProjectId,
  ProviderItemId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas";

export const ORCHESTRATION_WS_METHODS = {
  getSnapshot: "orchestration.getSnapshot",
  dispatchCommand: "orchestration.dispatchCommand",
  getTurnDiff: "orchestration.getTurnDiff",
  getFullThreadDiff: "orchestration.getFullThreadDiff",
  replayEvents: "orchestration.replayEvents",
} as const;

export const ORCHESTRATION_WS_CHANNELS = {
  domainEvent: "orchestration.domainEvent",
} as const;

export const ProviderKind = Schema.Literals(["codex", "claudeAgent"]);
export type ProviderKind = typeof ProviderKind.Type;
export const ProviderApprovalPolicy = Schema.Literals([
  "untrusted",
  "on-failure",
  "on-request",
  "never",
]);
export type ProviderApprovalPolicy = typeof ProviderApprovalPolicy.Type;
export const ProviderSandboxMode = Schema.Literals([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
export type ProviderSandboxMode = typeof ProviderSandboxMode.Type;

export const DEFAULT_PROVIDER_KIND: ProviderKind = "codex";

export const CodexModelSelection = Schema.Struct({
  provider: Schema.Literal("codex"),
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(CodexModelOptions),
});
export type CodexModelSelection = typeof CodexModelSelection.Type;

export const ClaudeModelSelection = Schema.Struct({
  provider: Schema.Literal("claudeAgent"),
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(ClaudeModelOptions),
});
export type ClaudeModelSelection = typeof ClaudeModelSelection.Type;

export const ModelSelection = Schema.Union([CodexModelSelection, ClaudeModelSelection]);
export type ModelSelection = typeof ModelSelection.Type;

export const RuntimeMode = Schema.Literals(["approval-required", "full-access"]);
export type RuntimeMode = typeof RuntimeMode.Type;
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
export const ProviderInteractionMode = Schema.Literals(["default", "plan"]);
export type ProviderInteractionMode = typeof ProviderInteractionMode.Type;
export const DEFAULT_PROVIDER_INTERACTION_MODE: ProviderInteractionMode = "default";
export const ProviderRequestKind = Schema.Literals(["command", "file-read", "file-change"]);
export type ProviderRequestKind = typeof ProviderRequestKind.Type;
export const AssistantDeliveryMode = Schema.Literals(["buffered", "streaming"]);
export type AssistantDeliveryMode = typeof AssistantDeliveryMode.Type;
export const ProviderApprovalDecision = Schema.Literals([
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
]);
export type ProviderApprovalDecision = typeof ProviderApprovalDecision.Type;
export const ProviderUserInputAnswers = Schema.Record(Schema.String, Schema.Unknown);
export type ProviderUserInputAnswers = typeof ProviderUserInputAnswers.Type;

export const PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000;
export const PROVIDER_SEND_TURN_MAX_ATTACHMENTS = 8;
export const PROVIDER_SEND_TURN_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS = 14_000_000;
const CHAT_ATTACHMENT_ID_MAX_CHARS = 128;
// Correlation id is command id by design in this model.
export const CorrelationId = CommandId;
export type CorrelationId = typeof CorrelationId.Type;

const ChatAttachmentId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CHAT_ATTACHMENT_ID_MAX_CHARS),
  Schema.isPattern(/^[a-z0-9_-]+$/i),
);
export type ChatAttachmentId = typeof ChatAttachmentId.Type;

export const ChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
});
export type ChatImageAttachment = typeof ChatImageAttachment.Type;

const UploadChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
  dataUrl: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS),
  ),
});
export type UploadChatImageAttachment = typeof UploadChatImageAttachment.Type;

export const ChatAttachment = Schema.Union([ChatImageAttachment]);
export type ChatAttachment = typeof ChatAttachment.Type;
const UploadChatAttachment = Schema.Union([UploadChatImageAttachment]);
export type UploadChatAttachment = typeof UploadChatAttachment.Type;

export const ProjectScriptIcon = Schema.Literals([
  "play",
  "test",
  "lint",
  "configure",
  "build",
  "debug",
]);
export type ProjectScriptIcon = typeof ProjectScriptIcon.Type;

export const ProjectScript = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  icon: ProjectScriptIcon,
  runOnWorktreeCreate: Schema.Boolean,
});
export type ProjectScript = typeof ProjectScript.Type;

export const OrchestrationProject = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  defaultModelSelection: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationProject = typeof OrchestrationProject.Type;

export const OrchestrationMessageRole = Schema.Literals(["user", "assistant", "system"]);
export type OrchestrationMessageRole = typeof OrchestrationMessageRole.Type;

export const OrchestrationMessage = Schema.Struct({
  id: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationMessage = typeof OrchestrationMessage.Type;

export const OrchestrationProposedPlanId = TrimmedNonEmptyString;
export type OrchestrationProposedPlanId = typeof OrchestrationProposedPlanId.Type;

export const OrchestrationProposedPlan = Schema.Struct({
  id: OrchestrationProposedPlanId,
  turnId: Schema.NullOr(TurnId),
  planMarkdown: TrimmedNonEmptyString,
  implementedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(() => null)),
  implementationThreadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(() => null)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationProposedPlan = typeof OrchestrationProposedPlan.Type;

const SourceProposedPlanReference = Schema.Struct({
  threadId: ThreadId,
  planId: OrchestrationProposedPlanId,
});

export const OrchestrationSessionStatus = Schema.Literals([
  "idle",
  "starting",
  "running",
  "ready",
  "interrupted",
  "stopped",
  "error",
]);
export type OrchestrationSessionStatus = typeof OrchestrationSessionStatus.Type;

export const OrchestrationSession = Schema.Struct({
  threadId: ThreadId,
  status: OrchestrationSessionStatus,
  providerName: Schema.NullOr(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE)),
  activeTurnId: Schema.NullOr(TurnId),
  lastError: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});
export type OrchestrationSession = typeof OrchestrationSession.Type;

export const OrchestrationCheckpointFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: TrimmedNonEmptyString,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type OrchestrationCheckpointFile = typeof OrchestrationCheckpointFile.Type;

export const OrchestrationCheckpointStatus = Schema.Literals(["ready", "missing", "error"]);
export type OrchestrationCheckpointStatus = typeof OrchestrationCheckpointStatus.Type;

export const OrchestrationCheckpointSummary = Schema.Struct({
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type OrchestrationCheckpointSummary = typeof OrchestrationCheckpointSummary.Type;

export const OrchestrationThreadActivityTone = Schema.Literals([
  "info",
  "tool",
  "approval",
  "error",
]);
export type OrchestrationThreadActivityTone = typeof OrchestrationThreadActivityTone.Type;

export const OrchestrationThreadActivity = Schema.Struct({
  id: EventId,
  tone: OrchestrationThreadActivityTone,
  kind: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  payload: Schema.Unknown,
  turnId: Schema.NullOr(TurnId),
  sequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});
export type OrchestrationThreadActivity = typeof OrchestrationThreadActivity.Type;

const OrchestrationLatestTurnState = Schema.Literals([
  "running",
  "interrupted",
  "completed",
  "error",
]);
export type OrchestrationLatestTurnState = typeof OrchestrationLatestTurnState.Type;

export const OrchestrationLatestTurn = Schema.Struct({
  turnId: TurnId,
  state: OrchestrationLatestTurnState,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
});
export type OrchestrationLatestTurn = typeof OrchestrationLatestTurn.Type;

export const OrchestrationThread = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(() => null)),
  deletedAt: Schema.NullOr(IsoDateTime),
  messages: Schema.Array(OrchestrationMessage),
  proposedPlans: Schema.Array(OrchestrationProposedPlan).pipe(Schema.withDecodingDefault(() => [])),
  activities: Schema.Array(OrchestrationThreadActivity),
  checkpoints: Schema.Array(OrchestrationCheckpointSummary),
  session: Schema.NullOr(OrchestrationSession),
});
export type OrchestrationThread = typeof OrchestrationThread.Type;

export const OrchestratorRunStatus = Schema.Literals([
  "draft",
  "active",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);
export type OrchestratorRunStatus = typeof OrchestratorRunStatus.Type;

export const OrchestratorLaneStatus = Schema.Literals([
  "draft",
  "ready",
  "dispatched",
  "running",
  "blocked",
  "awaiting-verification",
  "completed",
  "failed",
  "cancelled",
]);
export type OrchestratorLaneStatus = typeof OrchestratorLaneStatus.Type;

export const OrchestratorArtifactKind = Schema.Literals([
  "change-manifest",
  "acceptance-checklist",
  "verification-output",
  "summary",
  "prompt-patch",
  "audit-log",
]);
export type OrchestratorArtifactKind = typeof OrchestratorArtifactKind.Type;

export const OrchestratorArtifactStatus = Schema.Literals([
  "missing",
  "draft",
  "ready",
  "superseded",
]);
export type OrchestratorArtifactStatus = typeof OrchestratorArtifactStatus.Type;

export const OrchestratorVerificationStatus = Schema.Literals([
  "not-run",
  "running",
  "passed",
  "failed",
]);
export type OrchestratorVerificationStatus = typeof OrchestratorVerificationStatus.Type;

export const OrchestratorApprovalType = Schema.Literals([
  "strategy-shift",
  "prompt-self-edit",
  "remote-destructive-action",
]);
export type OrchestratorApprovalType = typeof OrchestratorApprovalType.Type;

export const OrchestratorApprovalStatus = Schema.Literals([
  "pending",
  "approved",
  "rejected",
  "cancelled",
]);
export type OrchestratorApprovalStatus = typeof OrchestratorApprovalStatus.Type;

export const ProcessRuleVersionStatus = Schema.Literals([
  "proposed",
  "approved",
  "applied",
  "rolled-back",
  "rejected",
]);
export type ProcessRuleVersionStatus = typeof ProcessRuleVersionStatus.Type;

export const OrchestratorChatMessageRole = Schema.Literals(["user", "assistant", "system"]);
export type OrchestratorChatMessageRole = typeof OrchestratorChatMessageRole.Type;

export const OrchestratorChatMessage = Schema.Struct({
  id: MessageId,
  role: OrchestratorChatMessageRole,
  text: Schema.String,
  createdAt: IsoDateTime,
});
export type OrchestratorChatMessage = typeof OrchestratorChatMessage.Type;

export const OrchestratorWorkerBrief = Schema.Struct({
  objective: TrimmedNonEmptyString,
  successCriteria: Schema.Array(TrimmedNonEmptyString),
  hardRequirements: Schema.Array(TrimmedNonEmptyString),
  orderedPhases: Schema.Array(TrimmedNonEmptyString),
  requiredArtifacts: Schema.Array(OrchestratorArtifactKind),
  constraints: Schema.Array(TrimmedNonEmptyString),
  failureHandling: TrimmedNonEmptyString,
  strategicContext: TrimmedNonEmptyString,
  implementationContext: TrimmedNonEmptyString,
  dispatchPrompt: TrimmedNonEmptyString,
});
export type OrchestratorWorkerBrief = typeof OrchestratorWorkerBrief.Type;

export const OrchestratorLaneDependency = Schema.Struct({
  fromLaneId: OrchestratorLaneId,
  toLaneId: OrchestratorLaneId,
  createdAt: IsoDateTime,
});
export type OrchestratorLaneDependency = typeof OrchestratorLaneDependency.Type;

export const OrchestratorArtifact = Schema.Struct({
  id: OrchestratorArtifactId,
  laneId: Schema.NullOr(OrchestratorLaneId),
  runId: OrchestratorRunId,
  kind: OrchestratorArtifactKind,
  status: OrchestratorArtifactStatus,
  title: TrimmedNonEmptyString,
  payload: Schema.Unknown,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestratorArtifact = typeof OrchestratorArtifact.Type;

export const OrchestratorVerificationReport = Schema.Struct({
  laneId: OrchestratorLaneId,
  status: OrchestratorVerificationStatus,
  requiredCommands: Schema.Array(TrimmedNonEmptyString),
  commandResults: Schema.Array(
    Schema.Struct({
      command: TrimmedNonEmptyString,
      exitCode: Schema.NullOr(Schema.Int),
      stdout: Schema.String,
      stderr: Schema.String,
      startedAt: IsoDateTime,
      completedAt: IsoDateTime,
    }),
  ),
  contradictions: Schema.Array(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});
export type OrchestratorVerificationReport = typeof OrchestratorVerificationReport.Type;

export const OrchestratorApprovalItem = Schema.Struct({
  id: OrchestratorApprovalId,
  runId: OrchestratorRunId,
  laneId: Schema.NullOr(OrchestratorLaneId),
  type: OrchestratorApprovalType,
  status: OrchestratorApprovalStatus,
  title: TrimmedNonEmptyString,
  rationale: TrimmedNonEmptyString,
  requestedAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestratorApprovalItem = typeof OrchestratorApprovalItem.Type;

export const ProcessRuleVersion = Schema.Struct({
  id: ProcessRuleVersionId,
  runId: Schema.NullOr(OrchestratorRunId),
  status: ProcessRuleVersionStatus,
  title: TrimmedNonEmptyString,
  rationale: TrimmedNonEmptyString,
  expectedBehaviorDelta: TrimmedNonEmptyString,
  riskLevel: TrimmedNonEmptyString,
  rollbackInstruction: TrimmedNonEmptyString,
  patch: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProcessRuleVersion = typeof ProcessRuleVersion.Type;

export const OrchestratorLane = Schema.Struct({
  id: OrchestratorLaneId,
  runId: OrchestratorRunId,
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  objective: TrimmedNonEmptyString,
  status: OrchestratorLaneStatus,
  blockedReason: Schema.NullOr(TrimmedNonEmptyString),
  brief: Schema.NullOr(OrchestratorWorkerBrief),
  requiredArtifactKinds: Schema.Array(OrchestratorArtifactKind),
  verification: Schema.NullOr(OrchestratorVerificationReport),
  artifacts: Schema.Array(OrchestratorArtifact),
  updatedAt: IsoDateTime,
  createdAt: IsoDateTime,
});
export type OrchestratorLane = typeof OrchestratorLane.Type;

export const OrchestratorRun = Schema.Struct({
  id: OrchestratorRunId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  goal: TrimmedNonEmptyString,
  status: OrchestratorRunStatus,
  latestSynthesis: Schema.NullOr(Schema.String),
  messages: Schema.Array(OrchestratorChatMessage),
  lanes: Schema.Array(OrchestratorLane),
  dependencies: Schema.Array(OrchestratorLaneDependency),
  approvals: Schema.Array(OrchestratorApprovalItem),
  processRuleVersions: Schema.Array(ProcessRuleVersion),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestratorRun = typeof OrchestratorRun.Type;

export const OrchestrationReadModel = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProject),
  threads: Schema.Array(OrchestrationThread),
  orchestratorRuns: Schema.Array(OrchestratorRun).pipe(Schema.withDecodingDefault(() => [])),
  updatedAt: IsoDateTime,
});
export type OrchestrationReadModel = typeof OrchestrationReadModel.Type;

export const ProjectCreateCommand = Schema.Struct({
  type: Schema.Literal("project.create"),
  commandId: CommandId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  createdAt: IsoDateTime,
});

const ProjectMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("project.meta.update"),
  commandId: CommandId,
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
});

const ProjectDeleteCommand = Schema.Struct({
  type: Schema.Literal("project.delete"),
  commandId: CommandId,
  projectId: ProjectId,
});

const ThreadCreateCommand = Schema.Struct({
  type: Schema.Literal("thread.create"),
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});

const ThreadDeleteCommand = Schema.Struct({
  type: Schema.Literal("thread.delete"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadArchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.archive"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadUnarchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.unarchive"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("thread.meta.update"),
  commandId: CommandId,
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});

const ThreadRuntimeModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.runtime-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  createdAt: IsoDateTime,
});

const ThreadInteractionModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.interaction-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode,
  createdAt: IsoDateTime,
});

export const ThreadTurnStartCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(ChatAttachment),
  }),
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE)),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

const ClientThreadTurnStartCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(UploadChatAttachment),
  }),
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

const ThreadTurnInterruptCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.interrupt"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadApprovalRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.approval.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

const ThreadUserInputRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.user-input.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  createdAt: IsoDateTime,
});

const ThreadCheckpointRevertCommand = Schema.Struct({
  type: Schema.Literal("thread.checkpoint.revert"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadSessionStopCommand = Schema.Struct({
  type: Schema.Literal("thread.session.stop"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

const OrchestratorRunCreateCommand = Schema.Struct({
  type: Schema.Literal("orchestrator.run.create"),
  commandId: CommandId,
  runId: OrchestratorRunId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  goal: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

const OrchestratorRunMessageCommand = Schema.Struct({
  type: Schema.Literal("orchestrator.run.message"),
  commandId: CommandId,
  runId: OrchestratorRunId,
  message: OrchestratorChatMessage,
  createdAt: IsoDateTime,
});

const OrchestratorRunSynthesisSetCommand = Schema.Struct({
  type: Schema.Literal("orchestrator.run.synthesis.set"),
  commandId: CommandId,
  runId: OrchestratorRunId,
  latestSynthesis: Schema.String,
  createdAt: IsoDateTime,
});

const OrchestratorLaneCreateCommand = Schema.Struct({
  type: Schema.Literal("orchestrator.lane.create"),
  commandId: CommandId,
  laneId: OrchestratorLaneId,
  runId: OrchestratorRunId,
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  objective: TrimmedNonEmptyString,
  requiredArtifactKinds: Schema.Array(OrchestratorArtifactKind),
  createdAt: IsoDateTime,
});

const OrchestratorLaneDispatchCommand = Schema.Struct({
  type: Schema.Literal("orchestrator.lane.dispatch"),
  commandId: CommandId,
  laneId: OrchestratorLaneId,
  brief: OrchestratorWorkerBrief,
  createdAt: IsoDateTime,
});

const OrchestratorLaneStatusSetCommand = Schema.Struct({
  type: Schema.Literal("orchestrator.lane.status.set"),
  commandId: CommandId,
  laneId: OrchestratorLaneId,
  status: OrchestratorLaneStatus,
  blockedReason: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  createdAt: IsoDateTime,
});

const OrchestratorLaneDependencyUpsertCommand = Schema.Struct({
  type: Schema.Literal("orchestrator.lane.dependency.upsert"),
  commandId: CommandId,
  runId: OrchestratorRunId,
  dependency: OrchestratorLaneDependency,
  createdAt: IsoDateTime,
});

const OrchestratorArtifactUpsertCommand = Schema.Struct({
  type: Schema.Literal("orchestrator.artifact.upsert"),
  commandId: CommandId,
  artifact: OrchestratorArtifact,
  createdAt: IsoDateTime,
});

const OrchestratorVerificationReportUpsertCommand = Schema.Struct({
  type: Schema.Literal("orchestrator.verification.upsert"),
  commandId: CommandId,
  report: OrchestratorVerificationReport,
  createdAt: IsoDateTime,
});

const OrchestratorLaneVerifyCommand = Schema.Struct({
  type: Schema.Literal("orchestrator.lane.verify"),
  commandId: CommandId,
  laneId: OrchestratorLaneId,
  createdAt: IsoDateTime,
});

const OrchestratorApprovalRequestCommand = Schema.Struct({
  type: Schema.Literal("orchestrator.approval.request"),
  commandId: CommandId,
  approval: OrchestratorApprovalItem,
  createdAt: IsoDateTime,
});

const OrchestratorApprovalResolveCommand = Schema.Struct({
  type: Schema.Literal("orchestrator.approval.resolve"),
  commandId: CommandId,
  approvalId: OrchestratorApprovalId,
  status: Schema.Literals(["approved", "rejected", "cancelled"]),
  createdAt: IsoDateTime,
});

const OrchestratorProcessRuleProposeCommand = Schema.Struct({
  type: Schema.Literal("orchestrator.process-rule.propose"),
  commandId: CommandId,
  version: ProcessRuleVersion,
  createdAt: IsoDateTime,
});

const OrchestratorProcessRuleStatusSetCommand = Schema.Struct({
  type: Schema.Literal("orchestrator.process-rule.status.set"),
  commandId: CommandId,
  versionId: ProcessRuleVersionId,
  status: ProcessRuleVersionStatus,
  createdAt: IsoDateTime,
});

const DispatchableClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  ThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadMetaUpdateCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ThreadTurnStartCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadCheckpointRevertCommand,
  ThreadSessionStopCommand,
  OrchestratorRunCreateCommand,
  OrchestratorRunMessageCommand,
  OrchestratorRunSynthesisSetCommand,
  OrchestratorLaneCreateCommand,
  OrchestratorLaneDispatchCommand,
  OrchestratorLaneStatusSetCommand,
  OrchestratorLaneDependencyUpsertCommand,
  OrchestratorArtifactUpsertCommand,
  OrchestratorVerificationReportUpsertCommand,
  OrchestratorLaneVerifyCommand,
  OrchestratorApprovalRequestCommand,
  OrchestratorApprovalResolveCommand,
  OrchestratorProcessRuleProposeCommand,
  OrchestratorProcessRuleStatusSetCommand,
]);
export type DispatchableClientOrchestrationCommand =
  typeof DispatchableClientOrchestrationCommand.Type;

export const ClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  ThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadMetaUpdateCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ClientThreadTurnStartCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadCheckpointRevertCommand,
  ThreadSessionStopCommand,
  OrchestratorRunCreateCommand,
  OrchestratorRunMessageCommand,
  OrchestratorRunSynthesisSetCommand,
  OrchestratorLaneCreateCommand,
  OrchestratorLaneDispatchCommand,
  OrchestratorLaneStatusSetCommand,
  OrchestratorLaneDependencyUpsertCommand,
  OrchestratorArtifactUpsertCommand,
  OrchestratorVerificationReportUpsertCommand,
  OrchestratorLaneVerifyCommand,
  OrchestratorApprovalRequestCommand,
  OrchestratorApprovalResolveCommand,
  OrchestratorProcessRuleProposeCommand,
  OrchestratorProcessRuleStatusSetCommand,
]);
export type ClientOrchestrationCommand = typeof ClientOrchestrationCommand.Type;

const ThreadSessionSetCommand = Schema.Struct({
  type: Schema.Literal("thread.session.set"),
  commandId: CommandId,
  threadId: ThreadId,
  session: OrchestrationSession,
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantDeltaCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.delta"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  delta: Schema.String,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadProposedPlanUpsertCommand = Schema.Struct({
  type: Schema.Literal("thread.proposed-plan.upsert"),
  commandId: CommandId,
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
  createdAt: IsoDateTime,
});

const ThreadTurnDiffCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.diff.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  completedAt: IsoDateTime,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.optional(MessageId),
  checkpointTurnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadActivityAppendCommand = Schema.Struct({
  type: Schema.Literal("thread.activity.append"),
  commandId: CommandId,
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
  createdAt: IsoDateTime,
});

const ThreadRevertCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.revert.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const InternalOrchestrationCommand = Schema.Union([
  ThreadSessionSetCommand,
  ThreadMessageAssistantDeltaCommand,
  ThreadMessageAssistantCompleteCommand,
  ThreadProposedPlanUpsertCommand,
  ThreadTurnDiffCompleteCommand,
  ThreadActivityAppendCommand,
  ThreadRevertCompleteCommand,
]);
export type InternalOrchestrationCommand = typeof InternalOrchestrationCommand.Type;

export const OrchestrationCommand = Schema.Union([
  DispatchableClientOrchestrationCommand,
  InternalOrchestrationCommand,
]);
export type OrchestrationCommand = typeof OrchestrationCommand.Type;

export const OrchestrationEventType = Schema.Literals([
  "project.created",
  "project.meta-updated",
  "project.deleted",
  "thread.created",
  "thread.deleted",
  "thread.archived",
  "thread.unarchived",
  "thread.meta-updated",
  "thread.runtime-mode-set",
  "thread.interaction-mode-set",
  "thread.message-sent",
  "thread.turn-start-requested",
  "thread.turn-interrupt-requested",
  "thread.approval-response-requested",
  "thread.user-input-response-requested",
  "thread.checkpoint-revert-requested",
  "thread.reverted",
  "thread.session-stop-requested",
  "thread.session-set",
  "thread.proposed-plan-upserted",
  "thread.turn-diff-completed",
  "thread.activity-appended",
  "orchestrator.run.created",
  "orchestrator.run.message-added",
  "orchestrator.run.synthesis-set",
  "orchestrator.lane.created",
  "orchestrator.lane.dispatched",
  "orchestrator.lane.status-set",
  "orchestrator.lane.dependency-upserted",
  "orchestrator.artifact.upserted",
  "orchestrator.verification.requested",
  "orchestrator.verification.upserted",
  "orchestrator.approval.requested",
  "orchestrator.approval.resolved",
  "orchestrator.process-rule.proposed",
  "orchestrator.process-rule.status-set",
]);
export type OrchestrationEventType = typeof OrchestrationEventType.Type;

export const OrchestrationAggregateKind = Schema.Literals([
  "project",
  "thread",
  "orchestrator-run",
  "orchestrator-lane",
]);
export type OrchestrationAggregateKind = typeof OrchestrationAggregateKind.Type;
export const OrchestrationActorKind = Schema.Literals(["client", "server", "provider"]);

export const ProjectCreatedPayload = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  defaultModelSelection: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ProjectMetaUpdatedPayload = Schema.Struct({
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
  updatedAt: IsoDateTime,
});

export const ProjectDeletedPayload = Schema.Struct({
  projectId: ProjectId,
  deletedAt: IsoDateTime,
});

export const ThreadCreatedPayload = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE)),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadDeletedPayload = Schema.Struct({
  threadId: ThreadId,
  deletedAt: IsoDateTime,
});

export const ThreadArchivedPayload = Schema.Struct({
  threadId: ThreadId,
  archivedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadUnarchivedPayload = Schema.Struct({
  threadId: ThreadId,
  updatedAt: IsoDateTime,
});

export const ThreadMetaUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  updatedAt: IsoDateTime,
});

export const ThreadRuntimeModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  updatedAt: IsoDateTime,
});

export const ThreadInteractionModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  updatedAt: IsoDateTime,
});

export const ThreadMessageSentPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadTurnStartRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE)),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

export const ThreadTurnInterruptRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

export const ThreadApprovalResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

const ThreadUserInputResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  createdAt: IsoDateTime,
});

export const ThreadCheckpointRevertRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

export const ThreadRevertedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
});

export const ThreadSessionStopRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

export const ThreadSessionSetPayload = Schema.Struct({
  threadId: ThreadId,
  session: OrchestrationSession,
});

export const ThreadProposedPlanUpsertedPayload = Schema.Struct({
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
});

export const ThreadTurnDiffCompletedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});

export const ThreadActivityAppendedPayload = Schema.Struct({
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
});

export const OrchestratorRunCreatedPayload = Schema.Struct({
  run: OrchestratorRun,
});

export const OrchestratorRunMessageAddedPayload = Schema.Struct({
  runId: OrchestratorRunId,
  message: OrchestratorChatMessage,
  updatedAt: IsoDateTime,
});

export const OrchestratorRunSynthesisSetPayload = Schema.Struct({
  runId: OrchestratorRunId,
  latestSynthesis: Schema.String,
  updatedAt: IsoDateTime,
});

export const OrchestratorLaneCreatedPayload = Schema.Struct({
  lane: OrchestratorLane,
});

export const OrchestratorLaneDispatchedPayload = Schema.Struct({
  laneId: OrchestratorLaneId,
  brief: OrchestratorWorkerBrief,
  status: OrchestratorLaneStatus,
  updatedAt: IsoDateTime,
});

export const OrchestratorLaneStatusSetPayload = Schema.Struct({
  laneId: OrchestratorLaneId,
  status: OrchestratorLaneStatus,
  blockedReason: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});

export const OrchestratorLaneDependencyUpsertedPayload = Schema.Struct({
  runId: OrchestratorRunId,
  dependency: OrchestratorLaneDependency,
  updatedAt: IsoDateTime,
});

export const OrchestratorArtifactUpsertedPayload = Schema.Struct({
  artifact: OrchestratorArtifact,
});

export const OrchestratorVerificationUpsertedPayload = Schema.Struct({
  report: OrchestratorVerificationReport,
});

export const OrchestratorVerificationRequestedPayload = Schema.Struct({
  laneId: OrchestratorLaneId,
  createdAt: IsoDateTime,
});

export const OrchestratorApprovalRequestedPayload = Schema.Struct({
  approval: OrchestratorApprovalItem,
});

export const OrchestratorApprovalResolvedPayload = Schema.Struct({
  approvalId: OrchestratorApprovalId,
  status: Schema.Literals(["approved", "rejected", "cancelled"]),
  resolvedAt: IsoDateTime,
});

export const OrchestratorProcessRuleProposedPayload = Schema.Struct({
  version: ProcessRuleVersion,
});

export const OrchestratorProcessRuleStatusSetPayload = Schema.Struct({
  versionId: ProcessRuleVersionId,
  status: ProcessRuleVersionStatus,
  updatedAt: IsoDateTime,
});

export const OrchestrationEventMetadata = Schema.Struct({
  providerTurnId: Schema.optional(TrimmedNonEmptyString),
  providerItemId: Schema.optional(ProviderItemId),
  adapterKey: Schema.optional(TrimmedNonEmptyString),
  requestId: Schema.optional(ApprovalRequestId),
  ingestedAt: Schema.optional(IsoDateTime),
});
export type OrchestrationEventMetadata = typeof OrchestrationEventMetadata.Type;

const EventBaseFields = {
  sequence: NonNegativeInt,
  eventId: EventId,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([ProjectId, ThreadId, OrchestratorRunId, OrchestratorLaneId]),
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  metadata: OrchestrationEventMetadata,
} as const;

const PersistedEventBaseFields = {
  sequence: NonNegativeInt,
  eventId: EventId,
  aggregateKind: OrchestrationAggregateKind,
  streamId: Schema.Union([ProjectId, ThreadId, OrchestratorRunId, OrchestratorLaneId]),
  streamVersion: NonNegativeInt,
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  actorKind: OrchestrationActorKind,
  metadata: OrchestrationEventMetadata,
} as const;

export const OrchestrationEvent = Schema.Union([
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.created"),
    payload: ProjectCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.meta-updated"),
    payload: ProjectMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.deleted"),
    payload: ProjectDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.created"),
    payload: ThreadCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.deleted"),
    payload: ThreadDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.archived"),
    payload: ThreadArchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unarchived"),
    payload: ThreadUnarchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.meta-updated"),
    payload: ThreadMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.runtime-mode-set"),
    payload: ThreadRuntimeModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.interaction-mode-set"),
    payload: ThreadInteractionModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.message-sent"),
    payload: ThreadMessageSentPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-start-requested"),
    payload: ThreadTurnStartRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-interrupt-requested"),
    payload: ThreadTurnInterruptRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.approval-response-requested"),
    payload: ThreadApprovalResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.user-input-response-requested"),
    payload: ThreadUserInputResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.checkpoint-revert-requested"),
    payload: ThreadCheckpointRevertRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.reverted"),
    payload: ThreadRevertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-stop-requested"),
    payload: ThreadSessionStopRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-set"),
    payload: ThreadSessionSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.proposed-plan-upserted"),
    payload: ThreadProposedPlanUpsertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-diff-completed"),
    payload: ThreadTurnDiffCompletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.activity-appended"),
    payload: ThreadActivityAppendedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("orchestrator.run.created"),
    payload: OrchestratorRunCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("orchestrator.run.message-added"),
    payload: OrchestratorRunMessageAddedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("orchestrator.run.synthesis-set"),
    payload: OrchestratorRunSynthesisSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("orchestrator.lane.created"),
    payload: OrchestratorLaneCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("orchestrator.lane.dispatched"),
    payload: OrchestratorLaneDispatchedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("orchestrator.lane.status-set"),
    payload: OrchestratorLaneStatusSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("orchestrator.lane.dependency-upserted"),
    payload: OrchestratorLaneDependencyUpsertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("orchestrator.artifact.upserted"),
    payload: OrchestratorArtifactUpsertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("orchestrator.verification.requested"),
    payload: OrchestratorVerificationRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("orchestrator.verification.upserted"),
    payload: OrchestratorVerificationUpsertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("orchestrator.approval.requested"),
    payload: OrchestratorApprovalRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("orchestrator.approval.resolved"),
    payload: OrchestratorApprovalResolvedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("orchestrator.process-rule.proposed"),
    payload: OrchestratorProcessRuleProposedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("orchestrator.process-rule.status-set"),
    payload: OrchestratorProcessRuleStatusSetPayload,
  }),
]);
export type OrchestrationEvent = typeof OrchestrationEvent.Type;

export const OrchestrationPersistedEvent = Schema.Union([
  Schema.Struct({
    ...PersistedEventBaseFields,
    eventType: Schema.Literal("project.created"),
    payload: ProjectCreatedPayload,
  }),
  Schema.Struct({
    ...PersistedEventBaseFields,
    eventType: Schema.Literal("project.meta-updated"),
    payload: ProjectMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...PersistedEventBaseFields,
    eventType: Schema.Literal("project.deleted"),
    payload: ProjectDeletedPayload,
  }),
  Schema.Struct({
    ...PersistedEventBaseFields,
    eventType: Schema.Literal("thread.created"),
    payload: ThreadCreatedPayload,
  }),
  Schema.Struct({
    ...PersistedEventBaseFields,
    eventType: Schema.Literal("thread.deleted"),
    payload: ThreadDeletedPayload,
  }),
  Schema.Struct({
    ...PersistedEventBaseFields,
    eventType: Schema.Literal("thread.meta-updated"),
    payload: ThreadMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...PersistedEventBaseFields,
    eventType: Schema.Literal("thread.runtime-mode-set"),
    payload: ThreadRuntimeModeSetPayload,
  }),
  Schema.Struct({
    ...PersistedEventBaseFields,
    eventType: Schema.Literal("thread.interaction-mode-set"),
    payload: ThreadInteractionModeSetPayload,
  }),
  Schema.Struct({
    ...PersistedEventBaseFields,
    eventType: Schema.Literal("thread.message-sent"),
    payload: ThreadMessageSentPayload,
  }),
  Schema.Struct({
    ...PersistedEventBaseFields,
    eventType: Schema.Literal("thread.turn-start-requested"),
    payload: ThreadTurnStartRequestedPayload,
  }),
  Schema.Struct({
    ...PersistedEventBaseFields,
    eventType: Schema.Literal("thread.turn-interrupt-requested"),
    payload: ThreadTurnInterruptRequestedPayload,
  }),
  Schema.Struct({
    ...PersistedEventBaseFields,
    eventType: Schema.Literal("thread.approval-response-requested"),
    payload: ThreadApprovalResponseRequestedPayload,
  }),
  Schema.Struct({
    ...PersistedEventBaseFields,
    eventType: Schema.Literal("thread.user-input-response-requested"),
    payload: ThreadUserInputResponseRequestedPayload,
  }),
  Schema.Struct({
    ...PersistedEventBaseFields,
    eventType: Schema.Literal("thread.checkpoint-revert-requested"),
    payload: ThreadCheckpointRevertRequestedPayload,
  }),
  Schema.Struct({
    ...PersistedEventBaseFields,
    eventType: Schema.Literal("thread.reverted"),
    payload: ThreadRevertedPayload,
  }),
  Schema.Struct({
    ...PersistedEventBaseFields,
    eventType: Schema.Literal("thread.session-stop-requested"),
    payload: ThreadSessionStopRequestedPayload,
  }),
  Schema.Struct({
    ...PersistedEventBaseFields,
    eventType: Schema.Literal("thread.session-set"),
    payload: ThreadSessionSetPayload,
  }),
  Schema.Struct({
    ...PersistedEventBaseFields,
    eventType: Schema.Literal("thread.proposed-plan-upserted"),
    payload: ThreadProposedPlanUpsertedPayload,
  }),
  Schema.Struct({
    ...PersistedEventBaseFields,
    eventType: Schema.Literal("thread.turn-diff-completed"),
    payload: ThreadTurnDiffCompletedPayload,
  }),
  Schema.Struct({
    ...PersistedEventBaseFields,
    eventType: Schema.Literal("thread.activity-appended"),
    payload: ThreadActivityAppendedPayload,
  }),
  Schema.Struct({
    ...PersistedEventBaseFields,
    eventType: Schema.Literal("orchestrator.run.created"),
    payload: OrchestratorRunCreatedPayload,
  }),
  Schema.Struct({
    ...PersistedEventBaseFields,
    eventType: Schema.Literal("orchestrator.run.message-added"),
    payload: OrchestratorRunMessageAddedPayload,
  }),
  Schema.Struct({
    ...PersistedEventBaseFields,
    eventType: Schema.Literal("orchestrator.run.synthesis-set"),
    payload: OrchestratorRunSynthesisSetPayload,
  }),
  Schema.Struct({
    ...PersistedEventBaseFields,
    eventType: Schema.Literal("orchestrator.lane.created"),
    payload: OrchestratorLaneCreatedPayload,
  }),
  Schema.Struct({
    ...PersistedEventBaseFields,
    eventType: Schema.Literal("orchestrator.lane.dispatched"),
    payload: OrchestratorLaneDispatchedPayload,
  }),
  Schema.Struct({
    ...PersistedEventBaseFields,
    eventType: Schema.Literal("orchestrator.lane.status-set"),
    payload: OrchestratorLaneStatusSetPayload,
  }),
  Schema.Struct({
    ...PersistedEventBaseFields,
    eventType: Schema.Literal("orchestrator.lane.dependency-upserted"),
    payload: OrchestratorLaneDependencyUpsertedPayload,
  }),
  Schema.Struct({
    ...PersistedEventBaseFields,
    eventType: Schema.Literal("orchestrator.artifact.upserted"),
    payload: OrchestratorArtifactUpsertedPayload,
  }),
  Schema.Struct({
    ...PersistedEventBaseFields,
    eventType: Schema.Literal("orchestrator.verification.requested"),
    payload: OrchestratorVerificationRequestedPayload,
  }),
  Schema.Struct({
    ...PersistedEventBaseFields,
    eventType: Schema.Literal("orchestrator.verification.upserted"),
    payload: OrchestratorVerificationUpsertedPayload,
  }),
  Schema.Struct({
    ...PersistedEventBaseFields,
    eventType: Schema.Literal("orchestrator.approval.requested"),
    payload: OrchestratorApprovalRequestedPayload,
  }),
  Schema.Struct({
    ...PersistedEventBaseFields,
    eventType: Schema.Literal("orchestrator.approval.resolved"),
    payload: OrchestratorApprovalResolvedPayload,
  }),
  Schema.Struct({
    ...PersistedEventBaseFields,
    eventType: Schema.Literal("orchestrator.process-rule.proposed"),
    payload: OrchestratorProcessRuleProposedPayload,
  }),
  Schema.Struct({
    ...PersistedEventBaseFields,
    eventType: Schema.Literal("orchestrator.process-rule.status-set"),
    payload: OrchestratorProcessRuleStatusSetPayload,
  }),
]);
export type OrchestrationPersistedEvent = typeof OrchestrationPersistedEvent.Type;

export const OrchestrationCommandReceiptStatus = Schema.Literals(["accepted", "rejected"]);
export type OrchestrationCommandReceiptStatus = typeof OrchestrationCommandReceiptStatus.Type;

export const TurnCountRange = Schema.Struct({
  fromTurnCount: NonNegativeInt,
  toTurnCount: NonNegativeInt,
}).check(
  Schema.makeFilter(
    (input) =>
      input.fromTurnCount <= input.toTurnCount ||
      new SchemaIssue.InvalidValue(Option.some(input.fromTurnCount), {
        message: "fromTurnCount must be less than or equal to toTurnCount",
      }),
    { identifier: "OrchestrationTurnDiffRange" },
  ),
);

export const ThreadTurnDiff = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    diff: Schema.String,
  }),
  { unsafePreserveChecks: true },
);

export const ProviderSessionRuntimeStatus = Schema.Literals([
  "starting",
  "running",
  "stopped",
  "error",
]);
export type ProviderSessionRuntimeStatus = typeof ProviderSessionRuntimeStatus.Type;

const ProjectionThreadTurnStatus = Schema.Literals([
  "running",
  "completed",
  "interrupted",
  "error",
]);
export type ProjectionThreadTurnStatus = typeof ProjectionThreadTurnStatus.Type;

const ProjectionCheckpointRow = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type ProjectionCheckpointRow = typeof ProjectionCheckpointRow.Type;

export const ProjectionPendingApprovalStatus = Schema.Literals(["pending", "resolved"]);
export type ProjectionPendingApprovalStatus = typeof ProjectionPendingApprovalStatus.Type;

export const ProjectionPendingApprovalDecision = Schema.NullOr(ProviderApprovalDecision);
export type ProjectionPendingApprovalDecision = typeof ProjectionPendingApprovalDecision.Type;

export const DispatchResult = Schema.Struct({
  sequence: NonNegativeInt,
});
export type DispatchResult = typeof DispatchResult.Type;

export const OrchestrationGetSnapshotInput = Schema.Struct({});
export type OrchestrationGetSnapshotInput = typeof OrchestrationGetSnapshotInput.Type;
const OrchestrationGetSnapshotResult = OrchestrationReadModel;
export type OrchestrationGetSnapshotResult = typeof OrchestrationGetSnapshotResult.Type;

export const OrchestrationGetTurnDiffInput = TurnCountRange.mapFields(
  Struct.assign({ threadId: ThreadId }),
  { unsafePreserveChecks: true },
);
export type OrchestrationGetTurnDiffInput = typeof OrchestrationGetTurnDiffInput.Type;

export const OrchestrationGetTurnDiffResult = ThreadTurnDiff;
export type OrchestrationGetTurnDiffResult = typeof OrchestrationGetTurnDiffResult.Type;

export const OrchestrationGetFullThreadDiffInput = Schema.Struct({
  threadId: ThreadId,
  toTurnCount: NonNegativeInt,
});
export type OrchestrationGetFullThreadDiffInput = typeof OrchestrationGetFullThreadDiffInput.Type;

export const OrchestrationGetFullThreadDiffResult = ThreadTurnDiff;
export type OrchestrationGetFullThreadDiffResult = typeof OrchestrationGetFullThreadDiffResult.Type;

export const OrchestrationReplayEventsInput = Schema.Struct({
  fromSequenceExclusive: NonNegativeInt,
});
export type OrchestrationReplayEventsInput = typeof OrchestrationReplayEventsInput.Type;

const OrchestrationReplayEventsResult = Schema.Array(OrchestrationEvent);
export type OrchestrationReplayEventsResult = typeof OrchestrationReplayEventsResult.Type;

export const OrchestrationRpcSchemas = {
  getSnapshot: {
    input: OrchestrationGetSnapshotInput,
    output: OrchestrationGetSnapshotResult,
  },
  dispatchCommand: {
    input: ClientOrchestrationCommand,
    output: DispatchResult,
  },
  getTurnDiff: {
    input: OrchestrationGetTurnDiffInput,
    output: OrchestrationGetTurnDiffResult,
  },
  getFullThreadDiff: {
    input: OrchestrationGetFullThreadDiffInput,
    output: OrchestrationGetFullThreadDiffResult,
  },
  replayEvents: {
    input: OrchestrationReplayEventsInput,
    output: OrchestrationReplayEventsResult,
  },
} as const;
