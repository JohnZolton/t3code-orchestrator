import { Outlet, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import OrchestratorPane from "../components/OrchestratorPane";
import ThreadSidebar from "../components/Sidebar";
import { Sidebar, SidebarProvider } from "~/components/ui/sidebar";

const ORCHESTRATOR_COLLAPSED_KEY = "t3code:orchestrator-collapsed";

function ChatRouteLayout() {
  const navigate = useNavigate();
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

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action !== "open-settings") return;
      void navigate({ to: "/settings" });
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate]);

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
          <Outlet />
        </DiffWorkerPoolProvider>
      </SidebarProvider>
    </div>
  );
}

export const Route = createFileRoute("/_chat")({
  component: ChatRouteLayout,
});
