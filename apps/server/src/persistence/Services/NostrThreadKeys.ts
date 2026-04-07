/**
 * NostrDmThreadKeysRepository - Per-thread Nostr keypairs for NIP-17 DMs.
 *
 * Each orchestration thread gets its own Nostr identity (keypair).
 * DMs to that thread's npub route directly to that thread.
 *
 * @module NostrDmThreadKeysRepository
 */
import { IsoDateTime, TrimmedNonEmptyString } from "@t3tools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const NostrDmThreadKeyRow = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  seckeyHex: TrimmedNonEmptyString,
  pubkeyHex: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type NostrDmThreadKeyRow = typeof NostrDmThreadKeyRow.Type;

export const GetByThreadIdInput = Schema.Struct({ threadId: TrimmedNonEmptyString });
export type GetByThreadIdInput = typeof GetByThreadIdInput.Type;

export const GetByPubkeyInput = Schema.Struct({ pubkeyHex: TrimmedNonEmptyString });
export type GetByPubkeyInput = typeof GetByPubkeyInput.Type;

export interface NostrDmThreadKeysRepositoryShape {
  readonly upsert: (row: NostrDmThreadKeyRow) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly getByThreadId: (
    input: GetByThreadIdInput,
  ) => Effect.Effect<Option.Option<NostrDmThreadKeyRow>, ProjectionRepositoryError>;

  readonly getByPubkey: (
    input: GetByPubkeyInput,
  ) => Effect.Effect<Option.Option<NostrDmThreadKeyRow>, ProjectionRepositoryError>;

  readonly list: () => Effect.Effect<
    ReadonlyArray<NostrDmThreadKeyRow>,
    ProjectionRepositoryError
  >;
}

export class NostrDmThreadKeysRepository extends ServiceMap.Service<
  NostrDmThreadKeysRepository,
  NostrDmThreadKeysRepositoryShape
>()("t3/persistence/Services/NostrDmThreadKeys/NostrDmThreadKeysRepository") {}
