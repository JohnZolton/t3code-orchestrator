import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface OrchestratorVerificationReactorShape {
  readonly start: Effect.Effect<void, never, Scope.Scope>;
}

export class OrchestratorVerificationReactor extends ServiceMap.Service<
  OrchestratorVerificationReactor,
  OrchestratorVerificationReactorShape
>()("t3/orchestration/Services/OrchestratorVerificationReactor") {}
