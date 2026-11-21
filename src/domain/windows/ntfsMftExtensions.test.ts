import { expect, it } from "vitest";
import { parseMftIndex, selectMftMetadata } from "./ntfsMft.js";
import {
  linkedMftFixture,
  mftFileNameAttribute,
  mftFileRecord,
  mftListEntry,
  residentMftAttribute,
} from "../../../tests/fixtures/ntfsMftExtension.js";

const inspect = (bytes: Buffer, limit = 1) => {
  const parsed = parseMftIndex(bytes, 0, limit);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
};

it("links exact acquired extension attributes without replacing physical facts or changing bytes", () => {
  const bytes = linkedMftFixture(),
    original = Buffer.from(bytes);
  const result = inspect(bytes);
  const base = result.metadata.record_headers[0]!;
  expect(base.fileNames.map(({ name }) => name)).toEqual(["local"]);
  expect(base.fileNameCoverage).toBe("incomplete");
  expect(base.attributeListResolution).toMatchObject({
    coverage: "complete",
    knownEntryCount: 1,
    omittedKnownEntries: 0,
    unreadListAttributeOffsets: [],
    incompleteRecordIndices: [],
    references: [
      {
        listEntryFileOffset: 184,
        result: { kind: "resolved", attributeFileOffset: 1080 },
      },
    ],
    linkedAttributes: [{ fileOffset: 1080, type: 0x30, id: 3 }],
    linkedFileNames: [
      {
        fileOffset: 1104,
        name: "linked",
        parent: { recordNumber: 9, sequenceNumber: 4 },
        createdFileTime: "133000000000000001",
        dataBytes: "9007199254740993",
      },
    ],
  });
  expect(result.metadata.file_name_count).toBe(2);
  expect(result.records[0]).not.toHaveProperty("attributeListResolution");
  expect(bytes.equals(original)).toBe(true);
});

it.each([
  [
    "missing record",
    (bytes: Buffer) => bytes.writeUInt32LE(2, 200),
    "record-unavailable",
  ],
  [
    "reused sequence",
    (bytes: Buffer) => bytes.writeUInt16LE(8, 1040),
    "sequence-mismatch",
  ],
  [
    "wrong base",
    (bytes: Buffer) => bytes.writeBigUInt64LE(3n << 48n, 1056),
    "base-reference-mismatch",
  ],
  [
    "contradictory slot",
    (bytes: Buffer) => bytes.writeUInt32LE(99, 1068),
    "unverified-record",
  ],
  [
    "failed fixup",
    (bytes: Buffer) => bytes.writeUInt16LE(0, 1534),
    "unverified-record",
  ],
  [
    "unverified base",
    (bytes: Buffer) => bytes.writeUInt16LE(0, 16),
    "unverified-base",
  ],
] as const)("keeps %s references unresolved", (_label, mutate, reason) => {
  const bytes = linkedMftFixture();
  mutate(bytes);
  expect(
    inspect(bytes).metadata.record_headers[0]?.attributeListResolution,
  ).toMatchObject({
    coverage: "incomplete",
    references: [{ result: { kind: "unresolved", reason } }],
    linkedFileNames: [],
    linkedAttributes: [],
  });
});

it.each([
  [0x80, 3, "", 0n],
  [0x30, 9, "", 0n],
  [0x30, 3, "stream", 0n],
  [0x30, 3, "", 1n],
] as const)(
  "requires the exact attribute tuple (%i, %i, %s, %s)",
  (type, id, name, vcn) => {
    const bytes = Buffer.concat([
      mftFileRecord(0, 2, [
        residentMftAttribute(0x20, 2, mftListEntry(type, id, 1, 7, name, vcn)),
      ]),
      mftFileRecord(1, 7, [mftFileNameAttribute(3, "linked")], {
        baseReference: 2n << 48n,
      }),
    ]);
    expect(
      inspect(bytes).metadata.record_headers[0]?.attributeListResolution,
    ).toMatchObject({
      coverage: "incomplete",
      references: [
        { result: { kind: "unresolved", reason: "attribute-unavailable" } },
      ],
    });
  },
);

it("preserves ambiguity rather than choosing one duplicate attribute identity", () => {
  const bytes = Buffer.concat([
    linkedMftFixture().subarray(0, 1024),
    mftFileRecord(
      1,
      7,
      [mftFileNameAttribute(3, "first"), mftFileNameAttribute(3, "second")],
      { baseReference: 2n << 48n },
    ),
  ]);
  expect(
    inspect(bytes).metadata.record_headers[0]?.attributeListResolution,
  ).toMatchObject({
    coverage: "incomplete",
    references: [{ result: { kind: "ambiguous", candidateCount: 2 } }],
    linkedFileNames: [],
  });
});

it("walks resident list graphs once, including self references and cycles", () => {
  const bytes = Buffer.concat([
    mftFileRecord(0, 2, [
      residentMftAttribute(
        0x20,
        2,
        Buffer.concat([
          mftListEntry(0x20, 2, 0, 2),
          mftListEntry(0x20, 4, 1, 7),
        ]),
      ),
    ]),
    mftFileRecord(
      1,
      7,
      [
        residentMftAttribute(
          0x20,
          4,
          Buffer.concat([
            mftListEntry(0x20, 2, 0, 2),
            mftListEntry(0x30, 3, 2, 8),
          ]),
        ),
      ],
      { baseReference: 2n << 48n },
    ),
    mftFileRecord(2, 8, [mftFileNameAttribute(3, "nested")], {
      baseReference: 2n << 48n,
    }),
  ]);
  const result =
    inspect(bytes).metadata.record_headers[0]?.attributeListResolution;
  expect(result).toMatchObject({
    coverage: "complete",
    knownEntryCount: 4,
    omittedKnownEntries: 0,
    linkedFileNames: [{ name: "nested" }],
  });
  expect(result?.references).toHaveLength(4);
  expect(result?.linkedAttributes).toHaveLength(2);
});

it("retains valid associations before a malformed attribute-list suffix", () => {
  const bytes = Buffer.concat([
    mftFileRecord(0, 2, [
      residentMftAttribute(
        0x20,
        2,
        Buffer.concat([mftListEntry(0x30, 3, 1, 7), Buffer.alloc(8)]),
      ),
    ]),
    linkedMftFixture().subarray(1024),
  ]);
  expect(
    inspect(bytes).metadata.record_headers[0]?.attributeListResolution,
  ).toMatchObject({
    coverage: "incomplete",
    incompleteRecordIndices: [0],
    linkedFileNames: [{ name: "linked" }],
  });
});

it("retains a verified attribute prefix when another extension attribute is malformed", () => {
  const broken = Buffer.alloc(24);
  broken.writeUInt32LE(0x80);
  broken.writeUInt32LE(9999, 4);
  const bytes = Buffer.concat([
    linkedMftFixture().subarray(0, 1024),
    mftFileRecord(1, 7, [mftFileNameAttribute(3, "linked"), broken], {
      baseReference: 2n << 48n,
    }),
  ]);
  expect(
    inspect(bytes).metadata.record_headers[0]?.attributeListResolution,
  ).toMatchObject({
    coverage: "incomplete",
    incompleteRecordIndices: [1],
    references: [{ result: { kind: "resolved" } }],
    linkedFileNames: [{ name: "linked" }],
  });
});

const nonresident = (type: number, name: string, lowest = 0n): Buffer => {
  const attribute = Buffer.alloc(88);
  attribute.writeUInt32LE(type);
  attribute.writeUInt32LE(88, 4);
  attribute.writeUInt8(1, 8);
  attribute.writeUInt8(name.length, 9);
  attribute.writeUInt16LE(64, 10);
  attribute.writeUInt16LE(8, 14);
  attribute.writeBigUInt64LE(lowest, 16);
  attribute.writeBigUInt64LE(lowest + 2n, 24);
  attribute.writeUInt16LE(80, 32);
  attribute.set(Buffer.from(name, "utf16le"), 64);
  attribute.set([0x11, 3, 10, 0], 80);
  return attribute;
};

it("keeps unavailable nonresident list contents explicitly unknown", () => {
  const bytes = mftFileRecord(0, 2, [nonresident(0x20, "")]);
  expect(
    inspect(bytes).metadata.record_headers[0]?.attributeListResolution,
  ).toEqual({
    coverage: "incomplete",
    knownEntryCount: 0,
    omittedKnownEntries: 0,
    unreadListAttributeOffsets: [56],
    incompleteRecordIndices: [],
    references: [],
    linkedAttributes: [],
    linkedFileNames: [],
  });
});

it("links named continuation mapping metadata at the exact lowest VCN", () => {
  const bytes = Buffer.concat([
    mftFileRecord(0, 2, [
      residentMftAttribute(0x20, 2, mftListEntry(0x80, 8, 1, 7, "stream", 5n)),
    ]),
    mftFileRecord(1, 7, [nonresident(0x80, "stream", 5n)], {
      baseReference: 2n << 48n,
    }),
  ]);
  expect(
    inspect(bytes).metadata.record_headers[0]?.attributeListResolution,
  ).toMatchObject({
    coverage: "complete",
    linkedAttributes: [
      {
        name: "stream",
        storage: {
          kind: "nonresident",
          lowestVcn: "5",
          highestVcn: "7",
          mappingPairsHex: "11030a00",
        },
      },
    ],
  });
});

it("bounds reference results and reports every known omission", () => {
  const entries = Array.from({ length: 40 }, (_, index) =>
    mftListEntry(0x30, 3, index + 1, 7),
  );
  const bytes = Buffer.concat([
    mftFileRecord(
      0,
      2,
      [residentMftAttribute(0x20, 2, Buffer.concat(entries))],
      { recordBytes: 4096 },
    ),
    ...entries.map((_, index) =>
      mftFileRecord(index + 1, 7, [mftFileNameAttribute(3, "linked")], {
        recordBytes: 4096,
        baseReference: 2n << 48n,
      }),
    ),
  ]);
  const result =
    inspect(bytes).metadata.record_headers[0]?.attributeListResolution;
  expect(result).toMatchObject({
    coverage: "incomplete",
    knownEntryCount: 40,
    omittedKnownEntries: 8,
  });
  expect(result?.references).toHaveLength(32);
  expect(result?.linkedFileNames).toHaveLength(32);
});

it("shares the additional-record budget across a page and replenishes it for another selection", () => {
  const options = { recordBytes: 4096 };
  const bytes = Buffer.concat([
    mftFileRecord(
      0,
      2,
      [
        residentMftAttribute(
          0x20,
          2,
          Buffer.concat(
            Array.from({ length: 32 }, (_, index) =>
              mftListEntry(0x30, 3, index + 2, 7),
            ),
          ),
        ),
      ],
      options,
    ),
    mftFileRecord(
      1,
      3,
      [residentMftAttribute(0x20, 2, mftListEntry(0x30, 3, 34, 7))],
      options,
    ),
    ...Array.from({ length: 33 }, (_, index) =>
      mftFileRecord(index + 2, 7, [mftFileNameAttribute(3, "linked")], {
        ...options,
        baseReference: index === 32 ? (3n << 48n) | 1n : 2n << 48n,
      }),
    ),
  ]);
  const indexed = inspect(bytes, 2);
  expect(
    indexed.metadata.record_headers[1]?.attributeListResolution,
  ).toMatchObject({
    coverage: "incomplete",
    references: [{ result: { kind: "unresolved", reason: "capacity" } }],
  });
  expect(
    selectMftMetadata(bytes, indexed, 1, 1).record_headers[0]
      ?.attributeListResolution,
  ).toMatchObject({
    coverage: "complete",
    linkedFileNames: [{ name: "linked" }],
  });
});
