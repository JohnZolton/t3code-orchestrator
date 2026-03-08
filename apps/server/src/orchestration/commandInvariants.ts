import type {
  OrchestrationCommand,
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationThread,
  OrchestratorLane,
  OrchestratorLaneId,
  OrchestratorRun,
  OrchestratorRunId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";

function invariantError(commandType: string, detail: string): OrchestrationCommandInvariantError {
  return new OrchestrationCommandInvariantError({
    commandType,
    detail,
  });
}

export function findThreadById(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationThread | undefined {
  return readModel.threads.find((thread) => thread.id === threadId);
}

export function findProjectById(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): OrchestrationProject | undefined {
  return readModel.projects.find((project) => project.id === projectId);
}

export function listThreadsByProjectId(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): ReadonlyArray<OrchestrationThread> {
  return readModel.threads.filter((thread) => thread.projectId === projectId);
}

export function findOrchestratorRunById(
  readModel: OrchestrationReadModel,
  runId: OrchestratorRunId,
): OrchestratorRun | undefined {
  return readModel.orchestratorRuns.find((run) => run.id === runId);
}

export function findOrchestratorLaneById(
  readModel: OrchestrationReadModel,
  laneId: OrchestratorLaneId,
): OrchestratorLane | undefined {
  for (const run of readModel.orchestratorRuns) {
    const lane = run.lanes.find((entry) => entry.id === laneId);
    if (lane) {
      return lane;
    }
  }
  return undefined;
}

export function requireProject(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<OrchestrationProject, OrchestrationCommandInvariantError> {
  const project = findProjectById(input.readModel, input.projectId);
  if (project) {
    return Effect.succeed(project);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireProjectAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findProjectById(input.readModel, input.projectId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireThread(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  const thread = findThreadById(input.readModel, input.threadId);
  if (thread) {
    return Effect.succeed(thread);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireThreadArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt !== null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is not archived for command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadNotArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt === null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is already archived and cannot handle command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findThreadById(input.readModel, input.threadId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireOrchestratorRun(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly runId: OrchestratorRunId;
}): Effect.Effect<OrchestratorRun, OrchestrationCommandInvariantError> {
  const run = findOrchestratorRunById(input.readModel, input.runId);
  if (run) {
    return Effect.succeed(run);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Orchestrator run '${input.runId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireOrchestratorRunAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly runId: OrchestratorRunId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findOrchestratorRunById(input.readModel, input.runId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Orchestrator run '${input.runId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireOrchestratorLane(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly laneId: OrchestratorLaneId;
}): Effect.Effect<OrchestratorLane, OrchestrationCommandInvariantError> {
  const lane = findOrchestratorLaneById(input.readModel, input.laneId);
  if (lane) {
    return Effect.succeed(lane);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Orchestrator lane '${input.laneId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireOrchestratorLaneAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly laneId: OrchestratorLaneId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findOrchestratorLaneById(input.readModel, input.laneId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Orchestrator lane '${input.laneId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireNonNegativeInteger(input: {
  readonly commandType: OrchestrationCommand["type"];
  readonly field: string;
  readonly value: number;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (Number.isInteger(input.value) && input.value >= 0) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.commandType,
      `${input.field} must be an integer greater than or equal to 0.`,
    ),
  );
}
