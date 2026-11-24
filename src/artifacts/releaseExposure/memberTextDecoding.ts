import { isUtf8 } from "node:buffer";

import { hasBinaryPlistSignature } from "../../domain/apple/appleArchiveFormat.js";
import { decodeBinaryPlistText } from "../../domain/apple/binaryPlistMaterializer.js";
import { InternalInvariantError } from "../../domain/internalInvariant.js";
import { byteOrderMarkEncoding } from "../../domain/textByteOrderMark.js";

const RELEASE_EXPOSURE_PLIST_DECODE_BYTES = 16 * 1024 * 1024;
const MEMBER_ENCODING_HEADER_BYTES = 512;
const WIDE_TEXT_NUL_DIVISOR = 8;

/** Text decoded from a member; `complete` is false when part of it went unread. */
export interface MemberText {
  readonly text: string;
  readonly complete: boolean;
}

/**
 * A binary plist that cannot be fully decoded keeps its raw bytes in the scan,
 * for the ASCII strings they show, beside whatever text it did decode, but its
 * other strings were not examined.
 */
const decodeBinaryPlistMember = (bytes: Buffer): MemberText => {
  try {
    const decoded = decodeBinaryPlistText(
      bytes,
      RELEASE_EXPOSURE_PLIST_DECODE_BYTES,
    );
    return decoded.complete
      ? decoded
      : { text: `${decoded.text}\n${bytes.toString("utf8")}`, complete: false };
  } catch (cause: unknown) {
    // A broken internal assumption is a REA defect, not an undecodable plist.
    if (cause instanceof InternalInvariantError) throw cause;
    return { text: bytes.toString("utf8"), complete: false };
  }
};

/**
 * Bytes that name their own text encoding, whose NULs are that encoding's
 * structure rather than a sign of binary data. `decodeMemberText` reads each of
 * these; a probe that admits on NULs alone would drop them unexamined.
 */
export const declaresTextEncoding = (bytes: Buffer): boolean =>
  byteOrderMarkEncoding(bytes) !== null || hasBinaryPlistSignature(bytes);

const cachedTextDecoders = new Map<string, TextDecoder>();
export const getCachedTextDecoder = (
  encoding: string,
  fatal: boolean,
): TextDecoder => {
  const key = `${encoding}:${fatal ? "1" : "0"}`;
  let decoder = cachedTextDecoders.get(key);
  if (decoder === undefined) {
    decoder = new TextDecoder(encoding, { fatal });
    cachedTextDecoders.set(key, decoder);
  }
  return decoder;
};

/** Retain visible text after a decoding error without calling the read complete. */
export const decodeDeclaredText = (
  bytes: Buffer,
  encoding: string,
): MemberText => {
  try {
    return {
      text: getCachedTextDecoder(encoding, true).decode(bytes),
      complete: true,
    };
  } catch (cause: unknown) {
    if (!(cause instanceof TypeError)) throw cause;
    return {
      text: getCachedTextDecoder(encoding, false).decode(bytes),
      complete: false,
    };
  }
};

/**
 * Wide text is valid UTF-8 when its characters are ASCII, so validity alone
 * cannot separate it from UTF-8 holding a NUL. Density can: UTF-16 puts a NUL in
 * every other byte of each ASCII character, and a stray NUL is one byte of many.
 */
export const hasNonUtf8Nul = (bytes: Buffer): boolean => {
  const len = Math.min(bytes.length, MEMBER_ENCODING_HEADER_BYTES);
  let nuls = 0;
  for (let i = 0; i < len; i += 1) {
    if (bytes[i] === 0) {
      nuls += 1;
      if (nuls * WIDE_TEXT_NUL_DIVISOR >= len) return true;
    }
  }
  return nuls > 0 && !isUtf8(bytes);
};

/**
 * The text a member's bytes encode, or null when they cannot be read as text.
 * A member's kind says nothing about its encoding: wide text has no byte order
 * mark to explain its NULs, and a scan of it would match nothing and still count
 * as complete. A NUL inside UTF-8 text does not change how the rest of it reads.
 * A binary plist has its own object encoding, so its owner decodes it.
 */
export const decodeMemberText = (bytes: Buffer): MemberText | null => {
  const encoding = byteOrderMarkEncoding(bytes);
  if (encoding === "utf-32") return null;
  if (encoding !== null) return decodeDeclaredText(bytes, encoding);
  if (hasBinaryPlistSignature(bytes)) return decodeBinaryPlistMember(bytes);
  if (hasNonUtf8Nul(bytes)) return null;
  return { text: bytes.toString("utf8"), complete: isUtf8(bytes) };
};
