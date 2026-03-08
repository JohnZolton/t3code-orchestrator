import { type ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { Outlet, createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import OrchestratorPane from "../components/OrchestratorPane";
import ThreadSidebar from "../components/Sidebar";
import { Sidebar, SidebarProvider } from "~/components/ui/sidebar";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { isTerminalFocused } from "../lib/terminalFocus";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { resolveShortcutCommand } from "../keybindings";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { resolveSidebarNewThreadEnvMode } from "~/components/Sidebar.logic";
import { useSettings } from "~/hooks/useSettings";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const ORCHESTRATOR_COLLAPSED_KEY = "t3code:orchestrator-collapsed";

function ChatRouteGlobalShortcuts() {
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const selectedThreadIdsSize = useThreadSelectionStore((state) => state.selectedThreadIds.size);
  const { activeDraftThread, activeThread, defaultProjectId, handleNewThread, routeThreadId } =
    useHandleNewThread();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const keybindings = serverConfigQuery.data?.keybindings ?? EMPTY_KEYBINDINGS;
  const terminalOpen = useTerminalStateStore((state) =>
    routeThreadId
      ? selectThreadTerminalState(state.terminalStateByThreadId, routeThreadId).terminalOpen
      : false,
  );
  const appSettings = useSettings();

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      if (event.key === "Escape" && selectedThreadIdsSize > 0) {
        event.preventDefault();
        clearSelection();
        return;
      }

      const projectId = activeThread?.projectId ?? activeDraftThread?.projectId ?? defaultProjectId;
      if (!projectId) return;

      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
        },
      });

      if (command === "chat.newLocal") {
        event.preventDefault();
        event.stopPropagation();
        void handleNewThread(projectId, {
          envMode: resolveSidebarNewThreadEnvMode({
            defaultEnvMode: appSettings.defaultThreadEnvMode,
          }),
        });
        return;
      }

      if (command === "chat.new") {
        event.preventDefault();
        event.stopPropagation();
        void handleNewThread(projectId, {
          branch: activeThread?.branch ?? activeDraftThread?.branch ?? null,
          worktreePath: activeThread?.worktreePath ?? activeDraftThread?.worktreePath ?? null,
          envMode:
            activeDraftThread?.envMode ?? (activeThread?.worktreePath ? "worktree" : "local"),
        });
        return;
      }
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [
    activeDraftThread,
    activeThread,
    clearSelection,
    handleNewThread,
    keybindings,
    defaultProjectId,
    selectedThreadIdsSize,
    terminalOpen,
    appSettings.defaultThreadEnvMode,
  ]);

  return null;
}

function ChatRouteLayout() {
  const [isOrchestratorCollapsed, setIsOrchestratorCollapsed] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.localStorage.getItem(ORCHESTRATOR_COLLAPSED_KEY) === "1";
  });

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(ORCHESTRATOR_COLLAPSED_KEY, isOrchestratorCollapsed ? "1" : "0");
  }, [isOrchestratorCollapsed]);

  return (
    <div
      className="flex h-dvh min-h-0 min-w-0 bg-background text-foreground"
      style={{
        ["--orchestrator-width" as string]: isOrchestratorCollapsed ? "0rem" : "22rem",
      }}
    >
      <div className="hidden shrink-0 overflow-hidden transition-[width] duration-300 ease-in-out md:block md:w-[var(--orchestrator-width)]">
        <OrchestratorPane />
      </div>
      <SidebarProvider defaultOpen>
        <Sidebar
          side="left"
          collapsible="offcanvas"
          className="border-r border-border bg-card text-foreground md:left-[var(--orchestrator-width)] md:transition-[left,right,width] md:duration-300 md:ease-in-out md:group-data-[collapsible=offcanvas]:left-[calc(var(--orchestrator-width)-var(--sidebar-width))]"
        >
          <ThreadSidebar
            isOrchestratorCollapsed={isOrchestratorCollapsed}
            onToggleOrchestrator={() => setIsOrchestratorCollapsed((value) => !value)}
          />
        </Sidebar>
        <DiffWorkerPoolProvider>
          <ChatRouteGlobalShortcuts />
          <Outlet />
        </DiffWorkerPoolProvider>
      </SidebarProvider>
    </div>
  );
}

export const Route = createFileRoute("/_chat")({
  component: ChatRouteLayout,
});
