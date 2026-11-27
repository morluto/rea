import { expect, it } from "vitest";

import {
  MACOS_PKG_MAX_TOC_COMPRESSED_BYTES,
  XAR_HEADER_MIN_BYTES,
  XAR_MAGIC,
} from "../../domain/macosPkgFormat.js";
import { parseXarHeader } from "./XarHeader.js";

it("parses a 28-byte xar header", () => {
  const header = Buffer.alloc(XAR_HEADER_MIN_BYTES);
  header.writeUInt32BE(XAR_MAGIC, 0);
  header.writeUInt16BE(28, 4);
  header.writeUInt16BE(1, 6);
  header.writeBigUInt64BE(32n, 8);
  header.writeBigUInt64BE(64n, 16);
  header.writeUInt32BE(1, 24);
  const parsed = parseXarHeader(header);
  expect(parsed).toMatchObject({
    ok: true,
    value: {
      magic: XAR_MAGIC,
      headerSize: 28,
      version: 1,
      tocCompressedLength: 32,
      tocUncompressedLength: 64,
      checksumAlgorithmId: 1,
      checksumAlgorithm: "sha1",
      heapOffset: 60,
    },
  });
});

it("names unknown checksum algorithms instead of failing", () => {
  const header = Buffer.alloc(XAR_HEADER_MIN_BYTES);
  header.writeUInt32BE(XAR_MAGIC, 0);
  header.writeUInt16BE(28, 4);
  header.writeUInt16BE(1, 6);
  header.writeUInt32BE(99, 24);
  const parsed = parseXarHeader(header);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.value.checksumAlgorithm).toBe("unknown");
});

it("refuses a truncated header", () => {
  const parsed = parseXarHeader(Buffer.from("xar!"));
  expect(parsed.ok).toBe(false);
  if (parsed.ok) return;
  expect(parsed.error.kind).toBe("truncated");
});

it("refuses a compressed TOC above the fixed allowance", () => {
  const header = Buffer.alloc(XAR_HEADER_MIN_BYTES);
  header.writeUInt32BE(XAR_MAGIC, 0);
  header.writeUInt16BE(28, 4);
  header.writeUInt16BE(1, 6);
  header.writeBigUInt64BE(BigInt(MACOS_PKG_MAX_TOC_COMPRESSED_BYTES + 1), 8);
  const parsed = parseXarHeader(header);
  expect(parsed.ok).toBe(false);
  if (parsed.ok) return;
  expect(parsed.error.kind).toBe("limit");
});
