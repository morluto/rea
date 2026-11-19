import { Buffer } from "node:buffer";
import { expect, it } from "vitest";
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

it("parses one AMI NVRAM entry with name, attributes, GUID index and data range", () => {
  const entry = encodeEntry("Setup", Buffer.from([0xde, 0xad]), 3);
  const parsed = scanAmiNvramStores(entry, 1, 1).stores[0]?.variables[0];
  expect(parsed).not.toBeNull();
  expect(parsed?.name).toBe("Setup");
  expect(parsed?.attributes).toBe(0x83);
  expect(parsed?.guidIndex).toBe(3);
  expect(parsed?.dataOffset).toBe(11 + 5 + 1);
  expect(parsed?.dataLength).toBe(2);
  expect(parsed?.endOffset).toBe(entry.length);
});

it("recurses into a StdDefaults container and exposes its nested variables", () => {
  const nested = Buffer.concat([
    encodeEntry("Setup", Buffer.from([0x01, 0x01, 0x00, 0x00]), 0),
    encodeEntry("PlatformLang", Buffer.from("en-US\0", "ascii"), 1),
    Buffer.alloc(4, 0xff),
  ]);
  const store = encodeEntry("StdDefaults", nested, 0);
  const scan = scanAmiNvramStores(store, 16, 2);
  expect(scan.coverage).toBe("complete");
  expect(scan.stores).toHaveLength(1);
  const found = scan.stores[0];
  if (found === undefined) throw new Error("expected exactly one store");
  expect(found.name).toBe("StdDefaults");
  expect(found.variables.map((v) => [v.name, v.depth])).toEqual([
    ["StdDefaults", 0],
    ["Setup", 1],
    ["PlatformLang", 1],
  ]);
  expect(found.variables[0]?.parentOffset).toBeNull();
  expect(found.variables[1]?.parentOffset).toBe(0);
});

it("walks a flat sibling chain without treating it as a container", () => {
  const flat = Buffer.concat([
    encodeEntry("First", Buffer.from([0x10]), 0),
    encodeEntry("Second", Buffer.from([0x20, 0x21]), 1),
    Buffer.alloc(8, 0xff),
  ]);
  const scan = scanAmiNvramStores(flat, 16, 2);
  expect(scan.stores).toHaveLength(1);
  const found = scan.stores[0];
  if (found === undefined) throw new Error("expected exactly one store");
  expect(found.name).toBe("First");
  expect(found.variables.map((v) => [v.name, v.depth])).toEqual([
    ["First", 0],
    ["Second", 0],
  ]);
  expect(found.trailingPadding).toBe(8);
});

it("rejects NVAR byte runs that do not match the record framing", () => {
  const image = Buffer.concat([NVAR_MAGIC, Buffer.alloc(20, 0x00)]);
  const scan = scanAmiNvramStores(image, 16, 2);
  expect(scan.stores).toHaveLength(0);
  expect(scan.limitations.join(" ")).toContain("No AMI NVRAM");
});

it("keeps a container's child walk inside the container boundary", () => {
  const child = encodeEntry("Child", Buffer.alloc(0), 0);
  const outer = encodeEntry("Outer", child, 0);
  const sibling = encodeEntry("Sibling", Buffer.alloc(0), 0);
  const scan = scanAmiNvramStores(Buffer.concat([outer, sibling]), 16, 2);
  expect(scan.stores).toHaveLength(1);
  const found = scan.stores[0];
  if (found === undefined) throw new Error("expected exactly one store");
  // Child belongs to Outer; Sibling is a top-level peer, not a second child.
  expect(found.variables.map((v) => [v.name, v.depth])).toEqual([
    ["Outer", 0],
    ["Child", 1],
    ["Sibling", 0],
  ]);
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
  const record = encodeEntry("A", Buffer.alloc(0), 0);
  const image = Buffer.alloc(100_001 * record.length);
  for (let offset = 0; offset < image.length; offset += record.length)
    record.copy(image, offset);
  const result = scanAmiNvramStores(image, 1, 1);
  expect(result.coverage).toBe("partial");
  expect(result.limitations[0]).toContain("Structural record limit");
  expect(result.stores[0]?.variables.length).toBe(100_000);
});

it("preserves a named record's link to a data-only entry without inventing a GUID index", () => {
  const named = encodeEntry("Setup", Buffer.from([0x42]), 3);
  named.writeUIntLE(named.length, 6, 3);
  const dataOnly = Buffer.from([
    0x4e, 0x56, 0x41, 0x52, 12, 0, 0xff, 0xff, 0xff, 0x88, 0xaa, 0xbb,
  ]);
  const result = scanAmiNvramStores(Buffer.concat([named, dataOnly]), 16, 2);
  expect(result.coverage).toBe("complete");
  expect(result.stores[0]?.variables).toMatchObject([
    { name: "Setup", next: named.length, attributes: 0x83, guidIndex: 3 },
    {
      name: null,
      next: 0xffffff,
      attributes: 0x88,
      guidIndex: null,
      dataLength: 2,
    },
  ]);
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

it.each([false, true])(
  "preserves active NVAR siblings across inactive records (nested: %s)",
  (nested) => {
    const first = encodeEntry("First", Buffer.from([1]), 0);
    const inactive = encodeEntry("Inactive", Buffer.from([2]), 0);
    inactive.writeUInt8(0x03, 9);
    const later = encodeEntry("Later", Buffer.from([3]), 0);
    const chain = Buffer.concat([first, inactive, later]);
    const result = scanAmiNvramStores(
      nested ? encodeEntry("Outer", chain, 0) : chain,
      16,
      2,
    );
    expect(result.coverage).toBe("complete");
    expect(result.stores).toHaveLength(1);
    expect(result.stores[0]?.variables.map(({ name }) => name)).toEqual(
      nested ? ["Outer", "First", "Later"] : ["First", "Later"],
    );
  },
);

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
