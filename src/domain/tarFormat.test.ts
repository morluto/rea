import { describe, expect, it } from "vitest";

import {
  parsePaxRecords,
  parseTarNumber,
  TAR_BLOCK_BYTES,
  tarHeaderChecksumMatches,
  tarHeaderDialect,
  walkPaxRecords,
} from "./tarFormat.js";

const buildHeader = (
  mutate?: (block: Buffer) => void,
  signed = false,
): Buffer => {
  const block = Buffer.alloc(TAR_BLOCK_BYTES);
  block.write("hello.txt", 0);
  block.write("0000644\0", 100);
  block.write("0000000\0", 108);
  block.write("0000000\0", 116);
  block.write("00000000000\0", 124);
  block.write("00000000000\0", 136);
  block.write("        ", 148);
  block[156] = 0x30;
  block.write("ustar\0", 257);
  block.write("00", 263);
  mutate?.(block);
  block.write("        ", 148);
  let sum = 0;
  for (const byte of block) sum += signed && byte >= 0x80 ? byte - 0x100 : byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
};

describe("parseTarNumber", () => {
  it("parses octal and GNU base-256 values including first-byte magnitude and sign bits", () => {
    expect(parseTarNumber(Buffer.from("0000755\0"))).toBe(0o755n);
    expect(
      parseTarNumber(
        new Uint8Array([0x80, 0x00, 0x00, 0x00, 0x00, 0x2d, 0xc6, 0xc0]),
      ),
    ).toBe(3_000_000n);
    expect(
      parseTarNumber(
        new Uint8Array([0x81, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x07]),
      ),
    ).toBe((1n << 56n) + 7n);
    expect(
      parseTarNumber(
        new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
      ),
    ).toBe(-1n);
    expect(parseTarNumber(Buffer.from("07x5\0"))).toBeUndefined();
  });
});

describe("tarHeaderChecksumMatches and tarHeaderDialect", () => {
  it("verifies unsigned and historic signed checksums and rejects corrupt or short blocks", () => {
    const ustar = buildHeader();
    expect(tarHeaderDialect(ustar)).toBe("ustar");
    expect(tarHeaderChecksumMatches(ustar)).toBe(true);

    const signed = buildHeader((block) => {
      block[0] = 0xff;
    }, true);
    expect(tarHeaderChecksumMatches(signed)).toBe(true);

    const bad = Buffer.from(ustar);
    bad[0] = (bad[0] ?? 0) ^ 1;
    expect(tarHeaderChecksumMatches(bad)).toBe(false);
    expect(tarHeaderChecksumMatches(ustar.subarray(0, 100))).toBe(false);
    expect(tarHeaderDialect(ustar.subarray(0, 100))).toBeUndefined();

    const gnu = buildHeader((block) => {
      block.write("ustar  \0", 257, "latin1");
    });
    expect(tarHeaderDialect(gnu)).toBe("gnu");
  });
});

describe("walkPaxRecords and parsePaxRecords", () => {
  it("walks raw records with byte offsets and leaves UTF-8 policy to callers", () => {
    const valid = Buffer.from("12 path=abc\n");
    const nonUtf8 = Buffer.concat([
      Buffer.from("11 uname="),
      Buffer.from([0xff, 0x0a]),
    ]);
    const payload = Buffer.concat([valid, nonUtf8, Buffer.alloc(4)]);
    const seen: [string, Uint8Array][] = [];
    const error = walkPaxRecords(payload, (key, value) => {
      seen.push([Buffer.from(key).toString("utf8"), value]);
    });
    expect(error).toBeUndefined();
    expect(seen).toHaveLength(2);
    expect(seen[0]?.[0]).toBe("path");
    expect(Buffer.from(seen[0]?.[1] ?? []).toString("utf8")).toBe("abc");
    expect(seen[1]?.[0]).toBe("uname");
    expect([...(seen[1]?.[1] ?? [])]).toEqual([0xff]);

    expect(parsePaxRecords(payload)).toEqual({
      reason: "pax record value is not UTF-8",
    });

    const malformed = Buffer.concat([valid, Buffer.from("99 path=abc\n")]);
    expect(walkPaxRecords(malformed, () => undefined)).toEqual({
      offset: valid.length,
      reason: "pax record length exceeds its extended header",
    });
  });
});
