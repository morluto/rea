import { crc32 } from "node:zlib";

import {
  N64_CHECKSUM_END,
  N64_CIC_6105_TABLE_OFFSET,
  N64_CIC_VARIANTS,
  N64_IPL3_END,
  N64_IPL3_OFFSET,
  n64CartridgeCrc,
  registerN64TestCic,
  swapN64Bytes,
  type N64ByteOrder,
  type N64CicVariant,
} from "./n64Rom.js";

/**
 * Synthetic Nintendo 64 ROMs. The IPL3 block is a test pattern, not a
 * commercial boot code. Its CRC32 is registered only through
 * {@link registerN64TestCic} so the domain table of published hashes stays
 * frozen. Importing this module registers the stubs.
 */

const IPL3_BYTES = N64_IPL3_END - N64_IPL3_OFFSET;

const ipl3Stub = (seedByte: number, lut: boolean): Buffer => {
  const bytes = Buffer.alloc(IPL3_BYTES);
  for (let index = 0; index < bytes.length; index++)
    bytes[index] = (seedByte + index) & 0xff;
  if (lut) {
    // CIC 6105 reads this table; the stub starts at the IPL3 offset.
    const table = N64_CIC_6105_TABLE_OFFSET - N64_IPL3_OFFSET;
    for (let index = 0; index < 0x100; index += 4)
      bytes.writeUInt32BE((0x0101_0101 * (index / 4 + 1)) >>> 0, table + index);
  }
  return bytes;
};

const published = (id: N64CicVariant["id"]): N64CicVariant => {
  const variant = N64_CIC_VARIANTS.find((row) => row.id === id);
  if (variant === undefined) throw new Error(`missing CIC ${id}`);
  return variant;
};

const registerStub = (
  id: N64CicVariant["id"],
  bytes: Buffer,
): { readonly bytes: Buffer; readonly variant: N64CicVariant } => {
  const source = published(id);
  const variant = {
    id,
    ipl3Crc32: crc32(bytes) >>> 0,
    seed: source.seed,
    usesLut: source.usesLut,
  } satisfies N64CicVariant;
  registerN64TestCic(variant);
  return { bytes, variant };
};

const stub6102 = registerStub("6102/7101", ipl3Stub(0x11, false));
const stub6105 = registerStub("6105/7105", ipl3Stub(0x22, true));
const stubUnknown = ipl3Stub(0x80, false);

/** IPL3 bytes the synthetic images carry. `unknown` is not a registered CIC. */
export const N64_FIXTURE_IPL3 = {
  "6102/7101": stub6102.bytes,
  "6105/7105": stub6105.bytes,
  unknown: stubUnknown,
} as const;

const stubFor = (
  cic: "6102/7101" | "6105/7105" | "unknown",
): { readonly bytes: Buffer; readonly variant: N64CicVariant | undefined } => {
  if (cic === "6105/7105") return stub6105;
  if (cic === "unknown") return { bytes: stubUnknown, variant: undefined };
  return stub6102;
};

export interface N64RomFixtureOptions {
  readonly order?: N64ByteOrder;
  /** Which registered test stub to embed. `unknown` is a third unregistered pattern. */
  readonly cic?: "6102/7101" | "6105/7105" | "unknown";
  /** Write the computed pair, or write CRC1 off by one. Ignored when CIC is unknown. */
  readonly crc?: "match" | "mismatch";
  /** Build the full 0x1000..0x101000 checksum window instead of a short image. */
  readonly fullWindow?: boolean;
  /** Stop at 0x80 so IPL3 is incomplete. */
  readonly truncatedIpl3?: boolean;
  readonly bootAddress?: number;
  /** Non-zero value stored at reserved header offset 0x18. */
  readonly reservedByte?: number;
  readonly title?: string;
  /** Bytes placed at 0x1000. Omitted for a truncated IPL3. */
  readonly program?: Buffer;
}

export interface N64FixtureImage {
  readonly order: N64ByteOrder;
  /** Big-endian image the reader serves as `program.z64`. */
  readonly normalized: Buffer;
  /** Image in `order`, the bytes a dump would contain. */
  readonly encoded: Buffer;
}

const DEFAULT_PROGRAM = Buffer.from("PROGPROG", "ascii");

/** Build one synthetic ROM in big-endian order and in the requested dump order. */
export const n64RomImage = (
  options: N64RomFixtureOptions = {},
): N64FixtureImage => {
  const order = options.order ?? "z64";
  const cic = options.cic ?? "6102/7101";
  const program = options.program ?? DEFAULT_PROGRAM;
  const size = options.truncatedIpl3
    ? 0x80
    : options.fullWindow
      ? N64_CHECKSUM_END
      : N64_IPL3_END + program.length + ((4 - (program.length % 4)) % 4);
  const normalized = Buffer.alloc(size);
  normalized.writeUInt32BE(0x8037_1240, 0);
  normalized.writeUInt32BE(0x0f, 4);
  normalized.writeUInt32BE(options.bootAddress ?? 0x8000_0400, 8);
  normalized.writeUInt32BE(0x20, 0x0c);
  const title = Buffer.alloc(20, 0x20);
  Buffer.from(options.title ?? "REA TEST", "latin1").copy(title, 0, 0, 20);
  title.copy(normalized, 0x20);
  if (options.reservedByte !== undefined)
    normalized[0x18] = options.reservedByte & 0xff;
  normalized[0x3b] = 0x4e;
  normalized.write("RE", 0x3c, "ascii");
  normalized[0x3e] = 0x45;
  normalized[0x3f] = 1;
  const stub = stubFor(cic);
  if (size >= N64_IPL3_END) stub.bytes.copy(normalized, N64_IPL3_OFFSET);
  if (size > N64_IPL3_END)
    program.copy(
      normalized,
      N64_IPL3_END,
      0,
      Math.min(program.length, size - N64_IPL3_END),
    );
  if (stub.variant !== undefined && size >= N64_IPL3_END) {
    const computed = n64CartridgeCrc(normalized, stub.variant);
    normalized.writeUInt32BE(
      options.crc === "mismatch" ? (computed.crc1 ^ 1) >>> 0 : computed.crc1,
      0x10,
    );
    normalized.writeUInt32BE(computed.crc2, 0x14);
  }
  return {
    order,
    normalized,
    encoded: Buffer.from(swapN64Bytes(normalized, order)),
  };
};

/** Encoded dump bytes for {@link n64RomImage}. */
export const n64RomFixture = (options?: N64RomFixtureOptions): Buffer =>
  n64RomImage(options).encoded;
