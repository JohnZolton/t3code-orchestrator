import { CommandId, MessageId, ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import { Cache, Duration, Effect, Layer, Option, Stream } from "effect";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  OrchestratorActionReactor,
  type OrchestratorActionReactorShape,
} from "../Services/OrchestratorActionReactor.ts";

type ThreadMessageSentEvent = Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

const ORCHESTRATOR_THREAD_TITLE = "Orchestrator";
const ACTION_BLOCK_PATTERN = /```t3code-actions\s*([\s\S]*?)```/i;

const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

type ParsedActionEnvelope = {
  actions: Array<
    | {
        type: "create_thread";
        projectId: string;
        title: string;
        prompt?: string;
      }
    | {
        type: "send_to_thread";
        threadId: string;
        prompt: string;
      }
  >;
};

function parseActionEnvelope(text: string): ParsedActionEnvelope | null {
  const match = ACTION_BLOCK_PATTERN.exec(text);
  if (!match) {
    return null;
  }
  try {
    const parsed = JSON.parse(match[1]?.trim() ?? "");
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { actions?: unknown }).actions)) {
      return null;
    }
    const actions: ParsedActionEnvelope["actions"] = [];
    for (const action of (parsed as { actions: Array<Record<string, unknown>> }).actions) {
      if (action.type === "create_thread") {
        if (
          typeof action.projectId === "string" &&
          typeof action.title === "string" &&
          (action.prompt === undefined || typeof action.prompt === "string")
        ) {
          actions.push({
            type: "create_thread",
            projectId: action.projectId,
            title: action.title,
            ...(typeof action.prompt === "string" ? { prompt: action.prompt } : {}),
          });
        }
      }
      if (
        action.type === "send_to_thread" &&
        typeof action.threadId === "string" &&
        typeof action.prompt === "string"
      ) {
        actions.push({
          type: "send_to_thread",
          threadId: action.threadId,
          prompt: action.prompt,
        });
      }
    }
    return { actions };
  } catch {
    return null;
  }
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const handledMessages = yield* Cache.make<MessageId, true>({
    capacity: 10_000,
    timeToLive: Duration.hours(4),
    lookup: () => Effect.succeed(true),
  });

  const wasHandled = (messageId: MessageId) =>
    Cache.getOption(handledMessages, messageId).pipe(
      Effect.flatMap((cached) => Cache.set(handledMessages, messageId, true).pipe(Effect.as(Option.isSome(cached)))),
    );

  const handleAssistantMessage = Effect.fnUntraced(function* (event: ThreadMessageSentEvent) {
    if (event.payload.role !== "assistant" || event.payload.streaming) {
      return;
    }
    const alreadyHandled = yield* wasHandled(event.payload.messageId);
    if (alreadyHandled) {
      return;
    }

    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === event.payload.threadId);
    if (!thread || thread.title !== ORCHESTRATOR_THREAD_TITLE) {
      return;
    }

    const message = thread.messages.find((entry) => entry.id === event.payload.messageId);
    if (!message || message.role !== "assistant") {
      return;
    }

    const parsed = parseActionEnvelope(message.text);
    if (!parsed || parsed.actions.length === 0) {
      return;
    }

    for (const action of parsed.actions) {
      if (action.type === "create_thread") {
        const project = readModel.projects.find((entry) => entry.id === action.projectId);
        if (!project) {
          continue;
        }
        const threadId = ThreadId.makeUnsafe(crypto.randomUUID());
        const createdAt = new Date().toISOString();
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: serverCommandId("orchestrator-action-create-thread"),
          threadId,
          projectId: project.id,
          title: action.title.trim() || "Worker",
          model: project.defaultModel ?? "gpt-5-codex",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        if (action.prompt && action.prompt.trim().length > 0) {
          yield* orchestrationEngine.dispatch({
            type: "thread.turn.start",
            commandId: serverCommandId("orchestrator-action-start-thread"),
            threadId,
            message: {
              messageId: MessageId.makeUnsafe(crypto.randomUUID()),
              role: "user",
              text: action.prompt,
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt,
          });
        }
      }

      if (action.type === "send_to_thread") {
        const target = readModel.threads.find((entry) => entry.id === action.threadId);
        if (!target) {
          continue;
        }
        yield* orchestrationEngine.dispatch({
          type: "thread.turn.start",
          commandId: serverCommandId("orchestrator-action-send-to-thread"),
          threadId: target.id,
          message: {
            messageId: MessageId.makeUnsafe(crypto.randomUUID()),
            role: "user",
            text: action.prompt,
            attachments: [],
          },
          runtimeMode: target.runtimeMode,
          interactionMode: target.interactionMode,
          createdAt: new Date().toISOString(),
        });
      }
    }
  });

  const start: OrchestratorActionReactorShape["start"] = Stream.runForEach(
    orchestrationEngine.streamDomainEvents,
    (event) => {
      if (event.type !== "thread.message-sent") {
        return Effect.void;
      }
      return handleAssistantMessage(event).pipe(Effect.catch(() => Effect.void));
    },
  ).pipe(Effect.forkScoped, Effect.asVoid);

  return { start } satisfies OrchestratorActionReactorShape;
});

export const OrchestratorActionReactorLive = Layer.effect(OrchestratorActionReactor, make);
