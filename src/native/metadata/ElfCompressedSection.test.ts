import { deflateSync, zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  decodeElfCompressedSection,
  decodeElfGnuZlibSection,
} from "./ElfCompressedSection.js";
import { decodeElfSectionNameTable } from "./ElfSectionNameTable.js";

const plain = Buffer.from("section-names\0", "latin1");

const chdr = (
  bits: 32 | 64,
  little: boolean,
  type: number,
  size: number,
): Buffer => {
  const header = Buffer.alloc(bits === 64 ? 24 : 12);
  if (little) header.writeUInt32LE(type, 0);
  else header.writeUInt32BE(type, 0);
  if (bits === 64) {
    if (little) {
      header.writeBigUInt64LE(BigInt(size), 8);
      header.writeBigUInt64LE(1n, 16);
    } else {
      header.writeBigUInt64BE(BigInt(size), 8);
      header.writeBigUInt64BE(1n, 16);
    }
  } else if (little) {
    header.writeUInt32LE(size, 4);
    header.writeUInt32LE(1, 8);
  } else {
    header.writeUInt32BE(size, 4);
    header.writeUInt32BE(1, 8);
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
    const decoded = decodeElfCompressedSection(
      Buffer.concat([chdr(64, true, 1, plain.length + 1), deflateSync(plain)]),
      0x800n,
      64,
      true,
      1024,
      "ELF sample section",
    );
    expect(decoded).toMatchObject({
      state: "malformed",
      message: "ELF sample section size is inconsistent",
    });
  });

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
    });
  });
});
