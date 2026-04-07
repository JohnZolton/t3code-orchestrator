/**
 * Generate a Nostr keypair for a thread.
 *
 * Uses nostr-tools to generate a random secret key and derive the public key.
 * Returns hex strings ready for storage.
 *
 * @module generateKeypair
 */
import { getPublicKey, generateSecretKey } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import { npubEncode } from "nostr-tools/nip19";

export interface ThreadKeypair {
  readonly seckeyHex: string;
  readonly pubkeyHex: string;
  readonly npub: string;
}

/** Convert a hex pubkey to npub bech32 format. */
export function npubFromHex(pubkeyHex: string): string {
  return npubEncode(pubkeyHex);
}

export function generateThreadKeypair(): ThreadKeypair {
  const secBytes = generateSecretKey();
  const seckeyHex = bytesToHex(secBytes);
  const pubkeyHex = getPublicKey(secBytes);
  const npub = npubEncode(pubkeyHex);
  return { seckeyHex, pubkeyHex, npub };
}
