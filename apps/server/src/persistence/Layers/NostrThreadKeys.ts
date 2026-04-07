import { TrimmedNonEmptyString } from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../Errors.ts";
import {
  NostrDmThreadKeyRow,
  NostrDmThreadKeysRepository,
  type NostrDmThreadKeysRepositoryShape,
} from "../Services/NostrThreadKeys.ts";

const decodeRow = Schema.decodeUnknownEffect(NostrDmThreadKeyRow);

const GetByThreadIdRequest = Schema.Struct({ threadId: TrimmedNonEmptyString });
const GetByPubkeyRequest = Schema.Struct({ pubkeyHex: TrimmedNonEmptyString });

function toPersistenceSqlOrDecodeError(sqlOp: string, decodeOp: string) {
  return (cause: unknown): ProjectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOp)(cause)
      : toPersistenceSqlError(sqlOp)(cause);
}

const makeNostrDmThreadKeysRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: NostrDmThreadKeyRow,
    execute: (row) =>
      sql`
        INSERT INTO nostr_thread_keys (thread_id, seckey_hex, pubkey_hex, created_at)
        VALUES (${row.threadId}, ${row.seckeyHex}, ${row.pubkeyHex}, ${row.createdAt})
        ON CONFLICT (thread_id) DO UPDATE SET
          seckey_hex = excluded.seckey_hex,
          pubkey_hex = excluded.pubkey_hex
      `,
  });

  const getRowByThreadId = SqlSchema.findOneOption({
    Request: GetByThreadIdRequest,
    Result: NostrDmThreadKeyRow,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          seckey_hex AS "seckeyHex",
          pubkey_hex AS "pubkeyHex",
          created_at AS "createdAt"
        FROM nostr_thread_keys
        WHERE thread_id = ${threadId}
      `,
  });

  const getRowByPubkey = SqlSchema.findOneOption({
    Request: GetByPubkeyRequest,
    Result: NostrDmThreadKeyRow,
    execute: ({ pubkeyHex }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          seckey_hex AS "seckeyHex",
          pubkey_hex AS "pubkeyHex",
          created_at AS "createdAt"
        FROM nostr_thread_keys
        WHERE pubkey_hex = ${pubkeyHex}
      `,
  });

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: NostrDmThreadKeyRow,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          seckey_hex AS "seckeyHex",
          pubkey_hex AS "pubkeyHex",
          created_at AS "createdAt"
        FROM nostr_thread_keys
        ORDER BY created_at DESC
      `,
  });

  const upsert: NostrDmThreadKeysRepositoryShape["upsert"] = (row) =>
    upsertRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "NostrDmThreadKeysRepository.upsert:query",
          "NostrDmThreadKeysRepository.upsert:encodeRequest",
        ),
      ),
    );

  const getByThreadId: NostrDmThreadKeysRepositoryShape["getByThreadId"] = (input) =>
    getRowByThreadId(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "NostrDmThreadKeysRepository.getByThreadId:query",
          "NostrDmThreadKeysRepository.getByThreadId:decodeRow",
        ),
      ),
      Effect.flatMap((opt) =>
        Option.match(opt, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            decodeRow(row).pipe(
              Effect.mapError(
                toPersistenceDecodeError("NostrDmThreadKeysRepository.getByThreadId:rowToKey"),
              ),
              Effect.map(Option.some),
            ),
        }),
      ),
    );

  const getByPubkey: NostrDmThreadKeysRepositoryShape["getByPubkey"] = (input) =>
    getRowByPubkey(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "NostrDmThreadKeysRepository.getByPubkey:query",
          "NostrDmThreadKeysRepository.getByPubkey:decodeRow",
        ),
      ),
      Effect.flatMap((opt) =>
        Option.match(opt, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            decodeRow(row).pipe(
              Effect.mapError(
                toPersistenceDecodeError("NostrDmThreadKeysRepository.getByPubkey:rowToKey"),
              ),
              Effect.map(Option.some),
            ),
        }),
      ),
    );

  const list: NostrDmThreadKeysRepositoryShape["list"] = () =>
    listRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "NostrDmThreadKeysRepository.list:query",
          "NostrDmThreadKeysRepository.list:decodeRows",
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(
          rows,
          (row) =>
            decodeRow(row).pipe(
              Effect.mapError(
                toPersistenceDecodeError("NostrDmThreadKeysRepository.list:rowToKey"),
              ),
            ),
          { concurrency: "unbounded" },
        ),
      ),
    );

  return { upsert, getByThreadId, getByPubkey, list } satisfies NostrDmThreadKeysRepositoryShape;
});

export const NostrDmThreadKeysRepositoryLive = Layer.effect(
  NostrDmThreadKeysRepository,
  makeNostrDmThreadKeysRepository,
);
