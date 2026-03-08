import { ThreadId } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { BotIcon, HistoryIcon, PlusIcon, SendIcon, Trash2Icon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { AUTO_SCROLL_BOTTOM_THRESHOLD_PX, isScrollContainerNearBottom } from "../chat-scroll";
import { newCommandId, newMessageId, newThreadId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { isOrchestratorThread, ORCHESTRATOR_THREAD_TITLE } from "../orchestratorThread";
import {
  deriveTimelineEntries,
  deriveWorkLogEntries,
  formatElapsed,
  formatTimestamp,
} from "../session-logic";
import { useStore } from "../store";
import type { ChatMessage } from "../types";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";
import ChatMarkdown from "./ChatMarkdown";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/menu";
import { ScrollArea } from "./ui/scroll-area";

const ORCHESTRATOR_HIDDEN_PROMPT_TAGS = ["T3CODE_ORCHESTRATOR_AUTOREVIEW"];

function defaultAssistantMessage(projectTitle: string, threadCount: number): string {
  return threadCount > 0
    ? `Tell me what you want built in ${projectTitle}. I'll coordinate the work and use the available worker threads as needed.`
    : `Tell me what you want built in ${projectTitle}. I'll coordinate the work and can spawn worker threads as needed.`;
}

function sanitizeDisplayedMessage(text: string): string {
  let sanitized = text.replace(
    /\[T3CODE_ORCHESTRATOR_CONTEXT\][\s\S]*?\[\/T3CODE_ORCHESTRATOR_CONTEXT\]\s*/gi,
    "",
  );

  for (const tag of ORCHESTRATOR_HIDDEN_PROMPT_TAGS) {
    sanitized = sanitized.replace(new RegExp(`\\[${tag}\\][\\s\\S]*?\\[\\/${tag}\\]\\s*`, "gi"), "");
  }

  return sanitized.trim();
}

function isHiddenOrchestratorMessage(text: string): boolean {
  return ORCHESTRATOR_HIDDEN_PROMPT_TAGS.some((tag) => text.includes(`[${tag}]`));
}

function collapseOrchestratorAssistantMessages(
  messages: ReadonlyArray<ChatMessage>,
): ChatMessage[] {
  const collapsed: ChatMessage[] = [];

  for (const message of messages) {
    const previous = collapsed.at(-1);
    const shouldReplacePreviousAssistantMessage =
      previous !== undefined &&
      previous.role === "assistant" &&
      message.role === "assistant" &&
      previous.completedAt === undefined &&
      message.completedAt !== undefined;

    if (shouldReplacePreviousAssistantMessage) {
      collapsed[collapsed.length - 1] = message;
      continue;
    }

    collapsed.push(message);
  }

  return collapsed;
}

function workToneClass(tone: "thinking" | "tool" | "info" | "error"): string {
  if (tone === "error") return "text-rose-300/50 dark:text-rose-300/50";
  if (tone === "tool") return "text-muted-foreground/70";
  if (tone === "thinking") return "text-muted-foreground/50";
  return "text-muted-foreground/40";
}

export default function OrchestratorPane() {
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const activeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const [draft, setDraft] = useState("");
  const [draftCursor, setDraftCursor] = useState(0);
  const [selectedOrchestratorThreadId, setSelectedOrchestratorThreadId] = useState<ThreadId | null>(null);
  const [startFreshOnNextSend, setStartFreshOnNextSend] = useState(false);
  const composerEditorRef = useRef<ComposerPromptEditorHandle | null>(null);
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const didHandleInitialHistoryPolicyRef = useRef(false);
  const shouldAutoScrollRef = useRef(true);

  const api = readNativeApi();
  const activeThread = threads.find((thread) => thread.id === activeThreadId) ?? null;
  const primaryProject =
    (activeThread ? projects.find((project) => project.id === activeThread.projectId) : null) ??
    projects[0] ??
    null;

  const orchestratorThreads = useMemo(
    () =>
      threads
        .filter((thread) => isOrchestratorThread(thread))
        .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt)),
    [threads],
  );
  const orchestratorThread =
    startFreshOnNextSend
      ? null
      :
    (selectedOrchestratorThreadId
      ? orchestratorThreads.find((thread) => thread.id === selectedOrchestratorThreadId) ?? null
      : null) ?? orchestratorThreads[0] ?? null;

  const projectThreads = useMemo(
    () => threads.filter((thread) => !isOrchestratorThread(thread)),
    [threads],
  );

  const sendMessage = async () => {
    if (!api || !primaryProject || draft.trim().length === 0) {
      return;
    }

    const now = new Date().toISOString();
    const threadId = startFreshOnNextSend || !orchestratorThread ? newThreadId() : orchestratorThread.id;

    if (startFreshOnNextSend || !orchestratorThread) {
      await api.orchestration.dispatchCommand({
        type: "thread.create",
        commandId: newCommandId(),
        threadId,
        projectId: primaryProject.id,
        title: ORCHESTRATOR_THREAD_TITLE,
        model: primaryProject.model,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: now,
      });
    }

    await api.orchestration.dispatchCommand({
      type: "thread.turn.start",
      commandId: newCommandId(),
      message: {
        messageId: newMessageId(),
        role: "user",
        text: draft.trim(),
        attachments: [],
      },
      threadId,
      assistantDeliveryMode: "streaming",
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: now,
    });

    setDraft("");
    setDraftCursor(0);
    setSelectedOrchestratorThreadId(threadId);
    setStartFreshOnNextSend(false);
  };

  const messages = useMemo(
    () =>
      collapseOrchestratorAssistantMessages(
        (orchestratorThread?.messages ?? []).filter((message) => !isHiddenOrchestratorMessage(message.text)),
      ),
    [orchestratorThread?.messages],
  );
  const workLogEntries = useMemo(
    () => deriveWorkLogEntries(orchestratorThread?.activities ?? [], undefined),
    [orchestratorThread?.activities],
  );
  const timelineEntries = deriveTimelineEntries(messages, [], workLogEntries);
  const isRunning = orchestratorThread?.session?.status === "running";
  const messageRenderSignature = timelineEntries
    .map((entry) => {
      if (entry.kind === "message") {
        return `${entry.id}:message:${entry.message.streaming ? "1" : "0"}:${entry.message.text}`;
      }

      if (entry.kind === "work") {
        return `${entry.id}:work:${entry.entry.label}:${entry.entry.detail ?? ""}`;
      }

      return `${entry.id}:${entry.kind}`;
    })
    .join("\u241e");

  useEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) {
      return;
    }

    const updateAutoScroll = () => {
      shouldAutoScrollRef.current = isScrollContainerNearBottom(
        viewport,
        AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
      );
    };

    updateAutoScroll();
    viewport.addEventListener("scroll", updateAutoScroll, { passive: true });
    return () => {
      viewport.removeEventListener("scroll", updateAutoScroll);
    };
  }, []);

  useEffect(() => {
    if (!shouldAutoScrollRef.current) {
      return;
    }
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [messageRenderSignature]);

  useEffect(() => {
    if (startFreshOnNextSend) {
      return;
    }
    if (selectedOrchestratorThreadId && orchestratorThreads.some((thread) => thread.id === selectedOrchestratorThreadId)) {
      return;
    }
    setSelectedOrchestratorThreadId(orchestratorThreads[0]?.id ?? null);
  }, [orchestratorThreads, selectedOrchestratorThreadId, startFreshOnNextSend]);

  useEffect(() => {
    if (!threadsHydrated || !api || didHandleInitialHistoryPolicyRef.current) {
      return;
    }
    didHandleInitialHistoryPolicyRef.current = true;

    if (orchestratorThreads.length === 0) {
      return;
    }

    void (async () => {
      for (const thread of orchestratorThreads) {
        if (thread.session && thread.session.status !== "closed") {
          await api.orchestration
            .dispatchCommand({
              type: "thread.session.stop",
              commandId: newCommandId(),
              threadId: thread.id,
              createdAt: new Date().toISOString(),
            })
            .catch(() => undefined);
        }

        await api.orchestration.dispatchCommand({
          type: "thread.delete",
          commandId: newCommandId(),
          threadId: thread.id,
        });
      }
    })();
  }, [api, orchestratorThreads, threadsHydrated]);

  const startFreshChat = () => {
    setSelectedOrchestratorThreadId(null);
    setStartFreshOnNextSend(true);
    setDraft("");
    setDraftCursor(0);
  };

  const deleteOrchestratorChat = async (threadId: ThreadId) => {
    if (!api) {
      return;
    }

    const thread = orchestratorThreads.find((entry) => entry.id === threadId) ?? null;
    if (!thread) {
      return;
    }

    if (thread.session && thread.session.status !== "closed") {
      await api.orchestration
        .dispatchCommand({
          type: "thread.session.stop",
          commandId: newCommandId(),
          threadId: thread.id,
          createdAt: new Date().toISOString(),
        })
        .catch(() => undefined);
    }

    await api.orchestration.dispatchCommand({
      type: "thread.delete",
      commandId: newCommandId(),
      threadId: thread.id,
    });

    if (selectedOrchestratorThreadId === thread.id) {
      setSelectedOrchestratorThreadId(null);
      setStartFreshOnNextSend(true);
    }
  };

  const stopOrchestrator = async () => {
    if (!api || !orchestratorThread) {
      return;
    }
    await api.orchestration.dispatchCommand({
      type: "thread.turn.interrupt",
      commandId: newCommandId(),
      threadId: orchestratorThread.id,
      createdAt: new Date().toISOString(),
    });
  };

  return (
    <aside
      className="hidden h-dvh w-[22rem] shrink-0 border-r border-border bg-background text-foreground md:flex md:flex-col"
    >
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <BotIcon className="size-4" />
          <span>Orchestrator</span>
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          <Button type="button" size="xs" variant="ghost" onClick={startFreshChat}>
            <PlusIcon className="mr-1 size-3.5" />
            New
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button type="button" size="xs" variant="ghost" />}>
              <HistoryIcon className="mr-1 size-3.5" />
              History
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={8} className="w-72">
                  {orchestratorThreads.length === 0 ? (
                    <DropdownMenuItem disabled>No chats yet</DropdownMenuItem>
                  ) : (
                    orchestratorThreads.map((thread, index) => (
                      <div key={thread.id} className="flex items-center gap-1 px-1 py-0.5">
                        <DropdownMenuItem
                          onClick={() => {
                            setSelectedOrchestratorThreadId(thread.id);
                            setStartFreshOnNextSend(false);
                          }}
                          className="min-w-0 flex-1 flex-col items-start gap-0.5"
                        >
                          <span className="truncate font-medium">
                            {thread.title === ORCHESTRATOR_THREAD_TITLE
                              ? index === 0
                                ? "Current chat"
                                : `Chat ${orchestratorThreads.length - index}`
                              : thread.title}
                          </span>
                          <span className="text-[10px] text-muted-foreground">{formatTimestamp(thread.createdAt)}</span>
                        </DropdownMenuItem>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="size-7 shrink-0"
                          onClick={() => void deleteOrchestratorChat(thread.id)}
                          aria-label="Delete orchestrator chat"
                        >
                          <Trash2Icon className="size-3.5" />
                        </Button>
                      </div>
                    ))
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {projects.length > 0
            ? `Coordinate work across ${projects.length} project${projects.length === 1 ? "" : "s"} and ${projectThreads.length} thread${projectThreads.length === 1 ? "" : "s"}.`
            : "Create a project to start coordinating work."}
        </p>
      </div>

      <ScrollArea viewportRef={scrollViewportRef} className="min-h-0 flex-1 px-4 py-4">
        <div className="space-y-3 pb-4">
          {timelineEntries.length === 0 ? (
            <div className="rounded-2xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
              {primaryProject
                ? defaultAssistantMessage("this workspace", projectThreads.length)
                : "Create a project, then tell the orchestrator what you want built."}
            </div>
          ) : (
            timelineEntries.map((entry) => {
              if (entry.kind === "work") {
                return (
                  <div
                    key={entry.id}
                    className="mr-6 min-w-0 rounded-2xl border border-border/80 bg-card/45 px-4 py-3"
                  >
                    <div className="mb-1 text-[10px] font-medium tracking-[0.16em] text-muted-foreground uppercase">
                      {entry.entry.tone === "tool" ? "tool" : "work"}
                    </div>
                    <div
                      className={`min-w-0 break-words text-xs leading-relaxed ${workToneClass(entry.entry.tone)}`}
                    >
                      <div className="break-words">{entry.entry.label}</div>
                      {entry.entry.detail ? (
                        <div className="mt-1 max-w-full whitespace-pre-wrap break-all font-mono text-[11px] opacity-60">
                          {entry.entry.detail}
                        </div>
                      ) : null}
                    </div>
                    <div className="mt-1.5 text-[10px] text-muted-foreground/40">
                      {formatTimestamp(entry.createdAt)}
                    </div>
                  </div>
                );
              }

              if (entry.kind !== "message") {
                return null;
              }

              const message = entry.message;
              const cleanText = sanitizeDisplayedMessage(message.text);
              return (
                <div
                  key={message.id}
                  className={
                    message.role === "user"
                      ? "ml-6 rounded-2xl bg-foreground px-4 py-3 text-sm text-background"
                      : "mr-6 rounded-2xl border border-border bg-card px-4 py-3 text-sm text-foreground"
                  }
                >
                  <div className="mb-1 text-[10px] font-medium tracking-[0.16em] text-muted-foreground uppercase">
                    {message.role}
                  </div>
                  {cleanText.length > 0 ? (
                    message.role === "assistant" ? (
                      <ChatMarkdown
                        text={cleanText || (message.streaming ? "" : "(empty response)")}
                        cwd={primaryProject?.cwd}
                        isStreaming={message.streaming}
                      />
                    ) : (
                      <div className="whitespace-pre-wrap">{cleanText}</div>
                    )
                  ) : message.role === "assistant" && message.streaming ? (
                    <ChatMarkdown text="" cwd={primaryProject?.cwd} isStreaming />
                  ) : null}
                  <div className="mt-1.5 text-[10px] text-muted-foreground/40">
                    {message.role === "assistant"
                      ? (() => {
                          const elapsed = message.streaming
                            ? formatElapsed(message.createdAt, new Date().toISOString())
                            : formatElapsed(message.createdAt, message.completedAt);
                          return elapsed
                            ? `${formatTimestamp(message.createdAt)} • ${elapsed}`
                            : formatTimestamp(message.createdAt);
                        })()
                      : formatTimestamp(message.createdAt)}
                  </div>
                </div>
              );
            })
          )}
          {isRunning ? (
            <div className="mr-6 flex items-center gap-2 rounded-2xl border border-border/80 bg-card/45 px-4 py-3">
              <span className="inline-flex items-center gap-[3px]">
                <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse" />
                <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse [animation-delay:200ms]" />
                <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse [animation-delay:400ms]" />
              </span>
              <span className="text-xs text-muted-foreground">Working...</span>
            </div>
          ) : null}
          <div ref={messagesEndRef} />
        </div>
      </ScrollArea>

      <div className="border-t border-border px-4 py-4">
        <form
          className="rounded-2xl border border-input bg-background shadow-xs/5"
          onSubmit={(event) => {
            event.preventDefault();
            void sendMessage();
          }}
        >
          <div className="px-3 py-3">
            <ComposerPromptEditor
              ref={composerEditorRef}
              value={draft}
              cursor={draftCursor}
              onChange={(nextValue, nextCursor) => {
                setDraft(nextValue);
                setDraftCursor(nextCursor);
              }}
              onCommandKeyDown={(key, event) => {
                if (key !== "Enter" || event.shiftKey) {
                  return false;
                }
                if (!primaryProject || draft.trim().length === 0) {
                  return true;
                }
                void sendMessage();
                return true;
              }}
              onPaste={() => {}}
              placeholder="Ask anything, @tag files/folders, or use /model"
              disabled={!primaryProject}
            />
          </div>
          <div className="flex items-center justify-end px-2.5 pb-2.5 sm:px-3 sm:pb-3">
            {isRunning ? (
              <button
                type="button"
                className="flex size-8 items-center justify-center rounded-full bg-rose-500/90 text-white transition-all duration-150 hover:bg-rose-500 hover:scale-105 sm:h-8 sm:w-8"
                onClick={() => void stopOrchestrator()}
                aria-label="Stop generation"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
                  <rect x="2" y="2" width="8" height="8" rx="1.5" />
                </svg>
              </button>
            ) : (
              <Button
                type="submit"
                size="sm"
                className="h-9 rounded-full px-4 sm:h-8"
                disabled={!primaryProject || draft.trim().length === 0}
              >
                <SendIcon className="size-4" />
              </Button>
            )}
          </div>
        </form>
      </div>
    </aside>
  );
}
