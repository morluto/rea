import { readUint16At, readUint32At } from "../binaryContainer.js";
import type { SvdIrqLookupEntry } from "./firmwareSvdInterrupts.js";
import { hex32, type RiscvTrapSlot } from "./firmwareVectorTable.js";

/** Interrupt `mcause` codes of the RISC-V Privileged Architecture (mcause table, Interrupt = 1). */
const RISCV_STANDARD_INTERRUPTS: Readonly<Record<number, string>> = {
  1: "SupervisorSoftwareInterrupt",
  3: "MachineSoftwareInterrupt",
  5: "SupervisorTimerInterrupt",
  7: "MachineTimerInterrupt",
  9: "SupervisorExternalInterrupt",
  11: "MachineExternalInterrupt",
};

/** Causes 16 and up are designated for platform use. */
const RISCV_LOCAL_INTERRUPT_CAUSE_BASE = 16;

const signExtend = (value: number, bits: number): number => {
  const shift = 32 - bits;
  return (value << shift) >> shift;
};

const decodeRiscvJalImm = (insn: number): number => {
  const imm20 = (insn >>> 31) & 1;
  const imm10_1 = (insn >>> 21) & 0x3ff;
  const imm11 = (insn >>> 20) & 1;
  const imm19_12 = (insn >>> 12) & 0xff;
  const raw = (imm20 << 20) | (imm19_12 << 12) | (imm11 << 11) | (imm10_1 << 1);
  return signExtend(raw, 21);
};

const decodeRiscvCJImm = (hw: number): number => {
  const b11 = (hw >>> 12) & 1;
  const b4 = (hw >>> 11) & 1;
  const b9_8 = (hw >>> 9) & 3;
  const b10 = (hw >>> 8) & 1;
  const b6 = (hw >>> 7) & 1;
  const b7 = (hw >>> 6) & 1;
  const b3_1 = (hw >>> 3) & 7;
  const b5 = (hw >>> 2) & 1;
  const raw =
    (b11 << 11) |
    (b10 << 10) |
    (b9_8 << 8) |
    (b7 << 7) |
    (b6 << 6) |
    (b5 << 5) |
    (b4 << 4) |
    (b3_1 << 1);
  return signExtend(raw, 12);
};

const decodeRiscvSlotInstruction = (
  tableBytes: Buffer,
  relOffset: number,
  slotAddress: number,
): Pick<
  RiscvTrapSlot,
  "encoding" | "raw_words" | "decoded_mnemonic" | "target_code_address"
> => {
  const word = readUint32At(tableBytes, relOffset, true);
  if (word === 0 || word === 0xffffffff) {
    return {
      encoding: "zero_or_erased",
      raw_words: [hex32(word)],
      decoded_mnemonic: null,
      target_code_address: null,
    };
  }
  const opcode = word & 0x7f;
  if (opcode === 0x6f) {
    const rd = (word >>> 7) & 0x1f;
    const imm = decodeRiscvJalImm(word);
    const target = (slotAddress + imm) >>> 0;
    return {
      encoding: "jal",
      raw_words: [hex32(word)],
      decoded_mnemonic: `jal x${String(rd)}, ${hex32(target)}`,
      target_code_address: hex32(target),
    };
  }
  if (
    opcode === 0x17 &&
    relOffset + 8 <= tableBytes.length &&
    slotAddress + 7 <= 0xffff_ffff
  ) {
    const word2 = readUint32At(tableBytes, relOffset + 4, true);
    const rd1 = (word >>> 7) & 0x1f;
    const rs1 = (word2 >>> 15) & 0x1f;
    if (
      (word2 & 0x7f) === 0x67 &&
      ((word2 >>> 12) & 7) === 0 &&
      rd1 !== 0 &&
      rd1 === rs1
    ) {
      const hi20 = word & 0xfffff000;
      const lo12 = signExtend(word2 >>> 20, 12);
      // RISC-V JALR clears bit 0 of (rs1 + sext(imm12)).
      const target = ((slotAddress + hi20 + lo12) & ~1) >>> 0;
      return {
        encoding: "auipc_jalr",
        raw_words: [hex32(word), hex32(word2)],
        decoded_mnemonic: `auipc x${String(rd1)}, ...; jalr ${hex32(target)}`,
        target_code_address: hex32(target),
      };
    }
  }
  const hw = readUint16At(tableBytes, relOffset, true);
  if ((hw & 0xe003) === 0xa001) {
    const imm = decodeRiscvCJImm(hw);
    const target = (slotAddress + imm) >>> 0;
    return {
      encoding: "c_j",
      raw_words: [hex32(hw)],
      decoded_mnemonic: `c.j ${hex32(target)}`,
      target_code_address: hex32(target),
    };
  }
  return {
    encoding: "unrecognized",
    raw_words: [hex32(word)],
    decoded_mnemonic: null,
    target_code_address: null,
  };
};

export interface DecodedRiscvVectorSlots {
  readonly slots: RiscvTrapSlot[];
  readonly activeTargets: readonly {
    readonly slotIndex: number;
    readonly address: string;
  }[];
  readonly activeIrqs: readonly number[];
  readonly consumedBytes: number;
}

export const decodeRiscvVectorSlots = (options: {
  readonly tableBytes: Buffer;
  readonly vectorTableOffset: number;
  readonly vtorAddress: number;
  readonly entryCount: number;
  readonly svdMap: ReadonlyMap<number, SvdIrqLookupEntry>;
}): DecodedRiscvVectorSlots => {
  const { tableBytes, vectorTableOffset, vtorAddress, entryCount, svdMap } =
    options;
  const slots: RiscvTrapSlot[] = [];
  const activeTargets: { slotIndex: number; address: string }[] = [];
  const activeIrqs: number[] = [];
  // not-an-allowance: tracks the furthest byte read across 4-byte and 8-byte slots
  let consumedBytes = 0;

  for (let i = 0; i < entryCount; i += 1) {
    const rel = i * 4;
    const slotAddress = (vtorAddress + rel) >>> 0;
    const manualName = RISCV_STANDARD_INTERRUPTS[i];
    const isLocalIrq = i >= RISCV_LOCAL_INTERRUPT_CAUSE_BASE;
    const svd = isLocalIrq ? svdMap.get(i) : undefined;
    let name: string | null = null;
    let nameBasis: RiscvTrapSlot["name_basis"] = "observed_slot";
    let peripheralName: string | null = null;
    let ambiguousNames: string[] = [];
    if (manualName !== undefined) {
      name = manualName;
      nameBasis = "architecture_manual";
    } else if (svd !== undefined) {
      if (svd.primaryName !== null) {
        name = svd.primaryName;
        nameBasis = "explicit_profile";
        peripheralName = svd.primaryPeripheral;
      } else {
        ambiguousNames = [...svd.ambiguousNames];
      }
    }

    const decoded = decodeRiscvSlotInstruction(tableBytes, rel, slotAddress);
    const slotEnd = rel + (decoded.encoding === "auipc_jalr" ? 8 : 4);
    if (slotEnd > consumedBytes) consumedBytes = slotEnd;
    if (decoded.target_code_address !== null) {
      activeTargets.push({
        slotIndex: i,
        address: decoded.target_code_address,
      });
      if (isLocalIrq) activeIrqs.push(i);
    }
    slots.push({
      slot_index: i,
      file_offset: vectorTableOffset + rel,
      slot_address: hex32(slotAddress),
      cause_code: i,
      name,
      name_basis: nameBasis,
      peripheral_name: peripheralName,
      ambiguous_profile_names: ambiguousNames,
      ...decoded,
    });
  }
  return { slots, activeTargets, activeIrqs, consumedBytes };
};
