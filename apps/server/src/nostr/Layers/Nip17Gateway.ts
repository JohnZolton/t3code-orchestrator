/**
 * Nip17Gateway - NIP-17 DM gateway for per-thread Nostr identities.
 *
 * Durable across restarts:
 * - Thread keypairs persisted in SQLite
 * - Owner pubkey from AUTH_NPUB env var (reply recipient)
 * - Polls for new thread keys and hot-adds relay subscriptions
 * - Inbox relays published per thread on keypair creation
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
import { NostrAllowedPubkeysRepository } from "../../persistence/Services/NostrAllowedPubkeys.ts";

import { NostrDmGateway, type NostrDmGatewayShape } from "../Services/NostrDmGateway.ts";

import { SimplePool } from "nostr-tools/pool";
import { getConversationKey, decrypt as nip44decrypt, encrypt as nip44encrypt } from "nostr-tools/nip44";
import { hexToBytes, bytesToHex } from "nostr-tools/utils";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { decode as nip19decode } from "nostr-tools/nip19";

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
const KEY_POLL_INTERVAL_MS = 10_000;

/** Resolve owner pubkey from env (npub1 or hex). */
function resolveOwnerPubkey(): string | null {
  const raw = process.env.AUTH_NPUB ?? "";
  if (!raw) return null;
  if (raw.startsWith("npub1")) {
    try {
      // Dynamic import would be async, so decode inline with the sync nip19 trick:
      // npub1 bech32 → 32 bytes → hex. We'll do this at runtime in the async block.
      return raw; // Return as-is, decode in async context
    } catch {
      return null;
    }
  }
  return raw;
}

const makeNip17Gateway = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const settingsService = yield* ServerSettingsService;
  const threadKeysRepo = yield* NostrDmThreadKeysRepository;
  const allowedPubkeysRepo = yield* NostrAllowedPubkeysRepository;

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

  // ── Start: main lifecycle ───────────────────────────────────────
  const start: NostrDmGatewayShape["start"] = Effect.fn("Nip17Gateway.start")(function* () {
    // Suppress relay connection errors
    process.on("unhandledRejection", (reason: unknown) => {
      if (typeof reason === "string" && (reason === "connection failed" || reason.includes("WebSocket"))) {
        return;
      }
      console.error("[NIP-17 gateway] unhandled rejection:", reason);
    });

    yield* Effect.log("NIP-17 gateway: starting...");
    yield* updateStatus({ status: "listening", activeMappings: 0 });

    yield* Effect.gen(function* () {
      // Wait for first keys to appear
      let keys: ReadonlyArray<NostrDmThreadKeyRow> = [];
      while (keys.length === 0) {
        keys = yield* threadKeysRepo
          .list()
          .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<NostrDmThreadKeyRow>)));
        if (keys.length === 0) {
          yield* Effect.sleep(`${KEY_POLL_INTERVAL_MS} millis`);
        }
      }

      // Load allowed pubkeys from DB
      let allowedPubkeys = yield* allowedPubkeysRepo
        .list()
        .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<{ pubkeyHex: string }>)));

      // Also seed from AUTH_NPUB env var if set and not already in DB
      const rawOwner = process.env.AUTH_NPUB ?? "";
      if (rawOwner) {
        let envPubkeyHex: string | null = null;
        if (rawOwner.startsWith("npub1")) {
          try {
            const decoded = nip19decode(rawOwner);
            envPubkeyHex = typeof decoded.data === "string"
              ? decoded.data
              : bytesToHex(decoded.data as Uint8Array);
          } catch {}
        } else if (rawOwner.length === 64) {
          envPubkeyHex = rawOwner;
        }
        if (envPubkeyHex && !allowedPubkeys.some((p) => p.pubkeyHex === envPubkeyHex)) {
          yield* allowedPubkeysRepo
            .add({ pubkeyHex: envPubkeyHex as any, label: "from AUTH_NPUB env", createdAt: new Date().toISOString() })
            .pipe(Effect.catch(() => Effect.void));
          // Reload
          allowedPubkeys = yield* allowedPubkeysRepo
            .list()
            .pipe(Effect.catch(() => Effect.succeed(allowedPubkeys)));
        }
      }

      const allowedSet = new Set(allowedPubkeys.map((p) => p.pubkeyHex));

      if (allowedSet.size === 0) {
        yield* Effect.logWarning("NIP-17 gateway: no allowed pubkeys configured — DMs disabled.");
        yield* Effect.logWarning("NIP-17 gateway: add a pubkey via the UI or set AUTH_NPUB in .env.");
        return;
      }

      yield* Effect.log(`NIP-17 gateway: ${allowedSet.size} allowed pubkey(s).`);

      const pool = new SimplePool();
      for (const relay of DEFAULT_RELAYS) {
        try { pool.ensureRelay(relay); } catch {}
      }

      // Shared state for subscriptions
      const pubkeyToThreadId = new Map(keys.map((k) => [k.pubkeyHex, k.threadId]));
      const threadIdToSeckey = new Map(keys.map((k) => [k.threadId, k.seckeyHex]));
      const knownPubkeys = new Set(keys.map((k) => k.pubkeyHex));
      const seen = new Set<string>();
      const threadLastSender = new Map<string, string>(); // threadId → sender pubkey hex

      yield* Effect.log(`NIP-17 gateway: ${keys.length} key(s). Connecting to ${DEFAULT_RELAYS.length} relays...`);

      // ── NIP-17 helpers ──────────────────────────────────────────
      function createGiftWrap(senderSecBytes: Uint8Array, senderPubkey: string, recipientPubkey: string, content: string) {
        const now = Math.floor(Date.now() / 1000);
        const twoDays = 2 * 24 * 60 * 60;
        const randomTs = () => now - Math.floor(Math.random() * twoDays);
        const rumor = {
          id: crypto.randomUUID().replace(/-/g, "").slice(0, 64),
          pubkey: senderPubkey, created_at: now, kind: 14,
          tags: [["p", recipientPubkey]], content,
        };
        const sealConvKey = getConversationKey(senderSecBytes, recipientPubkey);
        const seal = finalizeEvent(
          { kind: 13, created_at: randomTs(), tags: [], content: nip44encrypt(JSON.stringify(rumor), sealConvKey) },
          senderSecBytes,
        );
        const ephSec = crypto.getRandomValues(new Uint8Array(32));
        const wrapConvKey = getConversationKey(ephSec, recipientPubkey);
        return finalizeEvent(
          { kind: 1059, created_at: randomTs(), tags: [["p", recipientPubkey]], content: nip44encrypt(JSON.stringify(seal), wrapConvKey) },
          ephSec,
        );
      }

      async function getRecipientRelays(pubkey: string): Promise<string[]> {
        try {
          const events = await pool.querySync(DEFAULT_RELAYS, { kinds: [10050, 10002], authors: [pubkey], limit: 3 } as any);
          const relayEvent = (events as any[]).find((e: any) => e.kind === 10050) || (events as any[]).find((e: any) => e.kind === 10002);
          if (relayEvent) {
            const urls = relayEvent.tags.filter((t: string[]) => t[0] === "relay" || t[0] === "r").map((t: string[]) => t[1]).filter(Boolean);
            if (urls.length > 0) return [...new Set([...urls, ...DEFAULT_RELAYS])];
          }
        } catch {}
        return DEFAULT_RELAYS;
      }

      async function sendReply(threadSecHex: string, recipientPubkey: string, content: string) {
        const secBytes = hexToBytes(threadSecHex);
        const senderPub = getPublicKey(secBytes);
        const relays = await getRecipientRelays(recipientPubkey);
        const chunks = content.length <= MAX_DM_LENGTH ? [content]
          : Array.from({ length: Math.ceil(content.length / MAX_DM_LENGTH) }, (_, i) => content.slice(i * MAX_DM_LENGTH, (i + 1) * MAX_DM_LENGTH));
        for (const chunk of chunks) {
          const gw = createGiftWrap(secBytes, senderPub, recipientPubkey, chunk);
          await Promise.allSettled(pool.publish(relays, gw as any).map((p: Promise<any>) => Promise.race([p, new Promise((r) => setTimeout(r, 5000))])));
        }
      }

      // ── Inbound handler (shared by all subscriptions) ───────────
      function handleGiftWrap(event: any) {
        if (seen.has(event.id)) return;
        seen.add(event.id);
        if (seen.size > 50_000) { const e = [...seen]; for (let i = 0; i < 25_000; i++) seen.delete(e[i]!); }

        const pTags = (event.tags ?? []).filter((t: string[]) => t[0] === "p").map((t: string[]) => t[1]);
        let targetThreadId: string | null = null;
        let targetSecHex: string | null = null;
        for (const p of pTags) {
          const tid = pubkeyToThreadId.get(p);
          if (tid) { targetThreadId = tid; targetSecHex = threadIdToSeckey.get(tid) ?? null; break; }
        }
        if (!targetThreadId || !targetSecHex) return;

        const secBytes = hexToBytes(targetSecHex);
        try {
          const convKey = getConversationKey(secBytes, event.pubkey);
          const seal = JSON.parse(nip44decrypt(event.content, convKey));
          if (seal.kind !== 13) return;
          const rumor = JSON.parse(nip44decrypt(seal.content, getConversationKey(secBytes, seal.pubkey)));
          rumor.pubkey = seal.pubkey;
          if (rumor.kind !== 14 || !rumor.content?.trim()) return;

          // ── Allowlist: only accept DMs from allowed pubkeys ──────
          if (!allowedSet.has(rumor.pubkey)) {
            return; // Silently drop DMs from unknown senders
          }

          // Track sender for outbound replies
          const threadId = targetThreadId;
          const messageText: string = rumor.content.trim();
          threadLastSender.set(threadId, rumor.pubkey);

          // ── Command parsing: !kill, !stop, !status ──────────────
          const cmd = messageText.toLowerCase();
          if (cmd === "!kill" || cmd === "!stop" || cmd === "!interrupt") {
            Effect.runFork(
              Effect.gen(function* () {
                yield* Effect.log(`NIP-17 command: ${cmd} on thread ${threadId.slice(0, 8)}...`);
                yield* orchestrationEngine.dispatch({
                  type: "thread.turn.interrupt",
                  commandId: serverCommandId("nip17-interrupt"),
                  threadId: threadId as ThreadId,
                  createdAt: new Date().toISOString(),
                } as any);
              }).pipe(Effect.catch(() => Effect.void)),
            );
            return;
          }

          if (cmd === "!restart" || cmd === "!reset") {
            Effect.runFork(
              Effect.gen(function* () {
                yield* Effect.log(`NIP-17 command: ${cmd} on thread ${threadId.slice(0, 8)}...`);
                // Interrupt current turn first, then stop session
                yield* orchestrationEngine.dispatch({
                  type: "thread.turn.interrupt",
                  commandId: serverCommandId("nip17-interrupt"),
                  threadId: threadId as ThreadId,
                  createdAt: new Date().toISOString(),
                } as any).pipe(Effect.catch(() => Effect.void));
                yield* orchestrationEngine.dispatch({
                  type: "thread.session.stop",
                  commandId: serverCommandId("nip17-session-stop"),
                  threadId: threadId as ThreadId,
                  createdAt: new Date().toISOString(),
                } as any).pipe(Effect.catch(() => Effect.void));
              }).pipe(Effect.catch(() => Effect.void)),
            );
            return;
          }

          // ── Normal message: dispatch as a turn ──────────────────
          Effect.runFork(
            Effect.gen(function* () {
              yield* Effect.log(`NIP-17 DM on thread ${threadId.slice(0, 8)}...: "${messageText.slice(0, 50)}"`);
              yield* orchestrationEngine.dispatch({
                type: "thread.turn.start",
                commandId: serverCommandId("nip17-turn"),
                threadId: threadId as ThreadId,
                message: { messageId: serverMessageId(), role: "user" as const, text: messageText, attachments: [] },
                runtimeMode: "full-access",
                interactionMode: "default",
                createdAt: new Date().toISOString(),
              } as any);
              yield* updateStatus({ lastMessageAt: new Date().toISOString() });
            }).pipe(Effect.catch(() => Effect.void)),
          );
        } catch {}
      }

      // ── Start initial subscription ──────────────────────────────
      const allPubkeys = [...knownPubkeys];
      pool.subscribeMany(DEFAULT_RELAYS, { kinds: [1059], "#p": allPubkeys } as any, {
        onevent: handleGiftWrap,
        oneose: () => {},
      });

      yield* updateStatus({ status: "listening", activeMappings: knownPubkeys.size });
      yield* Effect.log("NIP-17 DM gateway started.");

      // ── Outbound replies ────────────────────────────────────────
      Effect.runFork(
        Stream.runForEach(orchestrationEngine.streamDomainEvents, (event: OrchestrationEvent) =>
          Effect.gen(function* () {
            if (event.type !== "thread.message-sent") return;
            const payload = (event as any).payload;
            if (payload.role !== "assistant" || !payload.text?.trim()) return;

            const keyRow = yield* threadKeysRepo
              .getByThreadId({ threadId: payload.threadId })
              .pipe(Effect.catch(() => Effect.succeed(Option.none())));
            if (Option.isNone(keyRow)) return;

            // Reply to whoever last DM'd this thread
            const recipientPubkey = threadLastSender.get(payload.threadId);
            if (!recipientPubkey || !allowedSet.has(recipientPubkey)) return;

            yield* Effect.log(
              `NIP-17 reply → ${recipientPubkey.slice(0, 12)}... (${payload.text.length} chars)`,
            );
            yield* Effect.tryPromise({
              try: () => sendReply(keyRow.value.seckeyHex, recipientPubkey, payload.text),
              catch: () => ({ _tag: "NostrDmError" as const, detail: "Reply failed" }),
            }).pipe(Effect.catch(() => Effect.void));
          }).pipe(Effect.catch(() => Effect.void)),
        ),
      );

      // ── Poll for new keys, hot-add subscriptions ────────────────
      while (true) {
        yield* Effect.sleep(`${KEY_POLL_INTERVAL_MS} millis`);
        const allKeys = yield* threadKeysRepo.list().pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<NostrDmThreadKeyRow>)));
        const newKeys = allKeys.filter((k) => !knownPubkeys.has(k.pubkeyHex));
        if (newKeys.length > 0) {
          yield* Effect.log(`NIP-17 gateway: +${newKeys.length} new thread key(s)`);
          for (const key of newKeys) {
            knownPubkeys.add(key.pubkeyHex);
            pubkeyToThreadId.set(key.pubkeyHex, key.threadId);
            threadIdToSeckey.set(key.threadId, key.seckeyHex);
          }
          pool.subscribeMany(DEFAULT_RELAYS, { kinds: [1059], "#p": newKeys.map((k) => k.pubkeyHex) } as any, {
            onevent: handleGiftWrap,
            oneose: () => {},
          });
          yield* updateStatus({ activeMappings: knownPubkeys.size });
        }
      }
    }).pipe(Effect.forkScoped);
  });

  return { start, getStatus } satisfies NostrDmGatewayShape;
});

export const Nip17GatewayLive = Layer.effect(NostrDmGateway, makeNip17Gateway);
