import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Check if auth_sessions exists. It may not if migration 020 was skipped
  // due to a migration ID conflict with old Nostr migrations (IDs 19-21).
  const sessionTableInfo = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_sessions)
  `;

  if (sessionTableInfo.length === 0) {
    // auth_sessions table doesn't exist — create it along with auth_pairing_links
    // (compensates for migrations 020 and 021 being skipped due to ID conflict)

    yield* sql`
      CREATE TABLE IF NOT EXISTS auth_pairing_links (
        id TEXT PRIMARY KEY,
        credential TEXT NOT NULL UNIQUE,
        method TEXT NOT NULL,
        role TEXT NOT NULL,
        subject TEXT NOT NULL,
        label TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        revoked_at TEXT
      )
    `;

    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_auth_pairing_links_active
      ON auth_pairing_links(revoked_at, consumed_at, expires_at)
    `;

    yield* sql`
      CREATE TABLE IF NOT EXISTS auth_sessions (
        session_id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        role TEXT NOT NULL,
        method TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        client_label TEXT,
        client_ip_address TEXT,
        client_user_agent TEXT,
        client_device_type TEXT NOT NULL DEFAULT 'unknown',
        client_os TEXT,
        client_browser TEXT,
        last_connected_at TEXT
      )
    `;

    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_active
      ON auth_sessions(revoked_at, expires_at, issued_at)
    `;
  } else {
    // auth_sessions exists — apply incremental column additions from 021 and 022

    const pairingLinkColumns = yield* sql<{ readonly name: string }>`
      PRAGMA table_info(auth_pairing_links)
    `;
    if (!pairingLinkColumns.some((column) => column.name === "label")) {
      yield* sql`
        ALTER TABLE auth_pairing_links
        ADD COLUMN label TEXT
      `;
    }

    if (!sessionTableInfo.some((column) => column.name === "client_label")) {
      yield* sql`ALTER TABLE auth_sessions ADD COLUMN client_label TEXT`;
    }
    if (!sessionTableInfo.some((column) => column.name === "client_ip_address")) {
      yield* sql`ALTER TABLE auth_sessions ADD COLUMN client_ip_address TEXT`;
    }
    if (!sessionTableInfo.some((column) => column.name === "client_user_agent")) {
      yield* sql`ALTER TABLE auth_sessions ADD COLUMN client_user_agent TEXT`;
    }
    if (!sessionTableInfo.some((column) => column.name === "client_device_type")) {
      yield* sql`ALTER TABLE auth_sessions ADD COLUMN client_device_type TEXT NOT NULL DEFAULT 'unknown'`;
    }
    if (!sessionTableInfo.some((column) => column.name === "client_os")) {
      yield* sql`ALTER TABLE auth_sessions ADD COLUMN client_os TEXT`;
    }
    if (!sessionTableInfo.some((column) => column.name === "client_browser")) {
      yield* sql`ALTER TABLE auth_sessions ADD COLUMN client_browser TEXT`;
    }
    if (!sessionTableInfo.some((column) => column.name === "last_connected_at")) {
      yield* sql`ALTER TABLE auth_sessions ADD COLUMN last_connected_at TEXT`;
    }
  }
});
