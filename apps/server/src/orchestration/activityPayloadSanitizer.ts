import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import type { ProjectionThreadActivity } from "../persistence/Services/ProjectionThreadActivities.ts";
import type { ProjectionTurn } from "../persistence/Services/ProjectionTurns.ts";

const TOOL_ACTIVITY_KINDS = new Set<OrchestrationThreadActivity["kind"]>([
  "tool.started",
  "tool.updated",
  "tool.completed",
]);
export const RECENT_SETTLED_TOOL_ACTIVITY_TURN_WINDOW = 5;

const MAX_SANITIZED_DATA_DEPTH = 5;
const MAX_SANITIZED_DATA_ARRAY_ITEMS = 12;
const MAX_SANITIZED_DATA_OBJECT_ENTRIES = 16;
const MAX_SANITIZED_DATA_STRING_LENGTH = 512;

function truncateString(value: string): string {
  return value.length > MAX_SANITIZED_DATA_STRING_LENGTH
    ? `${value.slice(0, MAX_SANITIZED_DATA_STRING_LENGTH - 3)}...`
    : value;
}

function sanitizeUnknown(value: unknown, depth: number): unknown {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "bigint"
  ) {
    return value;
  }

  if (typeof value === "string") {
    return truncateString(value);
  }

  if (depth >= MAX_SANITIZED_DATA_DEPTH) {
    if (Array.isArray(value)) {
      return value.length === 0 ? [] : ["..."];
    }
    if (typeof value === "object" && value !== null) {
      return { truncated: true };
    }
    return String(value);
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_SANITIZED_DATA_ARRAY_ITEMS)
      .map((entry) => sanitizeUnknown(entry, depth + 1));
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, MAX_SANITIZED_DATA_OBJECT_ENTRIES)
        .map(([key, entry]) => [key, sanitizeUnknown(entry, depth + 1)]),
    );
  }

  return String(value);
}

export function sanitizeActivityPayload(
  kind: OrchestrationThreadActivity["kind"],
  payload: unknown,
): unknown {
  if (!TOOL_ACTIVITY_KINDS.has(kind) || typeof payload !== "object" || payload === null) {
    return payload;
  }

  const record = payload as Record<string, unknown>;
  if (!("data" in record) || record.data === undefined) {
    return payload;
  }

  return {
    ...record,
    data: sanitizeUnknown(record.data, 0),
  };
}

export function isToolLifecycleActivityKind(kind: string): boolean {
  return TOOL_ACTIVITY_KINDS.has(kind as OrchestrationThreadActivity["kind"]);
}

export function compactHistoricalToolActivities(
  activities: ReadonlyArray<ProjectionThreadActivity>,
  turns: ReadonlyArray<ProjectionTurn>,
  recentSettledTurnWindow = RECENT_SETTLED_TOOL_ACTIVITY_TURN_WINDOW,
): ReadonlyArray<ProjectionThreadActivity> {
  if (activities.length === 0 || recentSettledTurnWindow < 0) {
    return activities;
  }

  const settledTurnCounts = turns.flatMap((turn) =>
    turn.turnId !== null && turn.checkpointTurnCount !== null ? [turn.checkpointTurnCount] : [],
  );
  if (settledTurnCounts.length <= recentSettledTurnWindow) {
    return activities;
  }

  const latestSettledTurnCount = Math.max(...settledTurnCounts);
  const cutoffTurnCount = latestSettledTurnCount - recentSettledTurnWindow;
  if (cutoffTurnCount <= 0) {
    return activities;
  }

  const compactedTurnIds = new Set(
    turns.flatMap((turn) =>
      turn.turnId !== null &&
      turn.checkpointTurnCount !== null &&
      turn.checkpointTurnCount <= cutoffTurnCount
        ? [turn.turnId]
        : [],
    ),
  );
  if (compactedTurnIds.size === 0) {
    return activities;
  }

  return activities.filter(
    (activity) =>
      !(
        activity.turnId !== null &&
        compactedTurnIds.has(activity.turnId) &&
        isToolLifecycleActivityKind(activity.kind)
      ),
  );
}
