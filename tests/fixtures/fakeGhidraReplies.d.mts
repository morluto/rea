import type { JsonValue } from "../../src/domain/jsonValue.js";

type Params = Readonly<Record<string, JsonValue>>;

/** Every method the fake's handshake advertises on a writable bridge. */
export const FAKE_GHIDRA_CAPABILITIES: readonly string[];
export function fakeGhidraSessionInfo(options: {
  readonly runId: string;
  readonly providerVersion: string;
  readonly profileDigest: string;
  readonly targetSha256: string;
  readonly transport: "unix-socket" | "authenticated-loopback-tcp";
  readonly timedOut: boolean;
}): JsonValue;
export const FAKE_GHIDRA_SHUTDOWN_ACK: JsonValue;
export function fakeGhidraAddressNameReply(params?: Params): JsonValue;
export function fakeGhidraFileOffsetReply(address: string):
  | { readonly ok: true; readonly result: JsonValue }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };
export function fakeGhidraStringItem(address: string, value: string): JsonValue;

/** Successful inventory replies the fake Ghidra serves, keyed by method. */
export const FAKE_GHIDRA_INVENTORY_REPLIES: Readonly<
  Record<string, (params?: Params) => JsonValue>
>;
export function fakeGhidraInventoryReply(
  method: string,
  params?: Params,
): JsonValue | undefined;
/** Every inventory method fakeGhidraInventoryReply answers. */
export const FAKE_GHIDRA_INVENTORY_METHODS: readonly string[];
