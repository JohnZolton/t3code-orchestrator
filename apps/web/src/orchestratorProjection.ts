import type { OrchestrationEvent, OrchestratorRun } from "@t3tools/contracts";

function updateRun(
  runs: ReadonlyArray<OrchestratorRun>,
  runId: string,
  updater: (run: OrchestratorRun) => OrchestratorRun,
): OrchestratorRun[] {
  return runs.map((run) => (run.id === runId ? updater(run) : run));
}

function updateLane(
  runs: ReadonlyArray<OrchestratorRun>,
  laneId: string,
  updater: (lane: OrchestratorRun["lanes"][number]) => OrchestratorRun["lanes"][number],
): OrchestratorRun[] {
  return runs.map((run) => ({
    ...run,
    lanes: run.lanes.map((lane) => (lane.id === laneId ? updater(lane) : lane)),
  }));
}

export function projectOrchestratorRuns(events: ReadonlyArray<OrchestrationEvent>): OrchestratorRun[] {
  let runs: OrchestratorRun[] = [];

  for (const event of events) {
    switch (event.type) {
      case "orchestrator.run.created": {
        runs = [...runs.filter((run) => run.id !== event.payload.run.id), event.payload.run].toSorted(
          (left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
        );
        break;
      }
      case "orchestrator.run.message-added": {
        runs = updateRun(runs, event.payload.runId, (run) => ({
          ...run,
          messages: [...run.messages, event.payload.message].slice(-500),
          updatedAt: event.payload.updatedAt,
        }));
        break;
      }
      case "orchestrator.run.synthesis-set": {
        runs = updateRun(runs, event.payload.runId, (run) => ({
          ...run,
          latestSynthesis: event.payload.latestSynthesis,
          updatedAt: event.payload.updatedAt,
        }));
        break;
      }
      case "orchestrator.lane.created": {
        runs = updateRun(runs, event.payload.lane.runId, (run) => ({
          ...run,
          lanes: [...run.lanes.filter((lane) => lane.id !== event.payload.lane.id), event.payload.lane],
          updatedAt: event.payload.lane.updatedAt,
        }));
        break;
      }
      case "orchestrator.lane.dispatched": {
        runs = updateLane(runs, event.payload.laneId, (lane) => ({
          ...lane,
          brief: event.payload.brief,
          status: event.payload.status,
          updatedAt: event.payload.updatedAt,
        }));
        break;
      }
      case "orchestrator.lane.status-set": {
        runs = updateLane(runs, event.payload.laneId, (lane) => ({
          ...lane,
          status: event.payload.status,
          blockedReason: event.payload.blockedReason,
          updatedAt: event.payload.updatedAt,
        }));
        break;
      }
      case "orchestrator.lane.dependency-upserted": {
        runs = updateRun(runs, event.payload.runId, (run) => ({
          ...run,
          dependencies: [
            ...run.dependencies.filter(
              (entry) =>
                !(
                  entry.fromLaneId === event.payload.dependency.fromLaneId &&
                  entry.toLaneId === event.payload.dependency.toLaneId
                ),
            ),
            event.payload.dependency,
          ],
          updatedAt: event.payload.updatedAt,
        }));
        break;
      }
      case "orchestrator.artifact.upserted": {
        runs = updateRun(runs, event.payload.artifact.runId, (run) => ({
          ...run,
          lanes:
            event.payload.artifact.laneId === null
              ? run.lanes
              : run.lanes.map((lane) =>
                  lane.id === event.payload.artifact.laneId
                    ? {
                        ...lane,
                        artifacts: [
                          ...lane.artifacts.filter((artifact) => artifact.id !== event.payload.artifact.id),
                          event.payload.artifact,
                        ],
                        updatedAt: event.payload.artifact.updatedAt,
                      }
                    : lane,
                ),
          updatedAt: event.payload.artifact.updatedAt,
        }));
        break;
      }
      case "orchestrator.verification.upserted": {
        runs = updateLane(runs, event.payload.report.laneId, (lane) => ({
          ...lane,
          verification: event.payload.report,
          updatedAt: event.payload.report.updatedAt,
        }));
        break;
      }
      case "orchestrator.approval.requested": {
        runs = updateRun(runs, event.payload.approval.runId, (run) => ({
          ...run,
          approvals: [
            ...run.approvals.filter((approval) => approval.id !== event.payload.approval.id),
            event.payload.approval,
          ],
          updatedAt: event.payload.approval.requestedAt,
        }));
        break;
      }
      case "orchestrator.approval.resolved": {
        runs = runs.map((run) => ({
          ...run,
          approvals: run.approvals.map((approval) =>
            approval.id === event.payload.approvalId
              ? { ...approval, status: event.payload.status, resolvedAt: event.payload.resolvedAt }
              : approval,
          ),
        }));
        break;
      }
      case "orchestrator.process-rule.proposed": {
        if (event.payload.version.runId === null) {
          break;
        }
        runs = updateRun(runs, event.payload.version.runId, (run) => ({
          ...run,
          processRuleVersions: [
            ...run.processRuleVersions.filter((version) => version.id !== event.payload.version.id),
            event.payload.version,
          ],
          updatedAt: event.payload.version.updatedAt,
        }));
        break;
      }
      case "orchestrator.process-rule.status-set": {
        runs = runs.map((run) => ({
          ...run,
          processRuleVersions: run.processRuleVersions.map((version) =>
            version.id === event.payload.versionId
              ? { ...version, status: event.payload.status, updatedAt: event.payload.updatedAt }
              : version,
          ),
        }));
        break;
      }
      default:
        break;
    }
  }

  return runs;
}
