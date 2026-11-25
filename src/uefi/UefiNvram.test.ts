import { Buffer } from "node:buffer";
import { expect, it } from "vitest";
import { UEFI_FIRMWARE_LIMITS } from "../domain/uefi/uefiLimits.js";
import { scanAmiNvramStores } from "./UefiNvram.js";

const NVAR_MAGIC = Buffer.from("NVAR", "ascii");

const encodeEntry = (name: string, data: Buffer, guidIndex: number): Buffer => {
  const nameBytes = Buffer.from(name, "ascii");
  const total = 11 + nameBytes.length + 1 + data.length;
  const entry = Buffer.alloc(total, 0);
  NVAR_MAGIC.copy(entry, 0);
  entry.writeUInt16LE(total, 4);
  entry.writeUIntLE(0xffffff, 6, 3);
  entry.writeUInt8(0x83, 9);
  entry.writeUInt8(guidIndex, 10);
  nameBytes.copy(entry, 11);
  data.copy(entry, 11 + nameBytes.length + 1);
  return entry;
};

const inactiveEntry = () => {
  const entry = encodeEntry("Inactive", Buffer.from([2]), 0);
  entry.writeUInt8(0x03, 9);
  return entry;
};

it("maps nested and top-level siblings across inactive entries and erased padding", () => {
  const setup = encodeEntry("Setup", Buffer.from([0xde, 0xad]), 3);
  const inactive = inactiveEntry();
  const lang = encodeEntry("PlatformLang", Buffer.from("en-US\0", "ascii"), 1);
  const outer = encodeEntry(
    "StdDefaults",
    Buffer.concat([setup, inactive, lang]),
    0,
  );
  const sibling = encodeEntry("Sibling", Buffer.from([0x20, 0x21]), 1);
  const nextStore = encodeEntry("OtherStore", Buffer.from([3]), 0);
  const erasedBytes = 2 * 65_536 + 3;
  const siblingOffset = outer.length + inactive.length;
  const nextOffset = siblingOffset + sibling.length + erasedBytes;
  const image = Buffer.concat([
    outer,
    inactive,
    sibling,
    Buffer.alloc(erasedBytes, 0xff),
    nextStore,
    Buffer.alloc(8, 0xff),
  ]);
  const report = scanAmiNvramStores(image, 2, 2);
  expect(report.coverage).toBe("complete");
  expect(report.stores).toMatchObject([
    {
      name: "StdDefaults",
      offset: 0,
      trailingPadding: erasedBytes,
      variables: [
        {
          name: "StdDefaults",
          offset: 0,
          depth: 0,
          parentOffset: null,
          dataOffset: 23,
        },
        {
          name: "Setup",
          offset: 23,
          attributes: 0x83,
          guidIndex: 3,
          depth: 1,
          parentOffset: 0,
          dataOffset: 40,
          dataLength: 2,
        },
        {
          name: "PlatformLang",
          offset: 23 + setup.length + inactive.length,
          depth: 1,
          parentOffset: 0,
        },
        {
          name: "Sibling",
          offset: siblingOffset,
          depth: 0,
          parentOffset: null,
          dataLength: 2,
        },
      ],
    },
    {
      name: "OtherStore",
      offset: nextOffset,
      trailingPadding: 8,
      variables: [
        {
          name: "OtherStore",
          offset: nextOffset,
          depth: 0,
          parentOffset: null,
        },
      ],
    },
  ]);
  const limited = scanAmiNvramStores(image, 1, 2);
  expect(limited).toEqual({
    stores: report.stores.slice(0, 1),
    coverage: "partial",
    limitations: ["Stopped after 1 AMI NVRAM stores; additional stores exist."],
  });
});

it("rejects NVAR byte runs that do not match the record framing", () => {
  const image = Buffer.concat([NVAR_MAGIC, Buffer.alloc(20, 0x00)]);
  const scan = scanAmiNvramStores(image, 16, 2);
  expect(scan.stores).toHaveLength(0);
  expect(scan.limitations.join(" ")).toContain("No AMI NVRAM");
});

it("reports partial coverage when a nested chain exceeds max_depth", () => {
  const leaf = encodeEntry("Leaf", Buffer.alloc(0), 0);
  const mid = encodeEntry("Mid", leaf, 0);
  const top = encodeEntry("Top", mid, 0);
  const scan = scanAmiNvramStores(top, 16, 1);
  expect(scan.coverage).toBe("partial");
  expect(scan.limitations.join(" ")).toContain("max_depth 1");
  const found = scan.stores[0];
  if (found === undefined) throw new Error("expected exactly one store");
  expect(found.variables.map((v) => [v.name, v.depth])).toEqual([
    ["Top", 0],
    ["Mid", 1],
  ]);
});

it("returns partial NVAR coverage when a single store exhausts the record limit", () => {
  const { scanRecords } = UEFI_FIRMWARE_LIMITS;
  const record = encodeEntry("A", Buffer.alloc(0), 0);
  const image = Buffer.alloc((scanRecords + 1) * record.length, record);
  const result = scanAmiNvramStores(image, 1, 1);
  expect(result.coverage).toBe("partial");
  expect(result.limitations[0]).toContain("Structural record limit");
  expect(result.stores[0]?.variables.length).toBe(scanRecords);
});

it("separates an inline GUID and UCS-2 name from data and the extended footer", () => {
  const name = Buffer.from("Δ\0", "utf16le");
  const entry = Buffer.concat([
    Buffer.from([0x4e, 0x56, 0x41, 0x52, 0, 0, 0xff, 0xff, 0xff, 0x94]),
    Buffer.from("78563412bc9af0de1122334455667788", "hex"),
    name,
    Buffer.from([0x42, 0, 3, 0]),
  ]);
  entry.writeUInt16LE(entry.length, 4);
  const parsed = scanAmiNvramStores(entry, 1, 1).stores[0]?.variables[0];
  expect(parsed).toMatchObject({
    name: "Δ",
    guid: "12345678-9abc-def0-1122-334455667788",
    guidIndex: null,
    dataOffset: 30,
    dataLength: 1,
  });
});

it("reports a truncated successor under an established nested NVAR chain", () => {
  const first = encodeEntry("First", Buffer.from([1]), 0);
  const later = encodeEntry("Later", Buffer.from([2]), 0);
  const chain = Buffer.concat([first, later.subarray(0, 7)]);
  const result = scanAmiNvramStores(encodeEntry("Outer", chain, 0), 16, 2);
  expect(result.stores[0]?.variables.map(({ name }) => name)).toEqual([
    "Outer",
    "First",
  ]);
  expect(result.coverage).toBe("partial");
  expect(result.limitations.join(" ")).toContain("invalid extent");
});

it("finds the first active child after an inactive prefix without leaving its container", () => {
  const inactive = inactiveEntry();
  const active = encodeEntry("Later", Buffer.from([1]), 0);
  const outer = encodeEntry(
    "StdDefaults",
    Buffer.concat([inactive, active]),
    0,
  );
  const sibling = encodeEntry("Sibling", Buffer.from([2]), 0);
  const data = Buffer.concat([outer, sibling]);

  const scan = scanAmiNvramStores(data, 16, 1);
  expect(scan.coverage).toBe("complete");
  expect(scan.stores).toHaveLength(1);
  expect(
    scan.stores[0]?.variables.map(({ name, depth, parentOffset }) => [
      name,
      depth,
      parentOffset,
    ]),
  ).toEqual([
    ["StdDefaults", 0, null],
    ["Later", 1, 0],
    ["Sibling", 0, null],
  ]);
  const limited = scanAmiNvramStores(data, 16, 0);
  expect(limited.coverage).toBe("partial");
  expect(limited.limitations.join(" ")).toContain("max_depth 0");
});

it.each([1, 2, 3])(
  "reports a %i-byte signature prefix at an established record boundary",
  (length) => {
    const first = encodeEntry("First", Buffer.alloc(0), 0);
    const image = Buffer.concat([first, NVAR_MAGIC.subarray(0, length)]);
    const scan = scanAmiNvramStores(image, 16, 2);
    expect(scan.stores[0]?.variables.map(({ name }) => name)).toEqual([
      "First",
    ]);
    expect(scan.coverage).toBe("partial");
    expect(scan.limitations.join(" ")).toContain(
      "incomplete or invalid extent",
    );
  },
);

it("marks a complete nested signature with a truncated first record as uncertain", () => {
  const child = encodeEntry("Child", Buffer.alloc(0), 0);
  const image = encodeEntry("Outer", child.subarray(0, 7), 0);
  const scan = scanAmiNvramStores(image, 16, 2);
  expect(scan.stores[0]?.variables.map(({ name }) => name)).toEqual(["Outer"]);
  expect(scan.coverage).toBe("partial");
  expect(scan.limitations.join(" ")).toContain("Possible nested NVAR record");
});

it("charges malformed discovery candidates against the structural record limit", () => {
  const first = encodeEntry("First", Buffer.alloc(0), 0);
  const malformed = Buffer.concat([NVAR_MAGIC, Buffer.alloc(6)]);
  const malformedCandidates = Buffer.alloc(
    UEFI_FIRMWARE_LIMITS.scanRecords * malformed.length,
    malformed,
  );
  const image = Buffer.concat([
    first,
    Buffer.from([0xff]),
    malformedCandidates,
    encodeEntry("Later", Buffer.alloc(0), 0),
  ]);
  const scan = scanAmiNvramStores(image, 16, 2);
  expect(scan.coverage).toBe("partial");
  expect(scan.limitations.at(-1)).toContain("Structural record limit");
  expect(scan.stores.map(({ name }) => name)).toEqual(["First"]);
});

it("does not spend a second discovery slot on an already examined invalid successor", () => {
  const record = encodeEntry("First", Buffer.alloc(0), 0);
  const firstStore = Buffer.alloc(
    (UEFI_FIRMWARE_LIMITS.scanRecords - 2) * record.length,
    record,
  );
  const invalidSuccessor = Buffer.concat([NVAR_MAGIC, Buffer.alloc(6)]);
  const firstEnd = firstStore.length;
  const laterOffset = firstEnd + invalidSuccessor.length;
  const later = encodeEntry("Later", Buffer.alloc(0), 0);
  const padding = Buffer.alloc(32, 0xff);
  const tailOffset = laterOffset + later.length + padding.length;
  const result = scanAmiNvramStores(
    Buffer.concat([firstStore, invalidSuccessor, later, padding, NVAR_MAGIC]),
    2,
    1,
  );

  expect(result.stores.map(({ offset, name }) => [offset, name])).toEqual([
    [0, "First"],
    [laterOffset, "Later"],
  ]);
  expect(result.stores[1]?.trailingPadding).toBe(padding.length);
  expect(result.coverage).toBe("partial");
  expect(result.limitations).toEqual([
    `NVAR record at 0x${firstEnd.toString(16)} has an incomplete or invalid extent.`,
    `Structural record limit ${UEFI_FIRMWARE_LIMITS.scanRecords} reached at NVAR candidate 0x${tailOffset.toString(16)}.`,
  ]);
});
