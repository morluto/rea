import { expect, it } from "vitest";
import { parseCodeViewData, peCodeViewDataRanges } from "./binaryTarget.js";

const entry = (type: number, size: number, rva: number, raw: number) => {
  const bytes = Buffer.alloc(28);
  bytes.writeUInt32LE(type, 12);
  bytes.writeUInt32LE(size, 16);
  bytes.writeUInt32LE(rva, 20);
  bytes.writeUInt32LE(raw, 24);
  return bytes;
};

const section = () => {
  const bytes = Buffer.alloc(40);
  bytes.writeUInt32LE(0x2000, 12);
  bytes.writeUInt32LE(4096, 16);
  bytes.writeUInt32LE(0x400, 20);
  return bytes;
};

it("prefers physical pointers and maps only missing pointers through section or header RVAs", () => {
  const directory = Buffer.concat([
    entry(2, 32, 0x2000, 0x900),
    entry(2, 32, 0x2020, 0),
    entry(2, 32, 0x100, 0),
    entry(2, 32, 0x8000, 0),
  ]);
  expect([...peCodeViewDataRanges(directory, section(), 1, 0x400)]).toEqual([
    { fileOffset: 0x900, declaredSize: 32 },
    { fileOffset: 0x420, declaredSize: 32 },
    { fileOffset: 0x100, declaredSize: 32 },
  ]);
});

it("ignores other debug types, undersized records and incomplete trailing entries", () => {
  const directory = Buffer.concat([
    entry(1, 32, 0, 0x500),
    entry(2, 15, 0, 0x600),
    entry(2, 16, 0, 0x700),
    entry(2, 32, 0, 0x800).subarray(0, 27),
  ]);
  expect([...peCodeViewDataRanges(directory, Buffer.alloc(0), 0, 0)]).toEqual([
    { fileOffset: 0x700, declaredSize: 16 },
  ]);
});

const codeViewRecord = (magic: "RSDS" | "NB10", path: Buffer): Buffer => {
  const header = magic === "RSDS" ? 24 : 16;
  const bytes = Buffer.alloc(header + path.length + 1);
  bytes.write(magic, 0, "ascii");
  bytes.writeUInt32LE(1, magic === "RSDS" ? 20 : 12);
  path.copy(bytes, header);
  return bytes;
};

it.each(["RSDS", "NB10"] as const)(
  "preserves a non-UTF-8 %s PDB path byte",
  (magic) => {
    const bytes = codeViewRecord(
      magic,
      Buffer.from([0x43, 0x3a, 0x5c, 0xe9, 0x2e, 0x70, 0x64, 0x62]),
    );
    expect(parseCodeViewData(bytes, bytes.length)).toMatchObject({
      pdbPath: "C:\\\u00e9.pdb",
      pdbFileName: "\u00e9.pdb",
    });
  },
);

it("keeps a UTF-8 CodeView PDB path", () => {
  const bytes = codeViewRecord(
    "RSDS",
    Buffer.from("C:\\caf\u00e9.pdb", "utf8"),
  );
  expect(parseCodeViewData(bytes, bytes.length)).toMatchObject({
    pdbPath: "C:\\café.pdb",
    pdbFileName: "café.pdb",
  });
});

it("maps the bounded payload prefix while retaining its full declared size", () => {
  const directory = Buffer.concat([
    entry(2, 8192, 0x2000, 0),
    entry(2, 8192, 0x2001, 0),
  ]);
  expect([...peCodeViewDataRanges(directory, section(), 1, 0x400)]).toEqual([
    { fileOffset: 0x400, declaredSize: 8192 },
  ]);
});
