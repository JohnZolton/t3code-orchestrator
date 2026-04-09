/**
 * NostrAllowedPubkeysRepository - Manages the allowlist of Nostr pubkeys
 * authorized to DM thread npubs and receive replies.
 *
 * @module NostrAllowedPubkeysRepository
 */
import { IsoDateTime, TrimmedNonEmptyString } from "@t3tools/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const NostrAllowedPubkeyRow = Schema.Struct({
  pubkeyHex: TrimmedNonEmptyString,
  label: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
});
export type NostrAllowedPubkeyRow = typeof NostrAllowedPubkeyRow.Type;

export interface NostrAllowedPubkeysRepositoryShape {
  readonly add: (row: NostrAllowedPubkeyRow) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly remove: (pubkeyHex: string) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly list: () => Effect.Effect<
    ReadonlyArray<NostrAllowedPubkeyRow>,
    ProjectionRepositoryError
  >;

  readonly isAllowed: (pubkeyHex: string) => Effect.Effect<boolean, ProjectionRepositoryError>;
}

export class NostrAllowedPubkeysRepository extends ServiceMap.Service<
  NostrAllowedPubkeysRepository,
  NostrAllowedPubkeysRepositoryShape
>()("t3/persistence/Services/NostrAllowedPubkeys/NostrAllowedPubkeysRepository") {}
