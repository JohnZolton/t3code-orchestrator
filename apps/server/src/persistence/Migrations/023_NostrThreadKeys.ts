import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS nostr_thread_keys (
      thread_id TEXT PRIMARY KEY,
      seckey_hex TEXT NOT NULL,
      pubkey_hex TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_nostr_thread_keys_pubkey
    ON nostr_thread_keys(pubkey_hex)
  `;
});
