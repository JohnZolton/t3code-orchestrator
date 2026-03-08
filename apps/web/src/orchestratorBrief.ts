import type {
  OrchestratorArtifactKind,
  OrchestratorLane,
  OrchestratorRun,
  OrchestratorWorkerBrief,
} from "@t3tools/contracts";

const DEFAULT_PHASES = ["design", "implement", "verify", "report"] as const;

function artifactLabel(kind: OrchestratorArtifactKind): string {
  switch (kind) {
    case "change-manifest":
      return "change manifest";
    case "acceptance-checklist":
      return "acceptance checklist";
    case "verification-output":
      return "verification output";
    case "summary":
      return "summary";
    case "prompt-patch":
      return "prompt patch artifact";
    case "audit-log":
      return "audit log";
  }
}

export function buildLaneWorkerBrief(input: {
  run: OrchestratorRun;
  lane: OrchestratorLane;
}): OrchestratorWorkerBrief {
  const { run, lane } = input;
  const successCriteria = [
    `Advance run goal: ${run.goal}`,
    `Complete lane objective: ${lane.objective}`,
    "Return all required artifacts with enough detail for human review",
    "Report uncertainty explicitly instead of guessing",
  ];
  const hardRequirements = [
    "Follow repository safety requirements from AGENTS.md",
    "Do not claim completion without evidence",
    "Prefer maintainable shared logic over one-off local hacks",
    "Do not skip required verification gates",
  ];
  const constraints = [
    "Keep direct worker-thread behavior intact unless the task requires a deliberate change",
    "Preserve predictable behavior under failure and reconnect conditions",
    "Call out blockers and tradeoffs clearly",
  ];
  const requiredArtifacts = lane.requiredArtifactKinds;
  const dispatchPrompt = [
    `Objective: ${lane.objective}`,
    "",
    "Success criteria:",
    ...successCriteria.map((item) => `- ${item}`),
    "",
    "Hard requirements:",
    ...hardRequirements.map((item) => `- ${item}`),
    "",
    "Execution phases:",
    ...DEFAULT_PHASES.map((item, index) => `${index + 1}. ${item}`),
    "",
    "Required artifacts:",
    ...requiredArtifacts.map((item) => `- ${artifactLabel(item)}`),
    "",
    "Constraints and boundaries:",
    ...constraints.map((item) => `- ${item}`),
    "",
    "Failure handling:",
    "- If blocked, stop and report the blocker, impact, and best next action.",
    "- If verification fails, include the failing command and the likely cause.",
    "",
    `Strategic context: ${run.goal}`,
    `Implementation context: lane '${lane.title}' in orchestrator run '${run.title}'.`,
  ].join("\n");

  return {
    objective: lane.objective,
    successCriteria,
    hardRequirements,
    orderedPhases: [...DEFAULT_PHASES],
    requiredArtifacts,
    constraints,
    failureHandling:
      "If anything is unclear or blocked, report what is known, what is uncertain, and the safest next step.",
    strategicContext: run.goal,
    implementationContext: `Execute lane '${lane.title}' using thread '${lane.threadId}'.`,
    dispatchPrompt,
  };
}
