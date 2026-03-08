import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
} from "@t3tools/contracts";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  requireOrchestratorLane,
  requireOrchestratorLaneAbsent,
  requireOrchestratorRun,
  requireOrchestratorRunAbsent,
  requireProject,
  requireProjectAbsent,
  requireThread,
  requireThreadArchived,
  requireThreadAbsent,
  requireThreadNotArchived,
} from "./commandInvariants.ts";

const nowIso = () => new Date().toISOString();
const defaultMetadata: Omit<OrchestrationEvent, "sequence" | "type" | "payload"> = {
  eventId: crypto.randomUUID() as OrchestrationEvent["eventId"],
  aggregateKind: "thread",
  aggregateId: "" as OrchestrationEvent["aggregateId"],
  occurredAt: nowIso(),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
};

function withEventBase(
  input: Pick<OrchestrationCommand, "commandId"> & {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: OrchestrationEvent["aggregateId"];
    readonly occurredAt: string;
    readonly metadata?: OrchestrationEvent["metadata"];
  },
): Omit<OrchestrationEvent, "sequence" | "type" | "payload"> {
  return {
    ...defaultMetadata,
    eventId: crypto.randomUUID() as OrchestrationEvent["eventId"],
    aggregateKind: input.aggregateKind,
    aggregateId: input.aggregateId,
    occurredAt: input.occurredAt,
    commandId: input.commandId,
    correlationId: input.commandId,
    metadata: input.metadata ?? {},
  };
}

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  Omit<OrchestrationEvent, "sequence"> | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
  OrchestrationCommandInvariantError
> {
  switch (command.type) {
    case "project.create": {
      yield* requireProjectAbsent({
        readModel,
        command,
        projectId: command.projectId,
      });

      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "project.created",
        payload: {
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          defaultModelSelection: command.defaultModelSelection ?? null,
          scripts: [],
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "project.meta.update": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.workspaceRoot !== undefined ? { workspaceRoot: command.workspaceRoot } : {}),
          ...(command.defaultModelSelection !== undefined
            ? { defaultModelSelection: command.defaultModelSelection }
            : {}),
          ...(command.scripts !== undefined ? { scripts: command.scripts } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "project.delete": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "project.deleted",
        payload: {
          projectId: command.projectId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.delete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.deleted",
        payload: {
          threadId: command.threadId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.archive": {
      yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.archived",
        payload: {
          threadId: command.threadId,
          archivedAt: occurredAt,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.unarchive": {
      yield* requireThreadArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.unarchived",
        payload: {
          threadId: command.threadId,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.meta.update": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.branch !== undefined ? { branch: command.branch } : {}),
          ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.runtime-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.runtime-mode-set",
        payload: {
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.interaction-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.interaction-mode-set",
        payload: {
          threadId: command.threadId,
          interactionMode: command.interactionMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.turn.start": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const sourceProposedPlan = command.sourceProposedPlan;
      const sourceThread = sourceProposedPlan
        ? yield* requireThread({
            readModel,
            command,
            threadId: sourceProposedPlan.threadId,
          })
        : null;
      const sourcePlan =
        sourceProposedPlan && sourceThread
          ? sourceThread.proposedPlans.find((entry) => entry.id === sourceProposedPlan.planId)
          : null;
      if (sourceProposedPlan && !sourcePlan) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan.planId}' does not exist on thread '${sourceProposedPlan.threadId}'.`,
        });
      }
      if (sourceThread && sourceThread.projectId !== targetThread.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan?.planId}' belongs to thread '${sourceThread.id}' in a different project.`,
        });
      }
      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: command.message.attachments,
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const turnStartRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        causationEventId: userMessageEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.titleSeed !== undefined ? { titleSeed: command.titleSeed } : {}),
          runtimeMode: targetThread.runtimeMode,
          interactionMode: targetThread.interactionMode,
          ...(sourceProposedPlan !== undefined ? { sourceProposedPlan } : {}),
          createdAt: command.createdAt,
        },
      };
      return [userMessageEvent, turnStartRequestedEvent];
    }

    case "thread.turn.interrupt": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: command.threadId,
          ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.approval.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        }),
        type: "thread.approval-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          decision: command.decision,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.user-input.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        }),
        type: "thread.user-input-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          answers: command.answers,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.checkpoint.revert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.checkpoint-revert-requested",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.stop": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.session-stop-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        }),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: command.session,
        },
      };
    }

    case "thread.message.assistant.delta": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: command.delta,
          turnId: command.turnId ?? null,
          streaming: true,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.assistant.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: "",
          turnId: command.turnId ?? null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.proposed-plan.upsert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: command.threadId,
          proposedPlan: command.proposedPlan,
        },
      };
    }

    case "thread.turn.diff.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          checkpointTurnCount: command.checkpointTurnCount,
          checkpointRef: command.checkpointRef,
          status: command.status,
          files: command.files,
          assistantMessageId: command.assistantMessageId ?? null,
          completedAt: command.completedAt,
        },
      };
    }

    case "thread.revert.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.reverted",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
        },
      };
    }

    case "thread.activity.append": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestId =
        typeof command.activity.payload === "object" &&
        command.activity.payload !== null &&
        "requestId" in command.activity.payload &&
        typeof (command.activity.payload as { requestId?: unknown }).requestId === "string"
          ? ((command.activity.payload as { requestId: string })
              .requestId as OrchestrationEvent["metadata"]["requestId"])
          : undefined;
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          ...(requestId !== undefined ? { metadata: { requestId } } : {}),
        }),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: command.activity,
        },
      };
    }

    case "orchestrator.run.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireOrchestratorRunAbsent({
        readModel,
        command,
        runId: command.runId,
      });
      return {
        ...withEventBase({
          aggregateKind: "orchestrator-run",
          aggregateId: command.runId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "orchestrator.run.created",
        payload: {
          run: {
            id: command.runId,
            projectId: command.projectId,
            title: command.title,
            goal: command.goal,
            status: "active",
            latestSynthesis: null,
            messages: [],
            lanes: [],
            dependencies: [],
            approvals: [],
            processRuleVersions: [],
            createdAt: command.createdAt,
            updatedAt: command.createdAt,
          },
        },
      };
    }

    case "orchestrator.run.message": {
      yield* requireOrchestratorRun({
        readModel,
        command,
        runId: command.runId,
      });
      return {
        ...withEventBase({
          aggregateKind: "orchestrator-run",
          aggregateId: command.runId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "orchestrator.run.message-added",
        payload: {
          runId: command.runId,
          message: command.message,
          updatedAt: command.createdAt,
        },
      };
    }

    case "orchestrator.run.synthesis.set": {
      yield* requireOrchestratorRun({
        readModel,
        command,
        runId: command.runId,
      });
      return {
        ...withEventBase({
          aggregateKind: "orchestrator-run",
          aggregateId: command.runId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "orchestrator.run.synthesis-set",
        payload: {
          runId: command.runId,
          latestSynthesis: command.latestSynthesis,
          updatedAt: command.createdAt,
        },
      };
    }

    case "orchestrator.lane.create": {
      yield* requireOrchestratorRun({
        readModel,
        command,
        runId: command.runId,
      });
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      yield* requireOrchestratorLaneAbsent({
        readModel,
        command,
        laneId: command.laneId,
      });
      return {
        ...withEventBase({
          aggregateKind: "orchestrator-lane",
          aggregateId: command.laneId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "orchestrator.lane.created",
        payload: {
          lane: {
            id: command.laneId,
            runId: command.runId,
            threadId: command.threadId,
            title: command.title,
            objective: command.objective,
            status: "ready",
            blockedReason: null,
            brief: null,
            requiredArtifactKinds: command.requiredArtifactKinds,
            verification: null,
            artifacts: [],
            updatedAt: command.createdAt,
            createdAt: command.createdAt,
          },
        },
      };
    }

    case "orchestrator.lane.dispatch": {
      const lane = yield* requireOrchestratorLane({
        readModel,
        command,
        laneId: command.laneId,
      });
      return {
        ...withEventBase({
          aggregateKind: "orchestrator-lane",
          aggregateId: command.laneId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "orchestrator.lane.dispatched",
        payload: {
          laneId: command.laneId,
          brief: command.brief,
          status: lane.status === "completed" ? "completed" : "dispatched",
          updatedAt: command.createdAt,
        },
      };
    }

    case "orchestrator.lane.status.set": {
      const lane = yield* requireOrchestratorLane({
        readModel,
        command,
        laneId: command.laneId,
      });
      if (command.status === "completed") {
        const readyArtifactKinds = new Set(
          lane.artifacts.filter((artifact) => artifact.status === "ready").map((artifact) => artifact.kind),
        );
        for (const requiredKind of lane.requiredArtifactKinds) {
          if (!readyArtifactKinds.has(requiredKind)) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `Lane '${command.laneId}' is missing required artifact '${requiredKind}'.`,
            });
          }
        }
        if (lane.verification === null || lane.verification.status !== "passed") {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Lane '${command.laneId}' cannot complete before verification passes.`,
          });
        }
      }
      return {
        ...withEventBase({
          aggregateKind: "orchestrator-lane",
          aggregateId: command.laneId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "orchestrator.lane.status-set",
        payload: {
          laneId: command.laneId,
          status: command.status,
          blockedReason: command.blockedReason ?? null,
          updatedAt: command.createdAt,
        },
      };
    }

    case "orchestrator.lane.dependency.upsert": {
      yield* requireOrchestratorRun({
        readModel,
        command,
        runId: command.runId,
      });
      yield* requireOrchestratorLane({
        readModel,
        command,
        laneId: command.dependency.fromLaneId,
      });
      yield* requireOrchestratorLane({
        readModel,
        command,
        laneId: command.dependency.toLaneId,
      });
      return {
        ...withEventBase({
          aggregateKind: "orchestrator-run",
          aggregateId: command.runId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "orchestrator.lane.dependency-upserted",
        payload: {
          runId: command.runId,
          dependency: command.dependency,
          updatedAt: command.createdAt,
        },
      };
    }

    case "orchestrator.artifact.upsert": {
      if (command.artifact.laneId !== null) {
        yield* requireOrchestratorLane({
          readModel,
          command,
          laneId: command.artifact.laneId,
        });
      }
      yield* requireOrchestratorRun({
        readModel,
        command,
        runId: command.artifact.runId,
      });
      return {
        ...withEventBase({
          aggregateKind: command.artifact.laneId === null ? "orchestrator-run" : "orchestrator-lane",
          aggregateId: command.artifact.laneId ?? command.artifact.runId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "orchestrator.artifact.upserted",
        payload: {
          artifact: command.artifact,
        },
      };
    }

    case "orchestrator.verification.upsert": {
      yield* requireOrchestratorLane({
        readModel,
        command,
        laneId: command.report.laneId,
      });
      return {
        ...withEventBase({
          aggregateKind: "orchestrator-lane",
          aggregateId: command.report.laneId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "orchestrator.verification.upserted",
        payload: {
          report: command.report,
        },
      };
    }

    case "orchestrator.lane.verify": {
      yield* requireOrchestratorLane({
        readModel,
        command,
        laneId: command.laneId,
      });
      return {
        ...withEventBase({
          aggregateKind: "orchestrator-lane",
          aggregateId: command.laneId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "orchestrator.verification.requested",
        payload: {
          laneId: command.laneId,
          createdAt: command.createdAt,
        },
      };
    }

    case "orchestrator.approval.request": {
      yield* requireOrchestratorRun({
        readModel,
        command,
        runId: command.approval.runId,
      });
      if (command.approval.laneId !== null) {
        yield* requireOrchestratorLane({
          readModel,
          command,
          laneId: command.approval.laneId,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: command.approval.laneId === null ? "orchestrator-run" : "orchestrator-lane",
          aggregateId: command.approval.laneId ?? command.approval.runId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "orchestrator.approval.requested",
        payload: {
          approval: command.approval,
        },
      };
    }

    case "orchestrator.approval.resolve": {
      const approvalContainerRun = readModel.orchestratorRuns.find((run) =>
        run.approvals.some((approval) => approval.id === command.approvalId),
      );
      if (!approvalContainerRun) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Approval '${command.approvalId}' does not exist.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "orchestrator-run",
          aggregateId: approvalContainerRun.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "orchestrator.approval.resolved",
        payload: {
          approvalId: command.approvalId,
          status: command.status,
          resolvedAt: command.createdAt,
        },
      };
    }

    case "orchestrator.process-rule.propose": {
      if (command.version.runId === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Process rule proposals must be attached to an orchestrator run in v1.",
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "orchestrator-run",
          aggregateId: command.version.runId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "orchestrator.process-rule.proposed",
        payload: {
          version: command.version,
        },
      };
    }

    case "orchestrator.process-rule.status.set": {
      const versionContainerRun = readModel.orchestratorRuns.find((run) =>
        run.processRuleVersions.some((version) => version.id === command.versionId),
      );
      if (!versionContainerRun) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Process rule version '${command.versionId}' does not exist.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "orchestrator-run",
          aggregateId: versionContainerRun.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "orchestrator.process-rule.status-set",
        payload: {
          versionId: command.versionId,
          status: command.status,
          updatedAt: command.createdAt,
        },
      };
    }

    default: {
      command satisfies never;
      const fallback = command as never as { type: string };
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unknown command type: ${fallback.type}`,
      });
    }
  }
});
