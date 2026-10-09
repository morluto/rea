import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const fixtureName = (x86, library) =>
  `rea-ghidra-windows${x86 ? "-x86" : ""}.${library ? "dll" : "exe"}`;

// Applications: entry calls the second function and returns zero; the second
// returns 42. Libraries have no entry routine and export a callee returning 42
// and a caller adding one to its result.
const APPLICATION_CODE = [
  [0x200, [0xe8, 0x0b, 0, 0, 0, 0x31, 0xc0, 0xc3]],
  [0x210, [0xb8, 0x2a, 0, 0, 0, 0xc3]],
];
const LIBRARY_CODE = [
  [0x200, [0xe8, 0x0b, 0, 0, 0, 0x83, 0xc0, 0x01, 0xc3]],
  [0x210, [0xb8, 0x2a, 0, 0, 0, 0xc3]],
];

/** Write an export directory naming the library's caller and callee. */
const writeExports = (bytes, fileOffset, rva, imageName) => {
  // Export names must be sorted for the loader's binary search.
  const exports = [
    ["fixture_caller", 0x1000],
    ["fixture_return42", 0x1010],
  ];
  const functions = rva + 40;
  const names = functions + exports.length * 4;
  const ordinals = names + exports.length * 4;
  let string = ordinals + exports.length * 2;
  const putString = (value) => {
    const at = string;
    bytes.write(`${value}\0`, fileOffset + at - rva, "ascii");
    string += value.length + 1;
    return at;
  };
  bytes.writeUInt32LE(putString(imageName), fileOffset + 12);
  bytes.writeUInt32LE(1, fileOffset + 16);
  bytes.writeUInt32LE(exports.length, fileOffset + 20);
  bytes.writeUInt32LE(exports.length, fileOffset + 24);
  bytes.writeUInt32LE(functions, fileOffset + 28);
  bytes.writeUInt32LE(names, fileOffset + 32);
  bytes.writeUInt32LE(ordinals, fileOffset + 36);
  exports.forEach(([name, address], index) => {
    bytes.writeUInt32LE(address, fileOffset + functions - rva + index * 4);
    bytes.writeUInt32LE(putString(name), fileOffset + names - rva + index * 4);
    bytes.writeUInt16LE(index, fileOffset + ordinals - rva + index * 2);
  });
  return string - rva;
};

for (const [architecture, library] of [
  ["x86_64", false],
  ["x86", false],
  ["x86_64", true],
  ["x86", true],
]) {
  const x86 = architecture === "x86";
  const name = fixtureName(x86, library);
  const output = resolve(root, "build", "fixtures", name);
  const bytes = Buffer.alloc(library ? 1536 : 1024);
  const peOffset = 0x80;
  const optionalHeader = peOffset + 24;
  const optionalHeaderSize = x86 ? 0xe0 : 0xf0;
  const sectionTable = optionalHeader + optionalHeaderSize;
  const dataDirectories = optionalHeader + (x86 ? 96 : 112);

  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(peOffset, 0x3c);
  bytes.write("PE\0\0", peOffset, "binary");
  bytes.writeUInt16LE(x86 ? 0x14c : 0x8664, peOffset + 4);
  bytes.writeUInt16LE(library ? 2 : 1, peOffset + 6);
  bytes.writeUInt16LE(optionalHeaderSize, peOffset + 20);
  bytes.writeUInt16LE(
    (x86 ? 0x102 : 0x22) | (library ? 0x2000 : 0),
    peOffset + 22,
  );

  bytes.writeUInt16LE(x86 ? 0x10b : 0x20b, optionalHeader);
  bytes.writeUInt32LE(0x200, optionalHeader + 4);
  bytes.writeUInt32LE(library ? 0 : 0x1000, optionalHeader + 16);
  bytes.writeUInt32LE(0x1000, optionalHeader + 20);
  if (x86)
    bytes.writeUInt32LE(library ? 0x1000_0000 : 0x400000, optionalHeader + 28);
  else
    bytes.writeBigUInt64LE(
      library ? 0x1_8000_0000n : 0x1_4000_0000n,
      optionalHeader + 24,
    );
  bytes.writeUInt32LE(0x1000, optionalHeader + 32);
  bytes.writeUInt32LE(0x200, optionalHeader + 36);
  bytes.writeUInt16LE(6, optionalHeader + 40);
  bytes.writeUInt16LE(6, optionalHeader + 48);
  bytes.writeUInt32LE(library ? 0x3000 : 0x2000, optionalHeader + 56);
  bytes.writeUInt32LE(0x200, optionalHeader + 60);
  bytes.writeUInt16LE(3, optionalHeader + 68);
  bytes.writeUInt16LE(x86 ? 0x8140 : 0x8160, optionalHeader + 70);
  if (x86) {
    bytes.writeUInt32LE(0x10_0000, optionalHeader + 72);
    bytes.writeUInt32LE(0x1000, optionalHeader + 76);
    bytes.writeUInt32LE(0x10_0000, optionalHeader + 80);
    bytes.writeUInt32LE(0x1000, optionalHeader + 84);
    bytes.writeUInt32LE(16, optionalHeader + 92);
  } else {
    bytes.writeBigUInt64LE(0x10_0000n, optionalHeader + 72);
    bytes.writeBigUInt64LE(0x1000n, optionalHeader + 80);
    bytes.writeBigUInt64LE(0x10_0000n, optionalHeader + 88);
    bytes.writeBigUInt64LE(0x1000n, optionalHeader + 96);
    bytes.writeUInt32LE(16, optionalHeader + 108);
  }

  bytes.write(".text", sectionTable, "ascii");
  bytes.writeUInt32LE(0x16, sectionTable + 8);
  bytes.writeUInt32LE(0x1000, sectionTable + 12);
  bytes.writeUInt32LE(0x200, sectionTable + 16);
  bytes.writeUInt32LE(0x200, sectionTable + 20);
  bytes.writeUInt32LE(0x6000_0020, sectionTable + 36);

  for (const [offset, code] of library ? LIBRARY_CODE : APPLICATION_CODE)
    bytes.set(code, offset);

  if (library) {
    const exportsSize = writeExports(bytes, 0x400, 0x2000, name);
    bytes.writeUInt32LE(0x2000, dataDirectories);
    bytes.writeUInt32LE(exportsSize, dataDirectories + 4);
    const rdata = sectionTable + 40;
    bytes.write(".rdata", rdata, "ascii");
    bytes.writeUInt32LE(exportsSize, rdata + 8);
    bytes.writeUInt32LE(0x2000, rdata + 12);
    bytes.writeUInt32LE(0x200, rdata + 16);
    bytes.writeUInt32LE(0x400, rdata + 20);
    bytes.writeUInt32LE(0x4000_0040, rdata + 36);
  }

  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, bytes);
  if (!x86 && !library) process.stdout.write(`${output}\n`);
}
