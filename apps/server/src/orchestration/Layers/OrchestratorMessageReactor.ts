import {
  type ChatAttachment,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  OrchestratorLaneId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationMessage,
  type OrchestrationReadModel,
  type OrchestratorArtifactKind,
  type OrchestratorLane,
  type OrchestratorRun,
  type OrchestratorWorkerBrief,
} from "@t3tools/contracts";
import { Cache, Duration, Effect, Layer, Option, Stream } from "effect";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  OrchestratorMessageReactor,
  type OrchestratorMessageReactorShape,
} from "../Services/OrchestratorMessageReactor.ts";

type OrchestratorUserMessageEvent = Extract<
  OrchestrationEvent,
  { type: "orchestrator.run.message-added" }
>;

type ThreadMessageSentEvent = Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

const DEFAULT_REQUIRED_ARTIFACTS: ReadonlyArray<OrchestratorArtifactKind> = [
  "change-manifest",
  "acceptance-checklist",
  "verification-output",
  "summary",
];
const ORCHESTRATOR_THREAD_TITLE = "Orchestrator";
const AUTOREVIEW_TAG = "T3CODE_ORCHESTRATOR_AUTOREVIEW";
const HANDLED_AUTOREVIEW_KEY_MAX = 10_000;
const HANDLED_AUTOREVIEW_KEY_TTL = Duration.minutes(30);

const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

const serverMessageId = (tag: string): MessageId =>
  MessageId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

function latestOrchestratorThread(readModel: OrchestrationReadModel) {
  return [...readModel.threads]
    .filter((entry) => entry.title === ORCHESTRATOR_THREAD_TITLE && entry.deletedAt === null)
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

function summarizeObjective(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 77).trimEnd()}...`;
}

function isSyntheticAutoreviewPrompt(text: string): boolean {
  return text.includes(`[${AUTOREVIEW_TAG}]`);
}

function readLatestOrchestratorDispatch(thread: {
  readonly activities: ReadonlyArray<{ kind: string; createdAt: string; payload: unknown }>;
}): { prompt: string; detail: string | null } | null {
  const activity = thread.activities
    .toReversed()
    .find((entry) => entry.kind === "orchestrator.dispatch");
  if (!activity || !activity.payload || typeof activity.payload !== "object") {
    return null;
  }

  const payload = activity.payload as Record<string, unknown>;
  if (typeof payload.prompt !== "string" || payload.prompt.trim().length === 0) {
    return null;
  }

  return {
    prompt: payload.prompt,
    detail: typeof payload.detail === "string" && payload.detail.trim().length > 0 ? payload.detail : null,
  };
}

function buildWorkerAutoreviewPrompt(input: {
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly assignment: { prompt: string; detail: string | null };
  readonly latestWorkerMessage: OrchestrationMessage;
}): string {
  return [
    `[${AUTOREVIEW_TAG}]`,
    "Review this worker update before anything is raised to the user.",
    "Act as the first-pass reviewer.",
    "If the worker is not actually done, use send_to_thread on the same thread with a short, concrete follow-up describing exactly what is still missing.",
    "If the worker is done, reply directly in this chat with a concise, human-checkable summary of what was accomplished and what evidence was returned.",
    "If you are uncertain, use read_thread_status before deciding.",
    "Do not ask the user what to do next unless the worker is genuinely blocked.",
    "",
    `Worker thread: ${input.threadTitle} (${input.threadId})`,
    `Latest delegated task: ${input.assignment.prompt}`,
    ...(input.assignment.detail ? [`Delegation note: ${input.assignment.detail}`] : []),
    "",
    "Worker's latest response:",
    input.latestWorkerMessage.text,
    `[/${AUTOREVIEW_TAG}]`,
  ].join("\n");
}

function buildWorkerBrief(input: {
  run: OrchestratorRun;
  lane: OrchestratorLane;
  latestUserMessage: string;
}): OrchestratorWorkerBrief {
  const definitionOfDone = [
    `Complete the lane objective: ${input.lane.objective}`,
    "Return concrete, human-checkable evidence instead of a generic completion claim.",
    "If you changed code, include the exact verification commands and their outcome.",
    "If the task is observational, include the exact observed output or file evidence.",
  ];

  const requiredEvidence = [
    "What changed or what was observed",
    "Exact commands run, if any",
    "Exact output, logs, or file references that prove the result",
    "Any remaining caveats or blockers",
  ];

  return {
    objective: input.lane.objective,
    successCriteria: [
      `Advance run goal: ${input.run.goal}`,
      `Complete lane objective: ${input.lane.objective}`,
      ...definitionOfDone,
    ],
    hardRequirements: [
      "Follow repository constraints in AGENTS.md",
      "Do not claim completion without verification evidence",
      "Use shared logic when it improves maintainability",
      "Do not say you are done until the definition of done is satisfied",
    ],
    orderedPhases: ["understand", "implement", "verify", "report"],
    requiredArtifacts: [...DEFAULT_REQUIRED_ARTIFACTS],
    constraints: [
      "Preserve predictable behavior under failure and reconnects",
      "Do not make destructive changes without explicit approval",
      "Prefer concise, evidence-first reporting",
    ],
    failureHandling:
      "If blocked or uncertain, stop, explain the blocker, and propose the safest next action.",
    strategicContext: input.run.goal,
    implementationContext: `Worker thread ${input.lane.threadId} is assigned to lane '${input.lane.title}'.`,
    dispatchPrompt: [
      `Primary objective: ${input.lane.objective}`,
      "",
      `Latest orchestrator instruction: ${input.latestUserMessage}`,
      "",
      "Definition of done:",
      ...definitionOfDone.map((item) => `- ${item}`),
      "",
      "Required evidence to return:",
      ...requiredEvidence.map((item) => `- ${item}`),
      "",
      "Verification expectations:",
      "- Run only the checks needed for the task.",
      "- If code changed in this repo, include `bun lint` and `bun typecheck` unless clearly not applicable.",
      "",
      "Reporting format:",
      "- Outcome",
      "- Evidence",
      "- Verification",
      "- Caveats",
    ].join("\n"),
  };
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const handledAutoreviewKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_AUTOREVIEW_KEY_MAX,
    timeToLive: HANDLED_AUTOREVIEW_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });

  const hasHandledAutoreviewRecently = (key: string) =>
    Cache.getOption(handledAutoreviewKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledAutoreviewKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  const appendOrchestratorActivity = (input: {
    readonly threadId: ThreadId;
    readonly tone: "info" | "tool" | "error";
    readonly kind: string;
    readonly summary: string;
    readonly payload: unknown;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId(`orchestrator-activity-${input.kind}`),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(`activity:${input.kind}:${crypto.randomUUID()}`),
        tone: input.tone,
        kind: input.kind,
        summary: input.summary,
        payload: input.payload,
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const ensureWorkerForRun = Effect.fnUntraced(function* (input: {
    run: OrchestratorRun;
    latestUserMessage: string;
    createdAt: string;
  }) {
    if (input.run.lanes.length > 0) {
      return input.run.lanes[0]!;
    }

    const readModel = yield* orchestrationEngine.getReadModel();
    const project = readModel.projects.find((entry) => entry.id === input.run.projectId);
    if (!project) {
      return null;
    }

    const threadId = ThreadId.makeUnsafe(crypto.randomUUID());
    const laneId = OrchestratorLaneId.makeUnsafe(crypto.randomUUID());
    const title = summarizeObjective(input.latestUserMessage);

    yield* orchestrationEngine.dispatch({
      type: "thread.create",
      commandId: serverCommandId("orchestrator-thread-create"),
      threadId,
      projectId: input.run.projectId,
      title,
      model: project.defaultModel ?? "gpt-5-codex",
      runtimeMode: "full-access",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      createdAt: input.createdAt,
    });

    yield* orchestrationEngine.dispatch({
      type: "orchestrator.lane.create",
      commandId: serverCommandId("orchestrator-lane-create"),
      laneId,
      runId: input.run.id,
      threadId,
      title,
      objective: input.latestUserMessage,
      requiredArtifactKinds: [...DEFAULT_REQUIRED_ARTIFACTS],
      createdAt: input.createdAt,
    });

    return {
      id: laneId,
      runId: input.run.id,
      threadId,
      title,
      objective: input.latestUserMessage,
      status: "ready",
      blockedReason: null,
      brief: null,
      requiredArtifactKinds: [...DEFAULT_REQUIRED_ARTIFACTS],
      verification: null,
      artifacts: [],
      updatedAt: input.createdAt,
      createdAt: input.createdAt,
    } satisfies OrchestratorLane;
  });

  const handleUserMessage = Effect.fnUntraced(function* (event: OrchestratorUserMessageEvent) {
    if (event.payload.message.role !== "user") {
      return;
    }

    const readModel = yield* orchestrationEngine.getReadModel();
    const run = readModel.orchestratorRuns.find((entry) => entry.id === event.payload.runId);
    if (!run) {
      return;
    }

    const workerLane = yield* ensureWorkerForRun({
      run,
      latestUserMessage: event.payload.message.text,
      createdAt: event.payload.updatedAt,
    });
    if (!workerLane) {
      return;
    }

    const brief = buildWorkerBrief({
      run,
      lane: workerLane,
      latestUserMessage: event.payload.message.text,
    });

    yield* orchestrationEngine.dispatch({
      type: "orchestrator.lane.dispatch",
      commandId: serverCommandId("orchestrator-lane-dispatch"),
      laneId: workerLane.id,
      brief,
      createdAt: event.payload.updatedAt,
    });

    yield* orchestrationEngine.dispatch({
      type: "orchestrator.lane.status.set",
      commandId: serverCommandId("orchestrator-lane-running"),
      laneId: workerLane.id,
      status: "running",
      blockedReason: null,
      createdAt: event.payload.updatedAt,
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: serverCommandId("orchestrator-thread-turn-start"),
      threadId: workerLane.threadId,
      message: {
        messageId: serverMessageId("orchestrator-worker-prompt"),
        role: "user",
        text: brief.dispatchPrompt,
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: event.payload.updatedAt,
    });

    const orchestratorThread = latestOrchestratorThread(readModel);
    if (orchestratorThread) {
      yield* appendOrchestratorActivity({
        threadId: orchestratorThread.id,
        tone: "info",
        kind: "delegation.started",
        summary: `Delegated to ${workerLane.title}`,
        payload: {
          workerThreadId: workerLane.threadId,
          workerTitle: workerLane.title,
          objective: workerLane.objective,
        },
        createdAt: event.payload.updatedAt,
      });
    }
  });

  const handleWorkerAssistantMessage = Effect.fnUntraced(function* (event: ThreadMessageSentEvent) {
    if (event.payload.role !== "assistant" || event.payload.streaming) {
      return;
    }

    const autoreviewKey = `${event.payload.threadId}:${event.payload.messageId}`;
    if (yield* hasHandledAutoreviewRecently(autoreviewKey)) {
      return;
    }

    const readModel = yield* orchestrationEngine.getReadModel();
    const workerThread = readModel.threads.find((entry) => entry.id === event.payload.threadId);
    if (!workerThread || workerThread.title === ORCHESTRATOR_THREAD_TITLE) {
      return;
    }

    const latestAssignment = readLatestOrchestratorDispatch(workerThread);
    if (!latestAssignment) {
      return;
    }

    const latestWorkerMessage = workerThread.messages.find((entry) => entry.id === event.payload.messageId) ?? {
      id: event.payload.messageId,
      role: event.payload.role,
      text: event.payload.text,
      ...(event.payload.attachments !== undefined ? { attachments: event.payload.attachments } : {}),
      turnId: event.payload.turnId,
      streaming: event.payload.streaming,
      createdAt: event.payload.createdAt,
      updatedAt: event.payload.updatedAt,
    };

    if (latestWorkerMessage.text.trim().length === 0) {
      return;
    }

    const orchestratorThread = latestOrchestratorThread(readModel);
    if (!orchestratorThread) {
      return;
    }

    const existingAutoreviewMessage = orchestratorThread.messages.find(
      (entry) => entry.role === "user" && isSyntheticAutoreviewPrompt(entry.text) && entry.turnId === event.payload.turnId,
    );
    if (existingAutoreviewMessage) {
      return;
    }

    yield* appendOrchestratorActivity({
      threadId: orchestratorThread.id,
      tone: "info",
      kind: "delegation.reviewing",
      summary: `Reviewing ${workerThread.title}`,
      payload: {
        workerThreadId: workerThread.id,
        workerTitle: workerThread.title,
      },
      createdAt: event.payload.updatedAt,
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: serverCommandId("orchestrator-worker-autoreview"),
      threadId: orchestratorThread.id,
      message: {
        messageId: serverMessageId("orchestrator-worker-autoreview"),
        role: "user",
        text: buildWorkerAutoreviewPrompt({
          threadId: workerThread.id,
          threadTitle: workerThread.title,
          assignment: latestAssignment,
          latestWorkerMessage,
        }),
        attachments: [] satisfies ReadonlyArray<ChatAttachment>,
      },
      assistantDeliveryMode: "streaming",
      runtimeMode: "full-access",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: event.payload.updatedAt,
    });
  });

  const start: OrchestratorMessageReactorShape["start"] = Stream.runForEach(
    orchestrationEngine.streamDomainEvents,
    (event) => {
      switch (event.type) {
        case "orchestrator.run.message-added":
          return handleUserMessage(event).pipe(Effect.catch(() => Effect.void));
        case "thread.message-sent":
          return handleWorkerAssistantMessage(event).pipe(Effect.catch(() => Effect.void));
        default:
          return Effect.void;
      }
    },
  ).pipe(Effect.forkScoped, Effect.asVoid);

  return {
    start,
  } satisfies OrchestratorMessageReactorShape;
});

export const OrchestratorMessageReactorLive = Layer.effect(OrchestratorMessageReactor, make);
