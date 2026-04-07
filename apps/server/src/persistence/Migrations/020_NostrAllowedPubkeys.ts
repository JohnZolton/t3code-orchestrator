import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS nostr_allowed_pubkeys (
      pubkey_hex TEXT PRIMARY KEY,
      label TEXT,
      created_at TEXT NOT NULL
    )
  `;
});
