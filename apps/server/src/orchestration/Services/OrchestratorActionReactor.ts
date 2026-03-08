import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface OrchestratorActionReactorShape {
  readonly start: Effect.Effect<void, never, Scope.Scope>;
}

export class OrchestratorActionReactor extends ServiceMap.Service<
  OrchestratorActionReactor,
  OrchestratorActionReactorShape
>()("t3/orchestration/Services/OrchestratorActionReactor") {}
