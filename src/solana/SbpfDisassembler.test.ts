import { expect, it } from "vitest";
import {
  disassembleSbpf,
  isUnknownSbpfInstruction,
} from "./SbpfDisassembler.js";
import { discriminatorHex, scanSolanaDispatch } from "./SolanaDispatch.js";

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

/** The create_config discriminator as Anchor emits it: one lddw constant. */
const CREATE_CONFIG_LDDW = join(
  word(0x18, 4, 0, 0, 0x72f3cfc9),
  word(0x00, 0, 0, 0, 0xbd2f6f4b),
);

it("decodes lddw as one two-slot instruction with an exact 64-bit immediate", () => {
  const [instruction] = disassembleSbpf(CREATE_CONFIG_LDDW, 0x1000, 0x200);
  expect(instruction?.slots).toBe(2);
  expect(instruction?.mnemonic).toBe("lddw");
  expect(instruction?.imm64).toBe(0xbd2f6f4b72f3cfc9n);
  expect(instruction?.address).toBe(0x1000);
  expect(instruction?.fileOffset).toBe(0x200);
  expect(instruction?.text).toContain("0xbd2f6f4b72f3cfc9");
});

it("renders the lddw constant as the Anchor discriminator byte order", () => {
  expect(discriminatorHex(0xbd2f6f4b72f3cfc9n)).toBe("c9cff3724b6f2fbd");
});

it("decodes register comparisons, calls, loads and exits", () => {
  const instructions = disassembleSbpf(
    join(
      word(0x1d, 3, 4, 187, 0),
      word(0x85, 0, 0, 0, 1234),
      word(0x79, 1, 7, -4088, 0),
      word(0xbf, 6, 8, 0, 0),
      word(0x95, 0, 0, 0, 0),
    ),
    0,
    0,
  );
  expect(instructions.map((entry) => entry.mnemonic)).toEqual([
    "jeq",
    "call",
    "ldx",
    "mov",
    "exit",
  ]);
  expect(instructions[0]?.srcIsRegister).toBe(true);
  expect(instructions[0]?.text).toBe("if r3 == r4 goto +187");
  expect(instructions[1]?.text).toBe("call 1234");
  expect(instructions.every((entry) => !isUnknownSbpfInstruction(entry))).toBe(
    true,
  );
});

it("recovers a dispatch candidate from the lddw plus register-compare idiom", () => {
  const instructions = disassembleSbpf(
    join(
      word(0x79, 3, 2, 0, 0),
      ...splitWords(CREATE_CONFIG_LDDW),
      word(0x1d, 3, 4, 5, 0),
      word(0x95, 0, 0, 0, 0),
    ),
    0x1000,
    0x200,
  );
  const candidates = scanSolanaDispatch(instructions).candidates;
  expect(candidates).toHaveLength(1);
  expect(candidates[0]?.discriminator).toBe("c9cff3724b6f2fbd");
  expect(candidates[0]?.branch).toBe("jeq");
  expect(candidates[0]?.valueRegister).toBe(3);
  expect(candidates[0]?.constantRegister).toBe(4);
  expect(candidates[0]?.branchTarget).toBe(0x1000 + 8 * (3 + 1 + 5));
});

it("does not promote constants that are overwritten or compared as immediates", () => {
  const overwritten = disassembleSbpf(
    join(
      ...splitWords(CREATE_CONFIG_LDDW),
      word(0xbf, 4, 0, 0, 0),
      word(0x1d, 3, 4, 5, 0),
    ),
    0,
    0,
  );
  expect(scanSolanaDispatch(overwritten).candidates).toHaveLength(0);
  const immediateCompare = disassembleSbpf(
    join(...splitWords(CREATE_CONFIG_LDDW), word(0x15, 3, 0, 5, 7)),
    0,
    0,
  );
  expect(scanSolanaDispatch(immediateCompare).candidates).toHaveLength(0);
});

const splitWords = (bytes: Uint8Array): readonly Uint8Array[] => [
  bytes.subarray(0, 8),
  bytes.subarray(8, 16),
];

it("resolves a jne dispatch to the fallthrough handler, not the skip target", () => {
  const instructions = disassembleSbpf(
    join(
      word(0x79, 3, 2, 0, 0),
      ...splitWords(CREATE_CONFIG_LDDW),
      word(0x5d, 3, 4, 5, 0),
      word(0x95, 0, 0, 0, 0),
    ),
    0x1000,
    0x200,
  );
  const [candidate] = scanSolanaDispatch(instructions).candidates;
  expect(candidate?.branch).toBe("jne");
  // Equality falls through to the word after the jne at 0x1000 + 8 * 3.
  expect(candidate?.branchTarget).toBe(0x1000 + 8 * 4);
});

it("does not pair a dispatch constant with a compare after a call, exit or jump", () => {
  for (const separator of [
    word(0x85, 0, 0, 0, 1234),
    word(0x95, 0, 0, 0, 0),
    word(0x05, 0, 0, 0, 0),
  ]) {
    const instructions = disassembleSbpf(
      join(
        ...splitWords(CREATE_CONFIG_LDDW),
        separator,
        word(0x1d, 3, 4, 5, 0),
      ),
      0,
      0,
    );
    expect(scanSolanaDispatch(instructions).candidates).toHaveLength(0);
  }
});

it("renders byte-swap conversions with their immediate width", () => {
  const instructions = disassembleSbpf(
    join(
      word(0xd4, 1, 0, 0, 16),
      word(0xd4, 1, 0, 0, 32),
      word(0xdc, 1, 0, 0, 64),
    ),
    0,
    0,
  );
  expect(instructions.map((entry) => entry.text)).toEqual([
    "r1 = le16(r1)",
    "r1 = le32(r1)",
    "r1 = be64(r1)",
  ]);
});

it("marks an lddw missing its second word as unknown instead of reading past the code", () => {
  const instructions = disassembleSbpf(CREATE_CONFIG_LDDW.subarray(0, 8), 0, 0);
  expect(instructions).toHaveLength(1);
  const [only] = instructions;
  expect(only !== undefined && isUnknownSbpfInstruction(only)).toBe(true);
});

it("decodes the callx target register for the ELF's sBPF version", () => {
  const [v0] = disassembleSbpf(word(0x8d, 0, 0, 0, 9), 0, 0, 0);
  expect(v0?.indirectRegister).toBe(9);
  expect(v0?.text).toBe("callx r9");
  const [v2] = disassembleSbpf(word(0x8d, 0, 9, 0, 0), 0, 0, 2);
  expect(v2?.indirectRegister).toBe(9);
  expect(v2?.text).toBe("callx r9");
});

it("renders 32-bit ALU operations with their width", () => {
  const instructions = disassembleSbpf(
    join(
      word(0xb4, 1, 0, 0, -1),
      word(0xb7, 1, 0, 0, -1),
      word(0x0c, 1, 2, 0, 0),
    ),
    0,
    0,
  );
  expect(instructions.map((entry) => entry.text)).toEqual([
    "w1 = -1",
    "r1 = -1",
    "w1 += w2",
  ]);
});
