import type { IncomingMessage, ServerResponse } from "node:http";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import * as z from "zod/v4";

const ORCHESTRATOR_THREAD_TITLE = "Orchestrator";

type OrchestratorMcpServerDeps = {
  readonly getReadModel: () => Promise<OrchestrationReadModel>;
  readonly dispatch: (command: OrchestrationCommand) => Promise<unknown>;
};

const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

const serverMessageId = (tag: string): MessageId =>
  MessageId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

const serverEventId = (tag: string): EventId =>
  EventId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

function isLoopbackAddress(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "::ffff:127.0.0.1" ||
    normalized === "localhost"
  );
}

function sendJsonError(res: ServerResponse, statusCode: number, message: string): void {
  if (res.headersSent) {
    return;
  }

  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32603,
        message,
      },
      id: null,
    }),
  );
}

function summarizeProjects(readModel: OrchestrationReadModel) {
  return readModel.projects
    .filter((project) => project.deletedAt === null)
    .map((project) => {
      const threadCount = readModel.threads.filter(
        (thread) =>
          thread.projectId === project.id &&
          thread.deletedAt === null &&
          thread.title !== ORCHESTRATOR_THREAD_TITLE,
      ).length;

      return {
        id: project.id,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
        defaultModel: project.defaultModel ?? "gpt-5-codex",
        threadCount,
      };
    });
}

function summarizeThreads(readModel: OrchestrationReadModel, projectId?: string) {
  return readModel.threads
    .filter((thread) => thread.deletedAt === null)
    .filter((thread) => thread.title !== ORCHESTRATOR_THREAD_TITLE)
    .filter((thread) => (projectId ? thread.projectId === projectId : true))
    .map((thread) => ({
      id: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      model: thread.model,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      latestTurn:
        thread.latestTurn === null
          ? null
          : {
              turnId: thread.latestTurn.turnId,
              state: thread.latestTurn.state,
              requestedAt: thread.latestTurn.requestedAt,
              startedAt: thread.latestTurn.startedAt,
              completedAt: thread.latestTurn.completedAt,
            },
      session:
        thread.session === null
          ? null
          : {
              status: thread.session.status,
              providerName: thread.session.providerName,
              runtimeMode: thread.session.runtimeMode,
              updatedAt: thread.session.updatedAt,
              lastError: thread.session.lastError,
            },
      updatedAt: thread.updatedAt,
      createdAt: thread.createdAt,
    }));
}

async function appendOrchestratorDispatchActivity(input: {
  readonly dispatch: (command: OrchestrationCommand) => Promise<unknown>;
  readonly threadId: ThreadId;
  readonly prompt: string;
  readonly detail: string;
  readonly createdAt: string;
}): Promise<void> {
  await input.dispatch({
    type: "thread.activity.append",
    commandId: serverCommandId("mcp-orchestrator-dispatch-activity"),
    threadId: input.threadId,
    activity: {
      id: serverEventId("mcp-orchestrator-dispatch-activity"),
      tone: "info",
      kind: "orchestrator.dispatch",
      summary: "Delegated by orchestrator",
      payload: {
        prompt: input.prompt,
        detail: input.detail,
      },
      turnId: null,
      createdAt: input.createdAt,
    },
    createdAt: input.createdAt,
  });
}

function makeOrchestratorMcpServer(deps: OrchestratorMcpServerDeps): McpServer {
  const server = new McpServer({
    name: "t3code-orchestrator",
    version: "0.1.0",
  });

  server.registerTool(
    "list_projects",
    {
      description: "List the existing projects the user already created.",
    },
    async () => {
      const readModel = await deps.getReadModel();
      const projects = summarizeProjects(readModel);

      return {
        content: [
          {
            type: "text",
            text:
              projects.length === 0
                ? "No projects are available."
                : `Found ${projects.length} project${projects.length === 1 ? "" : "s"}.`,
          },
        ],
        structuredContent: { projects },
      };
    },
  );

  server.registerTool(
    "list_threads",
    {
      description: "List existing worker threads across the workspace or for one project.",
      inputSchema: {
        projectId: z.string().trim().min(1).optional(),
      },
    },
    async ({ projectId }) => {
      const readModel = await deps.getReadModel();
      const threads = summarizeThreads(readModel, projectId);

      return {
        content: [
          {
            type: "text",
            text:
              threads.length === 0
                ? "No worker threads matched that query."
                : `Found ${threads.length} worker thread${threads.length === 1 ? "" : "s"}.`,
          },
        ],
        structuredContent: { threads },
      };
    },
  );

  server.registerTool(
    "create_thread",
    {
      description: "Spin up a new worker thread on an existing project, optionally with an opening prompt.",
      inputSchema: {
        projectId: z.string().trim().min(1),
        title: z.string().trim().min(1),
        prompt: z.string().trim().min(1).optional(),
        model: z.string().trim().min(1).optional(),
        runtimeMode: z.enum(["approval-required", "full-access"]).optional(),
      },
    },
    async ({ projectId, title, prompt, model, runtimeMode }) => {
      const readModel = await deps.getReadModel();
      const project = readModel.projects.find(
        (entry) => entry.id === projectId && entry.deletedAt === null,
      );
      if (!project) {
        throw new Error(`Project '${projectId}' was not found.`);
      }

      const threadId = ThreadId.makeUnsafe(crypto.randomUUID());
      const createdAt = new Date().toISOString();

      await deps.dispatch({
        type: "thread.create",
        commandId: serverCommandId("mcp-create-thread"),
        threadId,
        projectId: project.id,
        title,
        model: model ?? project.defaultModel ?? "gpt-5-codex",
        runtimeMode: runtimeMode ?? "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        createdAt,
      });

      if (prompt) {
        await deps.dispatch({
          type: "thread.turn.start",
          commandId: serverCommandId("mcp-create-thread-initial-turn"),
          threadId,
          message: {
            messageId: serverMessageId("mcp-create-thread-initial-message"),
            role: "user",
            text: prompt,
            attachments: [],
          },
          runtimeMode: runtimeMode ?? "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt,
        });

        await appendOrchestratorDispatchActivity({
          dispatch: deps.dispatch,
          threadId,
          prompt,
          detail: `Initial worker assignment for '${title}'.`,
          createdAt,
        });
      }

      return {
        content: [
          {
            type: "text",
            text: prompt
              ? `Created thread '${title}' (${threadId}) and sent its opening prompt.`
              : `Created thread '${title}' (${threadId}).`,
          },
        ],
        structuredContent: {
          thread: {
            id: threadId,
            projectId: project.id,
            title,
            model: model ?? project.defaultModel ?? "gpt-5-codex",
            runtimeMode: runtimeMode ?? "full-access",
            prompted: Boolean(prompt),
          },
        },
      };
    },
  );

  server.registerTool(
    "send_to_thread",
    {
      description: "Send a follow-up instruction to an existing worker thread.",
      inputSchema: {
        threadId: z.string().trim().min(1),
        prompt: z.string().trim().min(1),
      },
    },
    async ({ threadId, prompt }) => {
      const readModel = await deps.getReadModel();
      const thread = readModel.threads.find(
        (entry) =>
          entry.id === threadId &&
          entry.deletedAt === null &&
          entry.title !== ORCHESTRATOR_THREAD_TITLE,
      );
      if (!thread) {
        throw new Error(`Thread '${threadId}' was not found.`);
      }

      const createdAt = new Date().toISOString();
      await deps.dispatch({
        type: "thread.turn.start",
        commandId: serverCommandId("mcp-send-to-thread"),
        threadId: thread.id,
        message: {
          messageId: serverMessageId("mcp-send-to-thread-message"),
          role: "user",
          text: prompt,
          attachments: [],
        },
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt,
      });

      await appendOrchestratorDispatchActivity({
        dispatch: deps.dispatch,
        threadId: thread.id,
        prompt,
        detail: `Follow-up assignment for '${thread.title}'.`,
        createdAt,
      });

      return {
        content: [
          {
            type: "text",
            text: `Sent the instruction to thread '${thread.title}' (${thread.id}).`,
          },
        ],
        structuredContent: {
          thread: {
            id: thread.id,
            title: thread.title,
          },
          prompt,
        },
      };
    },
  );

  server.registerTool(
    "interrupt_thread",
    {
      description: "Interrupt the active turn for a worker thread if it is running.",
      inputSchema: {
        threadId: z.string().trim().min(1),
      },
    },
    async ({ threadId }) => {
      const readModel = await deps.getReadModel();
      const thread = readModel.threads.find(
        (entry) =>
          entry.id === threadId &&
          entry.deletedAt === null &&
          entry.title !== ORCHESTRATOR_THREAD_TITLE,
      );
      if (!thread) {
        throw new Error(`Thread '${threadId}' was not found.`);
      }

      await deps.dispatch({
        type: "thread.turn.interrupt",
        commandId: serverCommandId("mcp-interrupt-thread"),
        threadId: thread.id,
        createdAt: new Date().toISOString(),
      });

      return {
        content: [
          {
            type: "text",
            text: `Requested interruption for thread '${thread.title}' (${thread.id}).`,
          },
        ],
        structuredContent: {
          thread: {
            id: thread.id,
            title: thread.title,
          },
        },
      };
    },
  );

  server.registerTool(
    "read_thread_status",
    {
      description: "Read the current status, session state, and recent messages for a worker thread.",
      inputSchema: {
        threadId: z.string().trim().min(1),
      },
    },
    async ({ threadId }) => {
      const readModel = await deps.getReadModel();
      const thread = readModel.threads.find(
        (entry) =>
          entry.id === threadId &&
          entry.deletedAt === null &&
          entry.title !== ORCHESTRATOR_THREAD_TITLE,
      );
      if (!thread) {
        throw new Error(`Thread '${threadId}' was not found.`);
      }

      const recentMessages = thread.messages.slice(-6).map((message) => ({
        id: message.id,
        role: message.role,
        text: message.text,
        createdAt: message.createdAt,
        turnId: message.turnId,
        streaming: message.streaming,
      }));

      return {
        content: [
          {
            type: "text",
            text: `Read status for thread '${thread.title}' (${thread.id}).`,
          },
        ],
        structuredContent: {
          thread: {
            id: thread.id,
            projectId: thread.projectId,
            title: thread.title,
            model: thread.model,
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
            latestTurn: thread.latestTurn,
            session: thread.session,
            recentMessages,
            updatedAt: thread.updatedAt,
            createdAt: thread.createdAt,
          },
        },
      };
    },
  );

  return server;
}

export async function handleOrchestratorMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OrchestratorMcpServerDeps,
): Promise<void> {
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    sendJsonError(res, 403, "Orchestrator MCP requests are restricted to loopback clients.");
    return;
  }

  if (req.method !== "POST") {
    sendJsonError(res, 405, "Method not allowed.");
    return;
  }

  const server = makeOrchestratorMcpServer(deps);
  const transport = new StreamableHTTPServerTransport();

  const close = async () => {
    await transport.close();
    await server.close();
  };

  try {
    await server.connect(transport as Transport);
    res.on("close", () => {
      void close();
    });
    await transport.handleRequest(req, res);
  } catch (error) {
    await close();
    throw error;
  }
}
