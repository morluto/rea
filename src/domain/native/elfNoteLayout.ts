import { BinaryReader } from "../binaryContainer.js";
import { err, ok } from "../result.js";

export const ELF_NOTE_HEADER_BYTES = 12;
export type ElfNoteAlignment = 4 | 8;

/** Which note section declarations can be walked at their raw file offsets. */
export const elfNoteSectionStorage = (section: {
  readonly type: number;
  readonly compressed: boolean;
}): "not-note" | "compressed" | "uncompressed" =>
  section.type !== 7
    ? "not-note"
    : section.compressed
      ? "compressed"
      : "uncompressed";

/** ELF note padding follows binutils: only a declared alignment of 8 uses 8. */
export const elfNoteAlignment = (
  declared: number | bigint,
): ElfNoteAlignment => (declared === 8 || declared === 8n ? 8 : 4);

/** Fixed ELF note words without interpreting the rest of the table. */
export const readElfNoteHeader = (bytes: Uint8Array, littleEndian: boolean) => {
  if (bytes.byteLength < ELF_NOTE_HEADER_BYTES)
    return err({
      kind: "malformed" as const,
      message: "ELF note header is truncated",
    });
  const prefix = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const reader = new BinaryReader(prefix, littleEndian, "ELF note");
  return ok({
    namesz: reader.u32(0),
    descsz: reader.u32(4),
    type: reader.u32(8),
  });
};

/**
 * Frame one note in the bytes left in its table. Align from the start of the
 * header. Preserve offsets on incomplete extents for bounded owner checks.
 */
export const readElfNoteFrame = (
  bytes: Uint8Array,
  littleEndian: boolean,
  alignment: ElfNoteAlignment,
  remaining: number,
) => {
  const header = readElfNoteHeader(bytes, littleEndian);
  if (!header.ok) return header;
  const { namesz, descsz, type } = header.value;
  const endOfName = ELF_NOTE_HEADER_BYTES + namesz;
  const descriptor = Math.ceil(endOfName / alignment) * alignment;
  const endOfDescriptor = descriptor + descsz;
  const next = Math.ceil(endOfDescriptor / alignment) * alignment;
  const framing =
    endOfName > remaining
      ? "truncated-name"
      : endOfDescriptor > remaining
        ? "truncated-descriptor"
        : next > remaining
          ? "truncated-padding"
          : "complete";
  return ok({ namesz, descsz, type, descriptor, next, framing });
};

/** A short remainder after the last aligned note may be zero padding. */
export const isElfNotePadding = (bytes: Uint8Array): boolean =>
  bytes.every((byte) => byte === 0);
