import { expect, it } from "vitest";
import { decodeBytePattern } from "./bytePattern.js";
import {
  MAX_RAW_BYTES_LENGTH,
  formatHexDump,
  inspectRawBytesInputSchema,
  searchRawBytesInputSchema,
} from "./rawBytes.js";

const peHeaderBytes = Uint8Array.from([
  0x50, 0x45, 0x00, 0x00, 0x64, 0x86, 0x06, 0x00, 0x6c, 0x7d, 0xe9, 0x6a, 0x00,
  0x00, 0x00, 0x00,
]);

it("renders the xxd line with an absolute offset, grouped hex and printable ASCII", () => {
  expect(formatHexDump(peHeaderBytes, 0x78)).toBe(
    "00000078: 5045 0000 6486 0600 6c7d e96a 0000 0000  PE..d...l}.j....",
  );
});

it("pads a short last line so the ASCII column stays aligned and advances the offset by 16", () => {
  const bytes = Uint8Array.from([
    ...peHeaderBytes,
    0x41,
    0x42,
    0x43,
    0x7f,
    0x20,
  ]);
  expect(formatHexDump(bytes, 0x78).split("\n")).toEqual([
    "00000078: 5045 0000 6486 0600 6c7d e96a 0000 0000  PE..d...l}.j....",
    `00000088: 4142 437f 20${" ".repeat(29)}ABC. `,
  ]);
});

it("replaces non-printable bytes with a dot and keeps wide offsets exact", () => {
  expect(
    formatHexDump(Uint8Array.from([0x00, 0x1f, 0x7e, 0x80]), 0x1_0000_0000),
  ).toBe(`100000000: 001f 7e80${" ".repeat(32)}..~.`);
});

it("renders nothing for no bytes", () => {
  expect(formatHexDump(new Uint8Array(), 0)).toBe("");
});

it("rejects a read longer than the ceiling at the schema, before any provider work", () => {
  expect(
    inspectRawBytesInputSchema.safeParse({
      path: "/f",
      offset: 0,
      length: MAX_RAW_BYTES_LENGTH,
    }).success,
  ).toBe(true);
  expect(
    inspectRawBytesInputSchema.safeParse({
      path: "/f",
      offset: 0,
      length: MAX_RAW_BYTES_LENGTH + 1,
    }).success,
  ).toBe(false);
  for (const length of [0, -1, 1.5])
    expect(
      inspectRawBytesInputSchema.safeParse({ path: "/f", offset: 0, length })
        .success,
    ).toBe(false);
  expect(
    inspectRawBytesInputSchema.safeParse({
      path: "/f",
      offset: 0,
      length: 4,
      extra: true,
    }).success,
  ).toBe(false);
});

it("reuses the canonical byte-pattern grammar and rejects unconstrained patterns", () => {
  const search = (extra: Record<string, unknown>) =>
    searchRawBytesInputSchema.safeParse({ path: "/f", ...extra });
  expect(search({ pattern: "50 45 00 00" }).success).toBe(true);
  expect(search({ pattern: "52494646 ???????? 57415645" }).success).toBe(true);
  expect(search({ pattern: "?? ?? ??" }).success).toBe(false);
  expect(search({ pattern: "50 45", mask: "00 00" }).success).toBe(false);
  expect(search({ pattern: "50 45", mask: "ff" }).success).toBe(false);
  expect(search({ pattern: "5" }).success).toBe(false);
  expect(search({ pattern: "50 45", max_matches: 1001 }).success).toBe(false);
  expect(search({ pattern: "50 45", max_matches: 0 }).success).toBe(false);
  expect(search({ pattern: "50 45", context_lines: 9 }).success).toBe(false);
  expect(search({ pattern: "50".repeat(257) }).success).toBe(false);
  expect(search({ pattern: "50".repeat(256) }).success).toBe(true);
});

it("decodes wildcards and masks into value and mask bytes", () => {
  expect(decodeBytePattern({ pattern: "52 ?? 46 ab" })).toEqual({
    value: Uint8Array.from([0x52, 0x00, 0x46, 0xab]),
    mask: Uint8Array.from([0xff, 0x00, 0xff, 0xff]),
  });
  expect(decodeBytePattern({ pattern: "ff 12 ??", mask: "f0 00 ff" })).toEqual({
    value: Uint8Array.from([0xf0, 0x00, 0x00]),
    mask: Uint8Array.from([0xf0, 0x00, 0x00]),
  });
});

it("rejects pattern and mask strings exceeding the maximum text length", () => {
  const search = (extra: Record<string, unknown>) =>
    searchRawBytesInputSchema.safeParse({ path: "/f", ...extra });
  expect(search({ pattern: "ff", mask: "ff" + " ".repeat(2047) }).success).toBe(
    false,
  );
  expect(search({ pattern: "ff" + " ".repeat(2047) }).success).toBe(false);
});
