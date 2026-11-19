import { Buffer } from "node:buffer";
import { expect, it } from "vitest";
import { probeNvramEntry, scanAmiNvramStores } from "./UefiNvram.js";

const NVAR_MAGIC = Buffer.from("NVAR", "ascii");

const encodeEntry = (name: string, data: Buffer, state: number): Buffer => {
  const nameBytes = Buffer.from(name, "ascii");
  const total = 11 + nameBytes.length + 1 + data.length;
  const entry = Buffer.alloc(total, 0);
  NVAR_MAGIC.copy(entry, 0);
  entry.writeUInt16LE(total, 4);
  entry.writeUInt32LE(0x83ffffff, 6);
  entry.writeUInt8(state, 10);
  nameBytes.copy(entry, 11);
  data.copy(entry, 11 + nameBytes.length + 1);
  return entry;
};

it("parses one AMI NVRAM entry with name, attributes, state and data range", () => {
  const entry = encodeEntry("Setup", Buffer.from([0xde, 0xad]), 3);
  const parsed = probeNvramEntry(entry, 0);
  expect(parsed).not.toBeNull();
  expect(parsed?.name).toBe("Setup");
  expect(parsed?.attributes).toBe(0x83ffffff);
  expect(parsed?.state).toBe(3);
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

it("rejects NVAR byte runs that do not match the vendor attribute signature", () => {
  const image = Buffer.concat([NVAR_MAGIC, Buffer.alloc(20, 0x00)]);
  expect(probeNvramEntry(image, 0)).toBeNull();
  const scan = scanAmiNvramStores(image, 16, 2);
  expect(scan.stores).toHaveLength(0);
  expect(scan.limitations.join(" ")).toContain("No AMI NVRAM");
});
