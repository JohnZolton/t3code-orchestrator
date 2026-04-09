#!/usr/bin/env node --experimental-strip-types
/**
 * Send a single NIP-17 DM from the bot to a recipient.
 * Usage: node --experimental-strip-types scripts/nip17-send.ts <recipient-npub-or-hex> "message"
 */
import { decode as nip19decode, npubEncode } from "nostr-tools/nip19";
import { hexToBytes, bytesToHex } from "nostr-tools/utils";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { SimplePool } from "nostr-tools/pool";
import { encrypt as nip44encrypt, getConversationKey } from "nostr-tools/nip44";

function nostrKeyToHex(key: string): string {
  if (!key) return "";
  if (key.startsWith("npub1") || key.startsWith("nsec1")) {
    const decoded = nip19decode(key);
    const data = decoded.data;
    if (typeof data === "string") return data;
    if (data instanceof Uint8Array) return bytesToHex(data);
  }
  return key;
}

const BOT_NSEC_HEX = nostrKeyToHex(process.env.BOT_NSEC ?? "");
if (!BOT_NSEC_HEX) {
  console.error("BOT_NSEC required");
  process.exit(1);
}

const secBytes = hexToBytes(BOT_NSEC_HEX);
const botPubkey = getPublicKey(secBytes);

const recipientArg = process.argv[2] || process.env.AUTH_NPUB || "";
const message = process.argv[3] || "Hello from the bot! 🤖 If you see this, NIP-17 DMs work.";

const recipientHex = nostrKeyToHex(recipientArg);
if (!recipientHex) {
  console.error("Usage: nip17-send.ts <npub/hex> [message]");
  process.exit(1);
}

console.log(`Sending NIP-17 DM:`);
console.log(`  From: ${npubEncode(botPubkey)}`);
console.log(`  To:   ${npubEncode(recipientHex)}`);
console.log(`  Msg:  ${message}`);
console.log();

// NIP-59: randomize timestamps within 2 days for timing privacy
function randomTimestamp(): number {
  const now = Math.floor(Date.now() / 1000);
  return now - Math.floor(Math.random() * 2 * 24 * 60 * 60);
}

// Compute NIP-01 event ID
async function computeEventId(event: {
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}): Promise<string> {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
  return bytesToHex(new Uint8Array(hash));
}

// Build NIP-17: rumor (kind 14) → seal (kind 13) → gift wrap (kind 1059)
const rumorBase = {
  pubkey: botPubkey,
  created_at: Math.floor(Date.now() / 1000),
  kind: 14,
  tags: [["p", recipientHex]],
  content: message,
};
const rumorId = await computeEventId(rumorBase);
const rumor = { ...rumorBase, id: rumorId };

const sealConvKey = getConversationKey(secBytes, recipientHex);
const encryptedRumor = nip44encrypt(JSON.stringify(rumor), sealConvKey);
const seal = finalizeEvent(
  {
    kind: 13,
    created_at: randomTimestamp(),
    tags: [],
    content: encryptedRumor,
  },
  secBytes,
);

const randomSec = crypto.getRandomValues(new Uint8Array(32));
const wrapConvKey = getConversationKey(randomSec, recipientHex);
const encryptedSeal = nip44encrypt(JSON.stringify(seal), wrapConvKey);
const giftWrap = finalizeEvent(
  {
    kind: 1059,
    created_at: randomTimestamp(),
    tags: [["p", recipientHex]],
    content: encryptedSeal,
  },
  randomSec,
);

console.log(`Gift wrap event ID: ${(giftWrap as any).id}`);

// Look up recipient's inbox relays (NIP-17 spec: send to recipient's kind 10050 relays)
const pool = new SimplePool();
const discoveryRelays = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
  "wss://relay.primal.net",
  "wss://purplepag.es",
];
console.log("Looking up recipient's inbox relays (kind 10050)...");
const inboxEvents = await pool.querySync(discoveryRelays, {
  kinds: [10050, 10002],
  authors: [recipientHex],
  limit: 5,
} as any);
const inboxRelays: string[] = [];
// Prefer kind 10050 (DM inbox)
const dmInbox = inboxEvents.find((e: any) => e.kind === 10050);
const generalRelay = inboxEvents.find((e: any) => e.kind === 10002);
const relayEvent = dmInbox || generalRelay;
if (relayEvent) {
  for (const tag of (relayEvent as any).tags) {
    if ((tag[0] === "relay" || tag[0] === "r") && tag[1]) inboxRelays.push(tag[1]);
  }
}
// Fallback to discovery relays if no inbox found
const relays =
  inboxRelays.length > 0 ? [...new Set([...inboxRelays, ...discoveryRelays])] : discoveryRelays;
console.log(
  `Recipient inbox relays: ${inboxRelays.length > 0 ? inboxRelays.join(", ") : "(none found, using defaults)"}`,
);
console.log(`Publishing to: ${relays.join(", ")}`);

console.log(`Publishing to ${relays.length} relays...`);
const results = await Promise.allSettled(
  pool
    .publish(relays, giftWrap as any)
    .map((p) =>
      Promise.race([p, new Promise((_, reject) => setTimeout(() => reject("timeout"), 5000))]),
    ),
);

const acked = results.filter((r) => r.status === "fulfilled" && r.value !== "timeout").length;
const timeouts = results.filter(
  (r) => r.status === "rejected" || (r.status === "fulfilled" && r.value === "timeout"),
).length;
console.log(`✅ Published to ${acked}/${relays.length} relays (${timeouts} timed out)`);

pool.close(relays);
setTimeout(() => process.exit(0), 1000);
