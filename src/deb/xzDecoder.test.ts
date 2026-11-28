import { crc32 } from "node:zlib";
import { afterEach, expect, it } from "vitest";

import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import {
  compressXz,
  decodeXz,
  lzma2DictionaryBytes,
  replaceXzBindingForTests,
  XZ_DICTIONARY_MAX_BYTES,
  xzUncompressedSize,
} from "./xzDecoder.js";

afterEach(() => {
  replaceXzBindingForTests(undefined);
});

const writeU32LE = (buf: Buffer, offset: number, value: number): void => {
  buf.writeUInt32LE(value >>> 0, offset);
};

const encodeMbInt = (value: number): Buffer => {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return Buffer.from(bytes);
};

/**
 * Rewrite the LZMA2 dictionary property byte in the first block header of a
 * real XZ stream and recompute the block header CRC32.
 */
const withLzma2DictionaryProp = (xz: Buffer, propByte: number): Buffer => {
  const copy = Buffer.from(xz);
  const blockStart = 12;
  const headerSize = (copy[blockStart]! + 1) * 4;
  // Default single-filter LZMA2 block header:
  // [0]=size, [1]=flags(0x00), [2]=filterId(0x21), [3]=propsSize(0x01), [4]=props
  expect(copy[blockStart + 2]).toBe(0x21);
  expect(copy[blockStart + 3]).toBe(0x01);
  copy[blockStart + 4] = propByte;
  writeU32LE(
    copy,
    blockStart + headerSize - 4,
    crc32(copy.subarray(blockStart, blockStart + headerSize - 4)),
  );
  return copy;
};

/**
 * Rewrite a single-block XZ stream's Index so it falsely declares a tiny
 * uncompressed size while keeping all CRCs valid.
 */
const withSpoofedIndexUncompressedSize = (
  xz: Buffer,
  claimedSize: number,
): Buffer => {
  const footerStart = xz.length - 12;
  const oldBackwardSize = (xz.readUInt32LE(footerStart + 4) + 1) * 4;
  const oldIndexStart = footerStart - oldBackwardSize;
  // Read original unpadded size from the single-record index (skip 0x00 + count=1).
  let unpadded = 0;
  let shift = 0;
  for (let i = oldIndexStart + 2; i < footerStart - 4; i++) {
    const b = xz[i]!;
    unpadded += (b & 0x7f) * 2 ** shift;
    shift += 7;
    if ((b & 0x80) === 0) break;
  }
  const indexBody = Buffer.concat([
    Buffer.from([0x00, 0x01]),
    encodeMbInt(unpadded),
    encodeMbInt(claimedSize),
  ]);
  const padLen = (4 - (indexBody.length % 4)) % 4;
  const indexNoCrc = Buffer.concat([indexBody, Buffer.alloc(padLen)]);
  const indexCrc = Buffer.alloc(4);
  writeU32LE(indexCrc, 0, crc32(indexNoCrc));
  const newIndex = Buffer.concat([indexNoCrc, indexCrc]);

  const footer = Buffer.from(xz.subarray(footerStart));
  writeU32LE(footer, 4, newIndex.length / 4 - 1);
  writeU32LE(footer, 0, crc32(footer.subarray(4, 10)));
  return Buffer.concat([xz.subarray(0, oldIndexStart), newIndex, footer]);
};

it("reads the uncompressed size from a completed xz index", () => {
  const payload = Buffer.alloc(10752, 1);
  const compressed = compressXz(payload);
  expect(xzUncompressedSize(compressed)).toBe(payload.length);
});

it("decodes a valid xz stream within the selected limit", async () => {
  const payload = Buffer.from("control.tar contents\n");
  const decoded = await decodeXz(compressXz(payload), 4096);
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) throw new Error("Expected xz decode");
  expect(Buffer.from(decoded.value).equals(payload)).toBe(true);
});

it("decodes concatenated xz streams and sums their declared sizes", async () => {
  const first = Buffer.from("first stream\n");
  const second = Buffer.from("second stream\n");
  const combined = Buffer.concat([
    compressXz(first),
    Buffer.alloc(4),
    compressXz(second),
  ]);
  expect(xzUncompressedSize(combined)).toBe(first.length + second.length);
  const decoded = await decodeXz(combined, 4096);
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) throw new Error("Expected concatenated xz decode");
  expect(Buffer.from(decoded.value).toString("utf8")).toBe(
    "first stream\nsecond stream\n",
  );
});

it("skips trailing 4-byte stream padding before reading the footer", async () => {
  const payload = Buffer.from("data.tar contents\n");
  const padded = Buffer.concat([compressXz(payload), Buffer.alloc(8)]);
  expect(xzUncompressedSize(padded)).toBe(payload.length);
  const decoded = await decodeXz(padded, 4096);
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

it("refuses a truncated xz stream", async () => {
  const compressed = compressXz(Buffer.from("hello"));
  const decoded = await decodeXz(compressed.subarray(0, 8), 4096);
  expect(decoded).toEqual({ ok: false, error: { kind: "truncated" } });
});

it("refuses a corrupt xz stream", async () => {
  const compressed = compressXz(Buffer.from("hello"));
  compressed.writeUInt8(compressed.readUInt8(20) ^ 0xff, 20);
  const decoded = await decodeXz(compressed, 4096);
  expect(decoded.ok).toBe(false);
  if (decoded.ok) throw new Error("Expected corrupt xz");
  expect(decoded.error.kind).toBe("malformed");
});

it("refuses xz output past the selected limit before expanding", async () => {
  const payload = Buffer.alloc(4096, 2);
  const decoded = await decodeXz(compressXz(payload), 64);
  expect(decoded).toEqual({ ok: false, error: { kind: "too_large" } });
});

it("refuses an xz stream declaring an oversized LZMA2 dictionary before decoding", async () => {
  const base = compressXz(Buffer.from("small payload"));
  // prop=32 -> 256 MiB, prop=40 -> 4 GiB - 1 (both above 128 MiB ceiling)
  expect(lzma2DictionaryBytes(32)).toBe(256 * 1024 * 1024);
  expect(lzma2DictionaryBytes(40)).toBe(0xffffffff);
  const hugeDict = withLzma2DictionaryProp(base, 40);
  let decodes = 0;
  replaceXzBindingForTests({
    status: "ready",
    api: {
      compressSync: (input) =>
        compressXz(typeof input === "string" ? Buffer.from(input) : input),
      decompressStream: (input) => {
        decodes += 1;
        return input as unknown as ReadableStream<Buffer>;
      },
    },
  });
  const decoded = await decodeXz(hugeDict, 1 << 20);
  expect(decoded).toEqual({
    ok: false,
    error: {
      kind: "dictionary_too_large",
      dictionaryBytes: 0xffffffff,
      maximum: XZ_DICTIONARY_MAX_BYTES,
    },
  });
  expect(decodes).toBe(0);
});

it("stops streaming decode when a spoofed xz index under-reports expanded size", async () => {
  // Real stream expands to 2 MiB, but its rewritten index claims only 16 bytes.
  const realCompressed = compressXz(Buffer.alloc(2 * 1024 * 1024, 0x41));
  const spoofed = withSpoofedIndexUncompressedSize(realCompressed, 16);
  expect(xzUncompressedSize(spoofed)).toBe(16);
  const decoded = await decodeXz(spoofed, 128 * 1024);
  expect(decoded).toEqual({ ok: false, error: { kind: "too_large" } });
});

it("honors an already-aborted AbortSignal before decoding", async () => {
  const controller = new AbortController();
  const reason = new Error("caller cancelled xz decode");
  controller.abort(reason);
  const error = await decodeXz(
    compressXz(Buffer.from("hello")),
    4096,
    controller.signal,
  ).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AnalysisCancelledError);
  expect(error).toMatchObject({
    _tag: "AnalysisCancelledError",
    operation: "inspect_deb_package",
    cause: reason,
  });
});

it("wraps a raw mid-stream abort reason as a typed AnalysisCancelledError", async () => {
  const controller = new AbortController();
  const reason = new Error("caller cancelled mid-stream xz decode");
  const compressed = compressXz(Buffer.from("hello"));
  replaceXzBindingForTests({
    status: "ready",
    api: {
      compressSync: (input) =>
        compressXz(typeof input === "string" ? Buffer.from(input) : input),
      decompressStream: () =>
        new ReadableStream<Buffer>({
          pull() {
            controller.abort(reason);
            throw reason;
          },
        }),
    },
  });
  const error = await decodeXz(compressed, 4096, controller.signal).catch(
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AnalysisCancelledError);
  expect(error).toMatchObject({
    _tag: "AnalysisCancelledError",
    operation: "inspect_deb_package",
    cause: reason,
  });
});

it("rejects a crafted high-record-count xz index upfront without retaining block objects", async () => {
  const recordCount = 1_000_000;
  // Valid 12-byte XZ Stream Header (CRC64 check type 0x04).
  const header = Buffer.alloc(12);
  Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0x00, 0x04]).copy(header);
  writeU32LE(header, 8, crc32(header.subarray(6, 8)));

  // Crafted XZ Index with 1,000,000 two-byte (unpadded=8, uncompressed=0) records
  // and no physical blocks before it (~2 MiB index, valid CRC32).
  const countBytes = encodeMbInt(recordCount);
  const recordsBytes = Buffer.alloc(recordCount * 2);
  for (let i = 0; i < recordCount; i++) {
    recordsBytes[i * 2] = 0x08; // unpadded = 8
    recordsBytes[i * 2 + 1] = 0x00; // uncompressed = 0
  }
  const bodyLen = 1 + countBytes.length + recordsBytes.length;
  const padLen = (4 - (bodyLen % 4)) % 4;
  const index = Buffer.alloc(bodyLen + padLen + 4);
  index[0] = 0x00;
  countBytes.copy(index, 1);
  recordsBytes.copy(index, 1 + countBytes.length);
  writeU32LE(
    index,
    bodyLen + padLen,
    crc32(index.subarray(0, bodyLen + padLen)),
  );

  // Valid 12-byte XZ Stream Footer pointing to the crafted index.
  const footer = Buffer.alloc(12);
  writeU32LE(footer, 4, index.length / 4 - 1);
  footer[8] = 0x00;
  footer[9] = 0x04;
  footer[10] = 0x59;
  footer[11] = 0x5a;
  writeU32LE(footer, 0, crc32(footer.subarray(4, 10)));

  const crafted = Buffer.concat([header, index, footer]);
  let decodes = 0;
  replaceXzBindingForTests({
    status: "ready",
    api: {
      compressSync: (input) =>
        compressXz(typeof input === "string" ? Buffer.from(input) : input),
      decompressStream: (input) => {
        decodes += 1;
        return input as unknown as ReadableStream<Buffer>;
      },
    },
  });

  expect(xzUncompressedSize(crafted)).toBeNull();
  const decoded = await decodeXz(crafted, 1 << 20);
  expect(decoded).toEqual({ ok: false, error: { kind: "malformed" } });
  expect(decodes).toBe(0);
});

it("refuses xz when the native binding cannot load", async () => {
  const compressed = compressXz(Buffer.from("x"));
  replaceXzBindingForTests({
    status: "unavailable",
    cause: new Error("missing addon"),
  });
  expect(await decodeXz(compressed, 64)).toEqual({
    ok: false,
    error: { kind: "unavailable" },
  });
});

it("refuses an xz stream whose index cannot be read before decoding it", async () => {
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
      decompressStream: (input) => {
        decodes += 1;
        return input as unknown as ReadableStream<Buffer>;
      },
    },
  });
  expect(await decodeXz(compressed, 1 << 20)).toEqual({
    ok: false,
    error: { kind: "malformed" },
  });
  expect(decodes).toBe(0);
});

const extractSingleBlock = (
  xz: Buffer,
): {
  readonly header: Buffer;
  readonly block: Buffer;
  readonly unpadded: number;
  readonly uncompressed: number;
  readonly flags1: number;
} => {
  const footerStart = xz.length - 12;
  const backwardSize = (xz.readUInt32LE(footerStart + 4) + 1) * 4;
  const indexStart = footerStart - backwardSize;
  const readMb = (offset: number): { value: number; next: number } => {
    let value = 0;
    let shift = 0;
    for (let i = offset; i < footerStart - 4; i++) {
      const b = xz[i]!;
      value += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if ((b & 0x80) === 0) return { value, next: i + 1 };
    }
    throw new Error("invalid mbint");
  };
  const unpadded = readMb(indexStart + 2);
  const uncompressed = readMb(unpadded.next);
  return {
    header: xz.subarray(0, 12),
    block: Buffer.from(xz.subarray(12, indexStart)),
    unpadded: unpadded.value,
    uncompressed: uncompressed.value,
    flags1: xz[7]!,
  };
};

const assembleXzStream = (
  header: Buffer,
  flags1: number,
  blocks: readonly Buffer[],
  records: readonly {
    readonly unpadded: number;
    readonly uncompressed: number;
  }[],
): Buffer => {
  const recordBuffers = records.flatMap((record) => [
    encodeMbInt(record.unpadded),
    encodeMbInt(record.uncompressed),
  ]);
  const indexBody = Buffer.concat([
    Buffer.from([0x00]),
    encodeMbInt(records.length),
    ...recordBuffers,
  ]);
  const padLen = (4 - (indexBody.length % 4)) % 4;
  const indexNoCrc = Buffer.concat([indexBody, Buffer.alloc(padLen)]);
  const indexCrc = Buffer.alloc(4);
  writeU32LE(indexCrc, 0, crc32(indexNoCrc));
  const index = Buffer.concat([indexNoCrc, indexCrc]);

  const footer = Buffer.alloc(12);
  writeU32LE(footer, 4, index.length / 4 - 1);
  footer[8] = 0x00;
  footer[9] = flags1;
  footer[10] = 0x59;
  footer[11] = 0x5a;
  writeU32LE(footer, 0, crc32(footer.subarray(4, 10)));
  return Buffer.concat([header, ...blocks, index, footer]);
};

it("decodes a valid multi-block xz stream by walking actual block boundaries", async () => {
  const first = extractSingleBlock(compressXz(Buffer.from("block-one\n")));
  const second = extractSingleBlock(compressXz(Buffer.from("block-two\n")));
  const twoBlock = assembleXzStream(
    first.header,
    first.flags1,
    [first.block, second.block],
    [
      { unpadded: first.unpadded, uncompressed: first.uncompressed },
      { unpadded: second.unpadded, uncompressed: second.uncompressed },
    ],
  );
  expect(xzUncompressedSize(twoBlock)).toBe(
    first.uncompressed + second.uncompressed,
  );
  const decoded = await decodeXz(twoBlock, 4096);
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) throw new Error("Expected multi-block xz decode");
  expect(Buffer.from(decoded.value).toString("utf8")).toBe(
    "block-one\nblock-two\n",
  );
});

it("refuses a forged xz index record that spans two blocks to hide an oversized LZMA2 dictionary", async () => {
  const first = extractSingleBlock(compressXz(Buffer.from("benign-1")));
  const hugeSecondXz = withLzma2DictionaryProp(
    compressXz(Buffer.from("hidden-2")),
    40,
  );
  const second = extractSingleBlock(hugeSecondXz);
  // Forge a single index record whose unpadded size spans block 1 (padded) +
  // block 2, hiding block 2's 4 GiB LZMA2 dictionary from index-only jumps.
  const forged = assembleXzStream(
    first.header,
    first.flags1,
    [first.block, second.block],
    [
      {
        unpadded: first.block.length + second.unpadded,
        uncompressed: first.uncompressed,
      },
    ],
  );

  let decodes = 0;
  replaceXzBindingForTests({
    status: "ready",
    api: {
      compressSync: (input) =>
        compressXz(typeof input === "string" ? Buffer.from(input) : input),
      decompressStream: (input) => {
        decodes += 1;
        return input as unknown as ReadableStream<Buffer>;
      },
    },
  });

  expect(xzUncompressedSize(forged)).toBeNull();
  const decoded = await decodeXz(forged, 1 << 20);
  expect(decoded).toEqual({ ok: false, error: { kind: "malformed" } });
  expect(decodes).toBe(0);
});

it("refuses an oversized LZMA2 dictionary in a later block of a multi-block xz stream", async () => {
  const first = extractSingleBlock(compressXz(Buffer.from("benign-1")));
  const second = extractSingleBlock(
    withLzma2DictionaryProp(compressXz(Buffer.from("oversized-2")), 40),
  );
  const stream = assembleXzStream(
    first.header,
    first.flags1,
    [first.block, second.block],
    [
      { unpadded: first.unpadded, uncompressed: first.uncompressed },
      { unpadded: second.unpadded, uncompressed: second.uncompressed },
    ],
  );

  let decodes = 0;
  replaceXzBindingForTests({
    status: "ready",
    api: {
      compressSync: (input) =>
        compressXz(typeof input === "string" ? Buffer.from(input) : input),
      decompressStream: (input) => {
        decodes += 1;
        return input as unknown as ReadableStream<Buffer>;
      },
    },
  });

  const decoded = await decodeXz(stream, 1 << 20);
  expect(decoded).toEqual({
    ok: false,
    error: {
      kind: "dictionary_too_large",
      dictionaryBytes: 0xffffffff,
      maximum: XZ_DICTIONARY_MAX_BYTES,
    },
  });
  expect(decodes).toBe(0);
});
