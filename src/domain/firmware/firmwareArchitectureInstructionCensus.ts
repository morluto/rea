import { readUint16At, readUint32At } from "../binaryContainer.js";
import type {
  FirmwareCpuFamily,
  InstructionCensusProfile,
} from "./firmwareArchitectureCandidates.js";

const YIELD_BYTES = 1024 * 1024;

interface SignatureSpec {
  readonly id: string;
  readonly mnemonic: string;
  readonly alignment: 1 | 2 | 4;
}

interface ProfileSpec {
  readonly key: string;
  readonly profileId: string;
  readonly cpuFamily: FirmwareCpuFamily;
  readonly isaMode: "arm" | "thumb" | "standard";
  readonly wordSize: 32 | 64 | "unknown";
  readonly byteOrder: "little" | "big";
  readonly alignment: 1 | 2 | 4;
  readonly randomProbPerSite: number;
  readonly signatures: readonly SignatureSpec[];
}

interface ProfileAccumulator extends Omit<ProfileSpec, "key" | "signatures"> {
  readonly signatures: {
    readonly id: string;
    readonly mnemonic: string;
    readonly alignment: 1 | 2 | 4;
    // not-an-allowance: observed opcode hit counter
    hits: number;
  }[];
}

const WORD32_SPACE = 4294967296;
const HALFWORD_SPACE = 65536;

const PROFILE_SPECS: readonly ProfileSpec[] = [
  {
    key: "arm64",
    profileId: "arm64-le",
    cpuFamily: "arm64",
    isaMode: "standard",
    wordSize: 64,
    byteOrder: "little",
    alignment: 4,
    randomProbPerSite: 131 / WORD32_SPACE,
    signatures: [
      { id: "arm64_ret", mnemonic: "ret", alignment: 4 },
      {
        id: "arm64_stp_fp_lr",
        mnemonic: "stp x29, x30, [sp, #-imm]!",
        alignment: 4,
      },
      { id: "arm64_paciasp", mnemonic: "paciasp / autiasp", alignment: 4 },
    ],
  },
  {
    key: "armA32",
    profileId: "arm-a32-le",
    cpuFamily: "arm",
    isaMode: "arm",
    wordSize: 32,
    byteOrder: "little",
    alignment: 4,
    randomProbPerSite: 65535 / WORD32_SPACE,
    signatures: [
      { id: "arm_bx_lr", mnemonic: "bx lr", alignment: 4 },
      { id: "arm_push_lr", mnemonic: "push {..., lr}", alignment: 4 },
      { id: "arm_pop_pc", mnemonic: "pop {..., pc}", alignment: 4 },
    ],
  },
  {
    key: "armThumb",
    profileId: "arm-thumb-le",
    cpuFamily: "arm",
    isaMode: "thumb",
    wordSize: 32,
    byteOrder: "little",
    alignment: 2,
    randomProbPerSite: 63 / HALFWORD_SPACE,
    signatures: [
      { id: "thumb_bx_lr", mnemonic: "bx lr", alignment: 2 },
      { id: "thumb_push_lr", mnemonic: "push {..., lr}", alignment: 2 },
      { id: "thumb_pop_pc", mnemonic: "pop {..., pc}", alignment: 2 },
    ],
  },
  {
    key: "mipsLe",
    profileId: "mips32-le",
    cpuFamily: "mips",
    isaMode: "standard",
    wordSize: 32,
    byteOrder: "little",
    alignment: 4,
    randomProbPerSite: 16384 / WORD32_SPACE,
    signatures: [
      { id: "mips_le_jr_ra", mnemonic: "jr $ra", alignment: 4 },
      {
        id: "mips_le_addiu_sp",
        mnemonic: "addiu $sp, $sp, -imm",
        alignment: 4,
      },
      { id: "mips_le_sw_ra", mnemonic: "sw $ra, off($sp)", alignment: 4 },
    ],
  },
  {
    key: "mipsBe",
    profileId: "mips32-be",
    cpuFamily: "mips",
    isaMode: "standard",
    wordSize: 32,
    byteOrder: "big",
    alignment: 4,
    randomProbPerSite: 16384 / WORD32_SPACE,
    signatures: [
      { id: "mips_be_jr_ra", mnemonic: "jr $ra", alignment: 4 },
      {
        id: "mips_be_addiu_sp",
        mnemonic: "addiu $sp, $sp, -imm",
        alignment: 4,
      },
      { id: "mips_be_sw_ra", mnemonic: "sw $ra, off($sp)", alignment: 4 },
    ],
  },
  {
    key: "ppcBe",
    profileId: "powerpc-be",
    cpuFamily: "powerpc",
    isaMode: "standard",
    wordSize: 32,
    byteOrder: "big",
    alignment: 4,
    randomProbPerSite: 8193 / WORD32_SPACE,
    signatures: [
      { id: "ppc_blr", mnemonic: "blr", alignment: 4 },
      { id: "ppc_mflr_r0", mnemonic: "mflr r0", alignment: 4 },
      { id: "ppc_stwu_r1", mnemonic: "stwu r1, -imm(r1)", alignment: 4 },
    ],
  },
  {
    key: "riscvLe",
    profileId: "riscv-le",
    cpuFamily: "riscv",
    isaMode: "standard",
    wordSize: "unknown",
    byteOrder: "little",
    alignment: 2,
    randomProbPerSite: 98 / HALFWORD_SPACE,
    signatures: [
      { id: "riscv_ret", mnemonic: "ret / c.jr ra", alignment: 2 },
      {
        id: "riscv_addi_sp",
        mnemonic: "addi sp, sp, -imm / c.addi16sp",
        alignment: 2,
      },
      {
        id: "riscv_sw_ra",
        mnemonic: "sw/sd ra, off(sp) / c.swsp ra",
        alignment: 2,
      },
    ],
  },
  {
    key: "x86_64",
    profileId: "x86_64-le",
    cpuFamily: "x86_64",
    isaMode: "standard",
    wordSize: 64,
    byteOrder: "little",
    alignment: 1,
    randomProbPerSite: 1 / HALFWORD_SPACE,
    signatures: [
      { id: "x64_prologue", mnemonic: "push rbp; mov rbp, rsp", alignment: 1 },
      { id: "x64_endbr64", mnemonic: "endbr64", alignment: 1 },
      { id: "x64_epilogue", mnemonic: "pop rbp; ret", alignment: 1 },
    ],
  },
  {
    key: "x86",
    profileId: "x86-le",
    cpuFamily: "x86",
    isaMode: "standard",
    wordSize: 32,
    byteOrder: "little",
    alignment: 1,
    randomProbPerSite: 1.004 / HALFWORD_SPACE,
    signatures: [
      { id: "x86_prologue", mnemonic: "push ebp; mov ebp, esp", alignment: 1 },
      { id: "x86_leave_ret", mnemonic: "leave; ret", alignment: 1 },
    ],
  },
];

const createProfiles = (): Record<string, ProfileAccumulator> => {
  const out: Record<string, ProfileAccumulator> = {};
  for (const spec of PROFILE_SPECS) {
    out[spec.key] = {
      profileId: spec.profileId,
      cpuFamily: spec.cpuFamily,
      isaMode: spec.isaMode,
      wordSize: spec.wordSize,
      byteOrder: spec.byteOrder,
      alignment: spec.alignment,
      randomProbPerSite: spec.randomProbPerSite,
      signatures: spec.signatures.map((s) => ({ ...s, hits: 0 })),
    };
  }
  return out;
};

const scoreWord32Le = (
  le: number,
  p: Record<string, ProfileAccumulator>,
): void => {
  if (le === 0xd65f03c0) p.arm64!.signatures[0]!.hits += 1;
  else if ((le & 0xffc07fff) >>> 0 === 0xa9807bfd)
    p.arm64!.signatures[1]!.hits += 1;
  else if (le === 0xd503233f || le === 0xd50323bf)
    p.arm64!.signatures[2]!.hits += 1;

  if (le === 0xe12fff1e) p.armA32!.signatures[0]!.hits += 1;
  else if ((le & 0xffff4000) >>> 0 === 0xe92d4000 && (le & 0x3fff) !== 0)
    p.armA32!.signatures[1]!.hits += 1;
  else if ((le & 0xffff8000) >>> 0 === 0xe8bd8000 && (le & 0x7fff) !== 0)
    p.armA32!.signatures[2]!.hits += 1;

  if (le === 0x03e00008) p.mipsLe!.signatures[0]!.hits += 1;
  else if ((le & 0xffff8003) >>> 0 === 0x27bd8000 && (le & 0x7ffc) !== 0)
    p.mipsLe!.signatures[1]!.hits += 1;
  else if ((le & 0xffff8003) >>> 0 === 0xafbf0000)
    p.mipsLe!.signatures[2]!.hits += 1;
};

const scoreWord32Be = (
  be: number,
  p: Record<string, ProfileAccumulator>,
): void => {
  if (be === 0x03e00008) p.mipsBe!.signatures[0]!.hits += 1;
  else if ((be & 0xffff8003) >>> 0 === 0x27bd8000 && (be & 0x7ffc) !== 0)
    p.mipsBe!.signatures[1]!.hits += 1;
  else if ((be & 0xffff8003) >>> 0 === 0xafbf0000)
    p.mipsBe!.signatures[2]!.hits += 1;

  if (be === 0x4e800020) p.ppcBe!.signatures[0]!.hits += 1;
  else if (be === 0x7c0802a6) p.ppcBe!.signatures[1]!.hits += 1;
  else if ((be & 0xffff8003) >>> 0 === 0x94218000 && (be & 0x7ffc) !== 0)
    p.ppcBe!.signatures[2]!.hits += 1;
};

const scoreHalfwordAligned = (
  bytes: Buffer,
  offset: number,
  limit: number,
  p: Record<string, ProfileAccumulator>,
): void => {
  const hw = readUint16At(bytes, offset, true);
  if (hw === 0x4770) p.armThumb!.signatures[0]!.hits += 1;
  else if ((hw & 0xff07) === 0xb500 && (hw & 0x00f8) !== 0)
    p.armThumb!.signatures[1]!.hits += 1;
  else if ((hw & 0xff07) === 0xbd00 && (hw & 0x00f8) !== 0)
    p.armThumb!.signatures[2]!.hits += 1;
  else if (hw === 0xe92d && offset + 4 <= limit) {
    const hw2 = readUint16At(bytes, offset + 2, true);
    if ((hw2 & 0x4000) !== 0 && (hw2 & 0x1fff) !== 0)
      p.armThumb!.signatures[1]!.hits += 1;
  }

  if (hw === 0x8082) p.riscvLe!.signatures[0]!.hits += 1;
  else if ((hw & 0xff83) === 0x7101) p.riscvLe!.signatures[1]!.hits += 1;
  else if ((hw & 0xe07f) === 0xc006) p.riscvLe!.signatures[2]!.hits += 1;
  else if (offset + 4 <= limit && (hw & 0x0003) === 0x0003) {
    const insn = readUint32At(bytes, offset, true);
    if (insn === 0x00008067) p.riscvLe!.signatures[0]!.hits += 1;
    else if (
      (insn & 0xf00fffff) >>> 0 === 0xf0010113 &&
      ((insn >>> 20) & 0xf) === 0
    )
      p.riscvLe!.signatures[1]!.hits += 1;
    else if (
      (insn & 0x01fff07f) >>> 0 === 0x00112023 ||
      (insn & 0x01fff07f) >>> 0 === 0x00113023
    )
      p.riscvLe!.signatures[2]!.hits += 1;
  }
};

const scoreByteAlignedX86 = (
  bytes: Buffer,
  offset: number,
  limit: number,
  p: Record<string, ProfileAccumulator>,
): void => {
  const b0 = bytes[offset]!;
  if (b0 === 0x55 && offset + 3 <= limit) {
    const b1 = bytes[offset + 1]!;
    const b2 = bytes[offset + 2]!;
    if (b1 === 0x89 && b2 === 0xe5) p.x86!.signatures[0]!.hits += 1;
    else if (
      b1 === 0x48 &&
      b2 === 0x89 &&
      offset + 4 <= limit &&
      bytes[offset + 3] === 0xe5
    )
      p.x86_64!.signatures[0]!.hits += 1;
  } else if (b0 === 0xc9 && offset + 2 <= limit && bytes[offset + 1] === 0xc3) {
    p.x86!.signatures[1]!.hits += 1;
  } else if (b0 === 0x5d && offset + 2 <= limit && bytes[offset + 1] === 0xc3) {
    p.x86_64!.signatures[2]!.hits += 1;
  } else if (
    b0 === 0xf3 &&
    offset + 4 <= limit &&
    bytes[offset + 1] === 0x0f &&
    bytes[offset + 2] === 0x1e &&
    bytes[offset + 3] === 0xfa
  ) {
    p.x86_64!.signatures[1]!.hits += 1;
  }
};

const meetsCensusThreshold = (
  acc: ProfileAccumulator,
  totalHits: number,
  distinctMatched: number,
  examinedBytes: number,
): boolean => {
  if (distinctMatched < 2) return false;
  const sites = Math.floor(examinedBytes / acc.alignment);
  const expectedUniformHits = sites * acc.randomProbPerSite;
  const minHits = Math.max(
    4,
    Math.ceil(expectedUniformHits + 6 * Math.sqrt(expectedUniformHits) + 3),
  );
  return totalHits >= minHits;
};

export interface InstructionCensusOutcome {
  readonly examined_bytes: number;
  readonly leader: InstructionCensusProfile | null;
  readonly runner_up: InstructionCensusProfile | null;
  readonly margin_hits: number | null;
  readonly profiles: readonly InstructionCensusProfile[];
}

const projectCensusProfiles = (
  accumulators: Record<string, ProfileAccumulator>,
  limit: number,
): InstructionCensusProfile[] => {
  const kib = Math.max(limit / 1024, 1 / 1024);
  return Object.values(accumulators)
    .map((acc) => {
      const totalHits = acc.signatures.reduce((sum, s) => sum + s.hits, 0);
      const distinctMatched = acc.signatures.filter((s) => s.hits > 0).length;
      const density =
        limit === 0 ? 0 : Math.round((totalHits / kib) * 1000) / 1000;
      return {
        profile_id: acc.profileId,
        cpu_family: acc.cpuFamily,
        isa_mode: acc.isaMode,
        word_size: acc.wordSize,
        byte_order: acc.byteOrder,
        alignment: acc.alignment,
        total_hits: totalHits,
        distinct_signatures_matched: distinctMatched,
        density_per_kib: density,
        meets_threshold: meetsCensusThreshold(
          acc,
          totalHits,
          distinctMatched,
          limit,
        ),
        signatures: acc.signatures.map((s) => ({ ...s })),
      };
    })
    .sort((a, b) => {
      if (a.meets_threshold !== b.meets_threshold) {
        return a.meets_threshold ? -1 : 1;
      }
      if (b.total_hits !== a.total_hits) return b.total_hits - a.total_hits;
      return a.profile_id < b.profile_id ? -1 : 1;
    });
};

/** Cooperative instruction prologue/return signature census over `bytes[0..limit)`. */
export const runInstructionSignatureCensus = async (
  bytes: Buffer,
  limit: number,
  checkActive?: () => void,
): Promise<InstructionCensusOutcome> => {
  const accumulators = createProfiles();
  // not-an-allowance: cooperative event-loop yield cursor
  let nextYield = YIELD_BYTES;

  for (let offset = 0; offset < limit; offset += 1) {
    if (offset >= nextYield) {
      checkActive?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      checkActive?.();
      nextYield += YIELD_BYTES;
    }
    scoreByteAlignedX86(bytes, offset, limit, accumulators);
    if ((offset & 1) === 0 && offset + 2 <= limit) {
      scoreHalfwordAligned(bytes, offset, limit, accumulators);
    }
    if ((offset & 3) === 0 && offset + 4 <= limit) {
      scoreWord32Le(readUint32At(bytes, offset, true), accumulators);
      scoreWord32Be(readUint32At(bytes, offset, false), accumulators);
    }
  }

  const profiles = projectCensusProfiles(accumulators, limit);
  const qualified = profiles.filter((p) => p.meets_threshold);
  const leader = qualified[0] ?? null;
  const runnerUp = leader === null ? null : (qualified[1] ?? null);
  const marginHits =
    leader === null ? null : leader.total_hits - (runnerUp?.total_hits ?? 0);

  return {
    examined_bytes: limit,
    leader,
    runner_up: runnerUp,
    margin_hits: marginHits,
    profiles,
  };
};
