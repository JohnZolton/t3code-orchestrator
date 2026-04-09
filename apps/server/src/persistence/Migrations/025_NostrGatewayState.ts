import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Simple key-value state for the NIP-17 gateway (last seen timestamp, etc.)
  yield* sql`
    CREATE TABLE IF NOT EXISTS nostr_gateway_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `;
});
