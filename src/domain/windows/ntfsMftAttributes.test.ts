import { expect, it } from "vitest";
import { readMftAttributes } from "./ntfsMftAttributes.js";

const resident = (type: number, value: Buffer, name = ""): Buffer => {
  const nameBytes = Buffer.from(name, "utf16le");
  const valueOffset = Math.ceil((24 + nameBytes.length) / 8) * 8;
  const attribute = Buffer.alloc(
    Math.ceil((valueOffset + value.length) / 8) * 8,
  );
  attribute.writeUInt32LE(type);
  attribute.writeUInt32LE(attribute.length, 4);
  attribute.writeUInt8(name.length, 9);
  attribute.writeUInt16LE(24, 10);
  nameBytes.copy(attribute, 24);
  attribute.writeUInt32LE(value.length, 16);
  attribute.writeUInt16LE(valueOffset, 20);
  value.copy(attribute, valueOffset);
  return attribute;
};
const scan = (...attributes: Buffer[]) => {
  const marker = Buffer.alloc(8);
  marker.writeUInt32LE(0xffffffff);
  const bytes = Buffer.concat([...attributes, marker]);
  return readMftAttributes(bytes, 0, bytes.length, 4096);
};
const nonresident = (): Buffer => {
  const attribute = Buffer.alloc(88);
  attribute.writeUInt32LE(0x80);
  attribute.writeUInt32LE(attribute.length, 4);
  attribute.writeUInt8(1, 8);
  attribute.writeUInt16LE(0x8000, 12);
  attribute.writeBigUInt64LE(5n, 24);
  attribute.writeUInt16LE(72, 32);
  attribute.writeBigUInt64LE(9007199254740993n, 48);
  attribute.writeBigUInt64LE(1n, 56);
  attribute.writeBigUInt64LE(12288n, 64);
  // VCN 0..1 -> LCN 10..11, VCN 2..4 sparse, VCN 5 -> LCN 8.
  attribute.set([0x11, 2, 10, 0x01, 3, 0x11, 1, 0xfe, 0], 72);
  return attribute;
};

it.each([48, 72])(
  "retains %i-byte standard information independently of FILE_NAME values",
  (length) => {
    const value = Buffer.alloc(length);
    value.writeBigUInt64LE(133000000000000001n);
    value.writeBigUInt64LE(133000000000000002n, 8);
    value.writeUInt32LE(0x4000, 32);
    if (length === 72) {
      value.writeUInt32LE(42, 52);
      value.writeBigInt64LE(-1n, 64);
    }
    const result = scan(
      resident(0x10, value),
      resident(0x80, Buffer.from("data"), " stream"),
    );
    expect(result).toMatchObject({
      attributeCoverage: "complete",
      attributeIssue: null,
      attributes: [
        {
          type: 0x10,
          fileOffset: 4096,
          storage: {
            kind: "resident",
            standardInformation: {
              createdFileTime: "133000000000000001",
              modifiedFileTime: "133000000000000002",
              fileAttributes: 0x4000,
              securityId: length === 72 ? 42 : null,
              usn: length === 72 ? "-1" : null,
            },
          },
        },
        {
          type: 0x80,
          name: " stream",
          storage: { kind: "resident", valueBytes: 4 },
        },
      ],
    });
  },
);

it("retains fragmented and sparse mapping pairs and lossless nonresident sizes without reading a volume", () => {
  const attribute = nonresident();
  const original = Buffer.from(attribute);
  expect(scan(attribute)).toMatchObject({
    attributeCoverage: "complete",
    attributeIssue: null,
    attributes: [
      {
        storage: {
          kind: "nonresident",
          lowestVcn: "0",
          highestVcn: "5",
          runCount: 3,
          sparseRunCount: 1,
          physicalBytes: "12288",
          dataBytes: "9007199254740993",
          mappingPairsFileOffset: 4168,
          mappingPairsHex: "11020a01031101fe00",
        },
      },
    ],
  });
  expect(attribute.equals(original)).toBe(true);
});

it.each([
  ["zero-length run", (b: Buffer) => b.writeUInt8(0, 73)],
  ["negative LCN", (b: Buffer) => b.writeUInt8(0xff, 74)],
  ["short VCN coverage", (b: Buffer) => b.writeBigUInt64LE(6n, 24)],
  ["oversized run field", (b: Buffer) => b.writeUInt8(0x19, 72)],
  ["overlapping run offset", (b: Buffer) => b.writeUInt16LE(64, 32)],
  ["missing run terminator", (b: Buffer) => b.fill(0x11, 80)],
  [
    "initialized size beyond data",
    (b: Buffer) => b.writeBigUInt64LE(0xffffffffffffffffn, 56),
  ],
])("isolates %s after a completed prefix", (_name, mutate) => {
  const malformed = nonresident();
  mutate(malformed);
  const result = scan(resident(0x80, Buffer.from("ok")), malformed);
  expect(result.attributes).toHaveLength(1);
  expect(result.attributeCoverage).toBe("incomplete");
  expect(result.attributeIssue).toMatchObject({
    kind: "malformed",
    fileOffset: 4128,
  });
});

it("preserves self-referential attribute-list entries without traversing a cycle", () => {
  const list = Buffer.alloc(32);
  list.writeUInt32LE(0x20);
  list.writeUInt16LE(32, 4);
  list.writeBigUInt64LE(0x0002_0000_0000_0004n, 16);
  const result = scan(resident(0x20, list));
  expect(result).toMatchObject({
    attributeCoverage: "complete",
    fileNameCoverage: "incomplete",
    attributes: [
      {
        storage: {
          kind: "resident",
          listEntries: [
            {
              fileOffset: 4120,
              type: 0x20,
              reference: { recordNumber: 4, sequenceNumber: 2 },
              attributeId: 0,
            },
          ],
        },
      },
    ],
  });
});

it.each([
  ["resident value outside extent", (b: Buffer) => b.writeUInt32LE(1000, 16)],
  [
    "name overlaps header",
    (b: Buffer) => {
      b.writeUInt8(1, 9);
      b.writeUInt16LE(2, 10);
    },
  ],
  [
    "value overlaps name",
    (b: Buffer) => {
      b.writeUInt8(1, 9);
      b.writeUInt16LE(24, 10);
    },
  ],
])("refuses %s at the attribute owner", (_name, mutate) => {
  const attribute = resident(0x80, Buffer.from("test"));
  mutate(attribute);
  const result = scan(attribute);
  expect(result).toMatchObject({
    attributes: [],
    attributeCoverage: "incomplete",
    attributeIssue: { kind: "malformed" },
  });
});

it("retains completed list entries and later bounded attributes after a corrupt list suffix", () => {
  const list = Buffer.alloc(64);
  list.writeUInt32LE(0x30);
  list.writeUInt16LE(32, 4);
  list.writeUInt16LE(9, 24);
  const result = scan(
    resident(0x20, list),
    resident(0x80, Buffer.from("tail")),
  );
  expect(result).toMatchObject({
    attributeCoverage: "incomplete",
    attributeIssue: { kind: "malformed", fileOffset: 4152 },
    attributes: [
      {
        storage: {
          kind: "resident",
          listEntries: [{ type: 0x30, attributeId: 9 }],
          listIssue: { fileOffset: 4152 },
        },
      },
      { type: 0x80, storage: { kind: "resident", valueBytes: 4 } },
    ],
  });
});

it.each([0x10, 0x30])(
  "refuses a nonresident form of resident-only attribute %i",
  (type) => {
    const attribute = nonresident();
    attribute.writeUInt32LE(type);
    expect(scan(attribute)).toMatchObject({
      attributes: [],
      attributeCoverage: "incomplete",
      attributeIssue: {
        message: "Standard information and FILE_NAME must be resident",
      },
    });
  },
);
