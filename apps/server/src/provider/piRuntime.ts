import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

import type { ModelCapabilities, PiThinkingLevel, ServerProviderModel } from "@t3tools/contracts";

const DEFAULT_PI_RPC_TIMEOUT_MS = 5_000;
const PI_RPC_MODE_ARGS = ["--mode", "rpc"] as const;
const PI_RPC_PROBE_ARGS = ["--mode", "rpc", "--no-session"] as const;
const PI_GET_AVAILABLE_MODELS_ID = "pi-probe-models";
const PI_DOTENV_FILENAMES = [".env", ".env.local"] as const;

let piLoginShellEnvPromise: Promise<NodeJS.ProcessEnv> | null = null;

export interface PiRpcModel {
  readonly id?: string;
  readonly name?: string;
  readonly provider?: string;
  readonly reasoning?: boolean;
  readonly input?: ReadonlyArray<string>;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
}

export interface PiRpcState {
  readonly model?: PiRpcModel | null;
  readonly thinkingLevel?: string;
  readonly isStreaming?: boolean;
  readonly sessionFile?: string;
  readonly sessionId?: string;
  readonly sessionName?: string;
}

export interface PiRpcPromptImage {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export interface PiRpcForkMessage {
  readonly entryId?: string;
  readonly text?: string;
}

export interface PiRpcAgentMessage {
  readonly role?: string;
  readonly content?: unknown;
  readonly stopReason?: string;
  readonly usage?: unknown;
  readonly timestamp?: number;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly isError?: boolean;
}

interface PiRpcResponseSuccess<TData = unknown> {
  readonly type: "response";
  readonly id?: string;
  readonly command?: string;
  readonly success: true;
  readonly data?: TData;
}

interface PiRpcResponseFailure {
  readonly type: "response";
  readonly id?: string;
  readonly command?: string;
  readonly success: false;
  readonly error?: string;
}

type PiRpcResponse<TData = unknown> = PiRpcResponseSuccess<TData> | PiRpcResponseFailure;

export interface PiRpcExtensionUiRequest {
  readonly type: "extension_ui_request";
  readonly id: string;
  readonly method: string;
  readonly title?: string;
  readonly message?: string;
  readonly placeholder?: string;
  readonly prefill?: string;
  readonly options?: ReadonlyArray<string>;
  readonly timeout?: number;
  readonly notifyType?: "info" | "warning" | "error";
  readonly statusKey?: string;
  readonly statusText?: string;
  readonly widgetKey?: string;
  readonly widgetLines?: ReadonlyArray<string>;
  readonly widgetPlacement?: string;
  readonly text?: string;
}

export interface PiRpcAgentStartEvent {
  readonly type: "agent_start";
}

export interface PiRpcAgentEndEvent {
  readonly type: "agent_end";
  readonly messages?: ReadonlyArray<PiRpcAgentMessage>;
}

export interface PiRpcTurnStartEvent {
  readonly type: "turn_start";
}

export interface PiRpcTurnEndEvent {
  readonly type: "turn_end";
  readonly message?: PiRpcAgentMessage;
  readonly toolResults?: ReadonlyArray<PiRpcAgentMessage>;
}

export interface PiRpcMessageUpdateEvent {
  readonly type: "message_update";
  readonly message?: PiRpcAgentMessage;
  readonly assistantMessageEvent?: {
    readonly type?: string;
    readonly contentIndex?: number;
    readonly summaryIndex?: number;
    readonly delta?: string;
    readonly reason?: string;
    readonly content?: string;
    readonly partial?: unknown;
    readonly toolCall?: {
      readonly id?: string;
      readonly name?: string;
      readonly arguments?: unknown;
    };
  };
}

export interface PiRpcToolExecutionStartEvent {
  readonly type: "tool_execution_start";
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly args?: unknown;
}

export interface PiRpcToolExecutionUpdateEvent {
  readonly type: "tool_execution_update";
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly args?: unknown;
  readonly partialResult?: unknown;
}

export interface PiRpcToolExecutionEndEvent {
  readonly type: "tool_execution_end";
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly result?: unknown;
  readonly isError?: boolean;
}

export interface PiRpcQueueUpdateEvent {
  readonly type: "queue_update";
  readonly steering?: ReadonlyArray<string>;
  readonly followUp?: ReadonlyArray<string>;
}

export interface PiRpcCompactionEvent {
  readonly type: "compaction_start" | "compaction_end";
  readonly reason?: string;
  readonly result?: unknown;
  readonly aborted?: boolean;
  readonly willRetry?: boolean;
  readonly errorMessage?: string;
}

export interface PiRpcAutoRetryEvent {
  readonly type: "auto_retry_start" | "auto_retry_end";
  readonly attempt?: number;
  readonly maxAttempts?: number;
  readonly delayMs?: number;
  readonly errorMessage?: string;
  readonly success?: boolean;
  readonly finalError?: string;
}

export interface PiRpcExtensionErrorEvent {
  readonly type: "extension_error";
  readonly extensionPath?: string;
  readonly event?: string;
  readonly error?: string;
}

export type PiRpcEvent =
  | PiRpcAgentStartEvent
  | PiRpcAgentEndEvent
  | PiRpcTurnStartEvent
  | PiRpcTurnEndEvent
  | PiRpcMessageUpdateEvent
  | PiRpcToolExecutionStartEvent
  | PiRpcToolExecutionUpdateEvent
  | PiRpcToolExecutionEndEvent
  | PiRpcQueueUpdateEvent
  | PiRpcCompactionEvent
  | PiRpcAutoRetryEvent
  | PiRpcExtensionErrorEvent
  | PiRpcExtensionUiRequest;

export const EMPTY_PI_MODEL_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

export const PI_REASONING_MODEL_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [
    { value: "off", label: "Off" },
    { value: "minimal", label: "Minimal" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium", isDefault: true },
    { value: "high", label: "High" },
  ],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isPiRpcResponse<TData = unknown>(value: unknown): value is PiRpcResponse<TData> {
  return isRecord(value) && value.type === "response";
}

function isPiRpcEvent(value: unknown): value is PiRpcEvent {
  return isRecord(value) && typeof value.type === "string" && value.type !== "response";
}

function trimNonEmpty(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizePiPlaceholder(value: unknown): string | null {
  const normalized = trimNonEmpty(value);
  if (!normalized) {
    return null;
  }
  return normalized.toLowerCase() === "unknown" ? null : normalized;
}

function normalizePiProvider(value: unknown): string | null {
  return normalizePiPlaceholder(value);
}

function normalizePiModelId(value: unknown): string | null {
  return normalizePiPlaceholder(value);
}

function normalizePiModelName(value: unknown): string | null {
  return normalizePiPlaceholder(value);
}

function toPiProviderModels(value: unknown): ReadonlyArray<ServerProviderModel> {
  if (!Array.isArray(value)) {
    return [];
  }

  const models: Array<ServerProviderModel> = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const slug = normalizePiModelId(entry.id);
    if (!slug || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    const name = normalizePiModelName(entry.name) ?? slug;
    models.push({
      slug,
      name,
      isCustom: false,
      capabilities: entry.reasoning ? PI_REASONING_MODEL_CAPABILITIES : EMPTY_PI_MODEL_CAPABILITIES,
    });
  }

  return models;
}

function buildProcessErrorMessage(input: {
  readonly label: string;
  readonly code: number | null;
  readonly stderr: string;
}): Error {
  return new Error(
    [
      `${input.label} exited before responding (code: ${input.code ?? "unknown"}).`,
      input.stderr.trim().length > 0 ? `stderr:\n${input.stderr.trim()}` : null,
    ]
      .filter(Boolean)
      .join("\n\n"),
  );
}

async function loadPiLoginShellEnv(): Promise<NodeJS.ProcessEnv> {
  if (process.platform === "win32") {
    return process.env;
  }

  const shellPath = trimNonEmpty(process.env.SHELL) ?? "/bin/zsh";
  return await new Promise<NodeJS.ProcessEnv>((resolve) => {
    const child = spawn(shellPath, ["-lc", "env -0"], {
      stdio: ["ignore", "pipe", "ignore"],
      env: process.env,
    });

    const chunks: Array<Buffer> = [];
    child.stdout?.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    const fallback = () => resolve(process.env);
    child.once("error", fallback);
    child.once("exit", (code) => {
      if (code !== 0) {
        fallback();
        return;
      }

      const mergedEnv: NodeJS.ProcessEnv = { ...process.env };
      const output = Buffer.concat(chunks).toString("utf8");
      for (const entry of output.split("\0")) {
        const separator = entry.indexOf("=");
        if (separator <= 0) {
          continue;
        }
        const key = entry.slice(0, separator);
        const value = entry.slice(separator + 1);
        if (key.length > 0) {
          mergedEnv[key] = value;
        }
      }

      resolve(mergedEnv);
    });
  });
}

function decodePiDotEnvValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    const quote = trimmed[0];
    const inner = trimmed.slice(1, -1);
    if (quote === "'") {
      return inner;
    }
    return inner
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\\\/g, "\\")
      .replace(/\\"/g, '"');
  }

  const commentIndex = trimmed.search(/\s#/);
  return (commentIndex >= 0 ? trimmed.slice(0, commentIndex) : trimmed).trim();
}

export function parsePiDotEnv(content: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const rawLine of content.split(/\r?\n/u)) {
    const trimmedLine = rawLine.trim();
    if (trimmedLine.length === 0 || trimmedLine.startsWith("#")) {
      continue;
    }

    const line = trimmedLine.startsWith("export ") ? trimmedLine.slice(7).trim() : trimmedLine;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      continue;
    }

    env[key] = decodePiDotEnvValue(line.slice(separatorIndex + 1));
  }

  return env;
}

function collectPiDotEnvDirectories(root: string): string[] {
  const directories: string[] = [];
  let current = resolve(root);

  while (true) {
    directories.push(current);
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return directories.toReversed();
}

async function loadPiDotEnv(roots: ReadonlyArray<string>): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {};
  const seenDirectories = new Set<string>();

  for (const root of roots) {
    for (const directory of collectPiDotEnvDirectories(root)) {
      if (seenDirectories.has(directory)) {
        continue;
      }
      seenDirectories.add(directory);
      for (const filename of PI_DOTENV_FILENAMES) {
        try {
          const content = await readFile(join(directory, filename), "utf8");
          Object.assign(env, parsePiDotEnv(content));
        } catch {
          // Ignore missing or unreadable dotenv files.
        }
      }
    }
  }

  return env;
}

async function getPiSpawnEnv(input: {
  readonly cwd: string;
  readonly binaryPath: string;
}): Promise<NodeJS.ProcessEnv> {
  if (!piLoginShellEnvPromise) {
    piLoginShellEnvPromise = loadPiLoginShellEnv();
  }

  const [shellEnv, dotEnv] = await Promise.all([
    piLoginShellEnvPromise,
    loadPiDotEnv([input.cwd, dirname(resolve(input.binaryPath))]),
  ]);
  return {
    ...shellEnv,
    ...dotEnv,
  };
}

function attachJsonlReader(input: {
  readonly stream: NodeJS.ReadableStream;
  readonly onLine: (line: string) => void;
}): () => void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  const onData = (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      input.onLine(line);
    }
  };

  const onEnd = () => {
    buffer += decoder.end();
    if (buffer.length === 0) {
      return;
    }
    const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
    buffer = "";
    input.onLine(line);
  };

  input.stream.on("data", onData);
  input.stream.on("end", onEnd);

  return () => {
    input.stream.off("data", onData);
    input.stream.off("end", onEnd);
  };
}

interface PendingPiRpcRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
}

export class PiRpcSessionProcess {
  readonly child: ChildProcess;
  readonly sessionDir: string;

  private readonly pending = new Map<string, PendingPiRpcRequest>();
  private readonly eventListeners = new Set<(event: PiRpcEvent) => void>();
  private readonly exitListeners = new Set<
    (input: { code: number | null; stderr: string }) => void
  >();
  private readonly detachStdoutReader: () => void;
  private stderr = "";
  private closed = false;

  private constructor(input: { readonly child: ChildProcess; readonly sessionDir: string }) {
    this.child = input.child;
    this.sessionDir = input.sessionDir;
    this.child.stdout?.setEncoding("utf8");
    this.child.stderr?.setEncoding("utf8");
    this.detachStdoutReader = attachJsonlReader({
      stream: this.child.stdout as NodeJS.ReadableStream,
      onLine: (line) => this.handleStdoutLine(line),
    });
    this.child.stderr?.on("data", this.onStderr);
    this.child.once("exit", this.handleProcessExit);
    this.child.once("error", this.onError);
  }

  static async start(input: {
    readonly binaryPath: string;
    readonly cwd: string;
    readonly sessionDir: string;
    readonly resumeSessionFile?: string;
    readonly continueSession?: boolean;
    readonly timeoutMs?: number;
  }): Promise<PiRpcSessionProcess> {
    await mkdir(input.sessionDir, { recursive: true });
    const child = spawn(
      input.binaryPath,
      [
        ...PI_RPC_MODE_ARGS,
        ...(input.resumeSessionFile ? ["--session", input.resumeSessionFile] : []),
        ...(!input.resumeSessionFile && input.continueSession ? ["--continue"] : []),
        "--session-dir",
        input.sessionDir,
      ],
      {
        cwd: input.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
        env: await getPiSpawnEnv({ cwd: input.cwd, binaryPath: input.binaryPath }),
      },
    );

    const processHandle = new PiRpcSessionProcess({
      child,
      sessionDir: input.sessionDir,
    });

    await processHandle.request({ type: "get_state" }, input.timeoutMs);
    return processHandle;
  }

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

  async request<TData = unknown>(
    command: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<TData> {
    if (this.closed) {
      throw new Error("Pi RPC process is closed.");
    }

    const id = trimNonEmpty(command.id) ?? crypto.randomUUID();
    const payload = { ...command, id };
    const resolvedTimeoutMs = timeoutMs ?? DEFAULT_PI_RPC_TIMEOUT_MS;

    return await new Promise<TData>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Pi RPC response after ${resolvedTimeoutMs}ms.`));
      }, resolvedTimeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as TData),
        reject,
        timeout,
      });

      this.child.stdin?.write(`${JSON.stringify(payload)}\n`, "utf8", (error) => {
        if (!error) {
          return;
        }
        const pending = this.pending.get(id);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async getState(timeoutMs?: number): Promise<PiRpcState> {
    const data = await this.request<Record<string, unknown>>({ type: "get_state" }, timeoutMs);
    return isRecord(data) ? (data as PiRpcState) : {};
  }

  async getAvailableModels(timeoutMs?: number): Promise<ReadonlyArray<PiRpcModel>> {
    const data = await this.request<Record<string, unknown>>(
      { type: "get_available_models" },
      timeoutMs,
    );
    return Array.isArray(data.models) ? (data.models as ReadonlyArray<PiRpcModel>) : [];
  }

  async setModel(input: {
    readonly provider: string;
    readonly modelId: string;
    readonly timeoutMs?: number;
  }): Promise<PiRpcModel | null> {
    const data = await this.request<unknown>(
      {
        type: "set_model",
        provider: input.provider,
        modelId: input.modelId,
      },
      input.timeoutMs,
    );
    return isRecord(data) ? (data as PiRpcModel) : null;
  }

  async prompt(input: {
    readonly message: string;
    readonly images?: ReadonlyArray<PiRpcPromptImage>;
    readonly timeoutMs?: number;
  }): Promise<void> {
    await this.request(
      {
        type: "prompt",
        message: input.message,
        ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
      },
      input.timeoutMs,
    );
  }

  async setThinkingLevel(input: {
    readonly level: PiThinkingLevel;
    readonly timeoutMs?: number;
  }): Promise<void> {
    await this.request(
      {
        type: "set_thinking_level",
        level: input.level,
      },
      input.timeoutMs,
    );
  }

  async abort(timeoutMs?: number): Promise<void> {
    await this.request({ type: "abort" }, timeoutMs);
  }

  async getMessages(timeoutMs?: number): Promise<ReadonlyArray<PiRpcAgentMessage>> {
    const data = await this.request<Record<string, unknown>>({ type: "get_messages" }, timeoutMs);
    return Array.isArray(data.messages) ? (data.messages as ReadonlyArray<PiRpcAgentMessage>) : [];
  }

  async getForkMessages(timeoutMs?: number): Promise<ReadonlyArray<PiRpcForkMessage>> {
    const data = await this.request<Record<string, unknown>>(
      { type: "get_fork_messages" },
      timeoutMs,
    );
    return Array.isArray(data.messages) ? (data.messages as ReadonlyArray<PiRpcForkMessage>) : [];
  }

  async fork(
    entryId: string,
    timeoutMs?: number,
  ): Promise<{ readonly text?: string; readonly cancelled: boolean }> {
    const data = await this.request<Record<string, unknown>>({ type: "fork", entryId }, timeoutMs);
    const text = trimNonEmpty(data.text);
    return {
      ...(text ? { text } : {}),
      cancelled: data.cancelled === true,
    };
  }

  async respondToExtensionUi(input: {
    readonly id: string;
    readonly value?: string;
    readonly confirmed?: boolean;
    readonly cancelled?: boolean;
    readonly timeoutMs?: number;
  }): Promise<void> {
    await this.request(
      {
        type: "extension_ui_response",
        id: input.id,
        ...(input.value !== undefined ? { value: input.value } : {}),
        ...(input.confirmed !== undefined ? { confirmed: input.confirmed } : {}),
        ...(input.cancelled ? { cancelled: true } : {}),
      },
      input.timeoutMs,
    );
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.detachStdoutReader();
    this.child.stderr?.off("data", this.onStderr);
    this.child.off("exit", this.handleProcessExit);
    this.child.off("error", this.onError);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Pi RPC process closed."));
    }
    this.pending.clear();
    if (!this.child.killed) {
      this.child.kill();
    }
  }

  private readonly onStderr = (chunk: string) => {
    this.stderr += chunk;
  };

  private readonly handleProcessExit = (code: number | null) => {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.detachStdoutReader();
    this.child.stderr?.off("data", this.onStderr);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(
        buildProcessErrorMessage({ label: "Pi RPC process", code, stderr: this.stderr }),
      );
    }
    this.pending.clear();
    for (const listener of this.exitListeners) {
      listener({ code, stderr: this.stderr });
    }
  };

  private readonly onError = (error: Error) => {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.detachStdoutReader();
    this.child.stderr?.off("data", this.onStderr);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  };

  private handleStdoutLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }

    if (isPiRpcResponse(parsed)) {
      const id = trimNonEmpty(parsed.id);
      if (!id) {
        return;
      }
      const pending = this.pending.get(id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      this.pending.delete(id);
      if (!parsed.success) {
        pending.reject(new Error(parsed.error ?? `Pi RPC command failed: ${parsed.command ?? id}`));
        return;
      }
      pending.resolve(parsed.data);
      return;
    }

    if (!isPiRpcEvent(parsed)) {
      return;
    }

    for (const listener of this.eventListeners) {
      listener(parsed);
    }
  }
}

export function piThreadSessionDir(input: {
  readonly stateDir: string;
  readonly threadId: string;
}): string {
  const safeThreadId = input.threadId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 120);
  const threadSegment = safeThreadId.length > 0 ? safeThreadId : "thread";
  return join(input.stateDir, "provider-sessions", "pi", threadSegment);
}

export function resolvePiModelTarget(input: {
  readonly requestedModel: string;
  readonly availableModels: ReadonlyArray<PiRpcModel>;
  readonly fallbackProvider?: string | null | undefined;
}): { readonly provider: string; readonly modelId: string } | null {
  const requested = input.requestedModel.trim();
  if (requested.length === 0) {
    return null;
  }

  const slashIndex = requested.indexOf("/");
  if (slashIndex > 0 && slashIndex < requested.length - 1) {
    return {
      provider: requested.slice(0, slashIndex),
      modelId: requested.slice(slashIndex + 1),
    };
  }

  const exactMatch = input.availableModels.find((model) => trimNonEmpty(model.id) === requested);
  const provider = normalizePiProvider(exactMatch?.provider);
  if (provider) {
    return {
      provider,
      modelId: requested,
    };
  }

  const uniqueProviders = [
    ...new Set(
      input.availableModels
        .map((model) => normalizePiProvider(model.provider))
        .filter((value): value is string => value !== null),
    ),
  ];
  if (uniqueProviders.length === 1) {
    return {
      provider: uniqueProviders[0]!,
      modelId: requested,
    };
  }

  const fallbackProvider = normalizePiProvider(input.fallbackProvider);
  if (fallbackProvider) {
    return {
      provider: fallbackProvider,
      modelId: requested,
    };
  }

  return null;
}

export function piModelFromState(state: PiRpcState | null | undefined): string | undefined {
  const model = state?.model;
  return trimNonEmpty(model?.id) ?? undefined;
}

export async function probePiRpcModels(input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly timeoutMs?: number;
}): Promise<ReadonlyArray<PiRpcModel>> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_PI_RPC_TIMEOUT_MS;
  const spawnEnv = await getPiSpawnEnv({ cwd: input.cwd, binaryPath: input.binaryPath });

  return await new Promise<ReadonlyArray<PiRpcModel>>((resolve, reject) => {
    const child = spawn(input.binaryPath, [...PI_RPC_PROBE_ARGS], {
      cwd: input.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      env: spawnEnv,
    });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    let settled = false;
    let stderr = "";

    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      detachStdoutReader();
      child.stderr?.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
      clearTimeout(timeout);
      callback();
    };

    const killChild = () => {
      if (!child.killed) {
        child.kill();
      }
    };

    const onStdoutLine = (line: string) => {
      if (!line.trim()) {
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }

      if (!isPiRpcResponse<{ readonly models?: ReadonlyArray<PiRpcModel> }>(parsed)) {
        return;
      }
      if (parsed.id !== PI_GET_AVAILABLE_MODELS_ID) {
        return;
      }
      if (!parsed.success) {
        settle(() => {
          killChild();
          reject(new Error(parsed.error ?? "Pi RPC get_available_models failed."));
        });
        return;
      }
      const models = Array.isArray(parsed.data?.models)
        ? (parsed.data.models as ReadonlyArray<PiRpcModel>)
        : [];
      settle(() => {
        killChild();
        resolve(models);
      });
    };

    const detachStdoutReader = attachJsonlReader({
      stream: child.stdout as NodeJS.ReadableStream,
      onLine: onStdoutLine,
    });

    const onStderr = (chunk: string) => {
      stderr += chunk;
    };

    const onError = (error: Error) => {
      settle(() => reject(error));
    };

    const onExit = (code: number | null) => {
      settle(() => reject(buildProcessErrorMessage({ label: "Pi RPC probe", code, stderr })));
    };

    const timeout = setTimeout(() => {
      settle(() => {
        killChild();
        reject(new Error(`Timed out waiting for Pi RPC response after ${timeoutMs}ms.`));
      });
    }, timeoutMs);

    child.stderr?.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
    child.stdin?.write(
      `${JSON.stringify({ id: PI_GET_AVAILABLE_MODELS_ID, type: "get_available_models" })}\n`,
      "utf8",
    );
  });
}

export async function probePiCurrentModel(input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly timeoutMs?: number;
}): Promise<PiRpcModel | null> {
  const sessionDir = await mkdtemp(join(tmpdir(), "t3-pi-probe-"));
  try {
    const process = await PiRpcSessionProcess.start({
      binaryPath: input.binaryPath,
      cwd: input.cwd,
      sessionDir,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    });
    try {
      const state = await process.getState(input.timeoutMs);
      return state.model ?? null;
    } finally {
      process.close();
    }
  } finally {
    await rm(sessionDir, { recursive: true, force: true });
  }
}

export async function probePiModels(input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly timeoutMs?: number;
}): Promise<ReadonlyArray<ServerProviderModel>> {
  const models = await probePiRpcModels(input);
  const resolvedModels = toPiProviderModels(models);
  if (resolvedModels.length > 0) {
    return resolvedModels;
  }

  const currentModel = await probePiCurrentModel(input);
  return currentModel ? toPiProviderModels([currentModel]) : [];
}
