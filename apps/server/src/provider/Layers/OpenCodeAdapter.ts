import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import readline from "node:readline";

import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import type {
  Event,
  Session,
} from "@opencode-ai/sdk";
import {
  type CanonicalItemType,
  type CanonicalRequestType,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Effect, Layer, Queue, Schema, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { OpenCodeAdapter, type OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";

const PROVIDER = "opencode" as const;
const SDK_OPTIONS = { throwOnError: true as const };
const DEFAULT_START_TIMEOUT_MS = 20_000;
const LISTENING_LINE_PREFIX = "opencode server listening on ";

interface RunningServer {
  readonly baseUrl: string;
  readonly client: OpencodeClient;
  readonly child: ReturnType<typeof spawn>;
  readonly stdout: readline.Interface;
}

interface OpenCodeSession {
  threadId: ThreadId;
  sessionId: string;
  client: OpencodeClient;
  cwd: string;
  status: ProviderSession["status"];
  activeTurnId: TurnId | undefined;
  lastCompletedTurnId: TurnId | undefined;
  terminalTurnIds: Set<string>;
}

function toRequestError(
  threadId: ThreadId,
  method: string,
  detail: string,
  cause?: unknown,
): ProviderAdapterError {
  return new ProviderAdapterRequestError({ provider: PROVIDER, method, detail, cause });
}

function missingSession(threadId: ThreadId) {
  return new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
}

function nowIso() {
  return new Date().toISOString();
}

function toTurnId(messageId: string): TurnId {
  return TurnId.makeUnsafe(`opencode:${messageId}`);
}

function turnIdToMessageId(turnId: TurnId | string | undefined): string | undefined {
  if (!turnId) return undefined;
  const value = String(turnId);
  return value.startsWith("opencode:") ? value.slice("opencode:".length) : undefined;
}

function toToolItemId(callId: string): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(`opencode-tool:${callId}`);
}

function buildAuthHeader(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;
}

async function spawnOpenCodeServer(
  cwd: string,
  binaryPath: string,
): Promise<RunningServer> {
  const password = randomUUID();
  const authHeader = buildAuthHeader(password);

  const child = spawn(
    binaryPath,
    ["serve", "--hostname", "127.0.0.1", "--port", "0"],
    { cwd, stdio: ["pipe", "pipe", "pipe"] },
  );

  const stdout = readline.createInterface({ input: child.stdout });
  const stderrLines: string[] = [];

  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      const detail = stderrLines.at(-1) ?? "Timed out waiting for OpenCode server startup";
      stdout.close();
      child.kill();
      reject(new Error(detail));
    }, DEFAULT_START_TIMEOUT_MS);

    stdout.on("line", (line) => {
      if (settled) return;
      const trimmed = line.trim();
      if (!trimmed.startsWith(LISTENING_LINE_PREFIX)) return;
      const baseUrl = trimmed.slice(LISTENING_LINE_PREFIX.length).trim();
      if (!baseUrl) {
        settled = true;
        clearTimeout(timeout);
        stdout.close();
        child.kill();
        reject(new Error("OpenCode server reported malformed listening URL"));
        return;
      }

      settled = true;
      clearTimeout(timeout);

      const client = createOpencodeClient({
        baseUrl,
        directory: cwd,
        headers: { Authorization: authHeader },
      });

      resolve({ baseUrl, client, child, stdout });
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrLines.push(chunk.toString("utf8").trim());
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      stdout.close();
      reject(err);
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const detail = stderrLines.filter(Boolean).join("\n");
      stdout.close();
      reject(new Error(`OpenCode server exited early (code=${code}, signal=${signal})${detail ? ` ${detail}` : ""}`));
    });
  });
}

function killChildTree(child: ReturnType<typeof spawn>) {
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {}
  }
  child.kill();
}

function mapEvent(
  event: Event,
  threadId: ThreadId,
  sessions: Map<ThreadId, OpenCodeSession>,
  runtimeEventQueue: Queue.Queue<ProviderRuntimeEvent>,
  publish: (events: ProviderRuntimeEvent[]) => void,
) {
  const session = sessions.get(threadId);
  if (!session) return;

  const createdAt = nowIso();
  const base = {
    eventId: EventId.makeUnsafe(randomUUID()),
    provider: PROVIDER,
    threadId,
    createdAt,
  };

  switch (event.type) {
    case "session.status": {
      const status = event.properties.status;
      if (status.type === "busy") {
        session.status = "running";
      } else if (status.type === "idle") {
        session.status = "ready";
        if (session.activeTurnId && !session.terminalTurnIds.has(String(session.activeTurnId))) {
          session.terminalTurnIds.add(String(session.activeTurnId));
          publish([{
            ...base,
            type: "turn.completed",
            payload: { state: "completed", stopReason: "idle" },
          }]);
          session.activeTurnId = undefined;
        }
      }
      break;
    }

    case "message.part.updated": {
      const part = event.properties.part;
      if (part.type === "tool") {
        const itemId = toToolItemId(part.callID);
        const turnId = session.activeTurnId ?? session.lastCompletedTurnId;
        if (!turnId) break;

        if (part.state.status === "completed" || part.state.status === "error") {
          publish([{
            ...base,
            turnId,
            itemId,
            type: "item.completed",
            payload: {
              itemType: "tool_call" as CanonicalItemType,
              status: part.state.status === "completed" ? "completed" : "failed",
              title: part.tool,
              detail: part.state.output || part.state.error || undefined,
            },
          }]);
        } else {
          publish([{
            ...base,
            turnId,
            itemId,
            type: "item.started",
            payload: {
              itemType: "tool_call" as CanonicalItemType,
              status: "inProgress",
              title: part.tool,
            },
          }]);
        }
      }
      break;
    }

    case "message.part.delta": {
      if (event.properties.field !== "text") break;
      const turnId = session.activeTurnId;
      if (!turnId) break;
      publish([{
        ...base,
        turnId,
        type: "content.delta",
        payload: { streamKind: "assistant_text", delta: event.properties.delta },
      }]);
      break;
    }

    case "message.updated": {
      if (event.properties.info.role !== "assistant") break;
      const msg = event.properties.info;
      if (msg.finish !== undefined || msg.time.completed !== undefined || msg.error !== undefined) {
        const turnId = toTurnId(msg.parentID);
        if (session.activeTurnId && String(session.activeTurnId) === String(turnId)) {
          session.lastCompletedTurnId = turnId;
          session.activeTurnId = undefined;
          session.status = msg.error ? "error" : "ready";
        }
        const assistantText = msg.parts
          .filter((p) => p.type === "text")
          .map((p) => (p as { type: "text"; text: string }).text)
          .join("")
          .trim();
        publish([{
          ...base,
          turnId,
          type: "item.completed",
          payload: {
            itemType: "assistant_message" as CanonicalItemType,
            status: msg.error ? "failed" : "completed",
            title: "Assistant message",
            detail: assistantText || undefined,
          },
        }]);
      }
      break;
    }

    case "permission.asked": {
      const turnId = session.activeTurnId;
      const requestType: CanonicalRequestType = {
        type: "command",
        command: event.properties.permission,
      };
      const requestId = RuntimeRequestId.makeUnsafe(event.properties.id);
      session.pendingRequests ??= new Map();
      session.pendingRequests.set(event.properties.id, { turnId, requestType });
      publish([{
        ...base,
        turnId,
        requestId,
        type: "request.opened",
        payload: {
          requestType,
          detail: event.properties.patterns?.join(", "),
        },
      }]);
      break;
    }

    case "permission.replied": {
      break;
    }
  }
}

function makeOpenCodeAdapter() {
  return Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig;
    const binaryPath = "opencode";

    const sessions = new Map<ThreadId, OpenCodeSession>();
    const threadIdBySessionId = new Map<string, ThreadId>();
    const servers = new Map<string, RunningServer>();
    const pendingRequests = new Map<string, { turnId: TurnId | undefined; requestType: CanonicalRequestType }>();

    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

    const publish = (events: ProviderRuntimeEvent[]) => {
      void Queue.offerAll(runtimeEventQueue, events);
    };

    const getOrCreateServer = (key: string, cwd: string): Effect.Effect<RunningServer, ProviderAdapterProcessError> =>
      Effect.tryPromise({
        try: async () => {
          const existing = servers.get(key);
          if (existing) return existing;
          const server = await spawnOpenCodeServer(cwd, binaryPath);
          servers.set(key, server);
          return server;
        },
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: "_pool",
            detail: cause instanceof Error ? cause.message : "Failed to start OpenCode server",
            cause,
          }),
      });

    const startSession = (input: Parameters<OpenCodeAdapterShape["startSession"]>[0]) =>
      Effect.gen(function* () {
        const threadId = input.threadId;
        const cwd = input.cwd ?? process.cwd();
        const key = `${cwd}:${binaryPath}`;

        const existing = sessions.get(threadId);
        if (existing) {
          void existing;
        }

        const server = yield* getOrCreateServer(key, cwd);

        const sessionId = `sess_${randomUUID()}`;
        const sessionCreate = yield* Effect.tryPromise({
          try: () =>
            server.client.session.create(
              { title: `T3 ${threadId}` },
              { ...SDK_OPTIONS },
            ),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId,
              detail: cause instanceof Error ? cause.message : "Failed to create OpenCode session",
              cause,
            }),
        });
        const sessionData = sessionCreate.data as Session;

        const state: OpenCodeSession = {
          threadId,
          sessionId: sessionData.id,
          client: server.client,
          cwd,
          status: "ready",
          activeTurnId: undefined,
          lastCompletedTurnId: undefined,
          terminalTurnIds: new Set(),
          pendingRequests: new Map(),
        };
        sessions.set(threadId, state);
        threadIdBySessionId.set(sessionData.id, threadId);

        publish([{
          eventId: EventId.makeUnsafe(randomUUID()),
          provider: PROVIDER,
          threadId,
          createdAt: nowIso(),
          type: "session.started",
          payload: { message: "Started OpenCode session.", resume: { sessionId: sessionData.id } },
        }]);

        return {
          provider: PROVIDER as const,
          status: "ready",
          runtimeMode: input.runtimeMode ?? { _tag: "FullAccess" },
          threadId,
          cwd,
          resumeCursor: { sessionId: sessionData.id },
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
      });

    const sendTurn = (input: Parameters<OpenCodeAdapterShape["sendTurn"]>[0]) =>
      Effect.gen(function* () {
        const state = sessions.get(input.threadId);
        if (!state) return yield* missingSession(input.threadId);

        const messageId = `msg_${randomUUID()}`;
        const turnId = toTurnId(messageId);
        state.activeTurnId = turnId;
        state.status = "running";

        publish([{
          eventId: EventId.makeUnsafe(randomUUID()),
          provider: PROVIDER,
          threadId: input.threadId,
          createdAt: nowIso(),
          turnId,
          type: "turn.started",
          payload: {},
        }]);

        yield* Effect.tryPromise({
          try: () =>
            state.client.session.promptAsync(
              {
                sessionID: state.sessionId,
                messageID: messageId,
                agent: input.interactionMode === "Plan" ? "plan" : "build",
                body: {
                  message: input.input ?? "",
                },
              },
              { ...SDK_OPTIONS },
            ),
          catch: (cause) =>
            toRequestError(
              input.threadId,
              "session.promptAsync",
              cause instanceof Error ? cause.message : "Failed to send turn",
              cause,
            ),
        });

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: { sessionId: state.sessionId },
        } satisfies ProviderTurnStartResult;
      });

    const interruptTurn = (threadId: ThreadId, _turnId?: TurnId) =>
      Effect.gen(function* () {
        const state = sessions.get(threadId);
        if (!state) return yield* missingSession(threadId);
        yield* Effect.tryPromise({
          try: () => state.client.session.abort({ sessionID: state.sessionId }, SDK_OPTIONS),
          catch: (cause) =>
            toRequestError(
              threadId,
              "session.abort",
              cause instanceof Error ? cause.message : "Failed to interrupt turn",
              cause,
            ),
        });
        if (state.activeTurnId) {
          state.terminalTurnIds.add(String(state.activeTurnId));
          state.activeTurnId = undefined;
          state.status = "ready";
          publish([{
            eventId: EventId.makeUnsafe(randomUUID()),
            provider: PROVIDER,
            threadId,
            createdAt: nowIso(),
            type: "turn.aborted",
            payload: { reason: "Turn interrupted by user." },
          }]);
        }
      });

    const respondToRequest = (threadId: ThreadId, requestId: string, decision: string) =>
      Effect.gen(function* () {
        const state = sessions.get(threadId);
        if (!state) return yield* missingSession(threadId);
        const reply = decision === "accept" ? "once" : decision === "acceptForSession" ? "always" : "reject";
        yield* Effect.tryPromise({
          try: () =>
            state.client.postSessionIdPermissionsPermissionId(
              { requestID: requestId, reply },
              SDK_OPTIONS,
            ),
          catch: (cause) =>
            toRequestError(
              threadId,
              "permission.reply",
              cause instanceof Error ? cause.message : "Failed to respond to request",
              cause,
            ),
        });
      });

    const respondToUserInput = (threadId: ThreadId, requestId: string, answers: ProviderUserInputAnswers) =>
      Effect.gen(function* () {
        const state = sessions.get(threadId);
        if (!state) return yield* missingSession(threadId);
        void state;
        void requestId;
        void answers;
      });

    const stopSession = (threadId: ThreadId) =>
      Effect.sync(() => {
        const state = sessions.get(threadId);
        if (!state) return;
        sessions.delete(threadId);
        threadIdBySessionId.delete(state.sessionId);
      });

    const listSessions = () =>
      Effect.sync(() =>
        Array.from(sessions.values()).map((s) => ({
          provider: PROVIDER as const,
          status: s.status,
          runtimeMode: { _tag: "FullAccess" } as const,
          threadId: s.threadId,
          cwd: s.cwd,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        })),
      );

    const hasSession = (threadId: ThreadId) =>
      Effect.sync(() => sessions.has(threadId));

    const readThread = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const state = sessions.get(threadId);
        if (!state) return yield* missingSession(threadId);
        return { threadId, turns: [] };
      });

    const rollbackThread = (threadId: ThreadId, numTurns: number) =>
      Effect.gen(function* () {
        const state = sessions.get(threadId);
        if (!state) return yield* missingSession(threadId);
        if (numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be >= 1",
          });
        }
        yield* Effect.tryPromise({
          try: () => state.client.session.revert({ sessionID: state.sessionId, diff: numTurns }, SDK_OPTIONS),
          catch: (cause) =>
            toRequestError(
              threadId,
              "session.revert",
              cause instanceof Error ? cause.message : "Failed to rollback",
              cause,
            ),
        });
        return { threadId, turns: [] };
      });

    const stopAll = () =>
      Effect.sync(() => {
        for (const server of servers.values()) {
          server.stdout.close();
          killChildTree(server.child);
        }
        servers.clear();
        sessions.clear();
        threadIdBySessionId.clear();
      });

    yield* Effect.acquireRelease(
      Effect.void,
      () => stopAll(),
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "unsupported" },
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
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    } satisfies OpenCodeAdapterShape;
  });
}

export const OpenCodeAdapterLive = Layer.effect(
  OpenCodeAdapter,
  makeOpenCodeAdapter(),
);
