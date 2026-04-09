import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas";

// ── Branded IDs ─────────────────────────────────────────────────────

export const MlsGroupId = TrimmedNonEmptyString.pipe(Schema.brand("MlsGroupId"));
export type MlsGroupId = typeof MlsGroupId.Type;

export const NostrPubkey = TrimmedNonEmptyString.pipe(Schema.brand("NostrPubkey"));
export type NostrPubkey = typeof NostrPubkey.Type;

export const NostrDmMessageId = TrimmedNonEmptyString.pipe(Schema.brand("NostrDmMessageId"));
export type NostrDmMessageId = typeof NostrDmMessageId.Type;

// ── Relay Configuration ─────────────────────────────────────────────

export const NostrDmRelayConfig = Schema.Struct({
  nip65Relays: Schema.Array(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(() => [])),
  inboxRelays: Schema.Array(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(() => [])),
  bootstrapRelays: Schema.Array(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(() => [])),
});
export type NostrDmRelayConfig = typeof NostrDmRelayConfig.Type;

// ── Nostr DM Settings ──────────────────────────────────────────────

export const NostrDmSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  pollIntervalMs: NonNegativeInt.pipe(Schema.withDecodingDefault(() => 5000)),
  pubkey: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  seckey: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  relays: NostrDmRelayConfig.pipe(Schema.withDecodingDefault(() => ({}))),
  allowedSenders: Schema.Array(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(() => [])),
  defaultProjectId: Schema.optional(TrimmedNonEmptyString),
});
export type NostrDmSettings = typeof NostrDmSettings.Type;

export const DEFAULT_NOSTR_DM_SETTINGS: NostrDmSettings = Schema.decodeSync(NostrDmSettings)({});

// ── Settings Patch (for WS updates — seckey excluded) ───────────────

export const NostrDmSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  pollIntervalMs: Schema.optionalKey(NonNegativeInt),
  relays: Schema.optionalKey(
    Schema.Struct({
      nip65Relays: Schema.optionalKey(Schema.Array(Schema.String)),
      inboxRelays: Schema.optionalKey(Schema.Array(Schema.String)),
      bootstrapRelays: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
  allowedSenders: Schema.optionalKey(Schema.Array(Schema.String)),
  defaultProjectId: Schema.optionalKey(Schema.String),
});
export type NostrDmSettingsPatch = typeof NostrDmSettingsPatch.Type;

// ── Inbound / Outbound Message Envelopes ────────────────────────────

export const NostrDmInboundDm = Schema.Struct({
  senderPubkey: NostrPubkey,
  mlsGroupId: MlsGroupId,
  messageId: NostrDmMessageId,
  content: Schema.String,
  timestamp: IsoDateTime,
});
export type NostrDmInboundDm = typeof NostrDmInboundDm.Type;

export const NostrDmOutboundReply = Schema.Struct({
  mlsGroupId: MlsGroupId,
  content: TrimmedNonEmptyString,
  botPubkey: NostrPubkey,
});
export type NostrDmOutboundReply = typeof NostrDmOutboundReply.Type;

// ── Group ↔ Thread Mapping ──────────────────────────────────────────

export const NostrDmGroupMapping = Schema.Struct({
  mlsGroupId: MlsGroupId,
  threadId: TrimmedNonEmptyString,
  projectId: TrimmedNonEmptyString,
  senderPubkey: NostrPubkey,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type NostrDmGroupMapping = typeof NostrDmGroupMapping.Type;

// ── Transport Status ────────────────────────────────────────────────

export const NostrDmTransportStatus = Schema.Literals([
  "disabled",
  "connecting",
  "listening",
  "error",
]);
export type NostrDmTransportStatus = typeof NostrDmTransportStatus.Type;

export const NostrDmStatus = Schema.Struct({
  status: NostrDmTransportStatus,
  lastMessageAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String),
  activeMappings: NonNegativeInt,
  botPubkey: Schema.NullOr(Schema.String),
});
export type NostrDmStatus = typeof NostrDmStatus.Type;

// ── WS Method & Channel Constants ───────────────────────────────────

// ── Thread Npub ─────────────────────────────────────────────────────

export const ThreadNpubInfo = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  npub: TrimmedNonEmptyString,
  pubkeyHex: TrimmedNonEmptyString,
});
export type ThreadNpubInfo = typeof ThreadNpubInfo.Type;

export const AllowedPubkeyInfo = Schema.Struct({
  pubkeyHex: TrimmedNonEmptyString,
  npub: TrimmedNonEmptyString,
  label: Schema.NullOr(Schema.String),
});
export type AllowedPubkeyInfo = typeof AllowedPubkeyInfo.Type;

// ── RPC Method Names ────────────────────────────────────────────────

export const NOSTR_DM_WS_METHODS = {
  getStatus: "nostrDm.getStatus",
  getThreadNpub: "nostrDm.getThreadNpub",
  addAllowedPubkey: "nostrDm.addAllowedPubkey",
  removeAllowedPubkey: "nostrDm.removeAllowedPubkey",
  listAllowedPubkeys: "nostrDm.listAllowedPubkeys",
} as const;

// ── RPC Definitions ─────────────────────────────────────────────────

export const NostrDmGetStatusRpc = Rpc.make(NOSTR_DM_WS_METHODS.getStatus, {
  payload: Schema.Struct({}),
  success: NostrDmStatus,
});

export const NostrDmGetThreadNpubRpc = Rpc.make(NOSTR_DM_WS_METHODS.getThreadNpub, {
  payload: Schema.Struct({ threadId: TrimmedNonEmptyString }),
  success: ThreadNpubInfo,
});

export const NostrDmAddAllowedPubkeyRpc = Rpc.make(NOSTR_DM_WS_METHODS.addAllowedPubkey, {
  payload: Schema.Struct({
    pubkey: TrimmedNonEmptyString,
    label: Schema.optional(Schema.String),
  }),
  success: AllowedPubkeyInfo,
});

export const NostrDmRemoveAllowedPubkeyRpc = Rpc.make(NOSTR_DM_WS_METHODS.removeAllowedPubkey, {
  payload: Schema.Struct({ pubkeyHex: TrimmedNonEmptyString }),
  success: Schema.Struct({ ok: Schema.Boolean }),
});

export const NostrDmListAllowedPubkeysRpc = Rpc.make(NOSTR_DM_WS_METHODS.listAllowedPubkeys, {
  payload: Schema.Struct({}),
  success: Schema.Array(AllowedPubkeyInfo),
});

// ── RPC Group (self-contained, merged into WsRpcGroup in rpc.ts) ────

export const NostrDmRpcGroup = RpcGroup.make(
  NostrDmGetStatusRpc,
  NostrDmGetThreadNpubRpc,
  NostrDmAddAllowedPubkeyRpc,
  NostrDmRemoveAllowedPubkeyRpc,
  NostrDmListAllowedPubkeysRpc,
);
