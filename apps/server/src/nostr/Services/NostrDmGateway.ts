/**
 * NostrDmGateway - Transport reactor for Nostr DMs via NIP-17.
 *
 * Bridges inbound Nostr DMs to orchestration threads and sends
 * assistant replies back as encrypted Nostr messages.
 *
 * @module NostrDmGateway
 */
import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";
import type { NostrDmStatus } from "@t3tools/contracts";

export interface NostrDmGatewayShape {
  /**
   * Start the gateway: load thread keypairs,
   * fork inbound message watchers and outbound reply subscription.
   *
   * No-op when `nostrDm.enabled` is false in settings.
   * Must be run in a scope so all worker fibers can be finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /** Get current transport status (for WS API). */
  readonly getStatus: () => Effect.Effect<NostrDmStatus>;
}

export class NostrDmGateway extends ServiceMap.Service<
  NostrDmGateway,
  NostrDmGatewayShape
>()("t3/nostr/Services/NostrDmGateway") {}
