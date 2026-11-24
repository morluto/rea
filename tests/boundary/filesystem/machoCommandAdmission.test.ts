import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import {
  BinaryFormatFailure,
  BinaryResourceFailure,
} from "../../../src/domain/binaryContainer.js";
import {
  MAX_LOAD_COMMAND_BYTES,
  readSliceCommandTable,
} from "../../../src/domain/apple/machoLoadCommandReader.js";
import { readMachoLoadCommandTableHeader } from "../../../src/domain/apple/machoLoadCommands.js";
import { readBinaryContainer } from "../../../src/domain/native/readBinaryContainer.js";
import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import { thinMach } from "../../../src/domain/binaryTarget.fixture.js";
import { parseExecutableHeader } from "../../../src/domain/binaryTarget.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { BinaryTargetError } from "../../../src/domain/configurationErrors.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  CPU,
  fatImage,
} from "../../../src/artifacts/apple/MachoImage.fixture.js";

const commandImage = (
  wide: boolean,
  littleEndian: boolean,
  sizes: readonly number[],
): Buffer => {
  const magic = wide
    ? littleEndian
      ? 0xcffaedfe
      : 0xfeedfacf
    : littleEndian
      ? 0xcefaedfe
      : 0xfeedface;
  const header = thinMach(magic, wide ? 0x0100000c : 7);
  const bytes = Buffer.alloc(
    header.length + sizes.reduce((total, size) => total + size, 0),
  );
  header.copy(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(16, sizes.length, littleEndian);
  view.setUint32(20, bytes.length - header.length, littleEndian);
  let offset = header.length;
  for (const size of sizes) {
    view.setUint32(offset, 0x7fffffff, littleEndian); // Unknown commands still have framing.
    view.setUint32(offset + 4, size, littleEndian);
    offset += size;
  }
  return bytes;
};

it.each([
  {
    label: "an oversized declaration outside the slice",
    tableBytes: MAX_LOAD_COMMAND_BYTES + 8,
    count: 1,
    length: 32,
    status: "malformed",
    reason: /extend beyond/,
  },
  {
    label: "an impossible count in a backed oversized table",
    tableBytes: MAX_LOAD_COMMAND_BYTES + 8,
    count: 0xffffffff,
    length: 32 + MAX_LOAD_COMMAND_BYTES + 8,
    status: "malformed",
    reason: /count.*cannot fit/,
  },
  {
    label: "a plausible count in a backed oversized table",
    tableBytes: MAX_LOAD_COMMAND_BYTES + 8,
    count: 1,
    length: 32 + MAX_LOAD_COMMAND_BYTES + 8,
    status: "unsupported",
    reason: /above the .* limit/,
  },
])("reports $label before reading its payload", async (fixture) => {
  const header = commandImage(true, true, []);
  header.writeUInt32LE(fixture.count, 16);
  header.writeUInt32LE(fixture.tableBytes, 20);
  const reads: number[] = [];
  const result = await readSliceCommandTable(
    async (offset, size) => {
      reads.push(offset);
      return header.subarray(offset, offset + size);
    },
    0,
    fixture.length,
  );
  expect(result).toMatchObject({
    status: fixture.status,
    reason: expect.stringMatching(fixture.reason),
    header: { commandCount: fixture.count, commandBytes: fixture.tableBytes },
  });
  expect(reads).toEqual([0]);
});

it.each([
  { label: "undersized", field: 36, value: 4 },
  { label: "unaligned", field: 36, value: 12 },
  { label: "outside table", field: 36, value: 0xffffffff },
  { label: "truncated declared table", field: 20, value: 24 },
  { label: "too many commands", field: 16, value: 2 },
  { label: "unclaimed table bytes", field: 16, value: 0 },
  { label: "trailing table bytes", field: 36, value: 8 },
])(
  "rejects $label thin command framing before provider admission",
  async ({ field, value }) => {
    const bytes = commandImage(true, true, [16]);
    bytes.writeUInt32LE(value, field);
    const path = join(
      await createTestTempDirectory("rea-macho-command-"),
      "image",
    );
    await writeFile(path, bytes);
    expect(parseExecutableHeader(bytes, "arm64").ok).toBe(false);
    expect(() => readBinaryContainer(bytes, "elf-directory")).toThrow(
      /load command/iu,
    );
    const resolved = await parseBinaryTarget(path);
    expect(resolved.ok).toBe(false);
    if (resolved.ok || !(resolved.error instanceof BinaryTargetError))
      throw new Error("Expected target format refusal");
    expect(projectAnalysisError(resolved.error)).toMatchObject({
      code: "target_unavailable",
      category: "unsupported_target",
    });
    expect(resolved.error.reason).toMatch(/load command/iu);
  },
);

it.each([
  { wide: false, littleEndian: false, size: 12 },
  { wide: false, littleEndian: true, size: 12 },
  { wide: true, littleEndian: false, size: 16 },
  { wide: true, littleEndian: true, size: 16 },
])(
  "retains width-specific alignment and endian controls ($wide/$littleEndian)",
  async ({ wide, littleEndian, size }) => {
    const bytes = commandImage(wide, littleEndian, [size]);
    const path = join(
      await createTestTempDirectory("rea-macho-command-control-"),
      "image",
    );
    await writeFile(path, bytes);
    expect(readBinaryContainer(bytes, "elf-directory")).toMatchObject({
      format: "macho",
      bits: wide ? 64 : 32,
      byte_order: littleEndian ? "little" : "big",
    });
    expect(await parseBinaryTarget(path)).toMatchObject({
      ok: true,
      value: { format: "mach-o", architecture: wide ? "arm64" : "x86" },
    });
  },
);

it.each([false, true])(
  "walks command headers beyond the probe window (corrupt=%s)",
  async (corrupt) => {
    const bytes = commandImage(true, true, [4104, 16]);
    if (corrupt) bytes.writeUInt32LE(0xffffffff, 32 + 4104 + 4);
    const path = join(
      await createTestTempDirectory("rea-macho-command-window-"),
      "image",
    );
    await writeFile(path, bytes);
    const resolved = await parseBinaryTarget(path);
    expect(resolved.ok).toBe(!corrupt);
    if (!resolved.ok) {
      if (!(resolved.error instanceof BinaryTargetError)) throw resolved.error;
      expect(resolved.error.reason).toContain("load command 1");
    }
  },
);

it.each([null, 0, 1])(
  "validates only the selected FAT slice's command framing (corrupt slice %s)",
  async (corruptIndex) => {
    const slices = [
      commandImage(true, true, [16]),
      commandImage(true, true, [16]),
    ];
    const x86 = slices[0]!;
    x86.writeUInt32LE(CPU.x86_64.type, 4);
    x86.writeUInt32LE(CPU.x86_64.subtype, 8);
    if (corruptIndex !== null)
      slices[corruptIndex]!.writeUInt32LE(0xffffffff, 36);
    const bytes = fatImage([
      { cpu: CPU.x86_64, bytes: x86 },
      { cpu: CPU.arm64, bytes: slices[1]! },
    ]);
    const path = join(
      await createTestTempDirectory("rea-fat-command-"),
      "image",
    );
    await writeFile(path, bytes);
    const resolved = await parseBinaryTarget(path, {
      hostArchitecture: "arm64",
    });
    // Slice 1 (arm64) is selected; corrupting unselected slice 0 is isolated.
    expect(resolved.ok).toBe(corruptIndex !== 1);
    if (!resolved.ok) {
      if (!(resolved.error instanceof BinaryTargetError)) throw resolved.error;
      expect(resolved.error.reason).toContain("invalid cmdsize");
      expect(projectAnalysisError(resolved.error)).toMatchObject({
        code: "target_unavailable",
      });
    } else
      expect(resolved.value).toMatchObject({
        format: "mach-o-universal",
        architecture: "arm64",
      });
  },
);

const OVERSIZED_COMMAND_BYTES = 16 * 1024 * 1024 + 8;

it("reports truncation when an oversized command table cannot fit the file", () => {
  const bytes = commandImage(true, true, [16]);
  bytes.writeUInt32LE(OVERSIZED_COMMAND_BYTES, 20);
  expect(() => readBinaryContainer(bytes, "elf-directory")).toThrow(
    BinaryFormatFailure,
  );
  expect(() => readBinaryContainer(bytes, "elf-directory")).toThrow(
    expect.objectContaining({
      kind: "truncated",
      failure: expect.objectContaining({ field: "Mach-O load commands" }),
    }),
  );
  expect(readMachoLoadCommandTableHeader(bytes, bytes.length)).toMatchObject({
    ok: false,
    error: expect.stringContaining("truncated Mach-O load commands"),
  });
});

it("retains the native capacity result for a backed oversized command table", () => {
  const bytes = commandImage(true, true, [OVERSIZED_COMMAND_BYTES]);
  expect(readMachoLoadCommandTableHeader(bytes, bytes.length)).toMatchObject({
    ok: true,
    value: { commandBytes: OVERSIZED_COMMAND_BYTES },
  });
  expect(() => readBinaryContainer(bytes, "elf-directory")).toThrow(
    BinaryResourceFailure,
  );
});
