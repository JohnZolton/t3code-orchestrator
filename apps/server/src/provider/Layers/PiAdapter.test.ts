import assert from "node:assert/strict";

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

const PiAdapterTestLayer = makePiAdapterLive().pipe(
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

function isTurnCompleted(
  event: ProviderRuntimeEvent,
): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> {
  return event.type === "turn.completed";
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
});
