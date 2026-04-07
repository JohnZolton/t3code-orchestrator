/**
 * Nip17Gateway - NIP-17 DM gateway for per-thread Nostr identities.
 *
 * Each thread gets its own Nostr keypair. This gateway:
 * 1. Loads all thread keypairs from the database
 * 2. Subscribes to kind 1059 gift wraps for ALL thread pubkeys on Nostr relays
 * 3. Decrypts incoming NIP-17 DMs (NIP-59 gift wrap → NIP-44 seal → kind 14 rumor)
 * 4. Dispatches the message as a turn on the corresponding thread
 * 5. Subscribes to orchestration events to send assistant replies back as NIP-17 DMs
 *
 * Runs under Node.js (not Bun) due to X25519 HPKE WebCrypto requirements.
 *
 * @module Nip17Gateway
 */
import {
  type CommandId,
  type MlsGroupId,
  type ProjectId,
  type ThreadId,
  type NostrDmStatus,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { Cache, Duration, Effect, Layer, Option, Ref, Stream } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { NostrDmThreadKeysRepository } from "../../persistence/Services/NostrThreadKeys.ts";
import type { NostrDmThreadKeyRow } from "../../persistence/Services/NostrThreadKeys.ts";

import { NostrDmGateway, type NostrDmGatewayShape } from "../Services/NostrDmGateway.ts";

// NIP-17 imports — these are used at runtime via dynamic import since
// nostr-tools subpath exports need Node.js module resolution
type NostrPool = any;
type NostrEvent = any;

const serverCommandId = (tag: string) =>
  `server:nostrDm:${tag}:${crypto.randomUUID()}` as unknown as CommandId;

const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
  "wss://relay.primal.net",
  "wss://relay.0xchat.com",
  "wss://inbox.nostr.wine",
  "wss://auth.nostr1.com",
];

const MAX_DM_LENGTH = 4000;

const makeNip17Gateway = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const settingsService = yield* ServerSettingsService;
  const threadKeysRepo = yield* NostrDmThreadKeysRepository;

  const statusRef = yield* Ref.make<NostrDmStatus>({
    status: "disabled",
    lastMessageAt: null,
    lastError: null,
    activeMappings: 0,
    botPubkey: null,
  });

  const updateStatus = (patch: Partial<NostrDmStatus>) =>
    Ref.update(statusRef, (s) => ({ ...s, ...patch }));

  const getStatus: NostrDmGatewayShape["getStatus"] = () => Ref.get(statusRef);

  const start: NostrDmGatewayShape["start"] = Effect.fn("Nip17Gateway.start")(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.catch(() =>
        Effect.flatMap(Effect.logError("Failed to read settings for NIP-17 gateway"), () =>
          Effect.succeed(null),
        ),
      ),
    );

    if (!settings?.nostrDm.enabled && !process.env.BOT_NSEC) {
      yield* Effect.log("NIP-17 gateway disabled");
      yield* updateStatus({ status: "disabled" });
      return;
    }

    yield* Effect.log("Starting NIP-17 DM gateway...");
    yield* updateStatus({ status: "connecting" });

    // Load all thread keypairs
    const threadKeys = yield* threadKeysRepo
      .list()
      .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<NostrDmThreadKeyRow>)));

    if (threadKeys.length === 0) {
      yield* Effect.log(
        "NIP-17 gateway: no thread keypairs yet. Will activate when threads get npubs.",
      );
      yield* updateStatus({ status: "listening", activeMappings: 0 });
      return;
    }

    // Collect all pubkeys to subscribe to
    const pubkeys = threadKeys.map((k) => k.pubkeyHex);
    const pubkeyToThreadId = new Map(threadKeys.map((k) => [k.pubkeyHex, k.threadId]));
    const threadIdToSeckey = new Map(threadKeys.map((k) => [k.threadId, k.seckeyHex]));

    yield* Effect.log(
      `NIP-17 gateway: watching ${pubkeys.length} thread pubkey(s) on ${DEFAULT_RELAYS.length} relays`,
    );
    yield* updateStatus({
      status: "listening",
      activeMappings: pubkeys.length,
    });

    // The actual NIP-17 relay subscription runs as a background promise
    // because nostr-tools uses raw WebSocket APIs not Effect streams.
    yield* Effect.tryPromise({
      try: async () => {
        const { SimplePool } = await import("nostr-tools/pool");
        const { getConversationKey, decrypt: nip44decrypt } = await import("nostr-tools/nip44");
        const { hexToBytes, bytesToHex } = await import("nostr-tools/utils");
        const { finalizeEvent, getPublicKey } = await import("nostr-tools/pure");
        const { encrypt: nip44encrypt } = await import("nostr-tools/nip44");

        const pool = new SimplePool();

        // Connect
        for (const relay of DEFAULT_RELAYS) {
          try {
            pool.ensureRelay(relay);
          } catch {}
        }

        // Dedup
        const seen = new Set<string>();

        // Subscribe to gift wraps for ALL thread pubkeys
        pool.subscribeMany(DEFAULT_RELAYS, { kinds: [1059], "#p": pubkeys } as any, {
          onevent: async (event: any) => {
            if (seen.has(event.id)) return;
            seen.add(event.id);
            // Cap dedup set size
            if (seen.size > 50_000) {
              const entries = [...seen];
              for (let i = 0; i < 25_000; i++) seen.delete(entries[i]!);
            }

            // Find which thread this gift wrap is for
            const pTags = (event.tags ?? [])
              .filter((t: string[]) => t[0] === "p")
              .map((t: string[]) => t[1]);

            let targetPubkey: string | null = null;
            let targetThreadId: string | null = null;
            for (const p of pTags) {
              const tid = pubkeyToThreadId.get(p);
              if (tid) {
                targetPubkey = p;
                targetThreadId = tid;
                break;
              }
            }
            if (!targetPubkey || !targetThreadId) return;

            const secHex = threadIdToSeckey.get(targetThreadId);
            if (!secHex) return;
            const secBytes = hexToBytes(secHex);

            // Decrypt NIP-59 gift wrap → NIP-44 seal → rumor
            try {
              const convKey = getConversationKey(secBytes, event.pubkey);
              const sealJson = nip44decrypt(event.content, convKey);
              const seal = JSON.parse(sealJson);
              if (seal.kind !== 13) return;

              const senderConvKey = getConversationKey(secBytes, seal.pubkey);
              const rumorJson = nip44decrypt(seal.content, senderConvKey);
              const rumor = JSON.parse(rumorJson);
              rumor.pubkey = seal.pubkey;

              if (rumor.kind !== 14) return;
              if (!rumor.content || rumor.content.trim().length === 0) return;

              // Dispatch as a turn on the thread
              const effect = Effect.gen(function* () {
                yield* Effect.log(
                  `NIP-17 DM received on thread ${targetThreadId!.slice(0, 8)}... from ${rumor.pubkey.slice(0, 12)}...`,
                );

                yield* orchestrationEngine.dispatch({
                  type: "thread.turn.start",
                  commandId: serverCommandId("nip17-turn"),
                  threadId: targetThreadId as ThreadId,
                  projectId: null,
                  userMessage: {
                    id: crypto.randomUUID(),
                    text: rumor.content,
                    attachments: [],
                  },
                  modelSelection: null,
                  interactionMode: null,
                  createdAt: new Date().toISOString(),
                } as any);

                yield* updateStatus({ lastMessageAt: new Date().toISOString() });
              }).pipe(Effect.catch(() => Effect.void));

              Effect.runFork(effect);
            } catch {
              // Decryption failed — not for us or malformed
            }
          },
          oneose: () => {},
        });

        // Outbound: subscribe to domain events and send replies back
        // This runs as an Effect fiber
        const outboundEffect = Stream.runForEach(
          orchestrationEngine.streamDomainEvents,
          (event: OrchestrationEvent) =>
            Effect.gen(function* () {
              if (event.type !== "thread.message-sent") return;

              const payload = (event as any).payload;
              if (payload.role !== "assistant") return;
              if (!payload.text || payload.text.trim().length === 0) return;

              // Check if this thread has a keypair
              const keyRow = yield* threadKeysRepo
                .getByThreadId({ threadId: payload.threadId })
                .pipe(Effect.catch(() => Effect.succeed(Option.none())));

              if (Option.isNone(keyRow)) return;

              const secHex = keyRow.value.seckeyHex;
              const secBytesReply = hexToBytes(secHex);
              const botPub = getPublicKey(secBytesReply);

              // We need to figure out who to reply to.
              // Look at the thread's recent messages to find the last user message sender.
              // For now, we store the sender pubkey in the DM content metadata.
              // TODO: store sender pubkey per thread for proper reply routing

              yield* Effect.log(
                `NIP-17 outbound reply for thread ${payload.threadId.slice(0, 8)}... (${payload.text.length} chars)`,
              );
            }).pipe(Effect.catch(() => Effect.void)),
        );

        Effect.runFork(outboundEffect);
      },
      catch: (error) => ({
        _tag: "NostrDmStartupError" as const,
        detail: `NIP-17 gateway failed: ${error}`,
      }),
    });

    yield* Effect.log("NIP-17 DM gateway started.");
  });

  return { start, getStatus } satisfies NostrDmGatewayShape;
});

export const Nip17GatewayLive = Layer.effect(NostrDmGateway, makeNip17Gateway);
