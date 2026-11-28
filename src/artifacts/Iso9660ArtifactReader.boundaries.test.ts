import { setImmediate } from "node:timers/promises";

import { expect, it, vi } from "vitest";

import { Iso9660ArtifactReader } from "./Iso9660ArtifactReader.js";
import {
  DEFAULT_ISO9660_READER_LIMITS,
  type Iso9660ReaderLimits,
} from "../domain/artifactReaderLimits.js";
import { buildIso9660Image } from "../domain/iso9660/iso9660.fixture.js";
import { artifactReaderLifecycleCases } from "../../tests/fixtures/artifactReaderLifecycle.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";
import { createTestTempFile } from "../../tests/fixtures/temporaryDirectory.js";

vi.mock("node:timers/promises", async (importOriginal) => {
  const timers = await importOriginal<typeof import("node:timers/promises")>();
  return { ...timers, setImmediate: vi.fn(timers.setImmediate) };
});

const SECTOR = 2048;

const fixture = (bytes: Buffer): Promise<string> =>
  createTestTempFile("rea-iso9660-boundary-", "image.iso", bytes);

const inventory = async (
  bytes: Buffer,
  expandedBytes?: number,
  limits?: Iso9660ReaderLimits,
): Promise<unknown> => {
  const reader = new Iso9660ArtifactReader(
    await fixture(bytes),
    undefined,
    expandedBytes,
    limits,
  );
  try {
    for await (const _entry of reader.entries()) {
      /* Exhaust the listing. */
    }
    return undefined;
  } finally {
    await reader.close();
  }
};

const image = () =>
  buildIso9660Image({
    files: [
      { path: "dir/inner/file.bin", bytes: Buffer.from("payload") },
      { path: "top.txt", bytes: Buffer.from("top") },
    ],
  });

const bothEndian16 = (bytes: Buffer, at: number, value: number): void => {
  bytes.writeUInt16LE(value, at);
  bytes.writeUInt16BE(value, at + 2);
};

const bothEndian32 = (bytes: Buffer, at: number, value: number): void => {
  bytes.writeUInt32LE(value, at);
  bytes.writeUInt32BE(value, at + 4);
};

const rejectsAt = async (
  bytes: Buffer,
  reason: string,
  offset: number,
  field: string,
): Promise<void> => {
  await expect(inventory(bytes)).rejects.toMatchObject({
    reason,
    cause: { failure: { offset, field } },
  });
};

it.each([0x20, 0x40])("rejects reserved file flag %i", async (bit) => {
  const { bytes, layout } = image();
  const offset = layout.primaryRecords.get("top.txt")! + 25;
  bytes[offset]! |= bit;
  await rejectsAt(bytes, "malformed", offset, "file_flags");
});

it.each([0x08, 0x10, 0x18])(
  "rejects file flags %i without an extended attribute record",
  async (flags) => {
    const { bytes, layout } = image();
    const offset = layout.primaryRecords.get("top.txt")! + 25;
    bytes[offset] = flags;
    await rejectsAt(bytes, "malformed", offset, "file_flags");
  },
);

it.each(["self", "parent"])(
  "rejects a multi-extent %s record",
  async (kind) => {
    const { bytes, layout } = image();
    const root =
      bytes.readUInt32LE(layout.primaryDescriptor + 156 + 2) * SECTOR;
    const offset = root + (kind === "self" ? 0 : bytes[root]!) + 25;
    bytes[offset] = 0x82;
    await rejectsAt(bytes, "malformed", offset, "file_flags");
  },
);

it("reports the effective aggregate plaintext limit and admits an exact fit", async () => {
  const { bytes } = image();
  await expect(inventory(bytes, 9)).rejects.toMatchObject({
    reason: "limit",
    readerLimit: {
      parameter: "artifact_limits.expanded_bytes",
      effective_value: 9,
      required_value: 10,
      can_increase: true,
    },
  });
  await expect(inventory(bytes, 10)).resolves.toBeUndefined();
});

it("aliases a drive-like root directory and keeps its stored identifier", async () => {
  const { bytes } = buildIso9660Image({
    files: [
      { path: "C:/file", bytes: Buffer.from("x") },
      { path: "other", bytes: Buffer.from("y") },
    ],
  });
  const snapshot = await scanCanonicalArtifactInventory(await fixture(bytes));
  expect(snapshot.occurrences).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ logical_path: "entry-0", source_path: "C:" }),
      expect.objectContaining({ logical_path: "entry-0/file" }),
      expect.objectContaining({ logical_path: "other" }),
    ]),
  );
});

it.each([
  ["primary", 0],
  ["Joliet", SECTOR],
] as const)(
  "refuses an unsupported %s file structure version before walking its tree",
  async (_descriptor, delta) => {
    const { bytes, layout } = buildIso9660Image({ joliet: true });
    const offset = layout.primaryDescriptor + delta + 881;
    bytes[offset] = 2;
    await rejectsAt(bytes, "unsupported", offset, "file_structure_version");
  },
);

it("rejects a Joliet volume set that disagrees with the primary", async () => {
  const primary = buildIso9660Image({ joliet: true }).layout.primaryDescriptor;
  const joliet = primary + SECTOR;
  const sized = buildIso9660Image({ joliet: true }).bytes;
  bothEndian16(sized, joliet + 120, 2);
  await rejectsAt(sized, "malformed", joliet + 120, "volume_set_size");
  const halves = buildIso9660Image({ joliet: true }).bytes;
  halves.writeUInt16BE(2, joliet + 122);
  await rejectsAt(halves, "malformed", joliet + 120, "volume_set_size");
  // Both declare a two-volume set; the Joliet descriptor claims volume 2.
  const sequenced = buildIso9660Image({ joliet: true }).bytes;
  bothEndian16(sequenced, primary + 120, 2);
  bothEndian16(sequenced, joliet + 120, 2);
  bothEndian16(sequenced, joliet + 124, 2);
  bothEndian16(sequenced, joliet + 156 + 28, 2);
  await rejectsAt(
    sequenced,
    "malformed",
    joliet + 124,
    "volume_sequence_number",
  );
});

it("rejects a volume set size of 0 and a sequence number outside the set", async () => {
  const { layout } = image();
  const empty = image().bytes;
  bothEndian16(empty, layout.primaryDescriptor + 120, 0);
  await rejectsAt(
    empty,
    "malformed",
    layout.primaryDescriptor + 120,
    "volume_set_size",
  );
  for (const sequence of [0, 2]) {
    const { bytes } = image();
    bothEndian16(bytes, layout.primaryDescriptor + 124, sequence);
    await rejectsAt(
      bytes,
      "malformed",
      layout.primaryDescriptor + 124,
      "volume_sequence_number",
    );
  }
});

it.each([
  [1, 0, "malformed"],
  [1, 2, "malformed"],
  [2, 3, "malformed"],
  [2, 2, "unsupported"],
] as const)(
  "in a set of %i volumes, a directory record on volume %i is %s",
  async (setSize, recordVolume, reason) => {
    const { bytes, layout } = image();
    bothEndian16(bytes, layout.primaryDescriptor + 120, setSize);
    const record = layout.primaryRecords.get("top.txt")!;
    bothEndian16(bytes, record + 28, recordVolume);
    await rejectsAt(bytes, reason, record + 28, "volume_sequence_number");
  },
);

it("rejects a root record on a volume outside the declared set as malformed", async () => {
  const { bytes, layout } = image();
  bothEndian16(bytes, layout.primaryDescriptor + 156 + 28, 2);
  await rejectsAt(
    bytes,
    "malformed",
    layout.primaryDescriptor + 156 + 28,
    "volume_sequence_number",
  );
});

it("rejects a declared volume that ends before its descriptor set", async () => {
  const { bytes, layout } = image();
  // Sector 16 holds the primary descriptor and 17 the terminator.
  bothEndian32(bytes, layout.primaryDescriptor + 80, 17);
  await rejectsAt(
    bytes,
    "malformed",
    layout.primaryDescriptor + 80,
    "volume_space_size",
  );
});

it.each([
  ["identifier 0x01", 33, 1, "file_identifier"],
  ["associated-file flag", 25, 0x06, "file_flags"],
  ["record-format flag", 25, 0x0a, "file_flags"],
  ["multi-extent flag", 25, 0x82, "file_flags"],
] as const)(
  "rejects a descriptor root record with %s",
  async (_damage, field, value, name) => {
    const { bytes, layout } = image();
    const offset = layout.primaryDescriptor + 156 + field;
    bytes[offset] = value;
    await rejectsAt(bytes, "malformed", offset, name);
  },
);

it.each([
  ["associated", 0x04],
  ["hidden", 0x01],
] as const)(
  "keeps a section whose %s flag differs out of the multi-extent file",
  async (_flag, bit) => {
    const { bytes, layout } = buildIso9660Image({
      files: [
        { path: "file", bytes: Buffer.alloc(SECTOR + 1), extents: [SECTOR, 1] },
      ],
    });
    // The first section is an associated (or hidden) file missing its final
    // section; the next record is the ordinary file's.
    const first = layout.primaryRecords.get("file")!;
    bytes[first + 25] = 0x80 | bit;
    const second = first + bytes[first]!;
    await rejectsAt(bytes, "malformed", second + 25, "file_flags");
  },
);

it("reports an unterminated multi-extent file at its last flags byte", async () => {
  const { bytes, layout } = buildIso9660Image({
    files: [
      { path: "a", bytes: Buffer.from("a") },
      { path: "b", bytes: Buffer.from("b") },
    ],
  });
  const first = layout.primaryRecords.get("a")!;
  bytes[first + 25] = 0x80;
  await rejectsAt(bytes, "malformed", first + 25, "file_flags");
});

it("rejects a nonzero padding byte after an even-length identifier", async () => {
  const { bytes, layout } = buildIso9660Image({
    files: [{ path: "ab", bytes: Buffer.from("x") }],
  });
  // "ab;1" has four bytes, so a padding byte follows it.
  const offset = layout.primaryRecords.get("ab")! + 33 + 4;
  bytes[offset] = 0x20;
  await rejectsAt(bytes, "malformed", offset, "padding_field");
});

it("rejects an odd final record before the sector padding", async () => {
  const { bytes, layout } = buildIso9660Image({
    files: [{ path: "file", bytes: Buffer.from("x") }],
  });
  const record = layout.primaryRecords.get("file")!;
  bytes[record] = bytes[record]! + 1;
  await rejectsAt(bytes, "malformed", record, "length");
});

it.each([1, 3])(
  "rejects %i attribute blocks in a two-block file unit",
  async (length) => {
    const { bytes, layout } = image();
    const record = layout.primaryRecords.get("top.txt")!;
    bytes[record + 1] = length;
    bytes[record + 26] = 2;
    bytes[record + 27] = 1;
    await rejectsAt(
      bytes,
      "malformed",
      record + 1,
      "extended_attribute_length",
    );
  },
);

it("rejects an interleave gap declared without a file unit size", async () => {
  const { bytes, layout } = image();
  const offset = layout.primaryRecords.get("top.txt")! + 27;
  bytes[offset] = 1;
  await rejectsAt(bytes, "malformed", offset, "interleave_gap_size");
});

it.each(["self", "parent", "named"] as const)(
  "rejects an interleaved %s directory record",
  async (kind) => {
    const { bytes, layout } = image();
    const self = layout.directoryBlocks.get("dir")! * SECTOR;
    const records = {
      self,
      parent: self + bytes[self]!,
      named: layout.primaryRecords.get("dir")!,
    };
    const offset = records[kind] + 26;
    bytes[offset] = 1;
    await rejectsAt(
      bytes,
      kind === "named" ? "unsupported" : "malformed",
      offset,
      "file_unit_size",
    );
  },
);

it.each([
  ["data length", 10, "data_length"],
  ["extended attribute length", 1, "extended_attribute_length"],
] as const)(
  "rejects a parent (..) record whose %s differs from the parent's record",
  async (_field, at, field) => {
    const { bytes, layout } = image();
    const parent = layout.directoryBlocks.get("dir/inner")! * SECTOR + 34;
    if (at === 10) bothEndian32(bytes, parent + 10, 2 * SECTOR);
    else bytes[parent + 1] = 1;
    await rejectsAt(bytes, "malformed", parent + at, field);
  },
);

it("walks the primary tree with unknown coverage when a Joliet descriptor is skipped", async () => {
  const { bytes, layout } = buildIso9660Image({
    joliet: true,
    files: [{ path: "a.txt", bytes: Buffer.from("a") }],
  });
  bytes[layout.primaryDescriptor + SECTOR + 7] = 1;
  const snapshot = await scanCanonicalArtifactInventory(await fixture(bytes));
  expect(snapshot.coverage.status).toBe("unknown");
  expect(snapshot.limitations.join(" ")).toContain(
    "whether the skipped Joliet tree applies is unknown",
  );
  expect(
    snapshot.occurrences.find((row) => row.logical_path === ".")
      ?.format_metadata,
  ).toMatchObject({ name_source: "primary" });
  expect(snapshot.occurrences.some((row) => row.logical_path === "a.txt")).toBe(
    true,
  );
});

it("reads a Joliet surrogate pair and rejects an unpaired surrogate at its unit", async () => {
  const name = "a\u{1f600}b";
  const { bytes, layout } = buildIso9660Image({
    joliet: true,
    files: [{ path: name, bytes: Buffer.from("x") }],
  });
  const snapshot = await scanCanonicalArtifactInventory(await fixture(bytes));
  expect(snapshot.occurrences.map((row) => row.logical_path)).toContain(name);
  // Replace the low surrogate with "c": the high surrogate is unpaired.
  const high = layout.jolietRecords.get(name)! + 33 + 2;
  bytes.writeUInt16BE(0x63, high + 2);
  await rejectsAt(bytes, "malformed", high, "file_identifier");
});

it.each([true, false])(
  "rejects conflicting Joliet volume size (matching halves: %s)",
  async (matchingHalves) => {
    const { bytes, layout } = buildIso9660Image({ joliet: true });
    const offset = layout.primaryDescriptor + SECTOR + 80;
    const smaller = bytes.readUInt32LE(offset) - 1;
    if (matchingHalves) bytes.writeUInt32LE(smaller, offset);
    bytes.writeUInt32BE(smaller, offset + 4);
    await expect(inventory(bytes)).rejects.toMatchObject({
      reason: "malformed",
      cause: { failure: { offset, field: "volume_space_size" } },
    });
  },
);

it.each([0xd800, 0xdfff])(
  "rejects Joliet surrogate %i at its source offset",
  async (unit) => {
    const { bytes, layout } = buildIso9660Image({
      joliet: true,
      files: [{ path: "ab", bytes: Buffer.from("x") }],
    });
    const offset = layout.jolietRecords.get("ab")! + 33 + 2;
    bytes.writeUInt16BE(unit, offset);
    await expect(inventory(bytes)).rejects.toMatchObject({
      reason: "malformed",
      cause: { failure: { offset, field: "file_identifier" } },
    });
  },
);

it("fails a both-endian directory record disagreement as malformed", async () => {
  const { bytes, layout } = image();
  bytes.writeUInt32BE(9, layout.primaryRecords.get("top.txt")! + 14);
  await expect(inventory(bytes)).rejects.toMatchObject({
    reason: "malformed",
    message: expect.stringContaining("data_length"),
  });
});

it("fails a directory that points back at an ancestor as a cycle", async () => {
  const { bytes, layout } = image();
  const record = layout.primaryRecords.get("dir/inner")!;
  bytes.writeUInt32LE(layout.directoryBlocks.get("")!, record + 2);
  bytes.writeUInt32BE(layout.directoryBlocks.get("")!, record + 6);
  await expect(inventory(bytes)).rejects.toMatchObject({
    reason: "malformed",
    message: expect.stringContaining("revisits the extent"),
  });
});

it.each([
  [-1, "extent_location", 2],
  [1, "data_length", 10],
] as const)(
  "reports truncation when the image ends %i bytes from the file start",
  async (delta, field, fieldOffset) => {
    const { bytes, layout } = image();
    const record = layout.primaryRecords.get("top.txt")!;
    const start = bytes.readUInt32LE(record + 2) * SECTOR;
    await expect(
      inventory(bytes.subarray(0, start + delta)),
    ).rejects.toMatchObject({
      reason: "truncated",
      cause: { failure: { offset: record + fieldOffset, field } },
    });
  },
);

it("rejects an extent ending in trailing image bytes as malformed", async () => {
  const { bytes, layout } = image();
  const record = layout.primaryRecords.get("top.txt")!;
  const start = bytes.readUInt32LE(record + 2) * SECTOR;
  const length = bytes.length - start + 1;
  bytes.writeUInt32LE(length, record + 10);
  bytes.writeUInt32BE(length, record + 14);
  const paddedImage = Buffer.concat([bytes, Buffer.alloc(1)]);
  await expect(inventory(paddedImage)).rejects.toMatchObject({
    reason: "malformed",
    message: expect.stringContaining("declared volume"),
  });
});

it("refuses a logical block size other than 2048 as unsupported", async () => {
  const { bytes, layout } = image();
  bytes.writeUInt16LE(512, layout.primaryDescriptor + 128);
  bytes.writeUInt16BE(512, layout.primaryDescriptor + 130);
  await expect(inventory(bytes)).rejects.toMatchObject({
    reason: "unsupported",
  });
});

it("stops directory nesting at its depth allowance and admits when raised", async () => {
  const deep = Array.from({ length: 65 }, (_, index) => `d${String(index)}`);
  const { bytes } = buildIso9660Image({ directories: [deep.join("/")] });
  await expect(inventory(bytes)).rejects.toMatchObject({
    reason: "limit",
    readerLimit: {
      parameter: "artifact_limits.iso9660.directory_depth",
      effective_value: 64,
      unit: "count",
      required_value: 65,
      can_increase: true,
    },
  });
  await expect(
    inventory(bytes, undefined, {
      ...DEFAULT_ISO9660_READER_LIMITS,
      directory_depth: 65,
    }),
  ).resolves.toBeUndefined();
  const allowed = buildIso9660Image({
    directories: [deep.slice(0, 64).join("/")],
  });
  await expect(inventory(allowed.bytes)).resolves.toBeUndefined();
});

it("charges expanded entry paths against their allowance and admits when raised", async () => {
  // Sixty 200-byte directory names give each file about 24 KB of path and
  // source path while records, directory bytes and file bytes stay small.
  const deep = Array.from(
    { length: 60 },
    (_, index) => `${String(index).padStart(3, "0")}${"d".repeat(197)}`,
  ).join("/");
  const files = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      path: `${deep}/f${String(index)}`,
      bytes: Buffer.alloc(0),
    }));
  const overDefault = buildIso9660Image({ files: files(2_800) }).bytes;
  await expect(inventory(overDefault)).rejects.toMatchObject({
    reason: "limit",
    readerLimit: {
      parameter: "artifact_limits.iso9660.path_bytes",
      effective_value: 64 * 1024 * 1024,
      unit: "bytes",
      can_increase: true,
    },
  });
  await expect(
    inventory(overDefault, undefined, {
      ...DEFAULT_ISO9660_READER_LIMITS,
      path_bytes: 80 * 1024 * 1024,
    }),
  ).resolves.toBeUndefined();
  await expect(
    inventory(buildIso9660Image({ files: files(8) }).bytes),
  ).resolves.toBeUndefined();
});

it("enforces configurable descriptor_count, record_count, and directory_bytes limits", async () => {
  const { bytes } = image();
  await expect(
    inventory(bytes, undefined, {
      ...DEFAULT_ISO9660_READER_LIMITS,
      descriptor_count: 1,
    }),
  ).rejects.toMatchObject({
    reason: "limit",
    readerLimit: {
      parameter: "artifact_limits.iso9660.descriptor_count",
      effective_value: 1,
      unit: "count",
      required_value: 2,
      can_increase: true,
    },
  });
  await expect(
    inventory(bytes, undefined, {
      ...DEFAULT_ISO9660_READER_LIMITS,
      record_count: 2,
    }),
  ).rejects.toMatchObject({
    reason: "limit",
    readerLimit: {
      parameter: "artifact_limits.iso9660.record_count",
      effective_value: 2,
      unit: "count",
      required_value: 3,
      can_increase: true,
    },
  });
  await expect(
    inventory(bytes, undefined, {
      ...DEFAULT_ISO9660_READER_LIMITS,
      directory_bytes: SECTOR - 1,
    }),
  ).rejects.toMatchObject({
    reason: "limit",
    readerLimit: {
      parameter: "artifact_limits.iso9660.directory_bytes",
      effective_value: SECTOR - 1,
      unit: "bytes",
      required_value: SECTOR,
      can_increase: true,
    },
  });
});

it("rejects a directory as the final section of a file", async () => {
  const { bytes, layout } = buildIso9660Image({
    files: [
      { path: "file", bytes: Buffer.alloc(SECTOR + 1), extents: [SECTOR, 1] },
    ],
  });
  const first = layout.primaryRecords.get("file")!;
  bytes[first + bytes[first]! + 25] = 2;
  await expect(inventory(bytes)).rejects.toMatchObject({
    reason: "malformed",
    message: expect.stringContaining("multi-extent file"),
  });
});

it("fails a directory extent without its . and .. records as malformed", async () => {
  for (const path of ["", "dir/inner"]) {
    const { bytes, layout } = image();
    const start = layout.directoryBlocks.get(path)! * SECTOR;
    bytes.fill(0, start, start + SECTOR);
    await expect(inventory(bytes), path || "/").rejects.toMatchObject({
      reason: "malformed",
      message: expect.stringContaining("lacks its self (.) record"),
    });
  }
});

it.each([
  ["self", 0, () => 0x7fff_ffff],
  ["parent", 34, (blocks: ReadonlyMap<string, number>) => blocks.get("")!],
] as const)(
  "rejects a %s record that references the wrong directory as malformed",
  async (_link, record, location) => {
    const { bytes, layout } = image();
    const at = layout.directoryBlocks.get("dir/inner")! * SECTOR + record;
    const block = location(layout.directoryBlocks);
    bytes.writeUInt32LE(block, at + 2);
    bytes.writeUInt32BE(block, at + 6);
    await expect(inventory(bytes)).rejects.toMatchObject({
      reason: "malformed",
      cause: { failure: { offset: at + 2, field: "extent_location" } },
    });
  },
);

it("rejects an interleaved file whose gaps carry it past the declared volume", async () => {
  // Two one-block units with a one-block gap need three blocks; two remain.
  const { bytes } = buildIso9660Image({
    files: [
      { path: "units.bin", bytes: Buffer.alloc(SECTOR + 1), interleaved: true },
    ],
  });
  await expect(inventory(bytes)).rejects.toMatchObject({
    reason: "malformed",
    message: expect.stringContaining("declared volume"),
  });
});

it("reports the record of the section whose extent is invalid", async () => {
  const { bytes, layout } = buildIso9660Image({
    files: [
      { path: "file", bytes: Buffer.alloc(SECTOR + 1), extents: [SECTOR, 1] },
    ],
  });
  const second =
    layout.primaryRecords.get("file")! +
    bytes[layout.primaryRecords.get("file")!]!;
  const beyond = bytes.length / SECTOR + 8;
  bytes.writeUInt32LE(beyond, second + 2);
  bytes.writeUInt32BE(beyond, second + 6);
  await expect(inventory(bytes)).rejects.toMatchObject({
    reason: "malformed",
    cause: { failure: { offset: second + 2, field: "extent_location" } },
  });
});

it("recognizes a file ending inside the first descriptor and fails it as truncated", async () => {
  const { bytes } = image();
  await expect(
    inventory(bytes.subarray(0, 16 * SECTOR + 100)),
  ).rejects.toMatchObject({
    reason: "truncated",
    message: expect.stringContaining("first volume descriptor"),
  });
});

it("reports complete coverage for a primary-only image and names the unwalked primary tree under Joliet", async () => {
  const primary = await scanCanonicalArtifactInventory(
    await fixture(image().bytes),
  );
  expect(primary.coverage.status).toBe("complete");
  const { bytes, layout } = buildIso9660Image({
    joliet: true,
    files: [{ path: "a.txt", bytes: Buffer.from("a") }],
  });
  // The trees diverge: the primary tree lists a file Joliet does not.
  bytes.write("Z.TXT;1", layout.primaryRecords.get("a.txt")! + 33, "latin1");
  const joliet = await scanCanonicalArtifactInventory(await fixture(bytes));
  expect(joliet.coverage.status).toBe("unknown");
  expect(joliet.occurrences.map((row) => row.logical_path)).toContain("a.txt");
  expect(joliet.limitations.join(" ")).toContain(
    `The primary directory tree (root extent at block ${String(bytes.readUInt32LE(layout.primaryDescriptor + 156 + 2))}) was not walked`,
  );
});

it("admits a root extent against the image before charging its directory bytes", async () => {
  const { bytes, layout } = image();
  // 64 MiB and one block of root directory in an image of a few blocks.
  const at = layout.primaryDescriptor + 156 + 10;
  bothEndian32(bytes, at, 64 * 1024 * 1024 + SECTOR);
  await rejectsAt(bytes, "malformed", at, "data_length");
});

/** Absolute offsets of a directory extent's records, padding skipped. */
const recordOffsets = (bytes: Buffer, start: number): number[] => {
  const length = bytes.readUInt32LE(start + 10);
  const offsets: number[] = [];
  for (let at = 0; at < length;) {
    if (bytes[start + at] === 0) {
      at = (Math.floor(at / SECTOR) + 1) * SECTOR;
      continue;
    }
    offsets.push(start + at);
    at += bytes[start + at]!;
  }
  return offsets;
};

/** A root directory whose only failure follows 600 sections of one file. */
const longChain = () => {
  const sections = 600;
  const { bytes, layout } = buildIso9660Image({
    files: [
      {
        path: "chain.bin",
        bytes: Buffer.alloc(sections * SECTOR),
        extents: Array.from({ length: sections }, () => SECTOR),
      },
    ],
  });
  const last = recordOffsets(
    bytes,
    layout.directoryBlocks.get("")! * SECTOR,
  ).at(-1)!;
  bytes[last + 25]! |= 0x01;
  return { bytes, offset: last + 25, field: "file_flags" };
};

it("checks a continuing extent before reading the final section", async () => {
  const { bytes, layout } = buildIso9660Image({
    files: [
      { path: "file", bytes: Buffer.alloc(SECTOR + 1), extents: [SECTOR, 1] },
    ],
  });
  const first = layout.primaryRecords.get("file")!;
  bothEndian32(bytes, first + 2, 0xffffffff);
  const second = first + bytes[first]!;
  bytes[second + 25]! |= 0x01;
  await rejectsAt(bytes, "malformed", first + 2, "extent_location");
});

/** A root directory whose only failure follows 300 sectors of padding. */
const longPadding = () => {
  const sectors = 300;
  const { bytes, layout } = buildIso9660Image({
    files: [{ path: "pad.bin", bytes: Buffer.alloc(sectors * SECTOR) }],
  });
  const root = layout.directoryBlocks.get("")! * SECTOR;
  const length = (sectors + 1) * SECTOR;
  for (const at of [layout.primaryDescriptor + 156, root, root + 34])
    bothEndian32(bytes, at + 10, length);
  const record = layout.primaryRecords.get("pad.bin")!;
  bytes.fill(0, record, record + bytes[record]!);
  const offset = root + length - 1;
  bytes[offset] = 1;
  return { bytes, offset, field: "directory_padding" };
};

it.each([
  ["multi-extent chain", longChain],
  ["run of sector padding", longPadding],
] as const)(
  "yields and observes cancellation inside a long %s that lists nothing",
  async (_kind, build) => {
    const { bytes, offset, field } = build();
    // Uncancelled, the walk reaches the damage at the end of the run.
    await rejectsAt(bytes, "malformed", offset, field);
    const controller = new AbortController();
    const reason = new Error("cancel a long directory");
    vi.mocked(setImmediate).mockImplementationOnce(() => {
      controller.abort(reason);
      return Promise.resolve(undefined);
    });
    const reader = new Iso9660ArtifactReader(await fixture(bytes));
    try {
      await expect(
        (async () => {
          for await (const _entry of reader.entries(controller.signal)) {
            /* Exhaust the listing. */
          }
        })(),
      ).rejects.toMatchObject({ reason: "cancelled", cause: reason });
    } finally {
      await reader.close();
    }
  },
);

artifactReaderLifecycleCases({
  image: () => image().bytes,
  createReader: (path, admitted) => new Iso9660ArtifactReader(path, admitted),
});
