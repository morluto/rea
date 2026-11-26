import { BinaryReader } from "../domain/binaryContainer.js";
/**
 * Minimal sBPF instruction decoder built on the fixed 8-byte instruction
 * word: opcode, register pair (dst low nibble, src high nibble), signed
 * 16-bit offset, signed 32-bit immediate. `lddw` (0x18) spans two words and
 * carries one 64-bit immediate. Solana syscall invocations are `call` words
 * whose immediate is the syscall's registered hash; pseudo-calls to local
 * functions carry a relative instruction offset in the immediate instead.
 */
export interface SbpfInstruction {
  readonly address: number;
  readonly fileOffset: number;
  readonly opcode: number;
  readonly dst: number;
  readonly src: number;
  /** True when the source operand is a register (opcode source bit set). */
  readonly srcIsRegister: boolean;
  readonly offset: number;
  readonly imm: number;
  /** Combined 64-bit immediate for lddw; equal to imm for other words. A
   * bigint because discriminator constants span the full unsigned range. */
  readonly imm64: bigint;
  readonly slots: 1 | 2;
  /**
   * Target register of a register-indirect `callx`, decoded once for the
   * ELF's sBPF version (the `imm` field before v2, `src` from v2); null for
   * every other instruction.
   */
  readonly indirectRegister: number | null;
  readonly mnemonic: string;
  readonly text: string;
}

const ALU_NAMES: Readonly<Record<number, string>> = {
  0: "add",
  1: "sub",
  2: "mul",
  3: "div",
  4: "or",
  5: "and",
  6: "lsh",
  7: "rsh",
  9: "mod",
  10: "xor",
  11: "mov",
  12: "arsh",
};

const ALU_SYMBOLS: Readonly<Record<number, string>> = {
  0: "+",
  1: "-",
  2: "*",
  3: "/",
  4: "|",
  5: "&",
  6: "<<",
  7: ">>",
  9: "%",
  10: "^",
  12: "s>>",
};

const JMP_NAMES: Readonly<Record<number, string>> = {
  0: "ja",
  1: "jeq",
  2: "jgt",
  3: "jge",
  4: "jset",
  5: "jne",
  6: "jsgt",
  7: "jsge",
  8: "call",
  9: "exit",
  10: "jlt",
  11: "jle",
  12: "jslt",
  13: "jsle",
};

const SIZE_NAMES: Readonly<Record<number, string>> = {
  0: "u32",
  1: "u16",
  2: "u8",
  3: "u64",
};

const hex = (value: number, width: number): string =>
  `0x${value.toString(16).padStart(width, "0")}`;

/** Short operation name for one opcode; `unknown` when the decoder cannot name it. */
export const sbpfMnemonic = (opcode: number): string => {
  if (opcode === 0x18) return "lddw";
  const klass = opcode & 0x07;
  const op = (opcode >> 4) & 0x0f;
  if (klass === 0x05 || klass === 0x06) return JMP_NAMES[op] ?? "unknown";
  if (klass === 0x04 || klass === 0x07) {
    if (op === 8) return "neg";
    if (op === 13) return "end";
    return ALU_NAMES[op] ?? "unknown";
  }
  if (klass === 0x01) return "ldx";
  if (klass === 0x02) return "st";
  if (klass === 0x03) return "stx";
  if (klass === 0x00) return "ld";
  return "unknown";
};

const signed = (value: number): string =>
  value < 0 ? String(value) : `+${String(value)}`;

const formatInstruction = (base: Omit<SbpfInstruction, "text">): string => {
  const { opcode, dst, src, srcIsRegister, offset, imm, imm64 } = base;
  const klass = opcode & 0x07;
  const op = (opcode >> 4) & 0x0f;
  const operand = srcIsRegister ? `r${String(src)}` : String(imm);
  if (opcode === 0x18)
    return base.slots === 2
      ? `r${String(dst)} = 0x${imm64.toString(16).padStart(16, "0")} ll`
      : `truncated lddw (missing second word)`;
  if (klass === 0x04 || klass === 0x07) {
    const bits = klass === 0x07 ? 64 : 32;
    // 32-bit ALU operations truncate and zero the upper half; name their
    // registers wN so the width survives in the rendered text.
    const reg = bits === 64 ? "r" : "w";
    const aluOperand = srcIsRegister ? `${reg}${String(src)}` : String(imm);
    if (op === 8) return `${reg}${String(dst)} = -${reg}${String(dst)}`;
    if (op === 13)
      // The immediate carries the conversion width (16, 32 or 64 bits).
      return `r${String(dst)} = ${srcIsRegister ? "be" : "le"}${String(imm)}(r${String(dst)})`;
    const name = ALU_NAMES[op];
    if (name === undefined)
      return `unknown alu${String(bits)} op ${String(op)}`;
    if (name === "mov") return `${reg}${String(dst)} = ${aluOperand}`;
    const symbol = ALU_SYMBOLS[op] ?? name;
    return `${reg}${String(dst)} ${symbol}= ${aluOperand}`;
  }
  if (klass === 0x05 || klass === 0x06) {
    const name = JMP_NAMES[op];
    if (name === undefined) return `unknown jmp op ${String(op)}`;
    if (name === "ja") return `goto ${signed(offset)}`;
    if (name === "exit") return "exit";
    if (name === "call")
      return srcIsRegister
        ? base.indirectRegister === null
          ? `callx (unknown register)`
          : `callx r${String(base.indirectRegister)}`
        : `call ${String(imm >>> 0)}`;
    const comparison: Readonly<Record<string, string>> = {
      jeq: "==",
      jne: "!=",
      jgt: ">",
      jge: ">=",
      jset: "&",
      jsgt: "s>",
      jsge: "s>=",
      jlt: "<",
      jle: "<=",
      jslt: "s<",
      jsle: "s<=",
    };
    return `if r${String(dst)} ${comparison[name] ?? name} ${operand} goto ${signed(offset)}`;
  }
  if (klass === 0x01) {
    const size = SIZE_NAMES[(opcode >> 3) & 0x03] ?? "u32";
    return `r${String(dst)} = *(${size} *)(r${String(src)} ${signed(offset)})`;
  }
  if (klass === 0x02) {
    const size = SIZE_NAMES[(opcode >> 3) & 0x03] ?? "u32";
    return `*(${size} *)(r${String(dst)} ${signed(offset)}) = ${String(imm)}`;
  }
  if (klass === 0x03) {
    const size = SIZE_NAMES[(opcode >> 3) & 0x03] ?? "u32";
    return `*(${size} *)(r${String(dst)} ${signed(offset)}) = r${String(src)}`;
  }
  if (klass === 0x00) return `ld opcode ${hex(opcode, 2)}`;
  return `unknown opcode ${hex(opcode, 2)}`;
};

/**
 * Instruction-boundary facts for one code range: bytes left over after the
 * last whole 8-byte word, and whether the final word opens an `lddw` whose
 * second word is missing. Either means the range is not complete sBPF code.
 */
export const sbpfCodeBoundaryIssues = (
  text: Uint8Array,
): { readonly trailingBytes: number; readonly truncatedLddw: boolean } => {
  const trailingBytes = text.length % 8;
  const totalSlots = Math.floor(text.length / 8);
  let slot = 0;
  let truncatedLddw = false;
  while (slot < totalSlots) {
    if (text[slot * 8] === 0x18) {
      if (slot + 1 >= totalSlots) {
        truncatedLddw = true;
        break;
      }
      slot += 2;
    } else slot += 1;
  }
  return { trailingBytes, truncatedLddw };
};

/** True when the decoder cannot name the instruction's operation. */
export const isUnknownSbpfInstruction = (
  instruction: SbpfInstruction,
): boolean => instruction.mnemonic === "unknown";

/**
 * Decode one `.text` byte range into instructions. `baseAddress` is the
 * section's virtual address and `baseFileOffset` its file offset, so records
 * carry both identities. Decoding is a linear sweep; sBPF has no variable
 * instruction alignment to lose.
 */
export const disassembleSbpf = (
  text: Uint8Array,
  baseAddress: number,
  baseFileOffset: number,
  sbpfVersion = 0,
): readonly SbpfInstruction[] => {
  const instructions: SbpfInstruction[] = [];
  const reader = new BinaryReader(
    Buffer.from(text.buffer, text.byteOffset, text.byteLength),
    true,
    "solana-sbpf",
  );
  let slot = 0;
  const totalSlots = Math.floor(text.length / 8);
  while (slot < totalSlots) {
    const byteIndex = slot * 8;
    const opcode = text[byteIndex] ?? 0;
    const registers = text[byteIndex + 1] ?? 0;
    const dst = registers & 0x0f;
    const src = (registers >> 4) & 0x0f;
    const offset = reader.i16(byteIndex + 2);
    const imm = reader.i32(byteIndex + 4);
    let imm64 = BigInt(imm >>> 0);
    let slots: 1 | 2 = 1;
    if (opcode === 0x18 && slot + 1 < totalSlots) {
      const high = reader.u32(byteIndex + 12);
      imm64 = (BigInt(high) << 32n) | BigInt(imm >>> 0);
      slots = 2;
    }
    const srcIsRegister = (opcode & 0x08) !== 0;
    const indirectRegister =
      opcode === 0x8d && srcIsRegister
        ? sbpfVersion >= 2
          ? src
          : imm >= 0 && imm <= 10
            ? imm
            : null
        : null;
    const base: Omit<SbpfInstruction, "text"> = {
      address: baseAddress + slot * 8,
      fileOffset: baseFileOffset + byteIndex,
      opcode,
      dst,
      src,
      srcIsRegister,
      offset,
      imm,
      imm64,
      slots,
      indirectRegister,
      // A final one-word lddw lacks its high immediate; never report it
      // as a complete constant load.
      mnemonic:
        opcode === 0x18 && slots === 1 ? "unknown" : sbpfMnemonic(opcode),
    };
    instructions.push({ ...base, text: formatInstruction(base) });
    slot += slots;
  }
  return instructions;
};
