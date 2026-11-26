import { BinaryReader } from "../domain/binaryContainer.js";
import type { SolanaElfImage, SolanaElfSymbol } from "./SolanaElf.js";
import { R_BPF_64_32 } from "./SolanaElf.js";
import type { SbpfInstruction } from "./SbpfDisassembler.js";

/**
 * How one immediate `call` site acquired its name. `dynamic-symbol` and
 * `symbol-table` are grounded in the analyzed ELF itself (its relocation
 * table or its defined symbols); `known-syscall-table` is a Murmur3 hash
 * match against the canonical Solana syscall registry; `unresolved` keeps
 * the raw immediate because no candidate verified.
 */
export type SolanaCallResolutionBasis =
  | "dynamic-symbol"
  | "known-syscall-table"
  | "symbol-table"
  | "unresolved";

export interface SolanaCallResolution {
  readonly address: number;
  /** The call word's immediate, as an unsigned 32-bit value. */
  readonly immediate: number;
  readonly resolvedName: string | null;
  readonly basis: SolanaCallResolutionBasis;
  readonly note: string | null;
}

const rotateLeft32 = (value: number, bits: number): number =>
  ((value << bits) | (value >>> (32 - bits))) >>> 0;

/**
 * MurmurHash3 x86_32 with seed 0 — the hash the Solana loader substitutes
 * for a syscall's name at its `call` sites. Implemented from the reference
 * algorithm with stdlib arithmetic only (`Math.imul` for 32-bit products).
 */
export const murmur3_32 = (key: Uint8Array, seed = 0): number => {
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  let hash = seed >>> 0;
  const blockCount = Math.floor(key.length / 4);
  const reader = new BinaryReader(
    Buffer.from(key.buffer, key.byteOffset, key.byteLength),
    true,
    "murmur3-key",
  );
  for (let block = 0; block < blockCount; block += 1) {
    let k = reader.u32(block * 4);
    k = Math.imul(k, c1);
    k = rotateLeft32(k, 15);
    k = Math.imul(k, c2);
    hash ^= k;
    hash = rotateLeft32(hash, 13);
    hash = (Math.imul(hash, 5) + 0xe6546b64) >>> 0;
  }
  let k = 0;
  const tailStart = blockCount * 4;
  const tailLength = key.length - tailStart;
  if (tailLength >= 3) k ^= (key[tailStart + 2] ?? 0) << 16;
  if (tailLength >= 2) k ^= (key[tailStart + 1] ?? 0) << 8;
  if (tailLength >= 1) {
    k ^= key[tailStart] ?? 0;
    k = Math.imul(k, c1);
    k = rotateLeft32(k, 15);
    k = Math.imul(k, c2);
    hash ^= k;
  }
  hash ^= key.length;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
};

/** Murmur3-32 of a syscall or symbol name, as the loader computes it. */
export const solanaNameHash = (name: string): number =>
  murmur3_32(new TextEncoder().encode(name));

/**
 * Canonical Solana syscall registry names (the `sol_*` surface plus the
 * `abort` entry every sBPF program imports). A name here is only ever a
 * hash candidate: a call site resolves to it when the immediate equals the
 * name's Murmur3 hash and no other candidate collides.
 */
export const KNOWN_SOLANA_SYSCALLS: readonly string[] = [
  "abort",
  "sol_log_",
  "sol_log_64_",
  "sol_log_compute_units_",
  "sol_log_data",
  "sol_log_pubkey",
  "sol_memcpy_",
  "sol_memmove_",
  "sol_memcmp_",
  "sol_memset_",
  "sol_invoke_signed_c",
  "sol_invoke_signed_rust",
  "sol_set_return_data",
  "sol_get_return_data",
  "sol_create_program_address",
  "sol_try_find_program_address",
  "sol_sha256",
  "sol_keccak256",
  "sol_blake3",
  "sol_curve_validate_point",
  "sol_curve_group_op",
  "sol_alt_bn128_group_op",
  "sol_big_mod_exp",
  "sol_remaining_compute_units",
  "sol_panic_",
  "sol_get_clock_sysvar",
  "sol_get_epoch_schedule_sysvar",
  "sol_get_fees_sysvar",
  "sol_get_rent_sysvar",
  "sol_get_last_restart_slot",
  "sol_get_epoch_stake",
  "sol_get_cluster_sysvar",
  "sol_get_epoch_rewards_sysvar",
  "sol_get_stake_history_sysvar",
  "sol_get_sysvar",
  "sol_get_processed_sibling_instruction",
  "sol_get_stack_height",
];

interface NameCandidates {
  /** Candidate names by Murmur3 hash. */
  readonly byHash: ReadonlyMap<number, readonly string[]>;
  /** Which candidates the analyzed ELF itself imports as dynamic symbols. */
  readonly fromElf: ReadonlySet<string>;
}

const buildCandidates = (image: SolanaElfImage): NameCandidates => {
  const byHash = new Map<number, string[]>();
  const fromElf = new Set<string>();
  // Per-name work happens once: thousands of symbols can share one long
  // name, and hashing it per symbol would multiply its cost by the
  // symbol count.
  const hashed = new Set<string>();
  const add = (name: string, elf: boolean): void => {
    if (!hashed.has(name)) {
      hashed.add(name);
      const hash = solanaNameHash(name);
      const existing = byHash.get(hash);
      if (existing === undefined) byHash.set(hash, [name]);
      else if (!existing.includes(name)) existing.push(name);
    }
    if (elf) fromElf.add(name);
  };
  for (const name of KNOWN_SOLANA_SYSCALLS) add(name, false);
  for (const symbol of image.dynamicSymbols)
    if (symbol.sectionIndex === 0 && symbol.name.length > 0)
      add(symbol.name, true);
  return { byHash, fromElf };
};

/**
 * Resolve every immediate `call` site in one disassembly. Ground truth from
 * the binary wins over hash inference: an R_BPF_64_32 relocation naming the
 * site resolves it to that dynamic symbol (undefined imports are syscalls;
 * defined symbols are local functions). Otherwise the immediate must equal
 * exactly one candidate name's Murmur3 hash, or the pc-relative target must
 * land exactly on a defined symbol's address. Anything else — including a
 * hash shared by two candidates — stays unresolved rather than guessed.
 */
export const resolveSolanaCallSites = (
  instructions: readonly SbpfInstruction[],
  image: SolanaElfImage,
): readonly SolanaCallResolution[] => {
  const candidates = buildCandidates(image);
  const definedByValue = new Map<number, SolanaElfSymbol>();
  for (const symbol of image.dynamicSymbols)
    if (
      symbol.sectionIndex !== 0 &&
      symbol.name.length > 0 &&
      symbol.value !== 0 &&
      !definedByValue.has(symbol.value)
    )
      definedByValue.set(symbol.value, symbol);
  const relocationByAddress = new Map<number, SolanaElfSymbol>();
  for (const relocation of image.relocations) {
    if (relocation.type !== R_BPF_64_32) continue;
    const symbol = image.dynamicSymbols[relocation.symbolIndex];
    if (symbol !== undefined && symbol.name.length > 0)
      relocationByAddress.set(relocation.offset, symbol);
  }

  const resolutions: SolanaCallResolution[] = [];
  for (const instruction of instructions) {
    if (instruction.mnemonic !== "call" || instruction.srcIsRegister) continue;
    const immediate = instruction.imm >>> 0;
    const base = { address: instruction.address, immediate };
    const relocated = relocationByAddress.get(instruction.address);
    if (relocated !== undefined) {
      resolutions.push({
        ...base,
        resolvedName: relocated.name,
        basis: relocated.sectionIndex === 0 ? "dynamic-symbol" : "symbol-table",
        note: null,
      });
      continue;
    }
    const names = candidates.byHash.get(immediate) ?? [];
    if (names.length === 1) {
      const name = names[0] as string;
      resolutions.push({
        ...base,
        resolvedName: name,
        basis: candidates.fromElf.has(name)
          ? "dynamic-symbol"
          : "known-syscall-table",
        note: null,
      });
      continue;
    }
    if (names.length > 1) {
      resolutions.push({
        ...base,
        resolvedName: null,
        basis: "unresolved",
        note: `Immediate matches the Murmur3 hash of ${String(names.length)} candidate names (${names.join(", ")}); refusing to guess.`,
      });
      continue;
    }
    const target = instruction.address + 8 * (1 + instruction.imm);
    const symbol = definedByValue.get(target);
    if (symbol !== undefined) {
      resolutions.push({
        ...base,
        resolvedName: symbol.name,
        basis: "symbol-table",
        note: null,
      });
      continue;
    }
    resolutions.push({
      ...base,
      resolvedName: null,
      basis: "unresolved",
      note: null,
    });
  }
  return resolutions;
};
