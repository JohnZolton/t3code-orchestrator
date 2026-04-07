#!/usr/bin/env node --experimental-strip-types
/**
 * NIP-17 Direct Message listener.
 *
 * Listens for encrypted Nostr DMs (NIP-17 via NIP-44 + NIP-59 gift wraps).
 * No MLS, no key packages, no groups — just simple encrypted DMs.
 *
 * Env vars (from .env):
 *   BOT_NSEC  – bot's secret key (nsec1… or hex)
 *   BOT_NPUB  – bot's public key (npub1… or hex, optional — derived from nsec)
 *   AUTH_NPUB – your pubkey (only sender allowed to DM the bot)
 *
 * Usage:
 *   node --experimental-strip-types apps/server/scripts/nip17-listen.ts
 */

import { decode as nip19decode, npubEncode } from "nostr-tools/nip19";
import { hexToBytes, bytesToHex } from "nostr-tools/utils";
import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { SimplePool } from "nostr-tools/pool";
import {
  encrypt as nip44encrypt,
  decrypt as nip44decrypt,
  getConversationKey,
} from "nostr-tools/nip44";

// ── Catch unhandled errors ───────────────────────────────────────────
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

// ── Helpers ──────────────────────────────────────────────────────────

function nostrKeyToHex(key: string): string {
  if (!key) return "";
  if (key.startsWith("npub1") || key.startsWith("nsec1")) {
    const decoded = nip19decode(key);
    if (decoded.type === "npub" || decoded.type === "nsec") {
      const data = decoded.data;
      if (typeof data === "string") return data;
      if (data instanceof Uint8Array) return bytesToHex(data);
    }
  }
  return key;
}

// ── Config ───────────────────────────────────────────────────────────

const BOT_NSEC_HEX = nostrKeyToHex(process.env.BOT_NSEC ?? "");
const AUTH_NPUB_HEX = nostrKeyToHex(process.env.AUTH_NPUB ?? "");

if (!BOT_NSEC_HEX) {
  console.error("BOT_NSEC env var is required");
  process.exit(1);
}

const secBytes = hexToBytes(BOT_NSEC_HEX);
const botPubkeyHex = getPublicKey(secBytes);

const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
  "wss://relay.primal.net",
  "wss://purplepag.es",
  "wss://inbox.nostr.wine",
  "wss://relay.0xchat.com",
  "wss://auth.nostr1.com",
];

console.log("╔══════════════════════════════════════════════════╗");
console.log("║          NIP-17 DM Listener (standalone)        ║");
console.log("╠══════════════════════════════════════════════════╣");
console.log(`║  Bot npub: ${npubEncode(botPubkeyHex)}`);
console.log(`║  Bot hex:  ${botPubkeyHex}`);
console.log(`║  Auth hex: ${AUTH_NPUB_HEX || "(all senders)"}`);
console.log("╚══════════════════════════════════════════════════╝");
console.log();

// ── NIP-59 Gift Wrap Decryption ─────────────────────────────────────

interface Rumor {
  id?: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

/**
 * Unwrap a NIP-59 gift wrap (kind 1059) to extract the inner rumor.
 *
 * NIP-59 structure:
 *   Gift wrap (kind 1059, signed by random ephemeral key)
 *     → Seal (kind 13, NIP-44 encrypted with sender's real key)
 *       → Rumor (kind 14 = DM, unsigned inner event)
 */
function unwrapGiftWrap(event: any): Rumor | null {
  try {
    // The gift wrap's content is NIP-44 encrypted to us by the ephemeral key (event.pubkey)
    const conversationKey = getConversationKey(secBytes, event.pubkey);
    const sealJson = nip44decrypt(event.content, conversationKey);
    const seal = JSON.parse(sealJson);

    // The seal (kind 13) is encrypted by the real sender's key
    if (seal.kind !== 13) {
      console.log(`  [unwrap] Expected seal kind 13, got ${seal.kind}`);
      return null;
    }

    // Decrypt the seal's content using the real sender's pubkey
    const senderConversationKey = getConversationKey(secBytes, seal.pubkey);
    const rumorJson = nip44decrypt(seal.content, senderConversationKey);
    const rumor: Rumor = JSON.parse(rumorJson);

    // The rumor's pubkey should match the seal's pubkey (the real sender)
    rumor.pubkey = seal.pubkey;

    return rumor;
  } catch (e: any) {
    console.error(`  [unwrap] Failed to decrypt gift wrap:`, e?.message ?? e);
    return null;
  }
}

/**
 * Create and send a NIP-17 DM reply.
 *
 * NIP-17 structure (outbound):
 *   1. Create rumor (kind 14, unsigned)
 *   2. Wrap in seal (kind 13, NIP-44 encrypted, signed by us)
 *   3. Wrap in gift wrap (kind 1059, NIP-44 encrypted, signed by random key)
 */
/** Random timestamp within the last 2 days (NIP-59 spec for timing privacy). */
function randomTimestamp(): number {
  const now = Math.floor(Date.now() / 1000);
  const twoDays = 2 * 24 * 60 * 60;
  return now - Math.floor(Math.random() * twoDays);
}

/** Compute a NIP-01 event ID (SHA-256 of the serialized event). */
async function computeEventId(event: { pubkey: string; created_at: number; kind: number; tags: string[][]; content: string }): Promise<string> {
  const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
  return bytesToHex(new Uint8Array(hash));
}

async function createGiftWrappedDm(
  recipientPubkey: string,
  content: string,
): Promise<any> {
  // 1. Rumor (kind 14 = NIP-17 DM, NOT signed, but must have id)
  const rumorBase = {
    pubkey: botPubkeyHex,
    created_at: Math.floor(Date.now() / 1000),
    kind: 14,
    tags: [["p", recipientPubkey]],
    content,
  };
  const rumorId = await computeEventId(rumorBase);
  const rumor = { ...rumorBase, id: rumorId };

  // 2. Seal (kind 13, encrypt rumor, sign with our key, randomized timestamp)
  const sealConversationKey = getConversationKey(secBytes, recipientPubkey);
  const encryptedRumor = nip44encrypt(JSON.stringify(rumor), sealConversationKey);

  const sealEvent = finalizeEvent(
    {
      kind: 13,
      created_at: randomTimestamp(),
      tags: [],
      content: encryptedRumor,
    },
    secBytes,
  );

  // 3. Gift wrap (kind 1059, encrypt seal, sign with random ephemeral key, randomized timestamp)
  const randomSecBytes = crypto.getRandomValues(new Uint8Array(32));

  const wrapConversationKey = getConversationKey(randomSecBytes, recipientPubkey);
  const encryptedSeal = nip44encrypt(JSON.stringify(sealEvent), wrapConversationKey);

  const giftWrap = finalizeEvent(
    {
      kind: 1059,
      created_at: randomTimestamp(),
      tags: [["p", recipientPubkey]],
      content: encryptedSeal,
    },
    randomSecBytes,
  );

  return giftWrap;
}

// ── Main ─────────────────────────────────────────────────────────────

const pool = new SimplePool();

async function main() {
  console.log("[boot] Connecting to relays...");
  for (const relay of DEFAULT_RELAYS) {
    try {
      pool.ensureRelay(relay);
      console.log(`  ✓ ${relay}`);
    } catch (e) {
      console.warn(`  ✗ ${relay}:`, e);
    }
  }

  console.log("[boot] Waiting 2s for connections...");
  await new Promise((r) => setTimeout(r, 2000));

  // Publish NIP-65 relay list (kind 10002) and DM inbox relays (kind 10050)
  // so other clients know where to send us gift wraps
  console.log("[boot] Publishing relay list (kind 10002) and DM inbox relays (kind 10050)...");
  const relayTags = DEFAULT_RELAYS.map((r) => ["relay", r]);
  const relayListEvent = finalizeEvent(
    {
      kind: 10002,
      created_at: Math.floor(Date.now() / 1000),
      tags: DEFAULT_RELAYS.map((r) => ["r", r]),
      content: "",
    },
    secBytes,
  );
  const inboxRelayEvent = finalizeEvent(
    {
      kind: 10050,
      created_at: Math.floor(Date.now() / 1000),
      tags: relayTags,
      content: "",
    },
    secBytes,
  );
  try {
    await Promise.allSettled([
      ...pool.publish(DEFAULT_RELAYS, relayListEvent as any).map((p) =>
        Promise.race([p, new Promise((r) => setTimeout(r, 5000))]),
      ),
      ...pool.publish(DEFAULT_RELAYS, inboxRelayEvent as any).map((p) =>
        Promise.race([p, new Promise((r) => setTimeout(r, 5000))]),
      ),
    ]);
    console.log("[boot] ✅ Relay lists published.");
  } catch (e: any) {
    console.warn("[boot] ⚠️  Relay list publish failed:", e?.message);
  }

  // Subscribe to gift wraps (kind 1059) addressed to us
  console.log("[listen] Subscribing to kind 1059 gift wraps for our pubkey...");

  const seen = new Set<string>();

  pool.subscribeMany(
    DEFAULT_RELAYS,
    { kinds: [1059], "#p": [botPubkeyHex] } as any,
    {
      onevent: async (event: any) => {
        // Dedup
        if (seen.has(event.id)) return;
        seen.add(event.id);

        console.log(`\n📨  Gift wrap received (id: ${event.id?.slice(0, 12)}...)`);

        // Unwrap NIP-59 → NIP-44 → get the rumor
        const rumor = unwrapGiftWrap(event);
        if (!rumor) return;

        console.log(`  ✅ Decrypted! kind=${rumor.kind}, from=${rumor.pubkey?.slice(0, 12)}...`);

        // NIP-17 DMs are kind 14
        if (rumor.kind !== 14) {
          console.log(`  ℹ️  Not a DM (kind ${rumor.kind}), skipping.`);
          return;
        }

        // Allowlist check
        if (AUTH_NPUB_HEX && rumor.pubkey !== AUTH_NPUB_HEX) {
          console.log(`  ⛔ Sender not in allowlist.`);
          return;
        }

        const sender = rumor.pubkey.slice(0, 12);
        console.log();
        console.log(`💬  DM from ${sender}...`);
        console.log(`    Content: ${rumor.content}`);
        console.log(`    Time: ${new Date(rumor.created_at * 1000).toISOString()}`);

        // Auto-reply — send to recipient's inbox relays
        const replyText = `[bot] Got your message: "${rumor.content.slice(0, 100)}${rumor.content.length > 100 ? "..." : ""}"`;
        console.log(`    📤 Sending reply...`);

        try {
          const giftWrap = await createGiftWrappedDm(rumor.pubkey, replyText);

          // Look up sender's inbox relays
          let replyRelays = [...DEFAULT_RELAYS];
          try {
            const inboxEvents = await pool.querySync(DEFAULT_RELAYS, { kinds: [10050, 10002], authors: [rumor.pubkey], limit: 3 } as any);
            const dmInbox = (inboxEvents as any[]).find((e) => e.kind === 10050);
            const genRelay = (inboxEvents as any[]).find((e) => e.kind === 10002);
            const relayEvent = dmInbox || genRelay;
            if (relayEvent) {
              const inboxUrls = relayEvent.tags
                .filter((t: string[]) => t[0] === "relay" || t[0] === "r")
                .map((t: string[]) => t[1])
                .filter(Boolean);
              replyRelays = [...new Set([...inboxUrls, ...DEFAULT_RELAYS])];
              console.log(`    Inbox relays: ${inboxUrls.join(", ")}`);
            }
          } catch {}

          await Promise.allSettled(
            pool.publish(replyRelays, giftWrap as any).map((p) =>
              Promise.race([p, new Promise((r) => setTimeout(r, 5000))]),
            ),
          );
          console.log(`    ✅ Reply sent to ${replyRelays.length} relays!`);
        } catch (e: any) {
          console.error(`    ❌ Reply failed:`, e?.message ?? e);
        }
      },

      oneose: () => {
        console.log("[listen] End of stored events. Listening for new DMs...");
      },
    },
  );

  console.log();
  console.log("═══════════════════════════════════════════════════");
  console.log("  🟢 Listening for NIP-17 DMs...");
  console.log(`  Send a DM to: ${npubEncode(botPubkeyHex)}`);
  console.log("  (Use any NIP-17 client: Amethyst, Primal, 0xchat, etc.)");
  console.log("  Press Ctrl+C to stop.");
  console.log("═══════════════════════════════════════════════════");
  console.log();

  // Keep alive
  await new Promise(() => {});
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
