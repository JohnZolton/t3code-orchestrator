import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface OrchestratorMessageReactorShape {
  readonly start: Effect.Effect<void, never, Scope.Scope>;
}

export class OrchestratorMessageReactor extends ServiceMap.Service<
  OrchestratorMessageReactor,
  OrchestratorMessageReactorShape
>()("t3/orchestration/Services/OrchestratorMessageReactor") {}
