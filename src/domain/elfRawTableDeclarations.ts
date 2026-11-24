import { BinaryReader } from "./binaryContainer.js";
import { elfFixedHeaderWidth } from "./elfFixedHeader.js";
import { err, ok } from "./result.js";

/** Fixed-header table words, before extended numbering or file-range admission. */
export const readElfRawTableDeclarations = (
  bytes: Uint8Array,
  format: { readonly elfClass: 32 | 64; readonly byteOrder: "little" | "big" },
) => {
  const { elfClass, byteOrder } = format;
  const wide = elfClass === 64;
  if (bytes.byteLength < elfFixedHeaderWidth(elfClass))
    return err({
      kind: "malformed" as const,
      message: "ELF table declarations are truncated",
    });
  const reader = new BinaryReader(
    Buffer.isBuffer(bytes)
      ? bytes
      : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    byteOrder === "little",
    "elf",
  );
  return ok({
    programs: {
      offset: reader.word(wide ? 32 : 28, elfClass),
      width: reader.u16(wide ? 54 : 42),
      count: reader.u16(wide ? 56 : 44),
    },
    sections: {
      offset: reader.word(wide ? 40 : 32, elfClass),
      width: reader.u16(wide ? 58 : 46),
      count: reader.u16(wide ? 60 : 48),
      namesIndex: reader.u16(wide ? 62 : 50),
    },
  });
};
