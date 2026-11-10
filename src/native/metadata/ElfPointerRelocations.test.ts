import { expect, it } from "vitest";
import {
  elfAbsoluteRelocationType,
  readElfRelocationWritesSteps,
  type ElfPointerWrite,
} from "./ElfPointerRelocations.js";

const EM_X86_64 = 62;

const image = (): Buffer => {
  const bytes = Buffer.alloc(0x400);
  const dynamic: [bigint, bigint][] = [
    [7n, 0x100n],
    [8n, 72n],
    [9n, 24n],
    [17n, 0x200n],
    [18n, 16n],
    [19n, 16n],
    [0n, 0n],
  ];
  dynamic.forEach(([tag, value], index) => {
    bytes.writeBigUInt64LE(tag, index * 16);
    bytes.writeBigUInt64LE(value, index * 16 + 8);
  });
  const rela: [bigint, bigint, bigint][] = [
    [0x300n, (0n << 32n) | 8n, 0x1234n],
    [0x308n, (2n << 32n) | 1n, 0x10n],
    [0x310n, (3n << 32n) | 6n, -8n],
  ];
  rela.forEach(([offset, info, addend], index) => {
    const at = 0x100 + index * 24;
    bytes.writeBigUInt64LE(offset, at);
    bytes.writeBigUInt64LE(info, at + 8);
    bytes.writeBigInt64LE(addend, at + 16);
  });
  bytes.writeBigUInt64LE(0x318n, 0x200);
  bytes.writeBigUInt64LE((5n << 32n) | 1n, 0x208);
  bytes.writeBigUInt64LE(0x40n, 0x318);
  return bytes;
};

const drain = (bytes: Buffer): ElfPointerWrite[] => {
  const writes: ElfPointerWrite[] = [];
  const steps = readElfRelocationWritesSteps(bytes, {
    bits: 64,
    little: true,
    machine: EM_X86_64,
    dynamicSegments: [{ offset: 0n, size: 112n }],
    mappings: [{ address: 0n, offset: 0, size: bytes.length }],
    zeroFills: [],
  });
  for (let next = steps.next(); !next.done; next = steps.next())
    if (next.value !== undefined) writes.push(next.value);
  return writes;
};

it("returns the decoded record type, symbol index and addend with each write", () => {
  const writes = drain(image());
  expect(
    writes.map((write) => ({
      address: write.address,
      value: write.value,
      encoding: write.source.encoding,
      kind: write.source.kind,
      record_file_offset: write.source.record_file_offset,
      symbol_index: write.symbol_index,
      addend: write.addend,
    })),
  ).toEqual([
    {
      address: 0x300n,
      value: 0x1234n,
      encoding: "rela",
      kind: 8,
      record_file_offset: 0x100,
      symbol_index: 0,
      addend: 0x1234n,
    },
    {
      address: 0x308n,
      value: null,
      encoding: "rela",
      kind: 1,
      record_file_offset: 0x118,
      symbol_index: 2,
      addend: 0x10n,
    },
    {
      address: 0x310n,
      value: null,
      encoding: "rela",
      kind: 6,
      record_file_offset: 0x130,
      symbol_index: 3,
      addend: -8n,
    },
    {
      address: 0x318n,
      value: null,
      encoding: "rel",
      kind: 1,
      record_file_offset: 0x200,
      symbol_index: 5,
      addend: null,
    },
  ]);
});

it("owns the word-sized absolute relocation type per machine", () => {
  expect(elfAbsoluteRelocationType(62)).toBe(1);
  expect(elfAbsoluteRelocationType(3)).toBe(1);
  expect(elfAbsoluteRelocationType(183)).toBe(257);
  expect(elfAbsoluteRelocationType(40)).toBe(2);
  expect(elfAbsoluteRelocationType(8)).toBeUndefined();
});
