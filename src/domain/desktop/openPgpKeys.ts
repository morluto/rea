import { createHash } from "node:crypto";

import { err, ok, type Result } from "../result.js";
import { dearmorPublicKeys, isArmoredKey } from "./aptRepositories.js";

/** One transferable public key of a keyring: its packets as written, and its primary key's fingerprint. */
export interface TransferablePublicKey {
  readonly bytes: Buffer;
  /** Uppercase hex; undefined for a key version without a defined fingerprint. */
  readonly fingerprint: string | undefined;
}

const PUBLIC_KEY_TAG = 6;

/** A packet's tag and header and body lengths, from an old- or new-format header; partial and indeterminate lengths are refused. */
const packetHeader = (
  bytes: Buffer,
  at: number,
): { tag: number; header: number; body: number } | undefined => {
  const first = bytes[at] ?? 0;
  if ((first & 0x80) === 0) return undefined;
  if ((first & 0x40) === 0) {
    const width = [1, 2, 4][first & 0x03];
    if (width === undefined || at + 1 + width > bytes.length) return undefined;
    return {
      tag: (first >> 2) & 0x0f,
      header: 1 + width,
      body: bytes.readUIntBE(at + 1, width),
    };
  }
  const tag = first & 0x3f;
  const length = bytes[at + 1];
  if (length === undefined) return undefined;
  if (length < 192) return { tag, header: 2, body: length };
  if (length < 224) {
    const next = bytes[at + 2];
    return next === undefined
      ? undefined
      : { tag, header: 3, body: ((length - 192) << 8) + next + 192 };
  }
  if (length !== 255 || at + 6 > bytes.length) return undefined;
  return { tag, header: 6, body: bytes.readUInt32BE(at + 2) };
};

/** A primary key's fingerprint from its packet body: SHA-1 for version 4, SHA-256 for versions 5 and 6. */
const fingerprintOf = (body: Buffer): string | undefined => {
  const version = body[0];
  if (version === 4 && body.length <= 0xffff) {
    const prefix = Buffer.from([0x99, body.length >> 8, body.length & 0xff]);
    return createHash("sha1")
      .update(prefix)
      .update(body)
      .digest("hex")
      .toUpperCase();
  }
  if (version !== 5 && version !== 6) return undefined;
  const prefix = Buffer.alloc(5);
  prefix[0] = version === 5 ? 0x9a : 0x9b;
  prefix.writeUInt32BE(body.length, 1);
  return createHash("sha256")
    .update(prefix)
    .update(body)
    .digest("hex")
    .toUpperCase();
};

/**
 * A binary keyring split at each primary key packet; undefined unless it is a
 * sequence of whole packets that starts with one.
 */
export const transferablePublicKeys = (
  keyring: Buffer,
): readonly TransferablePublicKey[] | undefined => {
  const starts: { at: number; fingerprint: string | undefined }[] = [];
  for (let at = 0; at < keyring.length;) {
    const packet = packetHeader(keyring, at);
    const end =
      packet === undefined ? Infinity : at + packet.header + packet.body;
    if (packet === undefined || end > keyring.length) return undefined;
    if (packet.tag === PUBLIC_KEY_TAG)
      starts.push({
        at,
        fingerprint: fingerprintOf(keyring.subarray(at + packet.header, end)),
      });
    else if (starts.length === 0) return undefined;
    at = end;
  }
  return starts.map(({ at, fingerprint }, index) => ({
    bytes: keyring.subarray(at, starts[index + 1]?.at ?? keyring.length),
    fingerprint,
  }));
};

/**
 * What to keep of a key file whose key verified a release: the file as it is
 * when it holds one key, or else only the transferable key with the
 * verifying primary fingerprint, so the bundle trusts no other key.
 */
export const verifyingKey = (
  file: Buffer,
  primaryFingerprint: string,
): Result<
  { readonly bytes: Buffer; readonly format: "armored" | "binary" },
  string
> => {
  const armored = isArmoredKey(file);
  const keyring = armored ? dearmorPublicKeys(file) : file;
  const keys =
    keyring === undefined ? undefined : transferablePublicKeys(keyring);
  if (keys === undefined)
    return err("REA could not split the key file into OpenPGP keys");
  if (keys.length === 1)
    return ok({ bytes: file, format: armored ? "armored" : "binary" });
  const key = keys.find((each) => each.fingerprint === primaryFingerprint);
  return key === undefined
    ? err(
        `the key file holds ${String(keys.length)} keys and REA found none with the verifying fingerprint ${primaryFingerprint}`,
      )
    : ok({ bytes: Buffer.from(key.bytes), format: "binary" });
};
