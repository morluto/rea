import { err, ok } from "./result.js";

export type ElfSectionHeader = Extract<
  ReturnType<typeof readElfSectionHeader>,
  { readonly ok: true }
>["value"];

/** Fixed ELF32/ELF64 section declarations; consumers own names, numbering and mapping admission. */
export const readElfSectionHeader = (
  bytes: Uint8Array,
  bits: 32 | 64,
  littleEndian: boolean,
) => {
  const wide = bits === 64;
  if (bytes.byteLength < (wide ? 64 : 40))
    return err({
      kind: "malformed" as const,
      message: "ELF section header is truncated",
    });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const word = (at: number): bigint =>
    wide
      ? view.getBigUint64(at, littleEndian)
      : BigInt(view.getUint32(at, littleEndian));
  const flags = word(8);
  return ok({
    nameOffset: view.getUint32(0, littleEndian),
    type: view.getUint32(4, littleEndian),
    flags,
    compressed: (flags & 0x800n) !== 0n,
    address: word(wide ? 16 : 12),
    offset: word(wide ? 24 : 16),
    size: word(wide ? 32 : 20),
    link: view.getUint32(wide ? 40 : 24, littleEndian),
    info: view.getUint32(wide ? 44 : 28, littleEndian),
    alignment: word(wide ? 48 : 32),
    entrySize: word(wide ? 56 : 36),
  });
};
