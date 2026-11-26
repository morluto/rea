import { expect, it } from "vitest";
import {
  readFatHeaderPrefix,
  readFatContainerHeader,
} from "./machoContainer.js";
import { readUniversalMachoImage } from "./machoImageSelection.js";

const formats = [
  { magic: 0xcafebabe, wide: false, littleEndian: false },
  { magic: 0xcafebabf, wide: true, littleEndian: false },
  { magic: 0xbebafeca, wide: false, littleEndian: true },
  { magic: 0xbfbafeca, wide: true, littleEndian: true },
] as const;

it.each(formats)(
  "preserves partial format and raw count evidence from the same FAT view ($magic)",
  (format) => {
    const backing = Buffer.alloc(27, 0xa5);
    const window = backing.subarray(7, 15);
    const view = new DataView(
      window.buffer,
      window.byteOffset,
      window.byteLength,
    );
    view.setUint32(0, format.magic, false);
    for (let observed = 0; observed < window.length; observed++)
      expect(readFatHeaderPrefix(window.subarray(0, observed))).toEqual(
        observed < 4
          ? { state: "unknown", requiredBytes: 4 }
          : { state: "incomplete", ...format, requiredBytes: 8 },
      );

    for (const count of [0, 0xffffffff]) {
      view.setUint32(4, count, format.littleEndian);
      const before = Buffer.from(backing);
      const parsed = readFatHeaderPrefix(backing.subarray(7));
      expect(backing.equals(before)).toBe(true);
      expect(parsed).toEqual({
        state: "parsed",
        ...format,
        count,
        tableEnd: 8 + count * (format.wide ? 32 : 20),
      });
    }
  },
);

it("distinguishes observed non-FAT bytes from unavailable magic", () => {
  const bytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
  expect(readFatHeaderPrefix(bytes)).toEqual({
    state: "not-fat",
    magic: 0x7f454c46,
  });
  expect(readFatHeaderPrefix(bytes.subarray(0, 3))).toEqual({
    state: "unknown",
    requiredBytes: 4,
  });
});

it("keeps full-header file extent admission ahead of zero-count admission", () => {
  const bytes = Buffer.alloc(8);
  bytes.writeUInt32BE(0xcafebabe);
  expect(readFatContainerHeader(bytes, 7)).toEqual({
    state: "malformed",
    reason: "FAT file size is invalid or contradicts retained bytes",
  });
  expect(readFatContainerHeader(bytes, 8)).toEqual({
    state: "malformed",
    reason: "FAT header declares no architectures",
  });
});

/** A FAT header with `count` in its count field, `length` bytes long. */
const fatHeader = (magic: number, count: number, length: number): Buffer => {
  const bytes = Buffer.alloc(length);
  bytes.writeUInt32BE(magic);
  if (length < 8) return bytes;
  if (magic === 0xbebafeca || magic === 0xbfbafeca)
    bytes.writeUInt32LE(count, 4);
  else bytes.writeUInt32BE(count, 4);
  return bytes;
};

it.each(formats)(
  "reports a FAT header cut short as truncated at the file's end ($magic)",
  ({ magic }) => {
    expect(readFatContainerHeader(fatHeader(magic, 0, 6), 6)).toMatchObject({
      state: "truncated",
      extent: { availableBytes: 6, requiredBytes: 8 },
    });
  },
);

it.each(formats)(
  "reports a FAT table cut short as truncated at the file's end ($magic)",
  ({ magic, wide }) => {
    const bytes = fatHeader(magic, 2, 30);
    const extent = {
      availableBytes: 30,
      requiredBytes: 8 + 2 * (wide ? 32 : 20),
    };
    expect(readFatContainerHeader(bytes, 30)).toMatchObject({
      state: "truncated",
      extent,
    });
    // A retained prefix is measured against the file's size, not its own.
    expect(readFatContainerHeader(bytes.subarray(0, 8), 30)).toMatchObject({
      state: "truncated",
      extent,
    });
  },
);

it("keeps a short CAFEBABE file whose count reads as a JVM version outside FAT", () => {
  // Major version 52 (Java 8) in the count field: a class file shorter than
  // the table it would declare is not evidence of a cut-off universal file.
  expect(readFatContainerHeader(fatHeader(0xcafebabe, 52, 30), 30)).toEqual({
    state: "not-fat",
  });
});

/** A complete FAT32 file of arm64 and x86_64 slices, each a bare thin header. */
const universalImage = (): Buffer => {
  const slices = [
    { cpuType: 0x0100000c, cpuSubtype: 0, offset: 4096 },
    { cpuType: 0x01000007, cpuSubtype: 3, offset: 8192 },
  ];
  const bytes = Buffer.alloc(8192 + 32);
  bytes.writeUInt32BE(0xcafebabe);
  bytes.writeUInt32BE(slices.length, 4);
  for (const [index, { cpuType, cpuSubtype, offset }] of slices.entries()) {
    const row = 8 + index * 20;
    bytes.writeUInt32BE(cpuType, row);
    bytes.writeUInt32BE(cpuSubtype, row + 4);
    bytes.writeUInt32BE(offset, row + 8);
    bytes.writeUInt32BE(32, row + 12);
    bytes.writeUInt32BE(12, row + 16);
    bytes.writeUInt32LE(0xfeedfacf, offset);
    bytes.writeUInt32LE(cpuType, offset + 4);
    bytes.writeUInt32LE(cpuSubtype, offset + 8);
  }
  return bytes;
};

it("carries the container's truncation through universal image selection", () => {
  const bytes = universalImage();
  expect(readUniversalMachoImage(bytes).ok).toBe(true);
  expect(readUniversalMachoImage(bytes.subarray(0, 20))).toEqual({
    ok: false,
    error: expect.objectContaining({
      failure: expect.objectContaining({
        kind: "truncated",
        format: "macho",
        extent: { availableBytes: 20, requiredBytes: 48 },
      }),
    }),
  });
});

it.each([
  {
    name: "a slice that runs into the next",
    corrupt: (bytes: Buffer) => bytes.writeUInt32BE(4096 + 32, 8 + 12),
  },
  {
    name: "a slice inside the FAT table",
    corrupt: (bytes: Buffer) => bytes.writeUInt32BE(16, 8 + 8),
  },
])("keeps complete but corrupt FAT data malformed: $name", ({ corrupt }) => {
  const bytes = universalImage();
  corrupt(bytes);
  const result = readUniversalMachoImage(bytes);
  expect(result).toEqual({
    ok: false,
    error: expect.objectContaining({
      failure: expect.objectContaining({ kind: "malformed", format: "macho" }),
    }),
  });
  expect(result.ok ? undefined : result.error.failure).not.toHaveProperty(
    "extent",
  );
});
