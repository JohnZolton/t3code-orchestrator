/**
 * Nip17Gateway - NIP-17 DM gateway for per-thread Nostr identities.
 *
 * Each thread gets its own Nostr keypair. This gateway:
 * 1. Loads all thread keypairs from the database (or polls until some exist)
 * 2. Subscribes to kind 1059 gift wraps for ALL thread pubkeys on Nostr relays
 * 3. Decrypts incoming NIP-17 DMs (NIP-59 gift wrap → NIP-44 seal → kind 14 rumor)
 * 4. Dispatches the message as a turn on the corresponding thread
 * 5. Subscribes to orchestration events to send assistant replies back as NIP-17 DMs
 *
 * @module Nip17Gateway
 */
import {
  type CommandId,
  type MessageId,
  type ThreadId,
  type NostrDmStatus,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { Effect, Layer, Option, Ref, Stream } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { NostrDmThreadKeysRepository } from "../../persistence/Services/NostrThreadKeys.ts";
import type { NostrDmThreadKeyRow } from "../../persistence/Services/NostrThreadKeys.ts";

import { NostrDmGateway, type NostrDmGatewayShape } from "../Services/NostrDmGateway.ts";

const serverCommandId = (tag: string) =>
  `server:nostrDm:${tag}:${crypto.randomUUID()}` as unknown as CommandId;

const serverMessageId = () =>
  `server:nostrDm:msg:${crypto.randomUUID()}` as unknown as MessageId;

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

  const threadSenderMap = yield* Ref.make<Map<string, string>>(new Map());

  const updateStatus = (patch: Partial<NostrDmStatus>) =>
    Ref.update(statusRef, (s) => ({ ...s, ...patch }));

  const getStatus: NostrDmGatewayShape["getStatus"] = () => Ref.get(statusRef);

  // ── Core: start relay subscriptions for a set of thread keys ────
  const startRelaySubscriptions = (keys: ReadonlyArray<NostrDmThreadKeyRow>) =>
    Effect.tryPromise({
      try: async () => {
        const { SimplePool } = await import("nostr-tools/pool");
        const { getConversationKey, decrypt: nip44decrypt, encrypt: nip44encrypt } = await import(
          "nostr-tools/nip44"
        );
        const { hexToBytes } = await import("nostr-tools/utils");
        const { finalizeEvent, getPublicKey } = await import("nostr-tools/pure");

        // Suppress relay connection errors — they're non-fatal (pool auto-reconnects)
        const onUnhandledRejection = (reason: unknown) => {
          if (
            typeof reason === "string" &&
            (reason === "connection failed" || reason.includes("WebSocket"))
          ) {
            return; // Silently ignore relay connection failures
          }
          // Re-throw anything that's not a relay error
          console.error("[NIP-17 gateway] unhandled rejection:", reason);
        };
        process.on("unhandledRejection", onUnhandledRejection);

        const pool = new SimplePool();
        for (const relay of DEFAULT_RELAYS) {
          try {
            pool.ensureRelay(relay);
          } catch {}
        }

        const pubkeys = keys.map((k) => k.pubkeyHex);
        const pubkeyToThreadId = new Map(keys.map((k) => [k.pubkeyHex, k.threadId]));
        const threadIdToSeckey = new Map(keys.map((k) => [k.threadId, k.seckeyHex]));
        const seen = new Set<string>();

        // ── NIP-17 gift wrap builder ──────────────────────────────
        function createGiftWrap(
          senderSecBytes: Uint8Array,
          senderPubkey: string,
          recipientPubkey: string,
          content: string,
        ) {
          const now = Math.floor(Date.now() / 1000);
          const twoDays = 2 * 24 * 60 * 60;
          const randomTs = () => now - Math.floor(Math.random() * twoDays);

          const rumor = {
            id: crypto.randomUUID().replace(/-/g, "").slice(0, 64),
            pubkey: senderPubkey,
            created_at: now,
            kind: 14,
            tags: [["p", recipientPubkey]],
            content,
          };

          const sealConvKey = getConversationKey(senderSecBytes, recipientPubkey);
          const encryptedRumor = nip44encrypt(JSON.stringify(rumor), sealConvKey);
          const seal = finalizeEvent(
            { kind: 13, created_at: randomTs(), tags: [], content: encryptedRumor },
            senderSecBytes,
          );

          const ephSec = crypto.getRandomValues(new Uint8Array(32));
          const wrapConvKey = getConversationKey(ephSec, recipientPubkey);
          const encryptedSeal = nip44encrypt(JSON.stringify(seal), wrapConvKey);
          return finalizeEvent(
            { kind: 1059, created_at: randomTs(), tags: [["p", recipientPubkey]], content: encryptedSeal },
            ephSec,
          );
        }

        // ── Inbox relay lookup ────────────────────────────────────
        async function getRecipientRelays(pubkey: string): Promise<string[]> {
          try {
            const events = await pool.querySync(DEFAULT_RELAYS, {
              kinds: [10050, 10002],
              authors: [pubkey],
              limit: 3,
            } as any);
            const relayEvent =
              (events as any[]).find((e) => e.kind === 10050) ||
              (events as any[]).find((e) => e.kind === 10002);
            if (relayEvent) {
              const urls = relayEvent.tags
                .filter((t: string[]) => t[0] === "relay" || t[0] === "r")
                .map((t: string[]) => t[1])
                .filter(Boolean);
              if (urls.length > 0) return [...new Set([...urls, ...DEFAULT_RELAYS])];
            }
          } catch {}
          return DEFAULT_RELAYS;
        }

        // ── Send reply helper ─────────────────────────────────────
        async function sendReply(threadSecHex: string, recipientPubkey: string, content: string) {
          const secBytes = hexToBytes(threadSecHex);
          const senderPub = getPublicKey(secBytes);
          const relays = await getRecipientRelays(recipientPubkey);
          const chunks =
            content.length <= MAX_DM_LENGTH
              ? [content]
              : Array.from({ length: Math.ceil(content.length / MAX_DM_LENGTH) }, (_, i) =>
                  content.slice(i * MAX_DM_LENGTH, (i + 1) * MAX_DM_LENGTH),
                );
          for (const chunk of chunks) {
            const gw = createGiftWrap(secBytes, senderPub, recipientPubkey, chunk);
            await Promise.allSettled(
              pool.publish(relays, gw as any).map((p: Promise<any>) =>
                Promise.race([p, new Promise((r) => setTimeout(r, 5000))]),
              ),
            );
          }
        }

        // ── Inbound subscription ──────────────────────────────────
        pool.subscribeMany(DEFAULT_RELAYS, { kinds: [1059], "#p": pubkeys } as any, {
          onevent: async (event: any) => {
            if (seen.has(event.id)) return;
            seen.add(event.id);
            if (seen.size > 50_000) {
              const entries = [...seen];
              for (let i = 0; i < 25_000; i++) seen.delete(entries[i]!);
            }

            const pTags = (event.tags ?? [])
              .filter((t: string[]) => t[0] === "p")
              .map((t: string[]) => t[1]);

            let targetThreadId: string | null = null;
            let targetSecHex: string | null = null;
            for (const p of pTags) {
              const tid = pubkeyToThreadId.get(p);
              if (tid) {
                targetThreadId = tid;
                targetSecHex = threadIdToSeckey.get(tid) ?? null;
                break;
              }
            }
            if (!targetThreadId || !targetSecHex) return;

            const secBytes = hexToBytes(targetSecHex);

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

              const senderPubkey: string = rumor.pubkey;
              const threadId = targetThreadId;

              // Track sender for outbound replies
              Effect.runFork(
                Ref.update(threadSenderMap, (m) => new Map(m).set(threadId, senderPubkey)),
              );

              // Dispatch as a turn
              Effect.runFork(
                Effect.gen(function* () {
                  yield* Effect.log(
                    `NIP-17 DM on thread ${threadId.slice(0, 8)}... from ${senderPubkey.slice(0, 12)}...: "${rumor.content.slice(0, 50)}"`,
                  );
                  yield* orchestrationEngine.dispatch({
                    type: "thread.turn.start",
                    commandId: serverCommandId("nip17-turn"),
                    threadId: threadId as ThreadId,
                    message: {
                      messageId: serverMessageId(),
                      role: "user" as const,
                      text: rumor.content,
                      attachments: [],
                    },
                    runtimeMode: "full-access",
                    interactionMode: "default",
                    createdAt: new Date().toISOString(),
                  } as any);
                  yield* updateStatus({ lastMessageAt: new Date().toISOString() });
                }).pipe(Effect.catch(() => Effect.void)),
              );
            } catch {
              // Decryption failed
            }
          },
          oneose: () => {},
        });

        // ── Outbound: send assistant replies as DMs ───────────────
        Effect.runFork(
          Stream.runForEach(orchestrationEngine.streamDomainEvents, (event: OrchestrationEvent) =>
            Effect.gen(function* () {
              if (event.type !== "thread.message-sent") return;
              const payload = (event as any).payload;
              if (payload.role !== "assistant") return;
              if (!payload.text || payload.text.trim().length === 0) return;

              const keyRow = yield* threadKeysRepo
                .getByThreadId({ threadId: payload.threadId })
                .pipe(Effect.catch(() => Effect.succeed(Option.none())));
              if (Option.isNone(keyRow)) return;

              const senders = yield* Ref.get(threadSenderMap);
              const recipientPubkey = senders.get(payload.threadId);
              if (!recipientPubkey) return;

              yield* Effect.log(
                `NIP-17 reply on thread ${payload.threadId.slice(0, 8)}... → ${recipientPubkey.slice(0, 12)}... (${payload.text.length} chars)`,
              );
              yield* Effect.tryPromise({
                try: () => sendReply(keyRow.value.seckeyHex, recipientPubkey, payload.text),
                catch: () => ({ _tag: "NostrDmStartupError" as const, detail: "Reply failed" }),
              }).pipe(Effect.catch(() => Effect.void));
            }).pipe(Effect.catch(() => Effect.void)),
          ),
        );
      },
      catch: (error) => ({
        _tag: "NostrDmStartupError" as const,
        detail: `NIP-17 gateway failed: ${error}`,
      }),
    });

  // ── Start: main lifecycle ───────────────────────────────────────
  const start: NostrDmGatewayShape["start"] = Effect.fn("Nip17Gateway.start")(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.catch(() =>
        Effect.flatMap(Effect.logError("Failed to read settings"), () => Effect.succeed(null)),
      ),
    );

    const explicitlyEnabled = settings?.nostrDm.enabled || !!process.env.BOT_NSEC;

    // Poll for thread keys — start subscriptions as soon as any exist
    yield* Effect.log("NIP-17 gateway: polling for thread keypairs...");
    yield* updateStatus({ status: "listening", activeMappings: 0 });

    yield* Effect.gen(function* () {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const keys = yield* threadKeysRepo
          .list()
          .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<NostrDmThreadKeyRow>)));

        if (keys.length > 0) {
          yield* Effect.log(
            `NIP-17 gateway: found ${keys.length} thread key(s). Connecting to ${DEFAULT_RELAYS.length} relays...`,
          );
          yield* updateStatus({ status: "connecting", activeMappings: keys.length });
          yield* startRelaySubscriptions(keys).pipe(Effect.catch(() => Effect.void));
          yield* updateStatus({ status: "listening", activeMappings: keys.length });
          yield* Effect.log("NIP-17 DM gateway started.");
          return;
        }

        if (!explicitlyEnabled) {
          // Not enabled and no keys — check less frequently
          yield* Effect.sleep("30 seconds");
        } else {
          yield* Effect.sleep("5 seconds");
        }
      }
    }).pipe(Effect.forkScoped);
  });

  return { start, getStatus } satisfies NostrDmGatewayShape;
});

export const Nip17GatewayLive = Layer.effect(NostrDmGateway, makeNip17Gateway);
