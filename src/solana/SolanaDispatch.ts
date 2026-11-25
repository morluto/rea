import { createHash } from "node:crypto";

import { BinaryReader } from "../domain/binaryContainer.js";

import type { SbpfInstruction } from "./SbpfDisassembler.js";
import { solanaTextSection, type SolanaElfImage } from "./SolanaElf.js";

/** The dispatch idiom a handler candidate was recovered from. */
export type SolanaDispatchMethod =
  | "lddw-compare"
  | "split-compare"
  | "table-dispatch";

/**
 * One Anchor-style dispatch candidate. Rows are reconstruction leads, not
 * proof of a handler. Fields an idiom does not produce stay null rather
 * than being synthesized: split compares carry no constant address (their
 * constants are compare immediates), and table rows carry no discriminator
 * (their identity is the table slot, kept in `label`).
 */
export interface SolanaHandlerCandidate {
  readonly method: SolanaDispatchMethod;
  readonly discriminator: string | null;
  readonly label: string | null;
  readonly constantAddress: number | null;
  readonly constantFileOffset: number | null;
  /** First comparison address; the primary location for every idiom. */
  readonly comparisonAddress: number | null;
  /** Every comparison guarding the candidate (two for split compares). */
  readonly comparisonAddresses: readonly number[];
  readonly branch: "jeq" | "jne" | null;
  /**
   * Handler entry the guard selects: the taken target for `jeq`, the
   * fallthrough for `jne` (whose taken edge is the mismatch path), or the
   * table slot's target.
   */
  readonly branchTarget: number;
  readonly valueRegister: number | null;
  readonly constantRegister: number | null;
  readonly tableAddress: number | null;
  readonly tableIndex: number | null;
}

export interface SolanaDispatchScan {
  readonly candidates: readonly SolanaHandlerCandidate[];
  /**
   * Register-indirect transfers (`callx`) that matched no recovered table
   * idiom. Counted, never guessed: each is an unknown dispatch site.
   */
  readonly computedJumpsUnresolved: number;
  /**
   * Jump tables that still held code targets past the per-table slot
   * allowance: their later slots were not examined.
   */
  readonly truncatedTables: number;
}

/** Instructions scanned after an lddw for its dispatch comparison. */
const COMPARISON_WINDOW = 8;
/** Instructions allowed between the two halves of a split compare. */
const SPLIT_WINDOW = 24;
/** Instructions walked when tracing a register definition chain. */
const DEF_CHAIN_LIMIT = 6;
/** Upper bound on jump-table entries recovered from one table. */
/** Slots examined per jump table; a longer table is reported as truncated. */
export const SOLANA_MAX_TABLE_ENTRIES = 1024;
const MAX_TABLE_ENTRIES = SOLANA_MAX_TABLE_ENTRIES;

/** True when an instruction overwrites the given register. */
const writesRegister = (
  instruction: SbpfInstruction,
  register: number,
): boolean => {
  if (instruction.dst !== register) return false;
  if (instruction.mnemonic === "lddw") return true;
  const klass = instruction.opcode & 0x07;
  return klass === 0x01 || klass === 0x04 || klass === 0x07;
};

/**
 * The Anchor instruction discriminator for one instruction name:
 * the first 8 bytes of sha256("global:<name>"), hex-encoded. This is the
 * single derivation every consumer (name confirmation, receipts matching)
 * must use.
 */
export const anchorDiscriminator = (name: string): string =>
  createHash("sha256")
    .update(`global:${name}`)
    .digest()
    .subarray(0, 8)
    .toString("hex");

/** Render a 64-bit constant as Anchor discriminator bytes (little-endian hex). */
export const discriminatorHex = (imm64: bigint): string => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt.asUintN(64, imm64));
  return bytes.toString("hex");
};

const branchTargetOf = (instruction: SbpfInstruction): number =>
  instruction.address + 8 * (1 + instruction.offset);

/** Transfers after which a value loaded earlier no longer reaches the next instruction. */
const endsStraightLineBlock = (instruction: SbpfInstruction): boolean =>
  instruction.mnemonic === "call" ||
  instruction.mnemonic === "exit" ||
  instruction.mnemonic === "ja";

/**
 * Recover candidates from the idiom Anchor/rustc emits for instruction
 * dispatch on sBPF: a 64-bit discriminator constant is loaded with `lddw`
 * and compared, register against register, by a nearby `jeq`/`jne`. A
 * constant survives only when the comparison actually consumes the loaded
 * register before anything overwrites it.
 */
const scanLddwCompare = (
  instructions: readonly SbpfInstruction[],
  seen: Set<string>,
): SolanaHandlerCandidate[] => {
  const candidates: SolanaHandlerCandidate[] = [];
  for (let index = 0; index < instructions.length; index += 1) {
    const load = instructions[index];
    if (load === undefined || load.mnemonic !== "lddw") continue;
    for (
      let ahead = index + 1;
      ahead <= Math.min(index + COMPARISON_WINDOW, instructions.length - 1);
      ahead += 1
    ) {
      const candidate = instructions[ahead];
      if (candidate === undefined) break;
      // Share the register-lifetime rules of the other scans: a call
      // clobbers r0–r5, and an unconditional transfer or exit leaves the
      // straight-line block, so the constant cannot reach a later compare.
      if (endsStraightLineBlock(candidate)) break;
      if (writesRegister(candidate, load.dst)) break;
      const isComparison =
        (candidate.mnemonic === "jeq" || candidate.mnemonic === "jne") &&
        candidate.srcIsRegister &&
        candidate.src === load.dst;
      if (!isComparison) continue;
      const discriminator = discriminatorHex(load.imm64);
      if (!seen.has(discriminator)) {
        seen.add(discriminator);
        candidates.push({
          method: "lddw-compare",
          discriminator,
          label: null,
          constantAddress: load.address,
          constantFileOffset: load.fileOffset,
          comparisonAddress: candidate.address,
          comparisonAddresses: [candidate.address],
          branch: candidate.mnemonic === "jne" ? "jne" : "jeq",
          // `jne` bails on mismatch, so the handler is the fallthrough;
          // `jeq` branches into the handler. Same rule as split compares.
          branchTarget:
            candidate.mnemonic === "jne"
              ? candidate.address + 8
              : branchTargetOf(candidate),
          valueRegister: candidate.dst,
          constantRegister: load.dst,
          tableAddress: null,
          tableIndex: null,
        });
      }
      break;
    }
  }
  return candidates;
};

interface HalfCompare {
  readonly index: number;
  readonly address: number;
  readonly half: "lo" | "hi";
  readonly constant: number;
  readonly baseRegister: number;
  /** Which write of the base register the load read through. */
  readonly baseValue: number;
  readonly branch: "jeq" | "jne";
  readonly target: number;
  readonly valueRegister: number;
}

/**
 * Recover candidates from split 32-bit discriminator compares: the low
 * word is loaded from `[base + 0]` and the high word from `[base + 4]`,
 * each compared against a 32-bit immediate, both guarding one handler.
 * Two guard shapes are recovered: both halves bail (`jne`) to the same
 * skip target so the handler is the fallthrough, or the low half bails
 * and the high half branches (`jeq`) into the handler. Anything else is
 * left unrecovered rather than guessed.
 */
const scanSplitCompare = (
  instructions: readonly SbpfInstruction[],
  seen: Set<string>,
): SolanaHandlerCandidate[] => {
  // Track which registers currently hold a u32 loaded from [base + 0|4].
  const loads = new Map<
    number,
    {
      readonly base: number;
      readonly baseValue: number;
      readonly offset: number;
    }
  >();
  // A register's value identity: bumped on every write, so two loads pair
  // only when they read through the same value of the base register.
  const values = new Map<number, number>();
  let nextValue = 1;
  const valueOf = (register: number): number => {
    let value = values.get(register);
    if (value === undefined) {
      value = nextValue;
      nextValue += 1;
      values.set(register, value);
    }
    return value;
  };
  const compares: HalfCompare[] = [];
  for (let index = 0; index < instructions.length; index += 1) {
    const instruction = instructions[index];
    if (instruction === undefined) continue;
    if (
      (instruction.mnemonic === "jeq" || instruction.mnemonic === "jne") &&
      !instruction.srcIsRegister
    ) {
      const load = loads.get(instruction.dst);
      if (load !== undefined && (load.offset === 0 || load.offset === 4))
        compares.push({
          index,
          address: instruction.address,
          half: load.offset === 0 ? "lo" : "hi",
          constant: instruction.imm >>> 0,
          baseRegister: load.base,
          baseValue: load.baseValue,
          branch: instruction.mnemonic,
          target: branchTargetOf(instruction),
          valueRegister: instruction.dst,
        });
    }
    if (endsStraightLineBlock(instruction)) {
      loads.clear();
      values.clear();
    } else if (instruction.opcode === 0x61) {
      // ldx u32: dst = *(u32 *)(src + offset)
      const load = {
        base: instruction.src,
        baseValue: valueOf(instruction.src),
        offset: instruction.offset,
      };
      values.set(instruction.dst, nextValue);
      nextValue += 1;
      loads.set(instruction.dst, load);
    } else if (writesRegister(instruction, instruction.dst)) {
      loads.delete(instruction.dst);
      values.set(instruction.dst, nextValue);
      nextValue += 1;
    }
  }

  const candidates: SolanaHandlerCandidate[] = [];
  for (let lo = 0; lo < compares.length; lo += 1) {
    const low = compares[lo];
    if (low === undefined || low.half !== "lo") continue;
    for (let hi = lo + 1; hi < compares.length; hi += 1) {
      const high = compares[hi];
      if (high === undefined) break;
      if (high.index - low.index > SPLIT_WINDOW) break;
      if (
        high.half !== "hi" ||
        high.baseRegister !== low.baseRegister ||
        high.baseValue !== low.baseValue
      )
        continue;
      // A control transfer between the halves breaks the guard chain.
      let broken = false;
      for (let between = low.index + 1; between < high.index; between += 1) {
        const inner = instructions[between];
        if (inner === undefined) continue;
        const klass = inner.opcode & 0x07;
        if (klass === 0x05 || klass === 0x06) {
          broken = true;
          break;
        }
      }
      if (broken) break;
      let branchTarget: number | undefined;
      if (
        low.branch === "jne" &&
        high.branch === "jne" &&
        low.target === high.target
      )
        branchTarget = high.address + 8;
      else if (low.branch === "jne" && high.branch === "jeq")
        branchTarget = high.target;
      if (branchTarget === undefined || branchTarget === low.target) continue;
      const discriminator = discriminatorHex(
        BigInt(low.constant) | (BigInt(high.constant) << 32n),
      );
      if (seen.has(discriminator)) continue;
      seen.add(discriminator);
      candidates.push({
        method: "split-compare",
        discriminator,
        label: null,
        constantAddress: null,
        constantFileOffset: null,
        comparisonAddress: low.address,
        comparisonAddresses: [low.address, high.address],
        branch: high.branch,
        branchTarget,
        valueRegister: low.valueRegister,
        constantRegister: null,
        tableAddress: null,
        tableIndex: null,
      });
      break;
    }
  }
  return candidates;
};

/** How a register's current value was produced, as an immutable snapshot. */
type RegisterDef =
  | { readonly kind: "lddw"; readonly value: bigint }
  | {
      readonly kind: "ldx64";
      readonly base: RegisterDef | undefined;
      readonly offset: number;
    }
  | {
      readonly kind: "add";
      readonly left: RegisterDef | undefined;
      readonly right: RegisterDef | undefined;
    }
  | { readonly kind: "mov"; readonly from: RegisterDef | undefined }
  | { readonly kind: "other" };

const OTHER_DEF: RegisterDef = { kind: "other" };

/** Reduce a definition chain to the constant table base it derives from. */
const tableBaseOf = (
  def: RegisterDef | undefined,
  depth: number,
): number | null => {
  if (def === undefined || depth > DEF_CHAIN_LIMIT) return null;
  if (def.kind === "lddw")
    return def.value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(def.value)
      : null;
  if (def.kind === "mov") return tableBaseOf(def.from, depth + 1);
  if (def.kind === "add")
    return (
      tableBaseOf(def.left, depth + 1) ?? tableBaseOf(def.right, depth + 1)
    );
  return null;
};

/**
 * Recover jump-table dispatch: a register-indirect transfer (`callx`)
 * whose register was loaded from a read-only table of code addresses.
 * The table must start at a constant base, hold at least two consecutive
 * plausible `.text` targets, and be read through a zero-offset load;
 * anything ambiguous is counted as an unresolved computed jump instead.
 */
const scanTableDispatch = (
  instructions: readonly SbpfInstruction[],
  image: SolanaElfImage | undefined,
): {
  candidates: SolanaHandlerCandidate[];
  unresolved: number;
  truncatedTables: number;
} => {
  const candidates: SolanaHandlerCandidate[] = [];
  const emitted = new Set<string>();
  let unresolved = 0;
  let truncatedTables = 0;
  const text = image === undefined ? undefined : solanaTextSection(image);
  const rodataSections =
    image === undefined
      ? []
      : image.sections.filter(
          (section) =>
            section.type === 1 &&
            (section.name.startsWith(".rodata") ||
              section.name === ".data.rel.ro"),
        );
  const reader =
    image === undefined
      ? undefined
      : new BinaryReader(
          Buffer.from(
            image.bytes.buffer,
            image.bytes.byteOffset,
            image.bytes.byteLength,
          ),
          true,
          "elf",
        );

  const readTable = (
    base: number,
  ): { entries: readonly number[]; truncated: boolean } | undefined => {
    if (reader === undefined || text === undefined || image === undefined)
      return undefined;
    const section = rodataSections.find(
      (candidate) =>
        base >= candidate.address && base < candidate.address + candidate.size,
    );
    if (section === undefined) return undefined;
    const entryAt = (index: number): number | undefined => {
      const address = base + index * 8;
      const fileOffset = section.offset + (address - section.address);
      if (fileOffset + 8 > section.offset + section.size) return undefined;
      if (fileOffset + 8 > image.bytes.length) return undefined;
      const value = Number(reader.word(fileOffset, 64));
      if (
        value < text.address ||
        value >= text.address + text.size ||
        (value - text.address) % 8 !== 0
      )
        return undefined;
      return value;
    };
    const entries: number[] = [];
    for (let index = 0; index < MAX_TABLE_ENTRIES; index += 1) {
      const value = entryAt(index);
      if (value === undefined) break;
      entries.push(value);
    }
    if (entries.length < 2) return undefined;
    // A table still holding code targets past the slot allowance was not
    // examined in full; report it rather than present a complete table.
    const truncated =
      entries.length === MAX_TABLE_ENTRIES &&
      entryAt(MAX_TABLE_ENTRIES) !== undefined;
    return { entries, truncated };
  };

  const defs = new Map<number, RegisterDef>();
  for (const instruction of instructions) {
    if (instruction.mnemonic === "call" && instruction.srcIsRegister) {
      const def =
        instruction.indirectRegister === null
          ? undefined
          : defs.get(instruction.indirectRegister);
      const entries =
        def?.kind === "ldx64" && def.offset === 0
          ? (() => {
              const base = tableBaseOf(def.base, 0);
              const table = base === null ? undefined : readTable(base);
              return base === null || table === undefined
                ? undefined
                : { base, ...table };
            })()
          : undefined;
      if (entries === undefined) unresolved += 1;
      else {
        if (entries.truncated) truncatedTables += 1;
        entries.entries.forEach((target, index) => {
          const key = `${String(entries.base)}:${String(index)}`;
          if (emitted.has(key)) return;
          emitted.add(key);
          candidates.push({
            method: "table-dispatch",
            discriminator: null,
            label: `index:${String(index)}`,
            constantAddress: null,
            constantFileOffset: null,
            comparisonAddress: null,
            comparisonAddresses: [],
            branch: null,
            branchTarget: target,
            valueRegister: null,
            constantRegister: null,
            tableAddress: entries.base,
            tableIndex: index,
          });
        });
      }
    }
    // Record this instruction's effect on register definitions.
    if (instruction.mnemonic === "lddw")
      defs.set(instruction.dst, { kind: "lddw", value: instruction.imm64 });
    else if (instruction.opcode === 0x79)
      defs.set(instruction.dst, {
        kind: "ldx64",
        base: defs.get(instruction.src),
        offset: instruction.offset,
      });
    else if ((instruction.opcode & 0x07) === 0x07) {
      const op = (instruction.opcode >> 4) & 0x0f;
      if (op === 0 && instruction.srcIsRegister)
        defs.set(instruction.dst, {
          kind: "add",
          left: defs.get(instruction.dst),
          right: defs.get(instruction.src),
        });
      else if (op === 11 && instruction.srcIsRegister)
        defs.set(instruction.dst, {
          kind: "mov",
          from: defs.get(instruction.src),
        });
      else defs.set(instruction.dst, OTHER_DEF);
    } else if (writesRegister(instruction, instruction.dst))
      defs.set(instruction.dst, OTHER_DEF);
    if (instruction.mnemonic === "call")
      // Calls clobber the argument/return registers r0–r5.
      for (let register = 0; register <= 5; register += 1)
        defs.set(register, OTHER_DEF);
    // exit and ja end the straight-line block: a later function or block
    // never inherits this one's table definitions.
    if (instruction.mnemonic === "exit" || instruction.mnemonic === "ja")
      defs.clear();
  }
  return { candidates, unresolved, truncatedTables };
};

/**
 * Recover Anchor-style dispatch candidates from every idiom the bundled
 * decoder can verify. Candidates are reconstruction leads, not proof of a
 * handler. Full-width `lddw` candidates win discriminator deduplication:
 * a split pair composing the same discriminator is not double-counted.
 */
export const scanSolanaDispatch = (
  instructions: readonly SbpfInstruction[],
  image?: SolanaElfImage,
): SolanaDispatchScan => {
  const seen = new Set<string>();
  const lddw = scanLddwCompare(instructions, seen);
  const split = scanSplitCompare(instructions, seen);
  const table = scanTableDispatch(instructions, image);
  const candidates = [...lddw, ...split, ...table.candidates].sort((a, b) => {
    const aKey =
      a.constantAddress ?? a.comparisonAddress ?? a.tableAddress ?? 0;
    const bKey =
      b.constantAddress ?? b.comparisonAddress ?? b.tableAddress ?? 0;
    if (aKey !== bKey) return aKey - bKey;
    return a.branchTarget - b.branchTarget;
  });
  return {
    candidates,
    computedJumpsUnresolved: table.unresolved,
    truncatedTables: table.truncatedTables,
  };
};
