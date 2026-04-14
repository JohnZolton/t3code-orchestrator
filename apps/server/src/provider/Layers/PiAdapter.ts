import { randomUUID } from "node:crypto";

import {
  EventId,
  type PiModelOptions,
  type PiThinkingLevel,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { Cause, Effect, FileSystem, Layer, Queue, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  piModelFromState,
  probePiRpcModels,
  PiRpcSessionProcess,
  piThreadSessionDir,
  type PiRpcAgentMessage,
  type PiRpcEvent,
  type PiRpcExtensionUiRequest,
  type PiRpcModel,
  type PiRpcPromptImage,
  resolvePiModelTarget,
} from "../piRuntime.ts";
import { PiAdapter, type PiAdapterShape } from "../Services/PiAdapter.ts";

const PROVIDER = "pi" as const;

interface PiTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

interface PiPendingUserInput {
  readonly request: PiRpcExtensionUiRequest;
  readonly questions: ReadonlyArray<UserInputQuestion>;
}

interface PiActiveTurn {
  readonly turnId: TurnId;
  readonly items: Array<unknown>;
  assistantTextSeen: boolean;
  completed: boolean;
  lastTurnMessage: PiRpcAgentMessage | undefined;
  lastToolResults: ReadonlyArray<PiRpcAgentMessage> | undefined;
}

interface PiSessionContext {
  session: ProviderSession;
  readonly process: PiRpcSessionProcess;
  readonly sessionDir: string;
  readonly cwd: string;
  availableModels: ReadonlyArray<PiRpcModel>;
  thinkingLevel: PiThinkingLevel | undefined;
  readonly pendingUserInputs: Map<string, PiPendingUserInput>;
  readonly turns: Array<PiTurnSnapshot>;
  activeTurn: PiActiveTurn | undefined;
  stopped: boolean;
}

type MutableProviderSession = {
  -readonly [K in keyof ProviderSession]: ProviderSession[K];
};

export interface PiAdapterLiveOptions {}

function nowIso(): string {
  return new Date().toISOString();
}

function buildEventBase(input: {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly createdAt?: string | undefined;
}): Pick<
  ProviderRuntimeEvent,
  "eventId" | "provider" | "threadId" | "createdAt" | "turnId" | "itemId" | "requestId"
> {
  return {
    eventId: EventId.makeUnsafe(randomUUID()),
    provider: PROVIDER,
    threadId: input.threadId,
    createdAt: input.createdAt ?? nowIso(),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: RuntimeItemId.makeUnsafe(input.itemId) } : {}),
    ...(input.requestId ? { requestId: RuntimeRequestId.makeUnsafe(input.requestId) } : {}),
  };
}

function ensureSessionContext(
  sessions: ReadonlyMap<ThreadId, PiSessionContext>,
  threadId: ThreadId,
): PiSessionContext {
  const context = sessions.get(threadId);
  if (!context) {
    throw new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
  }
  if (context.stopped) {
    throw new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId });
  }
  return context;
}

function extractTextContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => extractTextContent(entry)).join("");
  }
  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as { type?: unknown; text?: unknown; content?: unknown };
  if (record.type === "text" && typeof record.text === "string") {
    return record.text;
  }
  if (typeof record.text === "string") {
    return record.text;
  }
  return extractTextContent(record.content);
}

function extractAssistantText(message: PiRpcAgentMessage | undefined): string {
  return extractTextContent(message?.content).trim();
}

function detailFromToolPayload(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { content?: unknown; details?: unknown };
  const text = extractTextContent(record.content).trim();
  if (text.length > 0) {
    return text.slice(0, 2_000);
  }
  if (record.details !== undefined) {
    const serialized = JSON.stringify(record.details);
    if (serialized.length > 0) {
      return serialized.slice(0, 2_000);
    }
  }
  return undefined;
}

function classifyToolItemType(
  toolName: string | undefined,
):
  | "command_execution"
  | "file_change"
  | "mcp_tool_call"
  | "dynamic_tool_call"
  | "web_search"
  | "image_view"
  | "collab_agent_tool_call" {
  const normalized = toolName?.trim().toLowerCase() ?? "";
  if (
    normalized === "bash" ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }
  if (
    normalized === "edit" ||
    normalized === "write" ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("file")
  ) {
    return "file_change";
  }
  if (normalized === "mcp" || normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("web")) {
    return "web_search";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  if (normalized.includes("agent") || normalized.includes("subagent")) {
    return "collab_agent_tool_call";
  }
  return "dynamic_tool_call";
}

function titleForTool(itemType: ReturnType<typeof classifyToolItemType>): string {
  switch (itemType) {
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "collab_agent_tool_call":
      return "Subagent task";
    case "dynamic_tool_call":
    default:
      return "Tool call";
  }
}

function summarizeToolArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  const record = args as Record<string, unknown>;
  const command =
    typeof record.command === "string"
      ? record.command
      : typeof record.cmd === "string"
        ? record.cmd
        : undefined;
  if (command && command.trim().length > 0) {
    return command.trim().slice(0, 400);
  }
  const serialized = JSON.stringify(args);
  return serialized.length > 0 ? serialized.slice(0, 400) : undefined;
}

function buildExtensionQuestions(
  request: PiRpcExtensionUiRequest,
): ReadonlyArray<UserInputQuestion> {
  switch (request.method) {
    case "confirm":
      return [
        {
          id: request.id,
          header: request.title?.trim() || "Confirm",
          question: request.message?.trim() || request.title?.trim() || "Confirm?",
          options: [
            { label: "Yes", description: "Confirm" },
            { label: "No", description: "Decline" },
          ],
          multiSelect: false,
        },
      ];
    case "select":
      return [
        {
          id: request.id,
          header: request.title?.trim() || "Select",
          question: request.message?.trim() || request.title?.trim() || "Choose an option",
          options: (request.options ?? []).map((option) => ({
            label: option,
            description: option,
          })),
          multiSelect: false,
        },
      ];
    case "input":
    case "editor":
      return [
        {
          id: request.id,
          header: request.title?.trim() || (request.method === "editor" ? "Editor" : "Input"),
          question:
            request.placeholder?.trim() ||
            request.message?.trim() ||
            request.title?.trim() ||
            "Enter a value",
          options: [{ label: "text", description: "Provide a text response" }],
          multiSelect: false,
        },
      ];
    default:
      return [];
  }
}

async function stopPiContext(context: PiSessionContext): Promise<void> {
  context.stopped = true;
  context.process.close();
}

function updateProviderSession(
  context: PiSessionContext,
  patch: Partial<ProviderSession>,
  options?: {
    readonly clearActiveTurnId?: boolean;
    readonly clearLastError?: boolean;
  },
): ProviderSession {
  const next = {
    ...context.session,
    ...patch,
    updatedAt: nowIso(),
  } as MutableProviderSession;
  if (options?.clearActiveTurnId) {
    delete next.activeTurnId;
  }
  if (options?.clearLastError) {
    delete next.lastError;
  }
  context.session = next;
  return next;
}

function normalizeForkableMessages(
  messages: ReadonlyArray<{ readonly entryId?: string; readonly text?: string }>,
) {
  return messages.filter(
    (
      message,
    ): message is {
      readonly entryId: string;
      readonly text?: string;
    } => typeof message.entryId === "string" && message.entryId.trim().length > 0,
  );
}

function stopReasonToTurnState(
  stopReason: string | undefined,
): "completed" | "failed" | "interrupted" | "cancelled" {
  switch (stopReason) {
    case "aborted":
      return "interrupted";
    case "error":
      return "failed";
    default:
      return "completed";
  }
}

function piThinkingLevelFromOptions(
  options: PiModelOptions | undefined,
): PiThinkingLevel | undefined {
  return options?.thinkingLevel;
}

function readResumeString(
  resumeCursor: unknown,
  key: "sessionDir" | "sessionFile",
): string | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object") {
    return undefined;
  }
  const value = (resumeCursor as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function errorMessageFromPiEvent(event: PiRpcEvent): string | undefined {
  if (event.type === "message_update") {
    const assistantMessageEvent = event.assistantMessageEvent;
    if (assistantMessageEvent?.type === "error") {
      return assistantMessageEvent.reason ?? "Pi assistant message failed.";
    }
  }
  if (event.type === "extension_error") {
    return event.error ?? "Pi extension failed.";
  }
  if (event.type === "compaction_end" && typeof event.errorMessage === "string") {
    return event.errorMessage;
  }
  if (event.type === "auto_retry_end" && typeof event.finalError === "string") {
    return event.finalError;
  }
  return undefined;
}

function latestAssistantMessage(
  messages: ReadonlyArray<PiRpcAgentMessage> | undefined,
): PiRpcAgentMessage | undefined {
  if (!messages) {
    return undefined;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") {
      return message;
    }
  }

  return undefined;
}

export function makePiAdapterLive(_options?: PiAdapterLiveOptions) {
  return Layer.effect(
    PiAdapter,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const services = yield* Effect.services();
      const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const sessions = new Map<ThreadId, PiSessionContext>();

      const emit = (event: ProviderRuntimeEvent) =>
        Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);

      const loadPromptImages = Effect.fn("loadPromptImages")(function* (
        threadId: ThreadId,
        attachments: ReadonlyArray<{
          readonly type: "image";
          readonly id: string;
          readonly name: string;
          readonly mimeType: string;
          readonly sizeBytes: number;
        }>,
      ) {
        return yield* Effect.forEach(
          attachments,
          (attachment) =>
            Effect.gen(function* () {
              const path = resolveAttachmentPath({
                attachmentsDir: serverConfig.attachmentsDir,
                attachment,
              });
              if (!path) {
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "prompt",
                  detail: `Invalid Pi attachment id '${attachment.id}'.`,
                });
              }
              const bytes = yield* fileSystem.readFile(path).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "prompt",
                      detail: "Failed to read Pi attachment file.",
                      cause,
                    }),
                ),
              );
              return {
                type: "image",
                data: Buffer.from(bytes).toString("base64"),
                mimeType: attachment.mimeType,
              } satisfies PiRpcPromptImage;
            }),
          { concurrency: 1 },
        );
      });

      const completeTurn = Effect.fn("completeTurn")(function* (
        context: PiSessionContext,
        input: {
          readonly state: "completed" | "failed" | "interrupted" | "cancelled";
          readonly stopReason?: string | null | undefined;
          readonly usage?: unknown;
          readonly errorMessage?: string | undefined;
          readonly finalMessage?: PiRpcAgentMessage | undefined;
          readonly finalItems?: ReadonlyArray<unknown> | undefined;
        },
      ) {
        const activeTurn = context.activeTurn;
        if (!activeTurn || activeTurn.completed) {
          return;
        }

        activeTurn.completed = true;
        if (input.finalMessage !== undefined) {
          activeTurn.items.push(input.finalMessage);
        }
        for (const item of input.finalItems ?? []) {
          activeTurn.items.push(item);
        }

        const fallbackAssistantText = extractAssistantText(input.finalMessage);
        if (!activeTurn.assistantTextSeen && fallbackAssistantText.length > 0) {
          yield* emit({
            ...buildEventBase({
              threadId: context.session.threadId,
              turnId: activeTurn.turnId,
              itemId: `assistant:${activeTurn.turnId}:0`,
            }),
            type: "item.completed",
            payload: {
              itemType: "assistant_message",
              status: "completed",
              title: "Assistant message",
              detail: fallbackAssistantText,
            },
          });
        }

        yield* emit({
          ...buildEventBase({ threadId: context.session.threadId, turnId: activeTurn.turnId }),
          type: "turn.completed",
          payload: {
            state: input.state,
            ...(input.stopReason !== undefined && input.stopReason !== null
              ? { stopReason: input.stopReason }
              : {}),
            ...(input.usage !== undefined ? { usage: input.usage } : {}),
            ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
          },
        });

        context.turns.push({
          id: activeTurn.turnId,
          items: [...activeTurn.items],
        });
        context.activeTurn = undefined;
        updateProviderSession(
          context,
          {
            status: input.state === "failed" ? "error" : "ready",
            ...(input.state === "failed" && input.errorMessage
              ? { lastError: input.errorMessage }
              : {}),
          },
          { clearActiveTurnId: true },
        );
      });

      const handleProcessExit = (context: PiSessionContext, message: string) =>
        Effect.gen(function* () {
          if (context.stopped) {
            return;
          }
          context.stopped = true;
          if (context.activeTurn && !context.activeTurn.completed) {
            yield* completeTurn(context, {
              state: "failed",
              errorMessage: message,
            });
          }
          yield* emit({
            ...buildEventBase({ threadId: context.session.threadId }),
            type: "runtime.error",
            payload: {
              message,
              class: "transport_error",
            },
          });
          yield* emit({
            ...buildEventBase({ threadId: context.session.threadId }),
            type: "session.exited",
            payload: {
              reason: message,
              recoverable: true,
              exitKind: "error",
            },
          });
        });

      const handlePiEvent = (context: PiSessionContext, event: PiRpcEvent) =>
        Effect.gen(function* () {
          const activeTurn = context.activeTurn;
          if (activeTurn) {
            activeTurn.items.push(event);
          }

          switch (event.type) {
            case "message_update": {
              const assistantMessageEvent = event.assistantMessageEvent;
              if (!activeTurn || !assistantMessageEvent?.type) {
                return;
              }

              if (assistantMessageEvent.type === "text_delta") {
                const delta = assistantMessageEvent.delta ?? "";
                if (delta.length === 0) {
                  return;
                }
                activeTurn.assistantTextSeen = true;
                const contentIndex = assistantMessageEvent.contentIndex ?? 0;
                yield* emit({
                  ...buildEventBase({
                    threadId: context.session.threadId,
                    turnId: activeTurn.turnId,
                    itemId: `assistant:${activeTurn.turnId}:${contentIndex}`,
                  }),
                  type: "content.delta",
                  payload: {
                    streamKind: "assistant_text",
                    delta,
                    contentIndex,
                  },
                });
                return;
              }

              if (assistantMessageEvent.type === "thinking_delta") {
                const delta = assistantMessageEvent.delta ?? "";
                if (delta.length === 0) {
                  return;
                }
                yield* emit({
                  ...buildEventBase({
                    threadId: context.session.threadId,
                    turnId: activeTurn.turnId,
                    itemId: `reasoning:${activeTurn.turnId}:${assistantMessageEvent.contentIndex ?? 0}`,
                  }),
                  type: "content.delta",
                  payload: {
                    streamKind: "reasoning_text",
                    delta,
                    ...(assistantMessageEvent.contentIndex !== undefined
                      ? { contentIndex: assistantMessageEvent.contentIndex }
                      : {}),
                  },
                });
                return;
              }

              if (assistantMessageEvent.type === "error") {
                const message = errorMessageFromPiEvent(event) ?? "Pi assistant message failed.";
                yield* emit({
                  ...buildEventBase({
                    threadId: context.session.threadId,
                    turnId: activeTurn.turnId,
                  }),
                  type: "runtime.error",
                  payload: {
                    message,
                    class:
                      assistantMessageEvent.reason === "aborted"
                        ? "transport_error"
                        : "provider_error",
                  },
                });
                if (assistantMessageEvent.reason === "aborted") {
                  yield* completeTurn(context, {
                    state: "interrupted",
                    stopReason: "aborted",
                    errorMessage: message,
                  });
                }
                return;
              }

              return;
            }

            case "tool_execution_start": {
              if (!activeTurn) {
                return;
              }
              const itemType = classifyToolItemType(event.toolName);
              yield* emit({
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId: activeTurn.turnId,
                  itemId: event.toolCallId,
                }),
                type: "item.started",
                payload: {
                  itemType,
                  status: "inProgress",
                  title: titleForTool(itemType),
                  ...(summarizeToolArgs(event.args)
                    ? { detail: summarizeToolArgs(event.args) }
                    : {}),
                  data: {
                    toolName: event.toolName,
                    args: event.args,
                  },
                },
              });
              return;
            }

            case "tool_execution_update": {
              if (!activeTurn) {
                return;
              }
              const itemType = classifyToolItemType(event.toolName);
              yield* emit({
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId: activeTurn.turnId,
                  itemId: event.toolCallId,
                }),
                type: "item.updated",
                payload: {
                  itemType,
                  status: "inProgress",
                  title: titleForTool(itemType),
                  ...(detailFromToolPayload(event.partialResult)
                    ? { detail: detailFromToolPayload(event.partialResult) }
                    : {}),
                  data: {
                    toolName: event.toolName,
                    args: event.args,
                    partialResult: event.partialResult,
                  },
                },
              });
              return;
            }

            case "tool_execution_end": {
              if (!activeTurn) {
                return;
              }
              const itemType = classifyToolItemType(event.toolName);
              yield* emit({
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId: activeTurn.turnId,
                  itemId: event.toolCallId,
                }),
                type: "item.completed",
                payload: {
                  itemType,
                  status: event.isError ? "failed" : "completed",
                  title: titleForTool(itemType),
                  ...(detailFromToolPayload(event.result)
                    ? { detail: detailFromToolPayload(event.result) }
                    : {}),
                  data: {
                    toolName: event.toolName,
                    result: event.result,
                    isError: event.isError === true,
                  },
                },
              });
              return;
            }

            case "turn_end": {
              if (!activeTurn) {
                return;
              }
              activeTurn.lastTurnMessage = event.message;
              activeTurn.lastToolResults = event.toolResults;
              return;
            }

            case "agent_end": {
              if (!activeTurn) {
                return;
              }
              const finalMessage =
                activeTurn.lastTurnMessage ?? latestAssistantMessage(event.messages);
              const stopReason = finalMessage?.stopReason;
              const state = stopReasonToTurnState(stopReason);
              yield* completeTurn(context, {
                state,
                ...(stopReason ? { stopReason } : {}),
                ...(finalMessage?.usage !== undefined ? { usage: finalMessage.usage } : {}),
                ...(state === "failed"
                  ? { errorMessage: extractAssistantText(finalMessage) || "Pi turn failed." }
                  : {}),
                finalMessage,
                finalItems: activeTurn.lastToolResults,
              });
              return;
            }

            case "extension_ui_request": {
              if (
                event.method !== "select" &&
                event.method !== "confirm" &&
                event.method !== "input" &&
                event.method !== "editor"
              ) {
                return;
              }
              const questions = buildExtensionQuestions(event);
              if (questions.length === 0) {
                return;
              }
              context.pendingUserInputs.set(event.id, { request: event, questions });
              yield* emit({
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId: activeTurn?.turnId,
                  requestId: event.id,
                }),
                type: "user-input.requested",
                payload: {
                  questions,
                },
              });
              return;
            }

            case "extension_error": {
              const message = errorMessageFromPiEvent(event) ?? "Pi extension failed.";
              yield* emit({
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId: activeTurn?.turnId,
                }),
                type: "runtime.error",
                payload: {
                  message,
                  class: "provider_error",
                  detail: event,
                },
              });
              return;
            }

            case "compaction_end": {
              if (!event.errorMessage) {
                return;
              }
              yield* emit({
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId: activeTurn?.turnId,
                }),
                type: "runtime.warning",
                payload: {
                  message: event.errorMessage,
                  detail: event,
                },
              });
              return;
            }

            case "auto_retry_end": {
              if (!event.finalError) {
                return;
              }
              yield* emit({
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId: activeTurn?.turnId,
                }),
                type: "runtime.warning",
                payload: {
                  message: event.finalError,
                  detail: event,
                },
              });
              return;
            }

            default:
              return;
          }
        });

      const startSession: PiAdapterShape["startSession"] = Effect.fn("startSession")(
        function* (input) {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }

          const settings = yield* serverSettings.getSettings.pipe(
            Effect.map((allSettings) => allSettings.providers.pi),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: "Failed to read Pi settings.",
                  cause,
                }),
            ),
          );

          const existing = sessions.get(input.threadId);
          if (existing) {
            yield* Effect.tryPromise({
              try: () => stopPiContext(existing),
              catch: (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: "Failed to stop existing Pi session.",
                  cause,
                }),
            });
            sessions.delete(input.threadId);
          }

          const cwd = input.cwd ?? serverConfig.cwd;
          const resumeSessionDir = readResumeString(input.resumeCursor, "sessionDir");
          const resumeSessionFile = readResumeString(input.resumeCursor, "sessionFile");
          const sessionDir =
            resumeSessionDir ??
            piThreadSessionDir({
              stateDir: serverConfig.stateDir,
              threadId: input.threadId,
            });
          yield* fileSystem.makeDirectory(sessionDir, { recursive: true }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: "Failed to create Pi session directory.",
                  cause,
                }),
            ),
          );

          const process = yield* Effect.tryPromise({
            try: () =>
              PiRpcSessionProcess.start({
                binaryPath: settings.binaryPath,
                cwd,
                sessionDir,
                ...(resumeSessionFile ? { resumeSessionFile } : {}),
                ...(!resumeSessionFile && input.resumeCursor !== undefined
                  ? { continueSession: true }
                  : {}),
              }),
            catch: (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: cause instanceof Error ? cause.message : "Failed to start Pi RPC process.",
                cause,
              }),
          });

          let availableModels = yield* Effect.tryPromise({
            try: () => process.getAvailableModels(),
            catch: (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: cause instanceof Error ? cause.message : "Failed to load Pi models.",
                cause,
              }),
          });

          let state = yield* Effect.tryPromise({
            try: () => process.getState(),
            catch: (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail:
                  cause instanceof Error ? cause.message : "Failed to query Pi session state.",
                cause,
              }),
          });

          const requestedThinkingLevel =
            input.modelSelection?.provider === PROVIDER
              ? piThinkingLevelFromOptions(input.modelSelection.options)
              : undefined;

          if (
            input.modelSelection?.provider === PROVIDER &&
            piModelFromState(state) !== input.modelSelection.model
          ) {
            let target = resolvePiModelTarget({
              requestedModel: input.modelSelection.model,
              availableModels,
              fallbackProvider: state.model?.provider,
            });
            if (!target) {
              availableModels = yield* Effect.tryPromise({
                try: () => probePiRpcModels({ binaryPath: settings.binaryPath, cwd }),
                catch: (cause) =>
                  new ProviderAdapterProcessError({
                    provider: PROVIDER,
                    threadId: input.threadId,
                    detail:
                      cause instanceof Error
                        ? cause.message
                        : "Failed to probe Pi providers for model resolution.",
                    cause,
                  }),
              });
              target = resolvePiModelTarget({
                requestedModel: input.modelSelection.model,
                availableModels,
                fallbackProvider: state.model?.provider,
              });
            }
            if (!target) {
              process.close();
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "startSession",
                issue: `Unable to resolve Pi model '${input.modelSelection.model}'.`,
              });
            }
            yield* Effect.tryPromise({
              try: () => process.setModel(target),
              catch: (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail:
                    cause instanceof Error ? cause.message : "Failed to set initial Pi model.",
                  cause,
                }),
            });
            state = yield* Effect.tryPromise({
              try: () => process.getState(),
              catch: (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail:
                    cause instanceof Error ? cause.message : "Failed to query Pi session state.",
                  cause,
                }),
            });
          }

          if (requestedThinkingLevel && state.thinkingLevel !== requestedThinkingLevel) {
            yield* Effect.tryPromise({
              try: () => process.setThinkingLevel({ level: requestedThinkingLevel }),
              catch: (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail:
                    cause instanceof Error
                      ? cause.message
                      : "Failed to set initial Pi thinking level.",
                  cause,
                }),
            });
            state = yield* Effect.tryPromise({
              try: () => process.getState(),
              catch: (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail:
                    cause instanceof Error ? cause.message : "Failed to query Pi session state.",
                  cause,
                }),
            });
          }

          const createdAt = nowIso();
          const session: ProviderSession = {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            ...(piModelFromState(state) ? { model: piModelFromState(state) } : {}),
            threadId: input.threadId,
            resumeCursor: {
              sessionDir,
              ...(state.sessionFile ? { sessionFile: state.sessionFile } : {}),
            },
            createdAt,
            updatedAt: createdAt,
          };

          const context: PiSessionContext = {
            session,
            process,
            sessionDir,
            cwd,
            availableModels,
            thinkingLevel: state.thinkingLevel as PiThinkingLevel | undefined,
            pendingUserInputs: new Map(),
            turns: [],
            activeTurn: undefined,
            stopped: false,
          };
          sessions.set(input.threadId, context);

          process.onEvent((event) => {
            void handlePiEvent(context, event).pipe(Effect.runPromiseWith(services));
          });
          process.onExit(({ code, stderr }) => {
            const detail = stderr.trim();
            const message =
              detail.length > 0
                ? `Pi RPC process exited unexpectedly (${code ?? "unknown"}): ${detail}`
                : `Pi RPC process exited unexpectedly (${code ?? "unknown"}).`;
            void handleProcessExit(context, message).pipe(Effect.runPromiseWith(services));
          });

          yield* emit({
            ...buildEventBase({ threadId: input.threadId, createdAt }),
            type: "session.started",
            payload: {
              message: "Pi RPC session started",
              resume: { sessionDir },
            },
          });
          yield* emit({
            ...buildEventBase({ threadId: input.threadId, createdAt }),
            type: "thread.started",
            payload: {
              providerThreadId: state.sessionId ?? sessionDir,
            },
          });
          if (input.runtimeMode !== "full-access") {
            yield* emit({
              ...buildEventBase({ threadId: input.threadId, createdAt }),
              type: "runtime.warning",
              payload: {
                message: "Pi ignores T3 runtime approval modes and runs with Pi defaults.",
                detail: { runtimeMode: input.runtimeMode },
              },
            });
          }

          return session;
        },
      );

      const sendTurn: PiAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
        const context = ensureSessionContext(sessions, input.threadId);
        const message = input.input?.trim() ?? "";
        if (message.length === 0 && (input.attachments?.length ?? 0) === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Pi turns require text input or at least one attachment.",
          });
        }
        if (context.activeTurn && !context.activeTurn.completed) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "prompt",
            detail: "Pi is already processing a turn for this thread.",
          });
        }

        const requestedThinkingLevel =
          input.modelSelection?.provider === PROVIDER
            ? piThinkingLevelFromOptions(input.modelSelection.options)
            : undefined;

        if (
          input.modelSelection?.provider === PROVIDER &&
          context.session.model !== input.modelSelection.model
        ) {
          const settings = yield* serverSettings.getSettings.pipe(
            Effect.map((allSettings) => allSettings.providers.pi),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: "Failed to read Pi settings.",
                  cause,
                }),
            ),
          );

          let target = resolvePiModelTarget({
            requestedModel: input.modelSelection.model,
            availableModels: context.availableModels,
          });
          if (!target) {
            context.availableModels = yield* Effect.tryPromise({
              try: () => probePiRpcModels({ binaryPath: settings.binaryPath, cwd: context.cwd }),
              catch: (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "get_available_models",
                  detail:
                    cause instanceof Error
                      ? cause.message
                      : "Failed to probe Pi providers for model resolution.",
                  cause,
                }),
            });
            target = resolvePiModelTarget({
              requestedModel: input.modelSelection.model,
              availableModels: context.availableModels,
            });
          }
          if (!target) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: `Unable to resolve Pi model '${input.modelSelection.model}'.`,
            });
          }
          const model = yield* Effect.tryPromise({
            try: () => context.process.setModel(target),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "set_model",
                detail: cause instanceof Error ? cause.message : "Failed to set Pi model.",
                cause,
              }),
          });
          context.session = updateProviderSession(context, {
            model: model?.id ?? input.modelSelection.model,
          });
        }

        if (requestedThinkingLevel && context.thinkingLevel !== requestedThinkingLevel) {
          yield* Effect.tryPromise({
            try: () => context.process.setThinkingLevel({ level: requestedThinkingLevel }),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "set_thinking_level",
                detail: cause instanceof Error ? cause.message : "Failed to set Pi thinking level.",
                cause,
              }),
          });
          context.thinkingLevel = requestedThinkingLevel;
        }

        const images = yield* loadPromptImages(
          input.threadId,
          (input.attachments ?? []).filter((attachment) => attachment.type === "image"),
        );
        const turnId = TurnId.makeUnsafe(`pi-turn-${randomUUID()}`);
        context.activeTurn = {
          turnId,
          items: [],
          assistantTextSeen: false,
          completed: false,
          lastTurnMessage: undefined,
          lastToolResults: undefined,
        };
        updateProviderSession(
          context,
          {
            status: "running",
            activeTurnId: turnId,
            ...(input.modelSelection?.provider === PROVIDER
              ? { model: input.modelSelection.model }
              : {}),
          },
          { clearLastError: true },
        );

        yield* emit({
          ...buildEventBase({ threadId: input.threadId, turnId }),
          type: "turn.started",
          payload: {
            model: context.session.model,
          },
        });

        const promptExit = yield* Effect.exit(
          Effect.tryPromise({
            try: () =>
              context.process.prompt({
                message,
                ...(images.length > 0 ? { images } : {}),
              }),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "prompt",
                detail: cause instanceof Error ? cause.message : "Failed to send Pi prompt.",
                cause,
              }),
          }),
        );
        if (promptExit._tag === "Failure") {
          const error = Cause.squash(promptExit.cause);
          yield* completeTurn(context, {
            state: "failed",
            errorMessage: error instanceof Error ? error.message : "Failed to send Pi prompt.",
          });
          return yield* Effect.failCause(promptExit.cause);
        }

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: context.session.resumeCursor ?? {
            sessionDir: context.sessionDir,
          },
        };
      });

      const interruptTurn: PiAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
        function* (threadId) {
          const context = ensureSessionContext(sessions, threadId);
          yield* Effect.tryPromise({
            try: () => context.process.abort(),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "abort",
                detail: cause instanceof Error ? cause.message : "Failed to abort Pi turn.",
                cause,
              }),
          });
          if (context.activeTurn && !context.activeTurn.completed) {
            yield* completeTurn(context, {
              state: "interrupted",
              stopReason: "aborted",
              errorMessage: "Interrupted by user.",
            });
          }
        },
      );

      const respondToRequest: PiAdapterShape["respondToRequest"] = Effect.fn("respondToRequest")(
        function* (_threadId, _requestId, _decision) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "respondToRequest",
            detail: "Pi does not expose approval callbacks through this adapter.",
          });
        },
      );

      const respondToUserInput: PiAdapterShape["respondToUserInput"] = Effect.fn(
        "respondToUserInput",
      )(function* (threadId, requestId, answers) {
        const context = ensureSessionContext(sessions, threadId);
        const pending = context.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "extension_ui_response",
            detail: `Unknown pending Pi user-input request: ${requestId}`,
          });
        }

        const questionId = pending.questions[0]?.id ?? requestId;
        const rawAnswer = answers[questionId] ?? answers[requestId];
        const answer =
          typeof rawAnswer === "string"
            ? rawAnswer
            : Array.isArray(rawAnswer)
              ? rawAnswer.find((entry): entry is string => typeof entry === "string")
              : undefined;
        const method = pending.request.method;

        yield* Effect.tryPromise({
          try: () => {
            if (method === "confirm") {
              return context.process.respondToExtensionUi({
                id: requestId,
                confirmed: (answer ?? "").trim().toLowerCase() === "yes",
              });
            }
            if (answer && answer.trim().length > 0) {
              return context.process.respondToExtensionUi({
                id: requestId,
                value: answer,
              });
            }
            return context.process.respondToExtensionUi({
              id: requestId,
              cancelled: true,
            });
          },
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "extension_ui_response",
              detail:
                cause instanceof Error ? cause.message : "Failed to submit Pi user-input response.",
              cause,
            }),
        });

        context.pendingUserInputs.delete(requestId);
        yield* emit({
          ...buildEventBase({
            threadId,
            turnId: context.activeTurn?.turnId,
            requestId,
          }),
          type: "user-input.resolved",
          payload: {
            answers,
          },
        });
      });

      const stopSession: PiAdapterShape["stopSession"] = Effect.fn("stopSession")(
        function* (threadId) {
          const context = ensureSessionContext(sessions, threadId);
          yield* Effect.tryPromise({
            try: () => stopPiContext(context),
            catch: (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId,
                detail: cause instanceof Error ? cause.message : "Failed to stop Pi session.",
                cause,
              }),
          });
          sessions.delete(threadId);
          yield* emit({
            ...buildEventBase({ threadId }),
            type: "session.exited",
            payload: {
              reason: "Session stopped.",
              recoverable: true,
              exitKind: "graceful",
            },
          });
        },
      );

      const listSessions: PiAdapterShape["listSessions"] = () =>
        Effect.sync(() => [...sessions.values()].map((context) => context.session));

      const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
        Effect.sync(() => sessions.has(threadId));

      const readThread: PiAdapterShape["readThread"] = Effect.fn("readThread")(
        function* (threadId) {
          const context = ensureSessionContext(sessions, threadId);
          const messages = yield* Effect.tryPromise({
            try: () => context.process.getMessages(),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "get_messages",
                detail: cause instanceof Error ? cause.message : "Failed to read Pi messages.",
                cause,
              }),
          });

          const turns: Array<PiTurnSnapshot> = [];
          let currentTurn: PiTurnSnapshot | undefined;
          for (const [index, message] of messages.entries()) {
            if (message.role === "assistant") {
              currentTurn = {
                id: TurnId.makeUnsafe(`pi-history-${threadId}-${index}`),
                items: [message],
              };
              turns.push(currentTurn);
              continue;
            }
            if (
              (message.role === "toolResult" || message.role === "bashExecution") &&
              currentTurn
            ) {
              currentTurn.items.push(message);
            }
          }

          return {
            threadId,
            turns,
          };
        },
      );

      const rollbackThread: PiAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
        function* (threadId, numTurns) {
          if (!Number.isInteger(numTurns) || numTurns < 1) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "rollbackThread",
              issue: "numTurns must be an integer >= 1.",
            });
          }

          const context = ensureSessionContext(sessions, threadId);
          const forkMessages = yield* Effect.tryPromise({
            try: () => context.process.getForkMessages(),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "get_fork_messages",
                detail:
                  cause instanceof Error ? cause.message : "Failed to inspect Pi fork messages.",
                cause,
              }),
          });
          const candidates = normalizeForkableMessages(forkMessages);
          const target = candidates[candidates.length - numTurns];
          if (!target) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "fork",
              detail: `Cannot roll back ${numTurns} turn(s); only ${candidates.length} fork point(s) are available.`,
            });
          }

          const result = yield* Effect.tryPromise({
            try: () => context.process.fork(target.entryId),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "fork",
                detail: cause instanceof Error ? cause.message : "Failed to fork Pi session.",
                cause,
              }),
          });
          if (result.cancelled) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "fork",
              detail: "Pi fork was cancelled.",
            });
          }

          context.turns.length = 0;
          context.activeTurn = undefined;
          context.pendingUserInputs.clear();
          const state = yield* Effect.tryPromise({
            try: () => context.process.getState(),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "get_state",
                detail: cause instanceof Error ? cause.message : "Failed to refresh Pi state.",
                cause,
              }),
          });
          context.session = updateProviderSession(
            context,
            {
              status: "ready",
              ...(piModelFromState(state) ? { model: piModelFromState(state) } : {}),
            },
            { clearActiveTurnId: true, clearLastError: true },
          );

          return yield* readThread(threadId);
        },
      );

      const stopAll: PiAdapterShape["stopAll"] = () =>
        Effect.tryPromise({
          try: async () => {
            await Promise.all([...sessions.values()].map((context) => stopPiContext(context)));
            sessions.clear();
          },
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: "*",
              detail: cause instanceof Error ? cause.message : "Failed to stop Pi sessions.",
              cause,
            }),
        });

      return {
        provider: PROVIDER,
        capabilities: {
          sessionModelSwitch: "in-session",
        },
        startSession,
        sendTurn,
        interruptTurn,
        respondToRequest,
        respondToUserInput,
        stopSession,
        listSessions,
        hasSession,
        readThread,
        rollbackThread,
        stopAll,
        get streamEvents() {
          return Stream.fromQueue(runtimeEvents);
        },
      } satisfies PiAdapterShape;
    }),
  );
}

export const PiAdapterLive = makePiAdapterLive();
