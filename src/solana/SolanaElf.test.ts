import { expect, it } from "vitest";
import {
  parseSolanaElf,
  solanaSbpfVersion,
  solanaTextSection,
  SolanaElfFailure,
} from "./SolanaElf.js";

/**
 * Build a minimal ELF64 sBPF image in memory: header, .text holding one
 * exit word, .rodata holding a syscall string, one undefined and one defined
 * dynamic symbol, a two-entry .rel.dyn, then trailing padding beyond the
 * declared extents.
 */
const buildElf = (padding: number): Uint8Array => {
  const text = new Uint8Array(8);
  text[0] = 0x95;
  const rodata = new TextEncoder().encode("sol_log_\0");
  const dynstr = new TextEncoder().encode("\0sol_log_\0helper\0");
  const shstrtab = new TextEncoder().encode(
    "\0.text\0.rodata\0.dynsym\0.dynstr\0.rel.dyn\0.shstrtab\0",
  );
  const nameOffsets = {
    text: 1,
    rodata: 7,
    dynsym: 15,
    dynstr: 23,
    reldyn: 31,
    shstrtab: 40,
  };
  const headerSize = 64;
  const textOffset = headerSize;
  const rodataOffset = textOffset + text.length;
  const dynsymOffset = rodataOffset + rodata.length;
  const dynsymSize = 72;
  const dynstrOffset = dynsymOffset + dynsymSize;
  const reldynOffset = dynstrOffset + dynstr.length;
  const reldynSize = 32;
  const shstrtabOffset = reldynOffset + reldynSize;
  const sectionHeaderOffset = shstrtabOffset + shstrtab.length;
  const sectionCount = 7;
  const total = sectionHeaderOffset + sectionCount * 64 + padding;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  view.setUint16(16, 3, true);
  view.setUint16(18, 263, true);
  view.setBigUint64(24, 0x120n, true);
  view.setBigUint64(40, BigInt(sectionHeaderOffset), true);
  view.setUint16(54, 56, true);
  view.setUint16(58, 64, true);
  view.setUint16(60, sectionCount, true);
  view.setUint16(62, 6, true);
  bytes.set(text, textOffset);
  bytes.set(rodata, rodataOffset);
  // Two dynamic symbols: null, undefined sol_log_, defined helper.
  const symbol = (index: number, name: number, shndx: number): void => {
    const offset = dynsymOffset + index * 24;
    view.setUint32(offset, name, true);
    bytes[offset + 4] = 0x10;
    view.setUint16(offset + 6, shndx, true);
  };
  view.setUint32(dynsymOffset, 0, true);
  symbol(1, 1, 0);
  symbol(2, 10, 1);
  bytes.set(dynstr, dynstrOffset);
  // Two relocations in sBPF 16-byte entry form: a call relocation naming
  // symbol 1 at the .text address, and a 64-bit relocation naming symbol 2.
  const relocation = (
    index: number,
    offset: number,
    symbolIndex: number,
    type: number,
  ): void => {
    const base = reldynOffset + index * 16;
    view.setBigUint64(base, BigInt(offset), true);
    view.setBigUint64(
      base + 8,
      (BigInt(symbolIndex) << 32n) | BigInt(type),
      true,
    );
  };
  relocation(0, 0x120, 1, 10);
  relocation(1, 0x128, 2, 8);
  bytes.set(shstrtab, shstrtabOffset);
  const section = (
    index: number,
    name: number,
    type: number,
    flags: number,
    address: number,
    offset: number,
    size: number,
    link = 0,
    entrySize = 0,
  ): void => {
    const base = sectionHeaderOffset + index * 64;
    view.setUint32(base, name, true);
    view.setUint32(base + 4, type, true);
    view.setBigUint64(base + 8, BigInt(flags), true);
    view.setBigUint64(base + 16, BigInt(address), true);
    view.setBigUint64(base + 24, BigInt(offset), true);
    view.setBigUint64(base + 32, BigInt(size), true);
    view.setUint32(base + 40, link, true);
    view.setBigUint64(base + 56, BigInt(entrySize), true);
  };
  section(1, nameOffsets.text, 1, 6, 0x120, textOffset, text.length);
  section(2, nameOffsets.rodata, 1, 2, 0x128, rodataOffset, rodata.length);
  section(3, nameOffsets.dynsym, 11, 0, 0, dynsymOffset, dynsymSize, 4, 24);
  section(4, nameOffsets.dynstr, 3, 0, 0, dynstrOffset, dynstr.length);
  section(5, nameOffsets.reldyn, 9, 0, 0, reldynOffset, reldynSize, 3, 16);
  section(6, nameOffsets.shstrtab, 3, 0, 0, shstrtabOffset, shstrtab.length);
  return bytes;
};

it("parses ELF64 sBPF headers, sections and dynamic symbols", () => {
  const image = parseSolanaElf(buildElf(0));
  expect(image.machine).toBe(263);
  expect(image.elfType).toBe(3);
  expect(image.entrypoint).toBe(0x120);
  expect(image.byteOrder).toBe("little");
  expect(image.sections.map((section) => section.name)).toEqual([
    "",
    ".text",
    ".rodata",
    ".dynsym",
    ".dynstr",
    ".rel.dyn",
    ".shstrtab",
  ]);
  expect(solanaTextSection(image)?.name).toBe(".text");
  expect(image.dynamicSymbols.map((entry) => entry.name)).toEqual([
    "",
    "sol_log_",
    "helper",
  ]);
  expect(image.dynamicSymbols[1]?.sectionIndex).toBe(0);
  expect(image.dynamicSymbols[2]?.sectionIndex).toBe(1);
  expect(image.trailingBytes).toBe(0);
});

it("parses relocation entries with symbol index and type split from r_info", () => {
  const image = parseSolanaElf(buildElf(0));
  expect(image.relocations).toEqual([
    { offset: 0x120, symbolIndex: 1, type: 10 },
    { offset: 0x128, symbolIndex: 2, type: 8 },
  ]);
});

it("reports bytes beyond the ELF-declared extents as trailing", () => {
  expect(parseSolanaElf(buildElf(4096)).trailingBytes).toBe(4096);
});

it("rejects non-ELF and 32-bit carriers instead of guessing", () => {
  expect(() => parseSolanaElf(new Uint8Array(128))).toThrow(SolanaElfFailure);
  const elf32 = buildElf(0);
  elf32[4] = 1;
  expect(() => parseSolanaElf(elf32)).toThrow(SolanaElfFailure);
  expect(() => parseSolanaElf(new Uint8Array(16))).toThrow(SolanaElfFailure);
});

it("rejects header tables that extend past the capture before reading entries", () => {
  const oversized = buildElf(0);
  new DataView(oversized.buffer).setUint16(60, 0xffff, true);
  expect(() => parseSolanaElf(oversized)).toThrow(/extends past/);

  const zeroEntrySize = buildElf(0);
  new DataView(zeroEntrySize.buffer).setUint16(58, 0, true);
  expect(() => parseSolanaElf(zeroEntrySize)).toThrow(/entry size 0/);

  const programHeaders = buildElf(0);
  const view = new DataView(programHeaders.buffer);
  view.setBigUint64(32, 64n, true);
  view.setUint16(56, 0xffff, true);
  expect(() => parseSolanaElf(programHeaders)).toThrow(/extends past/);
});

it("rejects a symbol table whose declared size runs past the capture", () => {
  const elf = buildElf(0);
  const view = new DataView(elf.buffer);
  const sectionHeaderOffset = Number(view.getBigUint64(40, true));
  for (let index = 0; index < 7; index += 1) {
    const base = sectionHeaderOffset + index * 64;
    if (view.getUint32(base + 4, true) === 11)
      view.setBigUint64(base + 32, 1n << 40n, true);
  }
  expect(() => parseSolanaElf(elf)).toThrow(SolanaElfFailure);
});

it("bounds the whole parse when symbol tables overlap", () => {
  const elf = buildElf(0);
  const view = new DataView(elf.buffer);
  const sectionHeaderOffset = Number(view.getBigUint64(40, true));
  let dynsym = -1;
  for (let index = 0; index < 7; index += 1)
    if (view.getUint32(sectionHeaderOffset + index * 64 + 4, true) === 11)
      dynsym = index;
  expect(dynsym).toBeGreaterThan(0);
  // Point every other section header at the same dynamic symbol table.
  const source = sectionHeaderOffset + dynsym * 64;
  for (let index = 1; index < 7; index += 1)
    if (index !== dynsym && index !== 6)
      elf.copyWithin(sectionHeaderOffset + index * 64, source, source + 64);
  // Grow the symbol table to span the whole file: each copy fits alone, all
  // copies together exceed what the file can hold.
  for (let index = 1; index < 6; index += 1) {
    const base = sectionHeaderOffset + index * 64;
    if (view.getUint32(base + 4, true) !== 11) continue;
    view.setBigUint64(base + 24, 0n, true);
    view.setBigUint64(base + 32, BigInt(elf.length - (elf.length % 24)), true);
  }
  expect(() => parseSolanaElf(elf)).toThrow(/tables overlap/);
});

it("decodes symbols that share one string once and keeps every symbol", () => {
  const elf = buildElf(0);
  const view = new DataView(elf.buffer);
  const sectionHeaderOffset = Number(view.getBigUint64(40, true));
  let dynsymOffset = -1;
  let dynsymSize = 0;
  for (let index = 0; index < 7; index += 1) {
    const base = sectionHeaderOffset + index * 64;
    if (view.getUint32(base + 4, true) !== 11) continue;
    dynsymOffset = Number(view.getBigUint64(base + 24, true));
    dynsymSize = Number(view.getBigUint64(base + 32, true));
  }
  expect(dynsymOffset).toBeGreaterThan(0);
  // Every symbol names the same dynstr offset: valid ELF, one decoded string.
  for (let entry = 0; entry < dynsymSize; entry += 24)
    view.setUint32(dynsymOffset + entry, 1, true);
  const image = parseSolanaElf(elf);
  const named = image.dynamicSymbols.filter((symbol) => symbol.name !== "");
  expect(named.length).toBeGreaterThan(1);
  expect(new Set(named.map((symbol) => symbol.name))).toEqual(
    new Set(["sol_log_"]),
  );
});

it("keeps unrecognized e_flags distinct from a declared version 0", () => {
  expect(solanaSbpfVersion(0)).toBe(0);
  expect(solanaSbpfVersion(0x20)).toBe(2);
  expect(solanaSbpfVersion(3)).toBe(3);
  expect(solanaSbpfVersion(0x99)).toBeNull();
});
