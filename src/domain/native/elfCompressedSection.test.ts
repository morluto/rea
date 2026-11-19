import { deflateSync, zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { runWithAnalysisOperationSnapshot } from "../analysisOperationSnapshot.js";
import {
  MAXIMUM_ZSTD_MAX_FRAMES,
  MINIMUM_ZSTD_MAX_FRAMES,
} from "../analysisResourceLimits.js";
import {
  decodeElfCompressedSection,
  decodeElfGnuZlibSection,
} from "./elfCompressedSection.js";
import { decodeElfSectionNameTable } from "./elfSectionNameTable.js";

const plain = Buffer.from("section-names\0", "latin1");

const chdr = (
  bits: 32 | 64,
  little: boolean,
  type: number,
  size: number,
  alignment = 1n,
): Buffer => {
  const header = Buffer.alloc(bits === 64 ? 24 : 12);
  if (little) header.writeUInt32LE(type, 0);
  else header.writeUInt32BE(type, 0);
  if (bits === 64) {
    if (little) {
      header.writeBigUInt64LE(BigInt(size), 8);
      header.writeBigUInt64LE(alignment, 16);
    } else {
      header.writeBigUInt64BE(BigInt(size), 8);
      header.writeBigUInt64BE(alignment, 16);
    }
  } else if (little) {
    header.writeUInt32LE(size, 4);
    header.writeUInt32LE(Number(alignment), 8);
  } else {
    header.writeUInt32BE(size, 4);
    header.writeUInt32BE(Number(alignment), 8);
  }
  return header;
};

describe("ELF compressed section payloads", () => {
  it.each([
    [64, true, "zlib"],
    [64, false, "zlib"],
    [32, true, "zlib"],
    [32, false, "zstd"],
    [64, true, "zstd"],
  ] as const)("decodes %s-bit %s %s payloads", (bits, little, compression) => {
    const payload =
      compression === "zstd" ? zstdCompressSync(plain) : deflateSync(plain);
    const bytes = Buffer.concat([
      chdr(bits, little, compression === "zstd" ? 2 : 1, plain.length),
      payload,
    ]);
    const decoded = decodeElfCompressedSection(
      bytes,
      0x800n,
      bits,
      little,
      1024,
      "ELF sample section",
    );
    expect(decoded).toMatchObject({
      state: "available",
      compressed: true,
      compression,
    });
    if (decoded.state === "available")
      expect(decoded.bytes.equals(plain)).toBe(true);
  });

  it("returns uncompressed bytes when the flag is clear", () => {
    const decoded = decodeElfCompressedSection(
      plain,
      0n,
      64,
      true,
      1024,
      "ELF sample section",
    );
    expect(decoded).toMatchObject({
      state: "available",
      compressed: false,
      compression: "none",
      bytes: plain,
    });
  });

  it("keeps the section-name subject in truncated-header text", () => {
    const decoded = decodeElfSectionNameTable(
      Buffer.alloc(4),
      0x800n,
      64,
      true,
      1024,
    );
    expect(decoded).toMatchObject({
      state: "malformed",
      message: "ELF compressed section-name table header is truncated",
      inflatedBytes: 0,
    });
  });

  it("names an unsupported compression type", () => {
    const decoded = decodeElfCompressedSection(
      chdr(64, true, 9, plain.length),
      0x800n,
      64,
      true,
      1024,
      "ELF sample section",
    );
    expect(decoded).toEqual({ state: "unsupported", compressionType: 9 });
  });

  it("rejects a decoded length that does not match the header", () => {
    const payload = deflateSync(plain);
    const decoded = decodeElfCompressedSection(
      Buffer.concat([chdr(64, true, 1, plain.length + 1), payload]),
      0x800n,
      64,
      true,
      1024,
      "ELF sample section",
    );
    expect(decoded).toMatchObject({
      state: "malformed",
      message: "ELF sample section size is inconsistent",
      inflatedBytes: Math.max(plain.length + 1, payload.length),
    });
  });

  it.each(["zlib", "zstd"] as const)(
    "charges compressed input for a failed zero-output %s attempt",
    (compression) => {
      const payload = Buffer.from("invalid compressed payload");
      expect(
        decodeElfCompressedSection(
          Buffer.concat([
            chdr(64, true, compression === "zstd" ? 2 : 1, 0),
            payload,
          ]),
          0x800n,
          64,
          true,
          1024,
          "ELF sample section",
        ),
      ).toMatchObject({ state: "malformed", inflatedBytes: payload.length });
    },
  );

  it("stops before inflation when the declared size exceeds the allowance", () => {
    const decoded = decodeElfCompressedSection(
      Buffer.concat([chdr(64, true, 1, 5000), deflateSync(plain)]),
      0x800n,
      64,
      true,
      100,
      "ELF sample section",
    );
    expect(decoded).toMatchObject({
      state: "limit",
      requiredBytes: 5000n,
      maximumBytes: 100,
    });
  });

  it("decodes a GNU ZLIB section and rejects a foreign prefix", () => {
    const header = Buffer.alloc(12);
    header.write("ZLIB", 0, "latin1");
    header.writeBigUInt64BE(BigInt(plain.length), 4);
    const decoded = decodeElfGnuZlibSection(
      Buffer.concat([header, deflateSync(plain)]),
      1024,
      "ELF .zdebug_info section",
    );
    expect(decoded.state).toBe("available");
    if (decoded.state === "available")
      expect(decoded.bytes.equals(plain)).toBe(true);
    expect(
      decodeElfGnuZlibSection(
        Buffer.from("nope"),
        1024,
        "ELF .zdebug_info section",
      ),
    ).toMatchObject({
      state: "malformed",
      message: "ELF .zdebug_info section is not a GNU ZLIB compressed section",
      inflatedBytes: 0,
    });
  });
});

const zstdFrame = (byte: number): Buffer =>
  Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x01, 0x09, 0x00, 0x00, byte]);

it("accepts a Zstandard skippable suffix and rejects a trailing byte", () => {
  const payload = zstdCompressSync(plain);
  const skip = Buffer.alloc(8);
  skip.writeUInt32LE(0x184d2a50, 0);
  const decode = (body: Buffer) =>
    decodeElfCompressedSection(
      Buffer.concat([chdr(64, true, 2, plain.length), body]),
      0x800n,
      64,
      true,
      1024,
      "ELF sample section",
    );
  expect(decode(payload)).toMatchObject({ state: "available" });
  expect(decode(Buffer.concat([payload, skip]))).toMatchObject({
    state: "available",
    compression: "zstd",
  });
  expect(decode(Buffer.concat([payload, Buffer.of(0)]))).toMatchObject({
    state: "malformed",
    reason: "trailing_bytes",
  });
});

it("refuses a Zstandard section that exceeds zstd.max_frames", () => {
  const body = Buffer.concat([zstdFrame(0x61), zstdFrame(0x62)]);
  const bytes = Buffer.concat([chdr(64, true, 2, 2), body]);
  const decode = () =>
    decodeElfCompressedSection(
      bytes,
      0x800n,
      64,
      true,
      1024,
      "ELF sample section",
    );
  expect(decode()).toMatchObject({ state: "available" });
  expect(
    runWithAnalysisOperationSnapshot(
      { revision: 1, overrides: { "zstd.max_frames": 1 } },
      decode,
    ),
  ).toMatchObject({
    state: "work_limit",
    reason: "work_limit",
    setting: "zstd.max_frames",
    value: 1,
    source: "runtime",
    minimum: MINIMUM_ZSTD_MAX_FRAMES,
    maximum: MAXIMUM_ZSTD_MAX_FRAMES,
  });
});

describe("ELF compressed section declaration admission", () => {
  it.each([
    [32, false, 0x8000_0000n],
    [64, true, 0x8000_0000_0000_0000n],
  ] as const)(
    "admits zero and the largest power-of-two alignment in an ELF%s header",
    (bits, little, alignment) => {
      for (const value of [0n, alignment]) {
        const bytes = Buffer.concat([
          chdr(bits, little, 1, plain.length, value),
          deflateSync(plain),
        ]);
        expect(
          decodeElfSectionNameTable(bytes, 0x800n, bits, little, 1024),
        ).toMatchObject({ state: "available", bytes: plain });
      }
    },
  );

  it.each([
    [32, false, 3n],
    [64, true, 0x8000_0000_0000_0001n],
  ] as const)(
    "rejects a non-power-of-two alignment in an ELF%s header before inflation",
    (bits, little, alignment) => {
      const bytes = Buffer.concat([
        chdr(bits, little, 1, plain.length, alignment),
        deflateSync(plain),
      ]);
      expect(
        decodeElfSectionNameTable(bytes, 0x800n, bits, little, 1024),
      ).toMatchObject({
        state: "malformed",
        message:
          "ELF compressed section-name table has an invalid decoded alignment",
        inflatedBytes: 0,
      });
    },
  );

  it.each([Buffer.from([0]), deflateSync("another stream")])(
    "rejects bytes beyond the single zlib stream in a section-name table",
    (suffix) => {
      const payload = Buffer.concat([deflateSync(plain), suffix]);
      const bytes = Buffer.concat([chdr(64, true, 1, plain.length), payload]);
      expect(
        decodeElfSectionNameTable(bytes, 0x800n, 64, true, 1024),
      ).toMatchObject({
        state: "malformed",
        message:
          "ELF compressed section-name table has bytes after its zlib stream",
        inflatedBytes: payload.length,
      });
    },
  );
});
