import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    DELETE FROM projection_thread_activities
    WHERE kind IN ('tool.started', 'tool.updated', 'tool.completed')
      AND turn_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM projection_turns current_turn
        JOIN (
          SELECT
            thread_id,
            MAX(checkpoint_turn_count) AS latest_checkpoint_turn_count
          FROM projection_turns
          WHERE checkpoint_turn_count IS NOT NULL
          GROUP BY thread_id
        ) latest_turn
          ON latest_turn.thread_id = current_turn.thread_id
        WHERE current_turn.thread_id = projection_thread_activities.thread_id
          AND current_turn.turn_id = projection_thread_activities.turn_id
          AND current_turn.checkpoint_turn_count IS NOT NULL
          AND current_turn.checkpoint_turn_count <= latest_turn.latest_checkpoint_turn_count - 5
      )
  `;
});
