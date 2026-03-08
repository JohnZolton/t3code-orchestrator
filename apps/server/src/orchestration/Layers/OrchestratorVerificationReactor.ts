import {
  CommandId,
  OrchestratorArtifactId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { Data, Effect, Layer, Stream } from "effect";

import { runProcess } from "../../processRunner.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  OrchestratorVerificationReactor,
  type OrchestratorVerificationReactorShape,
} from "../Services/OrchestratorVerificationReactor.ts";

type VerificationRequestedEvent = Extract<
  OrchestrationEvent,
  { type: "orchestrator.verification.requested" }
>;

const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

const REQUIRED_COMMANDS = ["bun lint", "bun typecheck"] as const;

class OrchestratorVerificationRunError extends Data.TaggedError(
  "OrchestratorVerificationRunError",
)<{
  readonly cause: unknown;
}> {}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;

  const runVerification = Effect.fnUntraced(function* (event: VerificationRequestedEvent) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const lane = readModel.orchestratorRuns
      .flatMap((run) => run.lanes)
      .find((entry) => entry.id === event.payload.laneId);
    if (!lane) {
      return;
    }
    const thread = readModel.threads.find((entry) => entry.id === lane.threadId);
    if (!thread) {
      return;
    }
    const project = readModel.projects.find((entry) => entry.id === thread.projectId);
    if (!project) {
      return;
    }

    yield* orchestrationEngine.dispatch({
      type: "orchestrator.verification.upsert",
      commandId: serverCommandId("orchestrator-verification-running"),
      report: {
        laneId: lane.id,
        status: "running",
        requiredCommands: [...REQUIRED_COMMANDS],
        commandResults: [],
        contradictions: [],
        updatedAt: event.occurredAt,
      },
      createdAt: event.occurredAt,
    });
    yield* orchestrationEngine.dispatch({
      type: "orchestrator.lane.status.set",
      commandId: serverCommandId("orchestrator-lane-awaiting-verification"),
      laneId: lane.id,
      status: "awaiting-verification",
      blockedReason: null,
      createdAt: event.occurredAt,
    });

    const commandResults = [] as Array<{
      command: string;
      exitCode: number | null;
      stdout: string;
      stderr: string;
      startedAt: string;
      completedAt: string;
    }>;

    for (const command of REQUIRED_COMMANDS) {
      const startedAt = new Date().toISOString();
      const result = yield* Effect.tryPromise({
        try: () => runProcess("bun", command.split(" ").slice(1), {
          cwd: project.workspaceRoot,
          timeoutMs: 120_000,
          allowNonZeroExit: true,
          outputMode: "truncate",
        }),
        catch: (cause) => new OrchestratorVerificationRunError({ cause }),
      });
      const completedAt = new Date().toISOString();
      commandResults.push({
        command,
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        startedAt,
        completedAt,
      });
    }

    const contradictions = commandResults.flatMap((result) =>
      result.exitCode === 0 ? [] : [`${result.command} failed with exit code ${result.exitCode ?? -1}.`],
    );
    const updatedAt = new Date().toISOString();
    const status = contradictions.length === 0 ? "passed" : "failed";

    yield* orchestrationEngine.dispatch({
      type: "orchestrator.verification.upsert",
      commandId: serverCommandId("orchestrator-verification-complete"),
      report: {
        laneId: lane.id,
        status,
        requiredCommands: [...REQUIRED_COMMANDS],
        commandResults,
        contradictions,
        updatedAt,
      },
      createdAt: updatedAt,
    });
    yield* orchestrationEngine.dispatch({
      type: "orchestrator.artifact.upsert",
      commandId: serverCommandId("orchestrator-verification-artifact"),
      artifact: {
        id: OrchestratorArtifactId.makeUnsafe(`verification:${lane.id}`),
        laneId: lane.id,
        runId: lane.runId,
        kind: "verification-output",
        status: "ready",
        title: "Verification output",
        payload: {
          commandResults,
          contradictions,
        },
        createdAt: updatedAt,
        updatedAt,
      },
      createdAt: updatedAt,
    });
    yield* orchestrationEngine.dispatch({
      type: "orchestrator.lane.status.set",
      commandId: serverCommandId("orchestrator-lane-verification-result"),
      laneId: lane.id,
      status: contradictions.length === 0 ? "awaiting-verification" : "blocked",
      blockedReason:
        contradictions.length === 0 ? null : `Verification failed: ${contradictions.join(" ")}`,
      createdAt: updatedAt,
    });
  });

  const start: OrchestratorVerificationReactorShape["start"] = Stream.runForEach(
    orchestrationEngine.streamDomainEvents,
    (event) => {
      if (event.type !== "orchestrator.verification.requested") {
        return Effect.void;
      }
      return runVerification(event).pipe(Effect.catch(() => Effect.void));
    },
  ).pipe(Effect.forkScoped, Effect.asVoid);

  return {
    start,
  } satisfies OrchestratorVerificationReactorShape;
});

export const OrchestratorVerificationReactorLive = Layer.effect(
  OrchestratorVerificationReactor,
  make,
);
