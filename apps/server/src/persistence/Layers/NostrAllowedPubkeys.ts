import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema } from "effect";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../Errors.ts";
import {
  NostrAllowedPubkeyRow,
  NostrAllowedPubkeysRepository,
  type NostrAllowedPubkeysRepositoryShape,
} from "../Services/NostrAllowedPubkeys.ts";

const makeNostrAllowedPubkeysRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const addRow = SqlSchema.void({
    Request: NostrAllowedPubkeyRow,
    execute: (row) =>
      sql`
        INSERT INTO nostr_allowed_pubkeys (pubkey_hex, label, created_at)
        VALUES (${row.pubkeyHex}, ${row.label}, ${row.createdAt})
        ON CONFLICT (pubkey_hex) DO UPDATE SET
          label = excluded.label
      `,
  });

  const removeRow = SqlSchema.void({
    Request: Schema.Struct({ pubkeyHex: Schema.String }),
    execute: ({ pubkeyHex }) =>
      sql`DELETE FROM nostr_allowed_pubkeys WHERE pubkey_hex = ${pubkeyHex}`,
  });

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: NostrAllowedPubkeyRow,
    execute: () =>
      sql`SELECT pubkey_hex AS "pubkeyHex", label, created_at AS "createdAt" FROM nostr_allowed_pubkeys ORDER BY created_at ASC`,
  });

  const checkRow = SqlSchema.findAll({
    Request: Schema.Struct({ pubkeyHex: Schema.String }),
    Result: Schema.Struct({ n: Schema.Number }),
    execute: ({ pubkeyHex }) =>
      sql`SELECT COUNT(*) AS n FROM nostr_allowed_pubkeys WHERE pubkey_hex = ${pubkeyHex}`,
  });

  const add: NostrAllowedPubkeysRepositoryShape["add"] = (row) =>
    addRow(row).pipe(Effect.mapError(toPersistenceSqlError("NostrAllowedPubkeys.add")));

  const remove: NostrAllowedPubkeysRepositoryShape["remove"] = (pubkeyHex) =>
    removeRow({ pubkeyHex }).pipe(
      Effect.mapError(toPersistenceSqlError("NostrAllowedPubkeys.remove")),
    );

  const list: NostrAllowedPubkeysRepositoryShape["list"] = () =>
    listRows(undefined).pipe(Effect.mapError(toPersistenceSqlError("NostrAllowedPubkeys.list")));

  const isAllowed: NostrAllowedPubkeysRepositoryShape["isAllowed"] = (pubkeyHex) =>
    checkRow({ pubkeyHex }).pipe(
      Effect.map((rows) => (rows[0]?.n ?? 0) > 0),
      Effect.mapError(toPersistenceSqlError("NostrAllowedPubkeys.isAllowed")),
    );

  return { add, remove, list, isAllowed } satisfies NostrAllowedPubkeysRepositoryShape;
});

export const NostrAllowedPubkeysRepositoryLive = Layer.effect(
  NostrAllowedPubkeysRepository,
  makeNostrAllowedPubkeysRepository,
);
