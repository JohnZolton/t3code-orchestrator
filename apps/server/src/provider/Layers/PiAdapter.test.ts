import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Fiber, Layer, Stream } from "effect";
import { vi } from "vitest";

import { ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { PiAdapter } from "../Services/PiAdapter.ts";
import type {
  PiRpcAgentMessage,
  PiRpcEvent,
  PiRpcForkMessage,
  PiRpcModel,
  PiRpcPromptImage,
  PiRpcState,
} from "../piRuntime.ts";
import { makePiAdapterLive } from "./PiAdapter.ts";
import { makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

class FakePiRpcSessionProcess {
  readonly sessionDir = "/tmp/t3-pi-test-session";

  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" = "medium";
  setThinkingLevelCalls: Array<"off" | "minimal" | "low" | "medium" | "high" | "xhigh"> = [];

  private readonly eventListeners = new Set<(event: PiRpcEvent) => void>();
  private readonly exitListeners = new Set<
    (input: { code: number | null; stderr: string }) => void
  >();

  async getAvailableModels(): Promise<ReadonlyArray<PiRpcModel>> {
    return [{ id: "claude-opus-4-6", provider: "anthropic", name: "Claude Opus 4.6" }];
  }

  async getState(): Promise<PiRpcState> {
    return {
      sessionId: "pi-session-test",
      model: { id: "claude-opus-4-6", provider: "anthropic", name: "Claude Opus 4.6" },
      thinkingLevel: this.thinkingLevel,
    };
  }

  async setModel(input: {
    readonly provider: string;
    readonly modelId: string;
  }): Promise<PiRpcModel> {
    return {
      id: input.modelId,
      provider: input.provider,
      name: input.modelId,
    };
  }

  async prompt(_input: {
    readonly message: string;
    readonly images?: ReadonlyArray<PiRpcPromptImage>;
  }): Promise<void> {}

  async setThinkingLevel(input: {
    readonly level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  }): Promise<void> {
    this.thinkingLevel = input.level;
    this.setThinkingLevelCalls.push(input.level);
  }

  async abort(): Promise<void> {}

  async getMessages(): Promise<ReadonlyArray<PiRpcAgentMessage>> {
    return [];
  }

  async getForkMessages(): Promise<ReadonlyArray<PiRpcForkMessage>> {
    return [];
  }

  async fork(): Promise<{ readonly cancelled: boolean; readonly text?: string }> {
    return { cancelled: false };
  }

  async respondToExtensionUi(): Promise<void> {}

  onEvent(listener: (event: PiRpcEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  onExit(listener: (input: { code: number | null; stderr: string }) => void): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  emit(event: PiRpcEvent): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  close(): void {
    for (const listener of this.exitListeners) {
      listener({ code: 0, stderr: "" });
    }
  }
}

const runtimeMock = vi.hoisted(() => {
  const processes: Array<FakePiRpcSessionProcess> = [];
  const startCalls: Array<Record<string, unknown>> = [];

  return {
    reset() {
      processes.length = 0;
      startCalls.length = 0;
    },
    createProcess(input: Record<string, unknown>) {
      startCalls.push(input);
      const process = new FakePiRpcSessionProcess();
      processes.push(process);
      return process;
    },
    latestProcess() {
      const process = processes.at(-1);
      if (!process) {
        throw new Error("Expected a fake Pi RPC process.");
      }
      return process;
    },
    latestStartCall() {
      const call = startCalls.at(-1);
      if (!call) {
        throw new Error("Expected a fake Pi RPC start call.");
      }
      return call;
    },
  };
});

vi.mock("../piRuntime.ts", async () => {
  const actual = await vi.importActual<typeof import("../piRuntime.ts")>("../piRuntime.ts");

  return {
    ...actual,
    PiRpcSessionProcess: {
      start: vi.fn(async (input: Record<string, unknown>) => runtimeMock.createProcess(input)),
    },
  };
});

const PiAdapterNativeEventLogTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-pi-native-log-"));
const PiAdapterNativeEventLogPath = path.join(
  PiAdapterNativeEventLogTempDir,
  "provider-native.ndjson",
);

function makePiAdapterTestLayer(config?: { readonly nativeEventLogPath?: string }) {
  const nativeEventLogger = config?.nativeEventLogPath
    ? Effect.runSync(
        makeEventNdjsonLogger(config.nativeEventLogPath, {
          stream: "native",
          batchWindowMs: 0,
        }),
      )
    : undefined;
  return makePiAdapterLive(nativeEventLogger ? { nativeEventLogger } : undefined).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(
      ServerSettingsService.layerTest({
        providers: {
          pi: {
            binaryPath: "fake-pi",
          },
        },
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
}

const PiAdapterTestLayer = makePiAdapterTestLayer({
  nativeEventLogPath: PiAdapterNativeEventLogPath,
});

function isTurnCompleted(
  event: ProviderRuntimeEvent,
): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> {
  return event.type === "turn.completed";
}

function isAssistantItemCompleted(
  event: ProviderRuntimeEvent,
): event is Extract<ProviderRuntimeEvent, { type: "item.completed" }> {
  return event.type === "item.completed" && event.payload.itemType === "assistant_message";
}

function isToolItemCompleted(
  event: ProviderRuntimeEvent,
): event is Extract<ProviderRuntimeEvent, { type: "item.completed" }> {
  return event.type === "item.completed" && event.payload.itemType !== "assistant_message";
}

it.layer(PiAdapterTestLayer)("PiAdapterLive", (it) => {
  it.effect("resumes Pi sessions from the persisted session file", () =>
    Effect.gen(function* () {
      runtimeMock.reset();

      const adapter = yield* PiAdapter;
      const threadId = asThreadId("thread-pi-resume");

      yield* adapter.startSession({
        provider: "pi",
        threadId,
        runtimeMode: "full-access",
        resumeCursor: {
          sessionDir: "/tmp/t3-pi-resume-dir",
          sessionFile: "/tmp/t3-pi-resume-dir/session.jsonl",
        },
      });

      assert.deepEqual(runtimeMock.latestStartCall(), {
        binaryPath: "fake-pi",
        cwd: process.cwd(),
        sessionDir: "/tmp/t3-pi-resume-dir",
        resumeSessionFile: "/tmp/t3-pi-resume-dir/session.jsonl",
      });
    }),
  );

  it.effect("logs raw Pi RPC events to the native provider NDJSON stream", () =>
    Effect.gen(function* () {
      runtimeMock.reset();
      const adapter = yield* PiAdapter;
      const threadId = asThreadId("thread-pi-native-log");
      const threadLogPath = path.join(PiAdapterNativeEventLogTempDir, "thread-pi-native-log.log");
      fs.rmSync(threadLogPath, { force: true });

      yield* adapter.startSession({
        provider: "pi",
        threadId,
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 2).pipe(Stream.runCollect);

      yield* adapter.sendTurn({
        threadId,
        input: "inspect and continue",
        attachments: [],
      });

      const process = runtimeMock.latestProcess();
      process.emit({
        type: "queue_update",
        steering: ["Thinking through the next step"],
        followUp: ["Open the target file"],
      });

      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));

      assert.equal(fs.existsSync(threadLogPath), true);
      const logLines = fs.readFileSync(threadLogPath, "utf8").trim().split("\n");
      assert.equal(logLines.length > 0, true);
      assert.equal(
        logLines.some((line) => line.includes('"method":"queue_update"')),
        true,
      );
      assert.equal(
        logLines.some((line) => line.includes('"steering":["Thinking through the next step"]')),
        true,
      );
    }),
  );

  it.effect("applies configured Pi thinking levels before sending turns", () =>
    Effect.gen(function* () {
      runtimeMock.reset();

      const adapter = yield* PiAdapter;
      const threadId = asThreadId("thread-pi-thinking");

      yield* adapter.startSession({
        provider: "pi",
        threadId,
        runtimeMode: "full-access",
        modelSelection: {
          provider: "pi",
          model: "claude-opus-4-6",
          options: {
            thinkingLevel: "high",
          },
        },
      });

      const process = runtimeMock.latestProcess();
      assert.deepEqual(process.setThinkingLevelCalls, ["high"]);

      yield* adapter.sendTurn({
        threadId,
        input: "keep going",
        attachments: [],
        modelSelection: {
          provider: "pi",
          model: "claude-opus-4-6",
          options: {
            thinkingLevel: "minimal",
          },
        },
      });

      assert.deepEqual(process.setThinkingLevelCalls, ["high", "minimal"]);
    }),
  );

  it.effect("finalizes Pi assistant preamble before the first tool starts", () =>
    Effect.gen(function* () {
      runtimeMock.reset();

      const adapter = yield* PiAdapter;
      const threadId = asThreadId("thread-pi-tool-loop-ordering");

      yield* adapter.startSession({
        provider: "pi",
        threadId,
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 2).pipe(Stream.runCollect);

      yield* adapter.sendTurn({
        threadId,
        input: "say something, then run a tool",
        attachments: [],
      });

      const process = runtimeMock.latestProcess();
      const eventFiber = yield* Stream.take(adapter.streamEvents, 4).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      process.emit({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "Preamble before tools.",
        },
      });
      process.emit({
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "bash",
        args: { command: "echo hi" },
      });

      const events = yield* Fiber.join(eventFiber);
      assert.deepEqual(
        events.map((event) => event.type),
        ["turn.started", "content.delta", "item.completed", "item.started"],
      );
      if (events[2]?.type === "item.completed") {
        assert.equal(events[2].payload.itemType, "assistant_message");
      }
      if (events[3]?.type === "item.started") {
        assert.equal(events[3].itemId, "tool-1");
      }
    }),
  );

  it.effect("does not duplicate a Pi assistant preamble after it was finalized before tools", () =>
    Effect.gen(function* () {
      runtimeMock.reset();

      const adapter = yield* PiAdapter;
      const threadId = asThreadId("thread-pi-tool-loop-no-preamble-dup");

      yield* adapter.startSession({
        provider: "pi",
        threadId,
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 2).pipe(Stream.runCollect);

      yield* adapter.sendTurn({
        threadId,
        input: "say something, then run tools, then continue",
        attachments: [],
      });

      const process = runtimeMock.latestProcess();
      const runtimeEventFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      process.emit({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "Preamble before tools.",
        },
      });
      process.emit({
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "bash",
        args: { command: "echo hi" },
      });
      process.emit({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Preamble before tools." }],
          stopReason: "toolUse",
        },
        toolResults: [],
      });
      process.emit({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "Final answer.",
        },
      });
      process.emit({
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Final answer." }],
            stopReason: "stop",
          },
        ],
      });

      const runtimeEvents = yield* Fiber.join(runtimeEventFiber);
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "turn.started",
          "content.delta",
          "item.completed",
          "item.started",
          "content.delta",
          "item.completed",
        ],
      );
      if (runtimeEvents[2]?.type === "item.completed") {
        assert.equal(runtimeEvents[2].payload.itemType, "assistant_message");
      }
      if (runtimeEvents[5]?.type === "item.completed") {
        assert.equal(runtimeEvents[5].payload.itemType, "assistant_message");
      }
    }),
  );

  it.effect("suppresses duplicate tool output on completion after a streamed tool update", () =>
    Effect.gen(function* () {
      runtimeMock.reset();

      const adapter = yield* PiAdapter;
      const threadId = asThreadId("thread-pi-tool-output-dedup");

      yield* adapter.startSession({ provider: "pi", threadId, runtimeMode: "full-access" });
      yield* Stream.take(adapter.streamEvents, 2).pipe(Stream.runCollect);
      yield* adapter.sendTurn({ threadId, input: "run a command", attachments: [] });

      const process = runtimeMock.latestProcess();
      const toolCompletedFiber = yield* Stream.filter(
        adapter.streamEvents,
        isToolItemCompleted,
      ).pipe(Stream.runHead, Effect.forkChild);

      process.emit({
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "bash",
        args: { command: "echo hi" },
      });
      process.emit({
        type: "tool_execution_update",
        toolCallId: "tool-1",
        toolName: "bash",
        args: { command: "echo hi" },
        partialResult: { content: [{ type: "text", text: "hi\n" }] },
      });
      process.emit({
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "hi\n" }] },
        isError: false,
      });

      const completed = yield* Fiber.join(toolCompletedFiber);
      assert.equal(completed._tag, "Some");
      if (completed._tag === "Some") {
        assert.equal(completed.value.payload.itemType, "command_execution");
        assert.equal("detail" in completed.value.payload, false);
      }
    }),
  );

  it.effect(
    "splits Pi assistant messages across tool-use sub-turns instead of batching them together",
    () =>
      Effect.gen(function* () {
        runtimeMock.reset();

        const adapter = yield* PiAdapter;
        const threadId = asThreadId("thread-pi-tool-loop-split");

        yield* adapter.startSession({
          provider: "pi",
          threadId,
          runtimeMode: "full-access",
        });
        yield* Stream.take(adapter.streamEvents, 2).pipe(Stream.runCollect);

        const sentTurn = yield* adapter.sendTurn({
          threadId,
          input: "run a multi-step tool loop",
          attachments: [],
        });

        const process = runtimeMock.latestProcess();

        const assistantItemFiber = yield* Stream.filter(
          adapter.streamEvents,
          isAssistantItemCompleted,
        ).pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);

        process.emit({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: "I’ll kick off the work now.",
          },
        });
        process.emit({
          type: "turn_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "I’ll kick off the work now." }],
            stopReason: "toolUse",
          },
          toolResults: [],
        });
        process.emit({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: "All done.",
          },
        });
        process.emit({
          type: "turn_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "All done." }],
            stopReason: "stop",
          },
          toolResults: [],
        });

        process.emit({
          type: "agent_end",
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "All done." }],
              stopReason: "stop",
            },
          ],
        });

        const assistantItems = yield* Fiber.join(assistantItemFiber);
        assert.deepEqual(
          assistantItems.map((event) => event.itemId),
          [`assistant:${sentTurn.turnId}:0:0`, `assistant:${sentTurn.turnId}:1:0`],
        );
      }),
  );

  it.effect("emits a Pi assistant sub-turn when tool-use text arrives only on turn_end", () =>
    Effect.gen(function* () {
      runtimeMock.reset();

      const adapter = yield* PiAdapter;
      const threadId = asThreadId("thread-pi-tool-loop-turn-end-text");

      yield* adapter.startSession({
        provider: "pi",
        threadId,
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 2).pipe(Stream.runCollect);

      const sentTurn = yield* adapter.sendTurn({
        threadId,
        input: "run a batch of tools and narrate the next step",
        attachments: [],
      });

      const process = runtimeMock.latestProcess();
      const assistantItemFiber = yield* Stream.filter(
        adapter.streamEvents,
        isAssistantItemCompleted,
      ).pipe(Stream.runHead, Effect.forkChild);

      process.emit({
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "read",
        args: { path: "/tmp/file.txt" },
      });
      process.emit({
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "read",
        result: { content: [{ type: "text", text: "body" }] },
        isError: false,
      });
      process.emit({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "I’m going to try a different approach next." }],
          stopReason: "toolUse",
        },
        toolResults: [],
      });

      const assistantItem = yield* Fiber.join(assistantItemFiber);
      assert.equal(assistantItem._tag, "Some");
      if (assistantItem._tag === "Some") {
        assert.equal(assistantItem.value.itemId, `assistant:${sentTurn.turnId}:0:0`);
        assert.equal(assistantItem.value.payload.itemType, "assistant_message");
        assert.equal(
          assistantItem.value.payload.detail,
          "I’m going to try a different approach next.",
        );
      }
    }),
  );

  it.effect("emits Pi assistant text from message snapshots when no text_delta arrives", () =>
    Effect.gen(function* () {
      runtimeMock.reset();

      const adapter = yield* PiAdapter;
      const threadId = asThreadId("thread-pi-message-update-snapshot-text");

      yield* adapter.startSession({
        provider: "pi",
        threadId,
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 2).pipe(Stream.runCollect);

      yield* adapter.sendTurn({
        threadId,
        input: "work step by step",
        attachments: [],
      });

      const process = runtimeMock.latestProcess();
      const eventFiber = yield* Stream.take(adapter.streamEvents, 4).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      process.emit({
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "I’m going to inspect the config first." }],
        },
        assistantMessageEvent: {
          type: "message_snapshot",
        },
      });
      process.emit({
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "read",
        args: { path: "/tmp/config.json" },
      });

      const events = yield* Fiber.join(eventFiber);
      assert.deepEqual(
        events.map((event) => event.type),
        ["turn.started", "content.delta", "item.completed", "item.started"],
      );
      if (events[1]?.type === "content.delta") {
        assert.equal(events[1].payload.delta, "I’m going to inspect the config first.");
      }
      if (events[2]?.type === "item.completed") {
        assert.equal(events[2].payload.itemType, "assistant_message");
      }
      if (events[3]?.type === "item.started") {
        assert.equal(events[3].itemId, "tool-1");
      }
    }),
  );

  it.effect("emits Pi reasoning text when it only arrives on thinking_end", () =>
    Effect.gen(function* () {
      runtimeMock.reset();

      const adapter = yield* PiAdapter;
      const threadId = asThreadId("thread-pi-thinking-end-only");

      yield* adapter.startSession({
        provider: "pi",
        threadId,
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 2).pipe(Stream.runCollect);

      yield* adapter.sendTurn({
        threadId,
        input: "think before using a tool",
        attachments: [],
      });

      const process = runtimeMock.latestProcess();
      const eventFiber = yield* Stream.take(adapter.streamEvents, 2).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      process.emit({
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "I should inspect the config before acting." }],
        },
        assistantMessageEvent: {
          type: "thinking_end",
          contentIndex: 0,
          content: "I should inspect the config before acting.",
        },
      });

      const events = yield* Fiber.join(eventFiber);
      assert.deepEqual(
        events.map((event) => event.type),
        ["turn.started", "content.delta"],
      );
      if (events[1]?.type === "content.delta") {
        assert.equal(events[1].payload.streamKind, "reasoning_text");
        assert.equal(events[1].payload.delta, "I should inspect the config before acting.");
        assert.equal(events[1].payload.contentIndex, 0);
      }
    }),
  );

  it.effect(
    "does not duplicate assistant text when a later text_delta repeats a prior snapshot",
    () =>
      Effect.gen(function* () {
        runtimeMock.reset();

        const adapter = yield* PiAdapter;
        const threadId = asThreadId("thread-pi-message-update-snapshot-delta-dedup");

        yield* adapter.startSession({
          provider: "pi",
          threadId,
          runtimeMode: "full-access",
        });
        yield* Stream.take(adapter.streamEvents, 2).pipe(Stream.runCollect);

        yield* adapter.sendTurn({
          threadId,
          input: "work step by step",
          attachments: [],
        });

        const process = runtimeMock.latestProcess();
        const eventFiber = yield* Stream.take(adapter.streamEvents, 4).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        process.emit({
          type: "message_update",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "That was the first tool." }],
          },
          assistantMessageEvent: {
            type: "message_snapshot",
          },
        });
        process.emit({
          type: "message_update",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "That was the first tool." }],
          },
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: "That was the first tool.",
          },
        });
        process.emit({
          type: "tool_execution_start",
          toolCallId: "tool-1",
          toolName: "read",
          args: { path: "/tmp/config.json" },
        });

        const events = yield* Fiber.join(eventFiber);
        assert.deepEqual(
          events.map((event) => event.type),
          ["turn.started", "content.delta", "item.completed", "item.started"],
        );
        if (events[1]?.type === "content.delta") {
          assert.equal(events[1].payload.delta, "That was the first tool.");
        }
      }),
  );

  it.effect("does not complete a Pi turn on tool-use turn_end and waits for agent_end", () =>
    Effect.gen(function* () {
      runtimeMock.reset();

      const adapter = yield* PiAdapter;
      const threadId = asThreadId("thread-pi-tool-loop");

      yield* adapter.startSession({
        provider: "pi",
        threadId,
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 2).pipe(Stream.runCollect);

      yield* adapter.sendTurn({
        threadId,
        input: "please modify one file and then another file in separate tool use loops",
        attachments: [],
      });

      const process = runtimeMock.latestProcess();

      const preAgentEndFiber = yield* Stream.take(adapter.streamEvents, 3).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      process.emit({
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "read",
        args: { path: "/Users/johnzolton/.pi/agent/skills/rfi-eval-runner/SKILL.md" },
      });
      process.emit({
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "read",
        result: { content: [{ type: "text", text: "skill body" }] },
        isError: false,
      });
      process.emit({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "toolUse",
        },
        toolResults: [],
      });

      const preAgentEndEvents = yield* Fiber.join(preAgentEndFiber);
      assert.deepEqual(
        preAgentEndEvents.map((event) => event.type),
        ["turn.started", "item.started", "item.completed"],
      );
      assert.equal(preAgentEndEvents.some(isTurnCompleted), false);

      process.emit({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Got it, proceeding." }],
          stopReason: "stop",
        },
        toolResults: [],
      });

      const completedFiber = yield* Stream.filter(adapter.streamEvents, isTurnCompleted).pipe(
        Stream.runHead,
        Effect.forkChild,
      );

      process.emit({
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Got it, proceeding." }],
            stopReason: "stop",
          },
        ],
      });

      const completed = yield* Fiber.join(completedFiber);
      assert.equal(completed._tag, "Some");
      if (completed._tag === "Some") {
        assert.equal(completed.value.payload.state, "completed");
        assert.equal(completed.value.payload.stopReason, "stop");
      }
    }),
  );

  it.effect("completes a Pi turn from final turn_end even when agent_end never arrives", () =>
    Effect.gen(function* () {
      runtimeMock.reset();

      const adapter = yield* PiAdapter;
      const threadId = asThreadId("thread-pi-final-turn-end-without-agent-end");

      yield* adapter.startSession({
        provider: "pi",
        threadId,
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 2).pipe(Stream.runCollect);

      yield* adapter.sendTurn({
        threadId,
        input: "answer and stop",
        attachments: [],
      });

      const process = runtimeMock.latestProcess();
      const completedFiber = yield* Stream.filter(adapter.streamEvents, isTurnCompleted).pipe(
        Stream.runHead,
        Effect.forkChild,
      );

      process.emit({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "Finished.",
        },
      });
      process.emit({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Finished." }],
          stopReason: "stop",
        },
        toolResults: [],
      });

      const completed = yield* Fiber.join(completedFiber);
      assert.equal(completed._tag, "Some");
      if (completed._tag === "Some") {
        assert.equal(completed.value.payload.state, "completed");
        assert.equal(completed.value.payload.stopReason, "stop");
      }
    }),
  );
});
