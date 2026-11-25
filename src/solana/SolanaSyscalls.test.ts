import { expect, it } from "vitest";
import { disassembleSbpf, type SbpfInstruction } from "./SbpfDisassembler.js";
import type { SolanaElfImage, SolanaElfSymbol } from "./SolanaElf.js";
import {
  murmur3_32,
  resolveSolanaCallSites,
  solanaNameHash,
} from "./SolanaSyscalls.js";

/** Encode one sBPF word: opcode, register pair, i16 offset, i32 immediate. */
const word = (
  opcode: number,
  dst: number,
  src: number,
  offset: number,
  imm: number,
): Uint8Array => {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  bytes[0] = opcode;
  bytes[1] = dst | (src << 4);
  view.setInt16(2, offset, true);
  view.setInt32(4, imm, true);
  return bytes;
};

const join = (...words: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(words.length * 8);
  words.forEach((part, index) => out.set(part, index * 8));
  return out;
};

const symbol = (
  name: string,
  sectionIndex: number,
  value = 0,
): SolanaElfSymbol => ({ name, info: 0x10, sectionIndex, value, size: 0 });

const imageWith = (
  dynamicSymbols: readonly SolanaElfSymbol[],
  relocations: SolanaElfImage["relocations"] = [],
): SolanaElfImage => ({
  bytes: new Uint8Array(0),
  byteOrder: "little",
  elfType: 3,
  machine: 263,
  entrypoint: 0,
  elfFlags: 0,
  programHeaders: [],
  sections: [],
  dynamicSymbols,
  relocations,
  trailingBytes: 0,
});

const callsOf = (bytes: Uint8Array): readonly SbpfInstruction[] =>
  disassembleSbpf(bytes, 0x1000, 0);

/**
 * Hash vectors cross-checked two ways: the values are what the Solana
 * loader substitutes for these names, and they reproduce from the dynamic
 * symbols the captured pump_amm ELF carries (its R_BPF_64_32 relocations
 * name exactly these imports for its placeholder call sites).
 */
it("computes Murmur3-32 (x86, seed 0) for known syscall names", () => {
  expect(murmur3_32(new Uint8Array(0))).toBe(0);
  expect(solanaNameHash("sol_log_")).toBe(0x207559bd);
  expect(solanaNameHash("abort")).toBe(0xb6fc1a11);
  expect(solanaNameHash("sol_memcpy_")).toBe(0x717cc4a3);
  expect(solanaNameHash("sol_sha256")).toBe(0x11f49d86);
});

it("resolves a call whose immediate is the hash of an ELF dynamic symbol", () => {
  const instructions = callsOf(
    join(word(0x85, 0, 0, 0, solanaNameHash("sol_log_"))),
  );
  const resolutions = resolveSolanaCallSites(
    instructions,
    imageWith([symbol("", 0), symbol("sol_log_", 0)]),
  );
  expect(resolutions).toHaveLength(1);
  expect(resolutions[0]).toMatchObject({
    resolvedName: "sol_log_",
    basis: "dynamic-symbol",
    note: null,
  });
});

it("resolves a registry syscall the ELF does not import, by hash alone", () => {
  const instructions = callsOf(
    join(word(0x85, 0, 0, 0, solanaNameHash("sol_keccak256"))),
  );
  const resolutions = resolveSolanaCallSites(instructions, imageWith([]));
  expect(resolutions[0]).toMatchObject({
    resolvedName: "sol_keccak256",
    basis: "known-syscall-table",
  });
});

it("resolves a placeholder call site through its R_BPF_64_32 relocation", () => {
  // Captured sBPF ELFs carry imm -1 at syscall call sites; the relocation
  // names the import. The defined-symbol twin names a local function.
  const instructions = callsOf(
    join(word(0x85, 0, 0, 0, -1), word(0x85, 0, 0, 0, -1)),
  );
  const image = imageWith(
    [symbol("", 0), symbol("sol_log_", 0), symbol("custom_panic", 1, 0x1008)],
    [
      { offset: 0x1000, symbolIndex: 1, type: 10 },
      { offset: 0x1008, symbolIndex: 2, type: 10 },
    ],
  );
  const resolutions = resolveSolanaCallSites(instructions, image);
  expect(resolutions[0]).toMatchObject({
    resolvedName: "sol_log_",
    basis: "dynamic-symbol",
  });
  expect(resolutions[1]).toMatchObject({
    resolvedName: "custom_panic",
    basis: "symbol-table",
  });
});

it("resolves a pc-relative call landing exactly on a defined symbol", () => {
  // call at 0x1000 with imm 2 targets 0x1000 + 8 * (1 + 2) = 0x1018.
  const instructions = callsOf(join(word(0x85, 0, 0, 0, 2)));
  const resolutions = resolveSolanaCallSites(
    instructions,
    imageWith([symbol("helper", 1, 0x1018)]),
  );
  expect(resolutions[0]).toMatchObject({
    resolvedName: "helper",
    basis: "symbol-table",
  });
});

it("never guesses: unknown immediates and register calls stay unresolved", () => {
  const instructions = callsOf(
    join(
      word(0x85, 0, 0, 0, 424242),
      // callx: register-indirect, no immediate to resolve.
      word(0x8d, 0, 3, 0, 0),
      word(0x85, 0, 0, 0, -1),
    ),
  );
  const resolutions = resolveSolanaCallSites(
    instructions,
    imageWith([symbol("sol_log_", 0)]),
  );
  expect(resolutions).toHaveLength(2);
  expect(resolutions[0]).toMatchObject({
    resolvedName: null,
    basis: "unresolved",
  });
  expect(resolutions[1]).toMatchObject({
    resolvedName: null,
    basis: "unresolved",
  });
});
