import type { BinaryReader } from "../binaryContainer.js";
import { type Result, err, ok } from "../result.js";

/** ZIP APPNOTE §4.3.12. The three variable fields follow the fixed header in order. */
export const ZIP_CENTRAL_HEADER = {
  signature: 0x02014b50,
  bytes: 46,
  nameBytesOffset: 28,
  extraBytesOffset: 30,
  commentBytesOffset: 32,
  localHeaderOffset: 42,
} as const;

type ZipCentralExtent = {
  readonly name: number;
  readonly extra: number;
  readonly comment: number;
  readonly next: number;
};

type ZipCentralExtentError = {
  readonly kind: "fixed-fields" | "signature" | "name" | "extra-or-comment";
  readonly offset: number;
};

/**
 * Admit the entire record against the containing directory. A positional
 * probe can supply just the fixed bytes, which are all this calculation reads.
 */
export const readZipCentralExtent = (
  reader: BinaryReader,
  at: number,
  end: number,
): Result<ZipCentralExtent, ZipCentralExtentError> => {
  const layout = ZIP_CENTRAL_HEADER;
  const name = at + layout.bytes;
  if (at < 0 || name > end || name > reader.bytes.length)
    return err({ kind: "fixed-fields", offset: at });
  if (reader.u32(at) !== layout.signature)
    return err({ kind: "signature", offset: at });
  const extra = name + reader.u16(at + layout.nameBytesOffset);
  if (extra > end) return err({ kind: "name", offset: name });
  const comment = extra + reader.u16(at + layout.extraBytesOffset);
  const next = comment + reader.u16(at + layout.commentBytesOffset);
  if (next > end) return err({ kind: "extra-or-comment", offset: extra });
  return ok({ name, extra, comment, next });
};
