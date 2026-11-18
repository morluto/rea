/** Codecs Linux kernel images and modules are compressed with. */
export type KernelCompressionCodec =
  | "gzip"
  | "bzip2"
  | "lzma"
  | "xz"
  | "lzo"
  | "lz4"
  | "zstd";

/**
 * Stream magic numbers in the order `lib/decompress.c` checks them. gzip is
 * the RFC 1952 ID1/ID2 pair; the compression method byte is left to the gzip
 * reader. The lzma, bzip2, and lz4 magics are longer than the kernel's own
 * 2-byte checks so arbitrary bytes are less likely to be named as a codec.
 */
const MAGICS: readonly {
  readonly codec: KernelCompressionCodec;
  readonly magic: Buffer;
}[] = [
  { codec: "gzip", magic: Buffer.from([0x1f, 0x8b]) },
  { codec: "bzip2", magic: Buffer.from("BZh") },
  { codec: "lzma", magic: Buffer.from([0x5d, 0x00, 0x00]) },
  { codec: "xz", magic: Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]) },
  { codec: "lzo", magic: Buffer.from([0x89, 0x4c, 0x5a]) },
  { codec: "lz4", magic: Buffer.from([0x02, 0x21, 0x4c, 0x18]) },
  { codec: "zstd", magic: Buffer.from([0x28, 0xb5, 0x2f, 0xfd]) },
];

/** The first of `accepted` whose magic starts at `offset`, or null. */
export const kernelCompressionCodecAt = <C extends KernelCompressionCodec>(
  bytes: Buffer,
  offset: number,
  accepted: readonly C[],
): C | null => {
  for (const { codec, magic } of MAGICS)
    if (
      (accepted as readonly KernelCompressionCodec[]).includes(codec) &&
      offset + magic.length <= bytes.length &&
      bytes.subarray(offset, offset + magic.length).equals(magic)
    )
      return codec as C;
  return null;
};
