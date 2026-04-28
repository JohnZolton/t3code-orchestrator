import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("026_CompactHistoricalToolActivities", (it) => {
  it.effect("deletes tool lifecycle activities older than the latest five settled turns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 25 });

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          ('thread-1', 'turn-1', NULL, NULL, NULL, NULL, 'completed', '2026-03-01T00:00:01.000Z', '2026-03-01T00:00:01.000Z', '2026-03-01T00:00:01.000Z', 1, 'checkpoint-1', 'ready', '[]'),
          ('thread-1', 'turn-2', NULL, NULL, NULL, NULL, 'completed', '2026-03-01T00:00:02.000Z', '2026-03-01T00:00:02.000Z', '2026-03-01T00:00:02.000Z', 2, 'checkpoint-2', 'ready', '[]'),
          ('thread-1', 'turn-3', NULL, NULL, NULL, NULL, 'completed', '2026-03-01T00:00:03.000Z', '2026-03-01T00:00:03.000Z', '2026-03-01T00:00:03.000Z', 3, 'checkpoint-3', 'ready', '[]'),
          ('thread-1', 'turn-4', NULL, NULL, NULL, NULL, 'completed', '2026-03-01T00:00:04.000Z', '2026-03-01T00:00:04.000Z', '2026-03-01T00:00:04.000Z', 4, 'checkpoint-4', 'ready', '[]'),
          ('thread-1', 'turn-5', NULL, NULL, NULL, NULL, 'completed', '2026-03-01T00:00:05.000Z', '2026-03-01T00:00:05.000Z', '2026-03-01T00:00:05.000Z', 5, 'checkpoint-5', 'ready', '[]'),
          ('thread-1', 'turn-6', NULL, NULL, NULL, NULL, 'completed', '2026-03-01T00:00:06.000Z', '2026-03-01T00:00:06.000Z', '2026-03-01T00:00:06.000Z', 6, 'checkpoint-6', 'ready', '[]')
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES
          ('tool-old', 'thread-1', 'turn-1', 'tool', 'tool.updated', 'Old tool', '{"itemType":"command_execution"}', 1, '2026-03-01T00:00:01.500Z'),
          ('tool-keep', 'thread-1', 'turn-2', 'tool', 'tool.updated', 'Recent tool', '{"itemType":"command_execution"}', 2, '2026-03-01T00:00:02.500Z'),
          ('note-old', 'thread-1', 'turn-1', 'info', 'runtime.warning', 'Keep note', '{"detail":"keep"}', 3, '2026-03-01T00:00:01.750Z')
      `;

      yield* runMigrations({ toMigrationInclusive: 26 });

      const rows = yield* sql<{
        readonly activityId: string;
        readonly kind: string;
      }>`
        SELECT activity_id AS "activityId", kind
        FROM projection_thread_activities
        ORDER BY activity_id ASC
      `;

      assert.deepStrictEqual(rows, [
        { activityId: "note-old", kind: "runtime.warning" },
        { activityId: "tool-keep", kind: "tool.updated" },
      ]);
    }),
  );
});
