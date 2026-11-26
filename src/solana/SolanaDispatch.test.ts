import { expect, it } from "vitest";
import { disassembleSbpf } from "./SbpfDisassembler.js";
import { scanSolanaDispatch } from "./SolanaDispatch.js";
import type { SolanaElfImage, SolanaElfSection } from "./SolanaElf.js";

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

// create_config's discriminator c9cff3724b6f2fbd, as two 32-bit halves.
const LO = 0x72f3cfc9;
const HI = 0xbd2f6f4b;

it("recovers a split-compare candidate when the low half bails and the high half branches", () => {
  const instructions = disassembleSbpf(
    join(
      word(0x61, 3, 2, 0, 0), // r3 = *(u32 *)(r2 + 0)
      word(0x55, 3, 0, 3, LO), // if r3 != lo goto +3 (bail)
      word(0x61, 4, 2, 4, 0), // r4 = *(u32 *)(r2 + 4)
      word(0x15, 4, 0, 5, HI), // if r4 == hi goto +5 (handler)
      word(0x95, 0, 0, 0, 0),
    ),
    0x1000,
    0,
  );
  const { candidates } = scanSolanaDispatch(instructions);
  expect(candidates).toHaveLength(1);
  expect(candidates[0]).toMatchObject({
    method: "split-compare",
    discriminator: "c9cff3724b6f2fbd",
    comparisonAddress: 0x1008,
    comparisonAddresses: [0x1008, 0x1018],
    branch: "jeq",
    branchTarget: 0x1018 + 8 * 6,
    constantAddress: null,
  });
});

it("recovers a split-compare candidate when both halves bail to the same skip target", () => {
  const instructions = disassembleSbpf(
    join(
      word(0x61, 3, 2, 0, 0),
      word(0x55, 3, 0, 4, LO), // bail to 0x1030
      word(0x61, 4, 2, 4, 0),
      word(0x55, 4, 0, 2, HI), // bail to 0x1030
      word(0x95, 0, 0, 0, 0), // handler entry: fallthrough 0x1020
    ),
    0x1000,
    0,
  );
  const { candidates } = scanSolanaDispatch(instructions);
  expect(candidates).toHaveLength(1);
  expect(candidates[0]).toMatchObject({
    method: "split-compare",
    discriminator: "c9cff3724b6f2fbd",
    branch: "jne",
    branchTarget: 0x1020,
  });
});

it("does not double-count a discriminator the lddw idiom already recovered", () => {
  const instructions = disassembleSbpf(
    join(
      word(0x79, 3, 2, 0, 0), // r3 = *(u64 *)(r2 + 0)
      word(0x18, 4, 0, 0, LO), // lddw r4 = discriminator
      word(0x00, 0, 0, 0, HI),
      word(0x1d, 3, 4, 5, 0), // if r3 == r4 goto +5
      word(0x61, 5, 2, 0, 0),
      word(0x55, 5, 0, 3, LO),
      word(0x61, 6, 2, 4, 0),
      word(0x15, 6, 0, 5, HI),
    ),
    0x1000,
    0,
  );
  const { candidates } = scanSolanaDispatch(instructions);
  expect(candidates).toHaveLength(1);
  expect(candidates[0]?.method).toBe("lddw-compare");
});

it("ignores split pairs on different bases or broken by an inner branch", () => {
  const differentBases = disassembleSbpf(
    join(
      word(0x61, 3, 2, 0, 0),
      word(0x55, 3, 0, 3, LO),
      word(0x61, 4, 5, 4, 0), // high half from r5, not r2
      word(0x15, 4, 0, 5, HI),
    ),
    0x1000,
    0,
  );
  expect(scanSolanaDispatch(differentBases).candidates).toHaveLength(0);
  const brokenChain = disassembleSbpf(
    join(
      word(0x61, 3, 2, 0, 0),
      word(0x55, 3, 0, 3, LO),
      word(0x05, 0, 0, 1, 0), // ja +1 between the halves
      word(0x61, 4, 2, 4, 0),
      word(0x15, 4, 0, 5, HI),
    ),
    0x1000,
    0,
  );
  expect(scanSolanaDispatch(brokenChain).candidates).toHaveLength(0);
});

const section = (
  name: string,
  address: number,
  offset: number,
  size: number,
): SolanaElfSection => ({
  name,
  type: 1,
  flags: 0,
  address,
  offset,
  size,
  link: 0,
  entrySize: 0,
});

/** Image whose .rodata holds a 3-entry jump table at 0x2000 into .text. */
const tableImage = (entries: readonly number[]): SolanaElfImage => {
  const bytes = new Uint8Array(Math.max(0x60, 0x40 + entries.length * 8));
  const view = new DataView(bytes.buffer);
  entries.forEach((value, index) =>
    view.setBigUint64(0x40 + index * 8, BigInt(value), true),
  );
  return {
    bytes,
    byteOrder: "little",
    elfType: 3,
    machine: 263,
    entrypoint: 0x1000,
    elfFlags: 0,
    programHeaders: [],
    sections: [
      section(".text", 0x1000, 0, 0x100),
      section(".rodata", 0x2000, 0x40, entries.length * 8),
    ],
    dynamicSymbols: [],
    relocations: [],
    trailingBytes: 0,
  };
};

const TABLE_STREAM = join(
  word(0x18, 6, 0, 0, 0x2000), // lddw r6 = table base
  word(0x00, 0, 0, 0, 0),
  word(0x6f, 8, 2, 0, 3), // r8 = r2 << 3 (index scale; value not traced)
  word(0x0f, 7, 6, 0, 0), // r7 = r6 + r8
  word(0x79, 9, 7, 0, 0), // r9 = *(u64 *)(r7 + 0)
  word(0x8d, 0, 0, 0, 9), // callx r9 (sBPF v0: the register is in imm)
);

it("recovers jump-table entries as labeled candidates", () => {
  const instructions = disassembleSbpf(TABLE_STREAM, 0x1000, 0);
  const image = tableImage([0x1000, 0x1040, 0x1080, 0x9999]);
  const { candidates, computedJumpsUnresolved } = scanSolanaDispatch(
    instructions,
    image,
  );
  expect(computedJumpsUnresolved).toBe(0);
  expect(candidates).toHaveLength(3);
  expect(candidates.map((candidate) => candidate.label)).toEqual([
    "index:0",
    "index:1",
    "index:2",
  ]);
  expect(candidates[1]).toMatchObject({
    method: "table-dispatch",
    discriminator: null,
    branchTarget: 0x1040,
    tableAddress: 0x2000,
    tableIndex: 1,
  });
});

it("counts register-indirect transfers with no verified table as unresolved", () => {
  const instructions = disassembleSbpf(
    join(
      word(0x79, 9, 10, 0, 0), // r9 = *(u64 *)(r10 + 0): frame slot, not a table
      word(0x8d, 0, 0, 0, 9), // callx r9 (sBPF v0: the register is in imm)
    ),
    0x1000,
    0,
  );
  const scan = scanSolanaDispatch(instructions, tableImage([0x1000, 0x1040]));
  expect(scan.candidates).toHaveLength(0);
  expect(scan.computedJumpsUnresolved).toBe(1);
  // A one-entry table is not a dispatch table either.
  const single = scanSolanaDispatch(
    disassembleSbpf(TABLE_STREAM, 0x1000, 0),
    tableImage([0x1000, 0x9999]),
  );
  expect(single.candidates).toHaveLength(0);
  expect(single.computedJumpsUnresolved).toBe(1);
});

it("does not pair split halves read through a reassigned base register", () => {
  const instructions = disassembleSbpf(
    join(
      word(0x61, 3, 2, 0, 0), // r3 = *(u32 *)(r2 + 0)
      word(0x55, 3, 0, 3, LO), // if r3 != lo goto +3
      word(0xbf, 2, 7, 0, 0), // r2 = r7: a different base value
      word(0x61, 4, 2, 4, 0), // r4 = *(u32 *)(r2 + 4)
      word(0x15, 4, 0, 5, HI), // if r4 == hi goto +5
      word(0x95, 0, 0, 0, 0),
    ),
    0x1000,
    0,
  );
  expect(scanSolanaDispatch(instructions).candidates).toHaveLength(0);
});

it("does not carry a table definition across exit into a later function", () => {
  const instructions = disassembleSbpf(
    join(
      word(0x18, 6, 0, 0, 0x2000), // lddw r6 = table base
      word(0x00, 0, 0, 0, 0),
      word(0x79, 9, 6, 0, 0), // r9 = *(u64 *)(r6 + 0)
      word(0x95, 0, 0, 0, 0), // exit: the next function starts here
      word(0x8d, 0, 0, 0, 9), // callx r9
    ),
    0x1000,
    0,
  );
  const scan = scanSolanaDispatch(instructions, tableImage([0x1000, 0x1040]));
  expect(scan.candidates).toHaveLength(0);
  expect(scan.computedJumpsUnresolved).toBe(1);
});

it("reports a jump table longer than the slot allowance as truncated", () => {
  const scan = scanSolanaDispatch(
    disassembleSbpf(TABLE_STREAM, 0x1000, 0),
    tableImage(Array.from({ length: 1100 }, () => 0x1000)),
  );
  expect(scan.truncatedTables).toBe(1);
  expect(scan.candidates).toHaveLength(1024);
});
