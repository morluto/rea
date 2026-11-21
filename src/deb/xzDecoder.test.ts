import { afterEach, expect, it } from "vitest";

import {
  compressXz,
  decodeXz,
  replaceXzBindingForTests,
  xzUncompressedSize,
} from "./xzDecoder.js";

afterEach(() => {
  replaceXzBindingForTests(undefined);
});

it("reads the uncompressed size from a completed xz index", () => {
  const payload = Buffer.alloc(10752, 1);
  const compressed = compressXz(payload);
  expect(xzUncompressedSize(compressed)).toBe(payload.length);
});

it("decodes a valid xz stream within the selected limit", () => {
  const payload = Buffer.from("control.tar contents\n");
  const decoded = decodeXz(compressXz(payload), 4096);
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) throw new Error("Expected xz decode");
  expect(Buffer.from(decoded.value).equals(payload)).toBe(true);
});

it("skips trailing 4-byte stream padding before reading the footer", () => {
  const payload = Buffer.from("data.tar contents\n");
  const padded = Buffer.concat([compressXz(payload), Buffer.alloc(8)]);
  expect(xzUncompressedSize(padded)).toBe(payload.length);
  const decoded = decodeXz(padded, 4096);
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) throw new Error("Expected padded xz decode");
  expect(Buffer.from(decoded.value).equals(payload)).toBe(true);
});

it("rejects zero padding that is not a multiple of four bytes", () => {
  const padded = Buffer.concat([
    compressXz(Buffer.from("hello")),
    Buffer.alloc(3),
  ]);
  expect(xzUncompressedSize(padded)).toBeNull();
});

it("refuses a truncated xz stream", () => {
  const compressed = compressXz(Buffer.from("hello"));
  const decoded = decodeXz(compressed.subarray(0, 8), 4096);
  expect(decoded).toEqual({ ok: false, error: { kind: "truncated" } });
});

it("refuses a corrupt xz stream", () => {
  const compressed = compressXz(Buffer.from("hello"));
  compressed.writeUInt8(compressed.readUInt8(20) ^ 0xff, 20);
  const decoded = decodeXz(compressed, 4096);
  expect(decoded.ok).toBe(false);
  if (decoded.ok) throw new Error("Expected corrupt xz");
  expect(decoded.error.kind).toBe("malformed");
});

it("refuses xz output past the selected limit before expanding", () => {
  const payload = Buffer.alloc(4096, 2);
  const decoded = decodeXz(compressXz(payload), 64);
  expect(decoded).toEqual({ ok: false, error: { kind: "too_large" } });
});

it("refuses xz when the native binding cannot load", () => {
  const compressed = compressXz(Buffer.from("x"));
  replaceXzBindingForTests({
    status: "unavailable",
    cause: new Error("missing addon"),
  });
  expect(decodeXz(compressed, 64)).toEqual({
    ok: false,
    error: { kind: "unavailable" },
  });
});

it("refuses an xz stream whose index cannot be read before decoding it", () => {
  const compressed = Buffer.from(compressXz(Buffer.alloc(1024, 0x61)));
  // Corrupt the footer's backward size so the index cannot be located.
  compressed[compressed.length - 8] = 0xff;
  compressed[compressed.length - 7] = 0xff;
  let decodes = 0;
  replaceXzBindingForTests({
    status: "ready",
    api: {
      compressSync: (input) =>
        compressXz(typeof input === "string" ? Buffer.from(input) : input),
      decompressSync: () => {
        decodes += 1;
        return Buffer.alloc(0);
      },
    },
  });
  expect(decodeXz(compressed, 1 << 20)).toEqual({
    ok: false,
    error: { kind: "malformed" },
  });
  expect(decodes).toBe(0);
});
