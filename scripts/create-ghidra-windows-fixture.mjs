import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "build", "fixtures", "rea-ghidra-windows.exe");
const bytes = Buffer.alloc(1024);
const peOffset = 0x80;
const optionalHeader = peOffset + 24;
const sectionTable = optionalHeader + 0xf0;

bytes.write("MZ", 0, "ascii");
bytes.writeUInt32LE(peOffset, 0x3c);
bytes.write("PE\0\0", peOffset, "binary");
bytes.writeUInt16LE(0x8664, peOffset + 4);
bytes.writeUInt16LE(1, peOffset + 6);
bytes.writeUInt16LE(0xf0, peOffset + 20);
bytes.writeUInt16LE(0x22, peOffset + 22);

bytes.writeUInt16LE(0x20b, optionalHeader);
bytes.writeUInt32LE(0x200, optionalHeader + 4);
bytes.writeUInt32LE(0x1000, optionalHeader + 16);
bytes.writeUInt32LE(0x1000, optionalHeader + 20);
bytes.writeBigUInt64LE(0x1_4000_0000n, optionalHeader + 24);
bytes.writeUInt32LE(0x1000, optionalHeader + 32);
bytes.writeUInt32LE(0x200, optionalHeader + 36);
bytes.writeUInt16LE(6, optionalHeader + 40);
bytes.writeUInt16LE(6, optionalHeader + 48);
bytes.writeUInt32LE(0x2000, optionalHeader + 56);
bytes.writeUInt32LE(0x200, optionalHeader + 60);
bytes.writeUInt16LE(3, optionalHeader + 68);
bytes.writeUInt16LE(0x8160, optionalHeader + 70);
bytes.writeBigUInt64LE(0x10_0000n, optionalHeader + 72);
bytes.writeBigUInt64LE(0x1000n, optionalHeader + 80);
bytes.writeBigUInt64LE(0x10_0000n, optionalHeader + 88);
bytes.writeBigUInt64LE(0x1000n, optionalHeader + 96);
bytes.writeUInt32LE(16, optionalHeader + 108);

bytes.write(".text", sectionTable, "ascii");
bytes.writeUInt32LE(0x16, sectionTable + 8);
bytes.writeUInt32LE(0x1000, sectionTable + 12);
bytes.writeUInt32LE(0x200, sectionTable + 16);
bytes.writeUInt32LE(0x200, sectionTable + 20);
bytes.writeUInt32LE(0x6000_0020, sectionTable + 36);

// entry calls the second function, returns zero; second returns 42.
bytes.set([0xe8, 0x0b, 0, 0, 0, 0x31, 0xc0, 0xc3], 0x200);
bytes.set([0xb8, 0x2a, 0, 0, 0, 0xc3], 0x210);

await mkdir(dirname(output), { recursive: true });
await writeFile(output, bytes);
process.stdout.write(`${output}\n`);
