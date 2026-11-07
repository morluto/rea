import { err, ok } from "../result.js";

/** ELF note padding follows binutils: only a declared alignment of 8 uses 8. */
export const elfNoteAlignment = (declared: number | bigint): number =>
  declared === 8 || declared === 8n ? 8 : 4;

/** Descriptor and next-note offsets relative to the note's 12-byte header. */
export const elfNoteLayout = (
  namesz: number,
  descsz: number,
  alignment: number,
) => {
  const descriptor = Math.ceil((12 + namesz) / alignment) * alignment;
  return {
    descriptor,
    next: Math.ceil((descriptor + descsz) / alignment) * alignment,
  };
};

/** Fixed ELF note words; padding, owner names and descriptor admission belong to consumers. */
export const readElfNoteHeader = (bytes: Uint8Array, littleEndian: boolean) => {
  if (bytes.byteLength < 12)
    return err({
      kind: "malformed" as const,
      message: "ELF note header is truncated",
    });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return ok({
    namesz: view.getUint32(0, littleEndian),
    descsz: view.getUint32(4, littleEndian),
    type: view.getUint32(8, littleEndian),
  });
};

/**
 * Locate the note at stream offset `at`. Offsets align from the start of the
 * note: rounding namesz and descsz independently disagrees with binutils when
 * alignment is 8, because the 12-byte header is not 8-aligned (a GNU property
 * note with namesz 4 starts its descriptor at 16, not 20). A note whose aligned
 * extent leaves the stream is malformed; owners and descriptors belong to
 * consumers.
 */
export const readElfNoteRecord = (
  stream: Uint8Array,
  at: number,
  littleEndian: boolean,
  alignment: number,
) => {
  const header = readElfNoteHeader(stream.subarray(at, at + 12), littleEndian);
  if (!header.ok) return header;
  const { namesz, descsz, type } = header.value;
  const layout = elfNoteLayout(namesz, descsz, alignment);
  if (layout.next > stream.byteLength - at)
    return err({
      kind: "malformed" as const,
      message: "ELF note entry exceeds its table.",
    });
  return ok({
    namesz,
    descsz,
    type,
    /** Stream offset of the descriptor. */
    descriptor: at + layout.descriptor,
    /** Stream offset of the next note. */
    next: at + layout.next,
  });
};

/** Bytes after the last whole note are padding only when shorter than a header and zero. */
export const isElfNotePadding = (tail: Uint8Array): boolean =>
  tail.byteLength < 12 && tail.every((byte) => byte === 0);
