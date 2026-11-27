import { crc32 } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  n64RomEntryMetadataSchema,
  n64RomMetadataSchema,
} from "./formatMetadata/packageAndGameMetadata.js";
import { ParseFailureError } from "./parseFailure.js";
import {
  N64_CHECKSUM_END,
  N64_CIC_VARIANTS,
  N64_FORMAT,
  N64_HEADER_BYTES,
  N64_MAX_ROM_BYTES,
  N64_ROM_BYTES_LIMIT,
  n64BootAddressPlausible,
  n64CartridgeCrc,
  n64RomRecognition,
  parseN64Rom,
  swapN64Bytes,
  type N64ByteOrder,
} from "./n64Rom.js";
import {
  N64_FIXTURE_IPL3,
  n64RomImage,
  type N64RomFixtureOptions,
} from "./n64Rom.fixture.js";

const failureOf = (bytes: Uint8Array, fileSize = bytes.length): unknown => {
  try {
    parseN64Rom(bytes, fileSize);
  } catch (cause) {
    return cause;
  }
  throw new Error("parse succeeded");
};

const parsed = (options?: N64RomFixtureOptions) => {
  const image = n64RomImage(options);
  const result = parseN64Rom(image.encoded, image.encoded.length);
  n64RomMetadataSchema.parse(result.metadata);
  for (const entry of result.entries)
    n64RomEntryMetadataSchema.parse(entry.metadata);
  return { image, ...result };
};

/**
 * Line-by-line port of the public n64crc reference, in BigInt so it shares no
 * 32-bit arithmetic with the implementation under test.
 */
const referenceCrc = (
  rom: Uint8Array,
  bootcode: 6102 | 6103 | 6105 | 6106,
): readonly [number, number] => {
  const mask = 0xffff_ffffn;
  const word = (at: number): bigint =>
    BigInt(
      Buffer.from(rom.buffer, rom.byteOffset, rom.length).readUInt32BE(at),
    );
  const rol = (value: bigint, bits: bigint): bigint =>
    ((value << bits) | (value >> (32n - bits))) & mask;
  const seed = {
    6102: 0xf8ca4ddcn,
    6103: 0xa3886759n,
    6105: 0xdf26f436n,
    6106: 0x1fea617an,
  }[bootcode];
  let [t1, t2, t3, t4, t5, t6] = [seed, seed, seed, seed, seed, seed];
  for (let i = 0x1000; i < 0x1000 + 0x100000; i += 4) {
    const d = word(i);
    if (((t6 + d) & mask) < t6) t4 = (t4 + 1n) & mask;
    t6 = (t6 + d) & mask;
    t3 ^= d;
    const r = rol(d, d & 0x1fn);
    t5 = (t5 + r) & mask;
    if (t2 > d) t2 ^= r;
    else t2 ^= t6 ^ d;
    if (bootcode === 6105)
      t1 = (t1 + (word(0x40 + 0x710 + (i & 0xff)) ^ d)) & mask;
    else t1 = (t1 + (t5 ^ d)) & mask;
  }
  if (bootcode === 6103)
    return [Number(((t6 ^ t4) + t3) & mask), Number(((t5 ^ t2) + t1) & mask)];
  if (bootcode === 6106)
    return [Number((t6 * t4 + t3) & mask), Number((t5 * t2 + t1) & mask)];
  return [Number(t6 ^ t4 ^ t3), Number(t5 ^ t2 ^ t1)];
};

/** A full checksum window of xorshift noise with a non-zero 6105 table. */
const noiseRom = (): Buffer => {
  const rom = Buffer.alloc(N64_CHECKSUM_END);
  let state = 0x1234_5678;
  for (let offset = 0x40; offset < rom.length; offset += 4) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    rom.writeUInt32BE(state >>> 0, offset);
  }
  return rom;
};

describe("Nintendo 64 ROM domain", () => {
  it("matches the n64crc reference for every CIC seed and combine rule", () => {
    const rom = noiseRom();
    const variant = (id: string) => {
      const row = N64_CIC_VARIANTS.find((entry) => entry.id === id);
      if (row === undefined) throw new Error(id);
      return row;
    };
    const cases = [
      ["6102/7101", 6102],
      ["6103/7103", 6103],
      ["6105/7105", 6105],
      ["6106/7106", 6106],
    ] as const;
    for (const [id, bootcode] of cases) {
      const computed = n64CartridgeCrc(rom, variant(id));
      expect([computed.crc1, computed.crc2], id).toEqual(
        referenceCrc(rom, bootcode),
      );
    }
    // 6101 shares the 6102 routine.
    expect(n64CartridgeCrc(rom, variant("6101"))).toEqual(
      n64CartridgeCrc(rom, variant("6102/7101")),
    );
    // Hand check on an all-zero window: every word d is 0, so t6, t4, t3 and
    // t5 keep the seed, t2 > d always XORs rol(0) = 0 and keeps the seed, and
    // t1 adds t5 ^ 0 = seed once per each of the 0x40000 words.
    const zero = Buffer.alloc(N64_CHECKSUM_END);
    const seed = 0xf8ca_4ddc;
    expect(n64CartridgeCrc(zero, variant("6102/7101"))).toEqual({
      crc1: seed,
      crc2: (seed + Math.imul(seed, 0x4_0000)) >>> 0,
    });
  });

  it("uses the IEEE CRC32 check value for IPL3 identification", () => {
    expect(crc32(Buffer.from("123456789")) >>> 0).toBe(0xcbf4_3926);
  });

  it("normalizes z64, v64 and n64 to the same header facts", () => {
    const orders = [
      "z64",
      "v64",
      "n64",
    ] as const satisfies readonly N64ByteOrder[];
    const images = orders.map((order) => parsed({ order }));
    const [z64, v64, n64] = images;
    expect(z64?.metadata).toMatchObject({
      kind: "n64-rom",
      source_order: "z64",
      pi_dom1_config: 0x8037_1240,
      clock_rate: 0x0f,
      boot_address: 0x8000_0400,
      libultra_release: 0x20,
      cic: "6102/7101",
      title_ascii: "REA TEST            ",
      media_byte: 0x4e,
      media_name: "cartridge",
      cartridge_id: "RE",
      cartridge_id_hex: "5245",
      destination_byte: 0x45,
      destination_code: "E",
      destination_name: "North America",
      version: 1,
      crc: { status: "match" },
    });
    expect(v64?.metadata).toEqual({ ...z64?.metadata, source_order: "v64" });
    expect(n64?.metadata).toEqual({ ...z64?.metadata, source_order: "n64" });
    expect(v64?.limitations).toEqual(z64?.limitations);
    expect(z64?.metadata.ipl3_crc32).toBe(
      crc32(N64_FIXTURE_IPL3["6102/7101"]) >>> 0,
    );
    expect(z64?.entries.map((entry) => entry.path)).toEqual([
      "header.bin",
      "ipl3.bin",
      "program.z64",
    ]);
    expect(z64?.entries.map((entry) => entry.metadata.decoded)).toEqual([
      false,
      false,
      false,
    ]);
    expect(v64?.entries.map((entry) => entry.metadata.decoded)).toEqual([
      true,
      true,
      true,
    ]);
    for (const image of images) {
      const magic = Buffer.from(
        image.metadata.source_order === "z64"
          ? [0x80, 0x37, 0x12, 0x40]
          : image.metadata.source_order === "v64"
            ? [0x37, 0x80, 0x40, 0x12]
            : [0x40, 0x12, 0x37, 0x80],
      );
      expect(image.image.encoded.subarray(0, 4).equals(magic)).toBe(true);
      expect(
        Buffer.from(
          swapN64Bytes(image.image.encoded, image.metadata.source_order),
        ).equals(image.image.normalized),
      ).toBe(true);
    }
  });

  it("keeps a JIS X 0201 title byte in the raw hex and replaces it in ASCII", () => {
    const title = Buffer.alloc(20, 0x20);
    title[0] = 0xa1;
    title.write("A", 1, "ascii");
    const { metadata } = parsed({ title: title.toString("latin1") });
    expect(metadata.title_raw_hex.startsWith("a141")).toBe(true);
    expect(metadata.title_ascii.startsWith(".A")).toBe(true);
    expect(metadata.title_ascii).toHaveLength(20);
  });

  it("names an unknown media or destination byte without inventing a label", () => {
    const image = n64RomImage();
    image.normalized[0x3b] = 0x01;
    image.normalized[0x3e] = 0x01;
    const encoded = Buffer.from(swapN64Bytes(image.normalized, "z64"));
    const { metadata } = parseN64Rom(encoded, encoded.length);
    expect(metadata.media_name).toBeNull();
    expect(metadata.media_byte).toBe(1);
    expect(metadata.destination_name).toBeNull();
    expect(metadata.destination_byte).toBe(1);
    expect(metadata.destination_code).toBe("?");
  });

  it("keeps a printable destination byte outside the known table", () => {
    const image = n64RomImage();
    image.normalized[0x3e] = 0x51;
    const encoded = Buffer.from(swapN64Bytes(image.normalized, "z64"));
    const { metadata } = parseN64Rom(encoded, encoded.length);
    // Unknown is the null name; the code keeps the printable source byte.
    expect(metadata).toMatchObject({
      destination_byte: 0x51,
      destination_code: "Q",
      destination_name: null,
    });
  });

  it("matches the checksum's closed form on an all-zero window", () => {
    // Derived by hand from the IPL3 checksum routine (Project64
    // CalculateRomCrc, n64crc), not from n64CartridgeCrc: with every word 0
    // no accumulator changes except t1, which adds t5 (the seed) on each of
    // the 0x40000 words, so t1 ends at seed * 0x40001. A zero 6105 table
    // leaves t1 at the seed.
    const window = new Uint8Array(N64_CHECKSUM_END);
    const times = (a: number, b: number): number => Math.imul(a, b) >>> 0;
    for (const variant of N64_CIC_VARIANTS) {
      const seed = variant.seed;
      const t1 = variant.usesLut ? seed : times(seed, 0x4_0001);
      const expected =
        variant.id === "6103/7103"
          ? { crc1: seed, crc2: t1 }
          : variant.id === "6106/7106"
            ? {
                crc1: (times(seed, seed) + seed) >>> 0,
                crc2: (times(seed, seed) + t1) >>> 0,
              }
            : { crc1: seed, crc2: t1 };
      expect(n64CartridgeCrc(window, variant), variant.id).toEqual(expected);
    }
  });

  it("keeps the present bytes of a final partial word in a short checksum window", () => {
    const base = n64RomImage();
    const variant = N64_CIC_VARIANTS.find((row) => row.id === "6102/7101");
    if (variant === undefined) throw new Error("missing 6102 row");
    const baseCrc = parseN64Rom(base.encoded, base.encoded.length).metadata.crc;
    for (const [order, tail] of [
      ["z64", [0x5a]],
      ["z64", [0x5a, 0x5b]],
      ["z64", [0x5a, 0x5b, 0x5c]],
      ["v64", [0x5a, 0x5b]],
    ] as const) {
      // Big-endian content, then stored in the dump's own order.
      const content = Buffer.concat([base.normalized, Buffer.from(tail)]);
      const encoded = Buffer.from(swapN64Bytes(content, order));
      const { metadata, limitations } = parseN64Rom(encoded, encoded.length);
      // The same bytes padded explicitly with zeros to the window end.
      const padded = Buffer.alloc(N64_CHECKSUM_END);
      content.copy(padded);
      const expected = n64CartridgeCrc(padded, variant);
      const label = `${order} + ${String(tail.length)} bytes`;
      expect(metadata.crc.computed_crc1, label).toBe(expected.crc1);
      expect(metadata.crc.computed_crc2, label).toBe(expected.crc2);
      // The tail bytes change the result, so they were not dropped.
      expect(
        [metadata.crc.computed_crc1, metadata.crc.computed_crc2],
        label,
      ).not.toEqual([baseCrc.computed_crc1, baseCrc.computed_crc2]);
      expect(metadata.crc.status, label).toBe("mismatch");
      expect(limitations.join("\n"), label).toContain(
        `${String(N64_CHECKSUM_END - encoded.length)} bytes past the file were taken as zero`,
      );
    }
  });

  it("checks a full checksum window and reports a CRC mismatch", () => {
    const match = parsed({ fullWindow: true });
    expect(match.metadata.crc.status).toBe("match");
    expect(match.metadata.rom_bytes).toBe(N64_CHECKSUM_END);
    expect(match.limitations).toEqual([]);

    const mismatch = parsed({ fullWindow: true, crc: "mismatch" });
    expect(mismatch.metadata.crc.status).toBe("mismatch");
    expect(mismatch.metadata.crc.computed_crc1).not.toBe(
      mismatch.metadata.crc.declared_crc1,
    );
    expect(mismatch.limitations.join("\n")).toContain("Declared CRC1");
  });

  it("zero-pads a short checksum window and still reports the pair", () => {
    const { metadata, limitations } = parsed();
    expect(metadata.crc.status).toBe("match");
    expect(metadata.rom_bytes).toBeLessThan(N64_CHECKSUM_END);
    expect(limitations.join("\n")).toContain("taken as zero");
  });

  it("mixes the 6105 boot-code table into the checksum", () => {
    const image = n64RomImage({ cic: "6105/7105", fullWindow: true });
    const withLut = parsed({ cic: "6105/7105", fullWindow: true });
    expect(withLut.metadata.cic).toBe("6105/7105");
    expect(withLut.metadata.crc.status).toBe("match");
    expect(withLut.limitations).toEqual([]);
    const variant = {
      id: "6105/7105" as const,
      ipl3Crc32: withLut.metadata.ipl3_crc32 ?? 0,
      seed: 0xdf26_f436,
      usesLut: false,
    };
    // The table only feeds t1, so it changes CRC2 and leaves CRC1 alone.
    const withoutLut = n64CartridgeCrc(image.normalized, variant);
    expect(withoutLut.crc1).toBe(withLut.metadata.crc.computed_crc1);
    expect(withoutLut.crc2).not.toBe(withLut.metadata.crc.computed_crc2);
    expect([
      withLut.metadata.crc.computed_crc1,
      withLut.metadata.crc.computed_crc2,
    ]).toEqual(referenceCrc(image.normalized, 6105));
    expect(image.normalized.readUInt32BE(0x750)).not.toBe(0);
  });

  it("leaves the CRC unchecked when the IPL3 hash is unknown or the boot code is short", () => {
    const unknown = parsed({ cic: "unknown" });
    expect(unknown.metadata.cic).toBe("unknown");
    expect(unknown.metadata.crc).toMatchObject({
      status: "not-checked",
      computed_crc1: null,
      computed_crc2: null,
    });
    expect(unknown.limitations.join("\n")).toContain(
      "matches none of the known CIC",
    );

    const short = parsed({ truncatedIpl3: true });
    expect(short.metadata.ipl3_crc32).toBeNull();
    expect(short.metadata.cic).toBe("unknown");
    expect(short.entries.map((entry) => entry.path)).toEqual([
      "header.bin",
      "program.z64",
    ]);
    expect(short.limitations.join("\n")).toContain("boot code is incomplete");
  });

  it("reports non-zero reserved header bytes", () => {
    const { limitations, entries } = parsed({ reservedByte: 0x11 });
    expect(limitations.join("\n")).toContain("0x18..0x1F");
    expect(entries.map((entry) => entry.path)).toContain("program.z64");
  });

  it("refuses a truncated header, a length its order cannot normalize, an implausible boot address and a file above 64 MiB", () => {
    const image = n64RomImage();
    expect(failureOf(image.encoded.subarray(0, 32))).toMatchObject({
      kind: "truncated",
      failure: { format: N64_FORMAT, field: "header" },
    });
    // The length rule follows the byte order's swap unit.
    const oddV64 = Buffer.concat([
      n64RomImage({ order: "v64" }).encoded,
      Buffer.from([0]),
    ]);
    expect(failureOf(oddV64)).toMatchObject({
      kind: "malformed",
      failure: { field: "byte_order" },
    });
    const oddN64 = Buffer.concat([
      n64RomImage({ order: "n64" }).encoded,
      Buffer.alloc(2),
    ]);
    expect(failureOf(oddN64)).toMatchObject({
      kind: "malformed",
      failure: { field: "byte_order" },
    });
    const oddZ64 = Buffer.concat([image.encoded, Buffer.from([0])]);
    expect(parseN64Rom(oddZ64, oddZ64.length).metadata.rom_bytes).toBe(
      oddZ64.length,
    );
    expect(failureOf(image.encoded, N64_MAX_ROM_BYTES + 4)).toMatchObject({
      kind: "limit",
      failure: {
        limit: { name: N64_ROM_BYTES_LIMIT, maximum: N64_MAX_ROM_BYTES },
      },
    });
    const badBoot = n64RomImage({ bootAddress: 0x1000 }).encoded;
    expect(failureOf(badBoot)).toMatchObject({
      kind: "malformed",
      failure: { field: "boot_address" },
    });
    expect(failureOf(Buffer.alloc(64))).toMatchObject({
      kind: "malformed",
      failure: { field: "pi_dom1_config" },
    });
    expect(n64BootAddressPlausible(0x8000_0400)).toBe(true);
    expect(n64BootAddressPlausible(0x8000_0401)).toBe(false);
  });

  it("recognizes a plausible header in every order and refuses odd or implausible images", () => {
    for (const order of ["z64", "v64", "n64"] as const) {
      const encoded = n64RomImage({ order }).encoded;
      expect(n64RomRecognition(encoded, encoded.length)).toEqual({
        state: "recognized",
      });
    }
    const encoded = n64RomImage().encoded;
    expect(
      n64RomRecognition(encoded.subarray(0, 4), encoded.length),
    ).toBeUndefined();
    expect(n64RomRecognition(encoded.subarray(0, 32), 32)).toBeUndefined();
    const odd = Buffer.concat([encoded, Buffer.from([0])]);
    expect(n64RomRecognition(odd, odd.length)).toEqual({
      state: "recognized",
    });
    const oddV64 = Buffer.concat([
      n64RomImage({ order: "v64" }).encoded,
      Buffer.from([0]),
    ]);
    expect(n64RomRecognition(oddV64, oddV64.length)).toMatchObject({
      state: "refused",
    });
    const badBoot = n64RomImage({ bootAddress: 0 }).encoded;
    expect(n64RomRecognition(badBoot, badBoot.length)?.state).toBe("refused");
    expect(n64RomRecognition(encoded, N64_MAX_ROM_BYTES + 4)).toEqual({
      state: "recognized",
    });
    expect(encoded.length).toBeGreaterThan(N64_HEADER_BYTES);
  });

  it("throws ParseFailureError for a short header", () => {
    expect(failureOf(Buffer.alloc(8))).toBeInstanceOf(ParseFailureError);
  });
});
