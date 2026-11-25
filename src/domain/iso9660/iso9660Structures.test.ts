import { expect, it } from "vitest";

import { buildIso9660Image } from "./iso9660.fixture.js";
import {
  decodeIso9660RecordDate,
  decodeIso9660VolumeDate,
} from "./iso9660Dates.js";
import { parseIso9660VolumeDescriptors } from "./iso9660VolumeDescriptors.js";
import {
  extentOf,
  ISO9660_DESCRIPTOR_OFFSET,
  iso9660DirectoryRecordAt,
  ISO9660_SECTOR_BYTES,
  parseIso9660DirectoryExtent,
  type Iso9660DirectoryStep,
} from "./iso9660Structures.js";
import { groupIso9660Members, iso9660PathSegment } from "./iso9660Members.js";

/** A one-sector directory extent at `block`, as its admitting record describes it. */
const directoryLink = (block: number) => ({
  extentLocation: block,
  dataLength: ISO9660_SECTOR_BYTES,
  extendedAttributeLength: 0,
});

/** The only volume of a one-volume set. */
const ONE_VOLUME = { size: 1, sequence: 1 };

/** The root's `.` and `..` both describe the root extent. */
const rootLinks = (layout: {
  readonly directoryBlocks: ReadonlyMap<string, number>;
}) => {
  const root = directoryLink(layout.directoryBlocks.get("")!);
  return { self: root, parent: root };
};

/** The records among a directory extent's steps. */
const recordsOf = (steps: Iterable<Iso9660DirectoryStep>) =>
  Array.from(steps).flatMap((step) =>
    step.kind === "record" ? [step.record] : [],
  );

const descriptors = (image: Buffer) =>
  parseIso9660VolumeDescriptors(
    image.subarray(
      ISO9660_DESCRIPTOR_OFFSET,
      ISO9660_DESCRIPTOR_OFFSET + 8 * ISO9660_SECTOR_BYTES,
    ),
    image.length,
  );

it("accepts a volume partition descriptor and rejects reserved types", () => {
  const { bytes, layout } = buildIso9660Image({ joliet: true });
  const offset = layout.primaryDescriptor + ISO9660_SECTOR_BYTES;
  bytes[offset] = 3;
  expect(descriptors(bytes).ok).toBe(true);
  for (const type of [4, 254]) {
    bytes[offset] = type;
    expect(descriptors(bytes)).toMatchObject({
      ok: false,
      error: {
        failure: { kind: "malformed", field: "volume_descriptor_type", offset },
      },
    });
  }
});

it("accepts identical primary recordings and rejects a conflicting root", () => {
  const { bytes, layout } = buildIso9660Image({ joliet: true });
  const first = layout.primaryDescriptor;
  const copy = first + ISO9660_SECTOR_BYTES;
  bytes.copy(bytes, copy, first, copy);
  expect(descriptors(bytes)).toMatchObject({
    ok: true,
    value: { treeCoverage: "complete" },
  });
  const root = bytes.readUInt32LE(copy + 158) + 1;
  bytes.writeUInt32LE(root, copy + 158);
  bytes.writeUInt32BE(root, copy + 162);
  expect(descriptors(bytes)).toMatchObject({
    ok: false,
    error: {
      failure: {
        kind: "malformed",
        field: "primary_volume_descriptor",
        offset: copy,
      },
    },
  });
});

it("decodes the primary descriptor, Joliet level and El Torito record", () => {
  const { bytes } = buildIso9660Image({
    joliet: true,
    elTorito: true,
    volumeIdentifier: "INSTALLER",
    files: [{ path: "a.txt", bytes: Buffer.from("a") }],
  });
  const parsed = descriptors(bytes);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.value).toMatchObject({
    systemIdentifier: "REA",
    volumeIdentifier: "INSTALLER",
    applicationIdentifier: "REA FIXTURE",
    logicalBlockSize: 2048,
    volumeSpaceSize: bytes.length / ISO9660_SECTOR_BYTES,
    creationDate: "2024-01-02T03:04:05.00+01:00",
    expirationDate: null,
    jolietLevel: 3,
    elTorito: true,
    bootCatalogSector: bytes.length / ISO9660_SECTOR_BYTES - 1,
    descriptorCount: 4,
    nameSource: "joliet",
    treeCoverage: "unknown",
  });
  expect(parsed.value.jolietRoot).not.toBeNull();
  // The Joliet tree is walked; the primary tree may list other files.
  expect(parsed.value.limitations).toEqual([
    `The primary directory tree (root extent at block ${String(parsed.value.primaryRoot.extentLocation)}) was not walked; files listed only there are not reported.`,
  ]);
});

it("rejects an unsupported El Torito boot record version", () => {
  const { bytes, layout } = buildIso9660Image({ elTorito: true });
  const offset = layout.primaryDescriptor + ISO9660_SECTOR_BYTES + 6;
  bytes[offset] = 2;
  expect(descriptors(bytes)).toMatchObject({
    ok: false,
    error: { failure: { kind: "unsupported", offset, field: "version" } },
  });
});

it("validates repeated El Torito boot records", () => {
  const { bytes, layout } = buildIso9660Image({ elTorito: true, joliet: true });
  const first = layout.primaryDescriptor + ISO9660_SECTOR_BYTES;
  const second = first + ISO9660_SECTOR_BYTES;
  bytes.copy(bytes, second, first, second);
  const catalog = bytes.readUInt32LE(first + 71);
  expect(descriptors(bytes)).toMatchObject({
    ok: true,
    value: { bootCatalogSector: catalog },
  });

  bytes[second + 6] = 2;
  expect(descriptors(bytes)).toMatchObject({
    ok: false,
    error: {
      failure: { kind: "unsupported", offset: second + 6, field: "version" },
    },
  });

  bytes[second + 6] = 1;
  bytes.writeUInt32LE(catalog - 1, second + 71);
  expect(descriptors(bytes)).toMatchObject({
    ok: false,
    error: { failure: { offset: second + 71, field: "boot_catalog_sector" } },
  });
});

it("ignores a Joliet designation after the start of the escape field", () => {
  const { bytes, layout } = buildIso9660Image({ joliet: true });
  bytes.write(
    "XYZ%/E",
    layout.primaryDescriptor + ISO9660_SECTOR_BYTES + 88,
    "latin1",
  );
  expect(descriptors(bytes)).toMatchObject({
    ok: true,
    value: { jolietLevel: null, jolietRoot: null },
  });
});

it("keeps the primary tree when a Joliet descriptor is not eligible", () => {
  for (const [at, value, reason] of [
    [6, 2, "descriptor version is 2"],
    [7, 1, "unregistered escape sequences"],
  ] as const) {
    const { bytes, layout } = buildIso9660Image({ joliet: true });
    bytes[layout.primaryDescriptor + ISO9660_SECTOR_BYTES + at] = value;
    const parsed = descriptors(bytes);
    expect(parsed).toMatchObject({
      ok: true,
      value: { jolietLevel: null, jolietRoot: null },
    });
    if (!parsed.ok) return;
    expect(parsed.value.limitations.join(" ")).toContain(reason);
    expect(parsed.value.limitations.join(" ")).toContain(
      "Names come from the primary tree",
    );
  }
});

it("derives the primary-tree fallback only after a later Joliet descriptor is weighed", () => {
  const { bytes, layout } = buildIso9660Image({ joliet: true });
  const sector = (index: number) =>
    bytes.subarray(
      layout.primaryDescriptor + index * ISO9660_SECTOR_BYTES,
      layout.primaryDescriptor + (index + 1) * ISO9660_SECTOR_BYTES,
    );
  const skipped = Buffer.from(sector(1));
  skipped[6] = 2;
  const parsed = parseIso9660VolumeDescriptors(
    Buffer.concat([sector(0), skipped, sector(1), sector(2)]),
    bytes.length,
  );
  expect(parsed).toMatchObject({ ok: true, value: { jolietLevel: 3 } });
  if (!parsed.ok) return;
  expect(parsed.value.jolietRoot).not.toBeNull();
  expect(parsed.value.treeCoverage).toBe("unknown");
  expect(parsed.value.limitations).toEqual([
    `A supplementary descriptor at byte ${String(ISO9660_DESCRIPTOR_OFFSET + ISO9660_SECTOR_BYTES)} carries a Joliet escape sequence but was not used because its descriptor version is 2, not 1.`,
    `The primary directory tree (root extent at block ${String(parsed.value.primaryRoot.extentLocation)}) was not walked; files listed only there are not reported.`,
  ]);
  expect(parsed.value.limitations.join(" ")).not.toContain(
    "Names come from the primary tree",
  );
});

it("reports image-wide tree coverage as unknown whenever another tree is not walked", () => {
  const primaryOnly = descriptors(buildIso9660Image().bytes);
  expect(primaryOnly).toMatchObject({
    ok: true,
    value: { nameSource: "primary", treeCoverage: "complete", limitations: [] },
  });
  const { bytes, layout } = buildIso9660Image({ joliet: true });
  const supplementary = layout.primaryDescriptor + ISO9660_SECTOR_BYTES;
  const sector = (index: number) =>
    bytes.subarray(
      layout.primaryDescriptor + index * ISO9660_SECTOR_BYTES,
      layout.primaryDescriptor + (index + 1) * ISO9660_SECTOR_BYTES,
    );
  // A second Joliet descriptor names a tree that is not walked.
  const repeated = parseIso9660VolumeDescriptors(
    Buffer.concat([sector(0), sector(1), sector(1), sector(2)]),
    bytes.length,
  );
  expect(repeated).toMatchObject({
    ok: true,
    value: { nameSource: "joliet", treeCoverage: "unknown" },
  });
  if (!repeated.ok) return;
  expect(repeated.value.limitations).toContain(
    `The directory tree of the additional Joliet descriptor at byte ${String(supplementary + ISO9660_SECTOR_BYTES)} was not walked; files listed only there are not reported.`,
  );
  // A supplementary descriptor without Joliet escapes still has its own tree.
  bytes.fill(0x20, supplementary + 88, supplementary + 120);
  const plain = descriptors(bytes);
  expect(plain).toMatchObject({
    ok: true,
    value: { nameSource: "primary", treeCoverage: "unknown" },
  });
  if (!plain.ok) return;
  expect(plain.value.limitations).toEqual([
    `The directory tree of the non-Joliet supplementary descriptor at byte ${String(supplementary)} was not walked; files listed only there are not reported.`,
  ]);
});

it("fails both-endian disagreement, block size and a missing terminator with their kinds", () => {
  const { bytes, layout } = buildIso9660Image();
  const mismatch = Buffer.from(bytes);
  mismatch.writeUInt32BE(1, layout.primaryDescriptor + 84);
  expect(descriptors(mismatch)).toMatchObject({
    ok: false,
    error: { failure: { kind: "malformed", field: "volume_space_size" } },
  });
  const blocks = Buffer.from(bytes);
  blocks.writeUInt16LE(4096, layout.primaryDescriptor + 128);
  blocks.writeUInt16BE(4096, layout.primaryDescriptor + 130);
  expect(descriptors(blocks)).toMatchObject({
    ok: false,
    error: {
      failure: { kind: "unsupported", field: "logical_block_size" },
    },
  });
  const unterminated = Buffer.from(bytes);
  unterminated[layout.primaryDescriptor + ISO9660_SECTOR_BYTES] = 3;
  expect(
    parseIso9660VolumeDescriptors(
      unterminated.subarray(
        ISO9660_DESCRIPTOR_OFFSET,
        ISO9660_DESCRIPTOR_OFFSET + 2 * ISO9660_SECTOR_BYTES,
      ),
      unterminated.length,
    ),
  ).toMatchObject({ ok: false, error: { failure: { kind: "truncated" } } });
});

it("rejects a terminator whose descriptor version is not 1", () => {
  const { bytes, layout } = buildIso9660Image();
  expect(descriptors(bytes).ok).toBe(true);
  const terminator = layout.primaryDescriptor + ISO9660_SECTOR_BYTES;
  expect(bytes[terminator]).toBe(255);
  const offset = terminator + 6;
  bytes[offset] = 2;
  expect(descriptors(bytes)).toMatchObject({
    ok: false,
    error: { failure: { kind: "malformed", field: "version", offset } },
  });
});

it("decodes both date forms and leaves unrecorded dates null", () => {
  expect(
    decodeIso9660RecordDate(Uint8Array.from([124, 1, 2, 3, 4, 5, 0xfc]), 0),
  ).toBe("2024-01-02T03:04:05-01:00");
  expect(decodeIso9660RecordDate(new Uint8Array(7), 0)).toBeNull();
  expect(
    decodeIso9660RecordDate(Uint8Array.from([124, 13, 2, 3, 4, 5, 0]), 0),
  ).toBeNull();
  const volume = Buffer.alloc(17);
  volume.write("1999123123595999", 0, "latin1");
  expect(decodeIso9660VolumeDate(volume, 0)).toBe(
    "1999-12-31T23:59:59.99+00:00",
  );
  // Days are checked against the month and leap year.
  expect(
    decodeIso9660RecordDate(Uint8Array.from([124, 2, 30, 0, 0, 0, 0]), 0),
  ).toBeNull();
  expect(
    decodeIso9660RecordDate(Uint8Array.from([123, 2, 29, 0, 0, 0, 0]), 0),
  ).toBeNull();
  expect(
    decodeIso9660RecordDate(Uint8Array.from([124, 2, 29, 0, 0, 0, 0]), 0),
  ).toBe("2024-02-29T00:00:00+00:00");
  for (const digits of [
    "2023022900000000",
    "1900022900000000",
    "2024043100000000",
  ])
    expect(
      decodeIso9660VolumeDate(Buffer.from(`${digits}\0`, "latin1"), 0),
      digits,
    ).toBeNull();
  expect(
    decodeIso9660VolumeDate(Buffer.from("2000022900000000\0", "latin1"), 0),
  ).toBe("2000-02-29T00:00:00.00+00:00");
  expect(
    decodeIso9660VolumeDate(Buffer.from("0000000000000000\0", "latin1"), 0),
  ).toBeNull();
});

it("groups multi-extent records and strips version suffixes", () => {
  const { bytes, layout } = buildIso9660Image({
    files: [
      {
        path: "big.bin",
        bytes: Buffer.alloc(ISO9660_SECTOR_BYTES + 5, 7),
        extents: [ISO9660_SECTOR_BYTES, 5],
      },
      {
        path: "split.bin",
        bytes: Buffer.alloc(ISO9660_SECTOR_BYTES + 5, 8),
        extents: [ISO9660_SECTOR_BYTES, 5],
        fragmented: true,
      },
      { path: "README.", bytes: Buffer.from("r") },
    ],
  });
  // Use the gap before the second split section for its protection attributes.
  const first = layout.primaryRecords.get("split.bin")!;
  const second = first + bytes[first]!;
  const attributeBlock = bytes.readUInt32LE(second + 2) - 1;
  bytes.writeUInt32LE(attributeBlock, second + 2);
  bytes.writeUInt32BE(attributeBlock, second + 6);
  bytes[second + 1] = 1;
  bytes[second + 25] = 0x10;
  const root = layout.directoryBlocks.get("")! * ISO9660_SECTOR_BYTES;
  const steps = Array.from(
    parseIso9660DirectoryExtent(
      bytes.subarray(root, root + ISO9660_SECTOR_BYTES),
      root,
      () => {},
      ONE_VOLUME,
      rootLinks(layout),
    ),
  );
  const grouped = Array.from(groupIso9660Members(steps, false));
  // One value per step, so a long chain never completes inside one next().
  expect(grouped).toHaveLength(steps.length);
  const members = grouped.filter((member) => member !== undefined);
  expect(
    members.map(({ identifier, name, dataLength, layout: shape }) => ({
      identifier,
      name,
      dataLength,
      shape,
    })),
  ).toEqual([
    {
      identifier: "big.bin;1",
      name: "big.bin",
      dataLength: ISO9660_SECTOR_BYTES + 5,
      shape: "contiguous",
    },
    {
      identifier: "split.bin;1",
      name: "split.bin",
      dataLength: ISO9660_SECTOR_BYTES + 5,
      shape: "fragmented",
    },
    {
      identifier: "README.;1",
      name: "README",
      dataLength: 1,
      shape: "contiguous",
    },
  ]);
  // Dropping the final record leaves a multi-extent file unterminated.
  expect(() =>
    Array.from(groupIso9660Members(steps.slice(0, 3), false)),
  ).toThrow("multi-extent");
});

it("requires a directory extent to open with its . and .. records", () => {
  const { bytes, layout } = buildIso9660Image({
    files: [{ path: "a.txt", bytes: Buffer.from("a") }],
  });
  const root = layout.directoryBlocks.get("")! * ISO9660_SECTOR_BYTES;
  const parse = (extent: Buffer) =>
    recordsOf(
      parseIso9660DirectoryExtent(
        extent,
        root,
        () => {},
        ONE_VOLUME,
        rootLinks(layout),
      ),
    );
  expect(parse(bytes.subarray(root, root + ISO9660_SECTOR_BYTES))).toHaveLength(
    3,
  );
  for (const damaged of [
    Buffer.alloc(0),
    Buffer.alloc(ISO9660_SECTOR_BYTES),
    // Only the self record survives.
    Buffer.concat([
      bytes.subarray(root, root + 34),
      Buffer.alloc(ISO9660_SECTOR_BYTES - 34),
    ]),
  ])
    expect(() => parse(damaged)).toThrow(/lacks its (self|parent)/u);
  // A file record where the self record belongs is not a listing.
  const shifted = Buffer.from(
    bytes.subarray(root, root + ISO9660_SECTOR_BYTES),
  );
  shifted.copy(shifted, 0, 68);
  expect(() => parse(shifted)).toThrow("lacks its self (.) record");
});

it("rejects conflicting self declarations and nonzero sector padding", () => {
  const { bytes, layout } = buildIso9660Image({
    files: [{ path: "a.txt", bytes: Buffer.from("a") }],
  });
  const links = rootLinks(layout);
  const start = links.self.extentLocation * ISO9660_SECTOR_BYTES;
  const extent = Buffer.from(
    bytes.subarray(start, start + ISO9660_SECTOR_BYTES),
  );
  const check = (offset: number, field: string) =>
    expect(() =>
      Array.from(
        parseIso9660DirectoryExtent(extent, start, () => {}, ONE_VOLUME, links),
      ),
    ).toThrow(
      expect.objectContaining({
        failure: expect.objectContaining({
          kind: "malformed",
          offset: start + offset,
          field,
        }),
      }),
    );
  extent[1] = 1;
  check(1, "extended_attribute_length");
  extent[1] = 0;
  extent.writeUInt32LE(2 * ISO9660_SECTOR_BYTES, 10);
  extent.writeUInt32BE(2 * ISO9660_SECTOR_BYTES, 14);
  check(10, "data_length");
  bytes.copy(extent, 0, start, start + extent.length);
  const member = layout.primaryRecords.get("a.txt")! - start;
  extent[member] = 0;
  check(member + 2, "directory_padding");
});

it("includes the gap between an attribute unit and the first interleaved data unit", () => {
  expect(
    extentOf({
      offset: 0,
      extentLocation: 21,
      extendedAttributeLength: 1,
      dataLength: 57,
      fileUnitSize: 1,
      interleaveGapSize: 2,
    }).dataOffset,
  ).toBe(24 * ISO9660_SECTOR_BYTES);
});

it("requires . and .. to reference the directory and its parent", () => {
  const { bytes, layout } = buildIso9660Image({
    files: [{ path: "sub/a.txt", bytes: Buffer.from("a") }],
  });
  const rootBlock = layout.directoryBlocks.get("")!;
  const subBlock = layout.directoryBlocks.get("sub")!;
  const listing = (
    block: number,
    parent: number,
    damage?: [number, number],
  ) => {
    const start = block * ISO9660_SECTOR_BYTES;
    const extent = Buffer.from(
      bytes.subarray(start, start + ISO9660_SECTOR_BYTES),
    );
    if (damage !== undefined) {
      const [record, location] = damage;
      extent.writeUInt32LE(location, record + 2);
      extent.writeUInt32BE(location, record + 6);
    }
    return () =>
      recordsOf(
        parseIso9660DirectoryExtent(extent, start, () => {}, ONE_VOLUME, {
          self: directoryLink(block),
          parent: directoryLink(parent),
        }),
      );
  };
  expect(listing(rootBlock, rootBlock)()).toHaveLength(3);
  expect(listing(subBlock, rootBlock)()).toHaveLength(3);
  for (const [block, parent, record, location] of [
    // The root's . points past the image; its .. must also be the root.
    [rootBlock, rootBlock, 0, 0x7fff_ffff],
    [rootBlock, rootBlock, 34, subBlock],
    // A subdirectory's .. names itself instead of its parent.
    [subBlock, rootBlock, 34, subBlock],
    [subBlock, rootBlock, 0, rootBlock],
  ] as const)
    expect(listing(block, parent, [record, location])).toThrow(
      expect.objectContaining({
        failure: expect.objectContaining({
          kind: "malformed",
          offset: block * ISO9660_SECTOR_BYTES + record + 2,
          field: "extent_location",
        }),
      }),
    );
});

it("rejects a reserved . or .. identifier after the opening pair", () => {
  for (const identifier of ["\u0000", "\u0001"]) {
    const { bytes, layout } = buildIso9660Image({
      files: [
        { path: "a.txt", bytes: Buffer.from("a") },
        {
          path: "b.txt",
          bytes: Buffer.from("b"),
          primaryIdentifier: identifier,
        },
      ],
    });
    const root = layout.directoryBlocks.get("")! * ISO9660_SECTOR_BYTES;
    const records = () =>
      Array.from(
        groupIso9660Members(
          parseIso9660DirectoryExtent(
            bytes.subarray(root, root + ISO9660_SECTOR_BYTES),
            root,
            () => {},
            ONE_VOLUME,
            rootLinks(layout),
          ),
          false,
        ),
      );
    expect(records).toThrow(
      expect.objectContaining({
        failure: expect.objectContaining({
          kind: "malformed",
          offset: layout.primaryRecords.get("b.txt")! + 33,
          field: "file_identifier",
        }),
      }),
    );
  }
});

it("strips a version suffix only when digits follow the semicolon", () => {
  const { bytes, layout } = buildIso9660Image({
    files: [
      { path: "NOTES", bytes: Buffer.from("n") },
      { path: "NOTES2", bytes: Buffer.from("m"), primaryIdentifier: "NOTES;" },
    ],
  });
  const root = layout.directoryBlocks.get("")! * ISO9660_SECTOR_BYTES;
  const members = Array.from(
    groupIso9660Members(
      parseIso9660DirectoryExtent(
        bytes.subarray(root, root + ISO9660_SECTOR_BYTES),
        root,
        () => {},
        ONE_VOLUME,
        rootLinks(layout),
      ),
      false,
    ),
  ).filter((member) => member !== undefined);
  expect(members.map(({ identifier, name }) => ({ identifier, name }))).toEqual(
    [
      { identifier: "NOTES;1", name: "NOTES" },
      { identifier: "NOTES;", name: "NOTES;" },
    ],
  );
});

it("renames unsafe identifiers deterministically and keeps names unique", () => {
  const used = new Set<string>();
  expect(
    ["a", "..", "a", "x/y", "", "nul\0", "a-2", "é"].map((name, index) =>
      iso9660PathSegment(name, index, used),
    ),
  ).toEqual([
    { segment: "a", renamed: false },
    { segment: "entry-1", renamed: true },
    { segment: "a-2", renamed: false },
    { segment: "entry-3", renamed: true },
    { segment: "entry-4", renamed: true },
    { segment: "entry-5", renamed: true },
    { segment: "a-2-6", renamed: false },
    { segment: "é", renamed: false },
  ]);
});

it("requires the padding byte an even-length identifier needs to fit its record", () => {
  // A 37-byte record holds a 4-byte identifier but not its padding byte.
  const record = Buffer.alloc(37);
  record[0] = 37;
  record.writeUInt16LE(1, 28);
  record.writeUInt16BE(1, 30);
  record[32] = 4;
  record.write("AB;1", 33, "latin1");
  expect(() => iso9660DirectoryRecordAt(record, 0, 4096, 37)).toThrow(
    expect.objectContaining({
      failure: expect.objectContaining({
        kind: "malformed",
        offset: 4096 + 32,
        field: "identifier_length",
      }),
    }),
  );
  // An odd-length identifier has no padding byte.
  record[0] = 36;
  record[32] = 3;
  expect(
    iso9660DirectoryRecordAt(record, 0, 4096, 37).identifier.equals(
      Buffer.from("AB;"),
    ),
  ).toBe(true);
});
