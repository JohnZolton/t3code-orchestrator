import type { Thread } from "./types";

export const ORCHESTRATOR_THREAD_TITLE = "Orchestrator";

export function isOrchestratorThread(thread: Thread): boolean {
  return thread.title === ORCHESTRATOR_THREAD_TITLE;
}
