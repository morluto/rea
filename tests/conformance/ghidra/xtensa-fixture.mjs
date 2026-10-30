import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);

/**
 * Source-owned windowed-ABI code, so the base lane needs no Xtensa compiler.
 * GNU as and objdump from Espressif's esp-14.2.0_20251107 toolchain produced
 * and decoded these bytes once:
 *
 *   0x40080000 78563412  rea_xtensa_literal: .word 0x12345678
 *   0x40080004 364100    rea_xtensa_entry:   entry   a1, 32
 *   0x40080007 a1feff                        l32r    a10, 0x40080000
 *   0x4008000a a50000                        call8   0x40080014
 *   0x4008000d 2d0a                          mov.n   a2, a10
 *   0x4008000f 1df0                          retw.n
 *   0x40080011 000000                        (alignment)
 *   0x40080014 364100    rea_xtensa_leaf:    entry   a1, 32
 *   0x40080017 22c207                        addi    a2, a2, 7
 *   0x4008001a 1df0                          retw.n
 */
export const XTENSA_FIXTURE_TEXT = Buffer.from(
  "78563412364100a1feffa500002d0a1df000000036410022c2071df0",
  "hex",
);
const BASE = 0x40080000;
export const XTENSA_FIXTURE_SYMBOLS = {
  rea_xtensa_literal: { address: BASE, size: 4, type: "OBJECT" },
  rea_xtensa_entry: { address: BASE + 4, size: 13, type: "FUNC" },
  rea_xtensa_leaf: { address: BASE + 0x14, size: 8, type: "FUNC" },
};
/** Instruction addresses the lane inspects, from the annotation above. */
export const XTENSA_FIXTURE_INSTRUCTIONS = {
  entry: BASE + 4,
  l32r: BASE + 7,
  call8: BASE + 0xa,
  retw: BASE + 0xf,
};
/** The literal `l32r` loads and the leaf's addend. */
export const XTENSA_FIXTURE_LITERAL = 0x12345678;
export const XTENSA_FIXTURE_ADDEND = 7;
/** What `../c/xtensa.c` passes through call8 and the constant it loads. */
export const XTENSA_C_FIXTURE_VALUES = {
  global: "rea_xtensa_c_global",
  factor: 5,
  constant: 0x1234567,
};

const TEXT_OFFSET = 0x1000;
const INFO_DESCRIPTOR = "USE_ABSOLUTE_LITERALS=0\nABI=0\n";

/** The `.xtensa.info` note GNU ld writes for a windowed link (56 bytes). */
const xtensaInfo = () => {
  const name = Buffer.from("Xtensa_Info\0", "latin1");
  const descriptor = Buffer.alloc(32);
  descriptor.write(INFO_DESCRIPTOR, "latin1");
  const header = Buffer.alloc(12);
  header.writeUInt32LE(name.length, 0);
  header.writeUInt32LE(descriptor.length, 4);
  header.writeUInt32LE(1, 8);
  return Buffer.concat([header, name, descriptor]);
};

const align = (value, alignment) => Math.ceil(value / alignment) * alignment;

const strings = (names) => {
  const offsets = {};
  const parts = [Buffer.alloc(1)];
  let length = 1;
  for (const name of names) {
    offsets[name] = length;
    const bytes = Buffer.from(`${name}\0`, "latin1");
    parts.push(bytes);
    length += bytes.length;
  }
  return { bytes: Buffer.concat(parts), offsets };
};

/** Lay out ELF32 little-endian ET_EXEC bytes with one PT_LOAD and a symbol table. */
export function xtensaFixtureBytes() {
  const info = xtensaInfo();
  const symbolNames = Object.keys(XTENSA_FIXTURE_SYMBOLS);
  const strtab = strings(symbolNames);
  const shstrtab = strings([
    ".text",
    ".xtensa.info",
    ".symtab",
    ".strtab",
    ".shstrtab",
  ]);
  const symtab = Buffer.alloc(16 * (symbolNames.length + 1));
  symbolNames.forEach((name, index) => {
    const { address, size, type } = XTENSA_FIXTURE_SYMBOLS[name];
    const at = 16 * (index + 1);
    symtab.writeUInt32LE(strtab.offsets[name], at);
    symtab.writeUInt32LE(address, at + 4);
    symtab.writeUInt32LE(size, at + 8);
    symtab[at + 12] = (1 << 4) | (type === "FUNC" ? 2 : 1); // STB_GLOBAL
    symtab.writeUInt16LE(1, at + 14); // .text
  });
  const infoOffset = TEXT_OFFSET + XTENSA_FIXTURE_TEXT.length;
  const symtabOffset = align(infoOffset + info.length, 4);
  const strtabOffset = symtabOffset + symtab.length;
  const shstrtabOffset = strtabOffset + strtab.bytes.length;
  const sectionOffset = align(shstrtabOffset + shstrtab.bytes.length, 4);
  const sections = [
    null,
    [".text", 1, 6, BASE, TEXT_OFFSET, XTENSA_FIXTURE_TEXT.length, 0, 0, 4, 0],
    [".xtensa.info", 7, 0, 0, infoOffset, info.length, 0, 0, 1, 0],
    [".symtab", 2, 0, 0, symtabOffset, symtab.length, 4, 1, 4, 16],
    [".strtab", 3, 0, 0, strtabOffset, strtab.bytes.length, 0, 0, 1, 0],
    [".shstrtab", 3, 0, 0, shstrtabOffset, shstrtab.bytes.length, 0, 0, 1, 0],
  ];
  const bytes = Buffer.alloc(sectionOffset + 40 * sections.length);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]); // ELF32, little-endian
  bytes.writeUInt16LE(2, 16); // ET_EXEC
  bytes.writeUInt16LE(94, 18); // EM_XTENSA
  bytes.writeUInt32LE(1, 20);
  bytes.writeUInt32LE(XTENSA_FIXTURE_SYMBOLS.rea_xtensa_entry.address, 24);
  bytes.writeUInt32LE(52, 28);
  bytes.writeUInt32LE(sectionOffset, 32);
  bytes.writeUInt32LE(0x300, 36); // EF_XTENSA_XT_INSN | EF_XTENSA_XT_LIT
  bytes.writeUInt16LE(52, 40);
  bytes.writeUInt16LE(32, 42);
  bytes.writeUInt16LE(1, 44);
  bytes.writeUInt16LE(40, 46);
  bytes.writeUInt16LE(sections.length, 48);
  bytes.writeUInt16LE(sections.length - 1, 50);
  // PT_LOAD for .text, readable and executable.
  for (const [index, value] of [
    1,
    TEXT_OFFSET,
    BASE,
    BASE,
    XTENSA_FIXTURE_TEXT.length,
    XTENSA_FIXTURE_TEXT.length,
    5,
    0x1000,
  ].entries())
    bytes.writeUInt32LE(value, 52 + 4 * index);
  XTENSA_FIXTURE_TEXT.copy(bytes, TEXT_OFFSET);
  info.copy(bytes, infoOffset);
  symtab.copy(bytes, symtabOffset);
  strtab.bytes.copy(bytes, strtabOffset);
  shstrtab.bytes.copy(bytes, shstrtabOffset);
  sections.forEach((section, index) => {
    if (section === null) return;
    const [name, ...words] = section;
    const at = sectionOffset + 40 * index;
    bytes.writeUInt32LE(shstrtab.offsets[name], at);
    words.forEach((word, field) =>
      bytes.writeUInt32LE(word, at + 4 * (field + 1)),
    );
  });
  return bytes;
}

/** File offset of the `ABI=` digit inside `.xtensa.info`. */
const abiDigitOffset = () =>
  TEXT_OFFSET +
  XTENSA_FIXTURE_TEXT.length +
  24 +
  INFO_DESCRIPTOR.indexOf("ABI=") +
  "ABI=".length;

/** Header-mutated copies test admission; they are not new producer claims. */
export function mutateXtensaFixture(bytes, change) {
  const copy = Buffer.from(bytes);
  if (change.flags !== undefined) copy.writeUInt32LE(change.flags, 36);
  if (change.type !== undefined) copy.writeUInt16LE(change.type, 16);
  if (change.abi !== undefined)
    copy.write(change.abi, abiDigitOffset(), "latin1");
  return copy;
}

/** Write the source-owned fixture; its target code is never executed. */
export async function writeXtensaFixture(directory) {
  const bytes = xtensaFixtureBytes();
  const path = join(directory, "xtensa-windowed.elf");
  await writeFile(path, bytes);
  return {
    path,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/**
 * Optional route: build the C fixture with a caller-supplied Espressif
 * compiler, for example xtensa-esp32-elf-gcc. The lane never acquires one.
 */
export async function buildXtensaCFixture(directory, compiler) {
  const source = fileURLToPath(new URL("../c/xtensa.c", import.meta.url));
  const path = join(directory, "xtensa-c.elf");
  const args = [
    "-O1",
    "-g",
    "-nostdlib",
    "-static",
    "-Wl,-e,rea_xtensa_c_entry",
    "-Wl,--build-id=none",
    source,
    "-o",
    path,
  ];
  const options = { timeout: 60000, maxBuffer: 1024 * 1024 };
  const version = await execute(compiler, ["--version"], options);
  await execute(compiler, args, options);
  const bytes = await readFile(path);
  return {
    path,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    toolchain: {
      compiler: { command: compiler, version: version.stdout.split("\n")[0] },
      arguments: args,
    },
    source_sha256: createHash("sha256")
      .update(await readFile(source))
      .digest("hex"),
  };
}
