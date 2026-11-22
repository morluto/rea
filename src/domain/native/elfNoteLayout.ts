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

/**
 * The note padding a declared `sh_addralign` selects, as GNU readelf reads one
 * section's notes: up to 4 pads to 4 and 8 pads to 8. Readelf reports any other
 * value as a corrupt note and reads none of that section's notes, so it selects
 * no padding here.
 */
export const declaredElfNoteAlignment = (
  declared: bigint,
): ElfNoteAlignment | undefined =>
  declared <= 4n ? 4 : declared === 8n ? 8 : undefined;

const LE_NOTE_READERS = new WeakMap<Uint8Array, BinaryReader>();
const BE_NOTE_READERS = new WeakMap<Uint8Array, BinaryReader>();

const cachedElfNoteReader = (
  bytes: Uint8Array,
  littleEndian: boolean,
): BinaryReader => {
  const cache = littleEndian ? LE_NOTE_READERS : BE_NOTE_READERS;
  let reader = cache.get(bytes);
  if (reader === undefined) {
    const buffer = Buffer.isBuffer(bytes)
      ? bytes
      : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    reader = new BinaryReader(buffer, littleEndian, "ELF note");
    cache.set(bytes, reader);
  }
  return reader;
};

/** Fixed ELF note words without interpreting the rest of the table. */
export const readElfNoteHeader = (
  bytes: Uint8Array,
  littleEndian: boolean,
  offset = 0,
) => {
  if (offset < 0 || bytes.byteLength - offset < ELF_NOTE_HEADER_BYTES)
    return err({
      kind: "malformed" as const,
      message: "ELF note header is truncated",
    });
  const reader = cachedElfNoteReader(bytes, littleEndian);
  return ok({
    namesz: reader.u32(offset),
    descsz: reader.u32(offset + 4),
    type: reader.u32(offset + 8),
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
  offset = 0,
) => {
  const header = readElfNoteHeader(bytes, littleEndian, offset);
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
export const isElfNotePadding = (bytes: Uint8Array): boolean => {
  for (let i = 0; i < bytes.byteLength; i += 1) {
    if (bytes[i] !== 0) return false;
  }
  return true;
};

export type ElfNoteSpan = { readonly offset: number; readonly size: number };

export const sortElfNoteSpans = <T extends ElfNoteSpan>(
  spans: readonly T[],
): T[] =>
  spans.filter(({ size }) => size > 0).toSorted((a, b) => a.offset - b.offset);

/**
 * Overlap queries over spans sorted once. A section table can hold hundreds of
 * thousands of headers, so a query must not rescan the spans.
 */
export const elfNoteSpanOverlapIndex = (spans: readonly ElfNoteSpan[]) => {
  const sorted: ElfNoteSpan[] = [];
  for (const span of sortElfNoteSpans(spans)) {
    const previous = sorted.at(-1);
    if (
      previous !== undefined &&
      span.offset <= previous.offset + previous.size
    )
      sorted[sorted.length - 1] = {
        offset: previous.offset,
        size: Math.max(
          previous.size,
          span.offset + span.size - previous.offset,
        ),
      };
    else sorted.push(span);
  }
  return ({ offset, size }: ElfNoteSpan): "none" | "covered" | "partial" => {
    if (size <= 0) return "none";
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((sorted[middle]?.offset ?? 0) < offset + size) low = middle + 1;
      else high = middle;
    }
    const span = sorted[low - 1];
    if (span === undefined || span.offset + span.size <= offset) return "none";
    return span.offset <= offset && span.offset + span.size >= offset + size
      ? "covered"
      : "partial";
  };
};
