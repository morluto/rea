import type {
  HardwareChannelCategory,
  HardwareChannelDirection,
  HardwareTargetBasis,
} from "./hardwareInstructionChannels.js";

export interface ClassifiedInstruction {
  readonly mnemonic: string;
  readonly category: HardwareChannelCategory;
  readonly direction: HardwareChannelDirection;
  readonly target: string | null;
  readonly target_description: string | null;
  readonly target_basis: HardwareTargetBasis;
}

const RISCV_CSR_DESCRIPTIONS: Readonly<Record<string, string>> = {
  mstatus: "Machine Status Register",
  misa: "Machine ISA Register",
  medeleg: "Machine Exception Delegation Register",
  mideleg: "Machine Interrupt Delegation Register",
  mie: "Machine Interrupt-Enable Register",
  mtvec: "Machine Trap-Vector Base-Address Register",
  mcounteren: "Machine Counter-Enable Register",
  mscratch: "Machine Scratch Register",
  mepc: "Machine Exception Program Counter",
  mcause: "Machine Trap Cause Register",
  mtval: "Machine Bad Address or Instruction",
  mip: "Machine Interrupt-Pending Register",
  mcycle: "Machine Cycle Counter",
  minstret: "Machine Instructions-Retired Counter",
  mhartid: "Hardware Thread ID",
  sstatus: "Supervisor Status Register",
  sie: "Supervisor Interrupt-Enable Register",
  stvec: "Supervisor Trap-Vector Base-Address Register",
  sscratch: "Supervisor Scratch Register",
  sepc: "Supervisor Exception Program Counter",
  scause: "Supervisor Trap Cause Register",
  stval: "Supervisor Trap Value",
  sip: "Supervisor Interrupt-Pending Register",
  satp: "Supervisor Address Translation and Protection Register",
  fcsr: "Floating-Point Control and Status Register",
};

const describeRiscvCsr = (
  rawCsr: string,
): {
  readonly target: string;
  readonly description: string | null;
  readonly basis: HardwareTargetBasis;
} => {
  const lower = rawCsr.toLowerCase();
  const known = RISCV_CSR_DESCRIPTIONS[lower];
  if (known !== undefined) {
    return { target: lower, description: known, basis: "architecture_manual" };
  }
  if (/^pmpcfg[0-9]+$/u.test(lower)) {
    return {
      target: lower,
      description: "Physical Memory Protection Configuration",
      basis: "architecture_manual",
    };
  }
  if (/^pmpaddr[0-9]+$/u.test(lower)) {
    return {
      target: lower,
      description: "Physical Memory Protection Address",
      basis: "architecture_manual",
    };
  }
  if (/^(?:0x[0-9a-f]+|[0-9]+)$/u.test(lower)) {
    return { target: lower, description: null, basis: "numeric_encoding" };
  }
  return { target: lower, description: null, basis: "architecture_manual" };
};

const isZeroRegister = (operand: string | undefined): boolean =>
  operand !== undefined && /^(?:x0|zero)$/iu.test(operand.trim());

const isZeroImmediate = (operand: string | undefined): boolean =>
  operand !== undefined && /^[#$]?(?:0x0+|0+)$/iu.test(operand.trim());

const RISCV_EXPLICIT_CSR_OPS: ReadonlySet<string> = new Set([
  "csrrw",
  "csrrwi",
  "csrrs",
  "csrrsi",
  "csrrc",
  "csrrci",
]);

const RISCV_PSEUDO_WRITE_SET_OPS: ReadonlySet<string> = new Set([
  "csrw",
  "csrwi",
  "csrs",
  "csrsi",
  "csrc",
  "csrci",
]);

const RISCV_CONTROL_OPS: Readonly<
  Record<
    string,
    {
      readonly category: HardwareChannelCategory;
      readonly description: string;
    }
  >
> = {
  mret: {
    category: "privilege_or_trap",
    description: "Machine-mode Trap Return",
  },
  sret: {
    category: "privilege_or_trap",
    description: "Supervisor-mode Trap Return",
  },
  uret: { category: "privilege_or_trap", description: "User-mode Trap Return" },
  dret: { category: "privilege_or_trap", description: "Debug-mode Return" },
  ecall: { category: "privilege_or_trap", description: "Environment Call" },
  ebreak: {
    category: "privilege_or_trap",
    description: "Environment Breakpoint",
  },
  "c.ebreak": {
    category: "privilege_or_trap",
    description: "Compressed Environment Breakpoint",
  },
  wfi: { category: "power_or_wait", description: "Wait for Interrupt" },
  fence: { category: "memory_barrier", description: "Memory Ordering Fence" },
  "fence.i": {
    category: "cache_or_tlb",
    description: "Instruction-Stream Synchronization Fence",
  },
  "sfence.vma": {
    category: "cache_or_tlb",
    description: "Supervisor Virtual-Memory Fence",
  },
};

export const classifyRiscvInstruction = (
  mnemonic: string,
  operands: readonly string[],
): ClassifiedInstruction | null => {
  const fixed = RISCV_CONTROL_OPS[mnemonic];
  if (fixed !== undefined) {
    return {
      mnemonic,
      category: fixed.category,
      direction: "control",
      target: null,
      target_description: fixed.description,
      target_basis: "not_applicable",
    };
  }

  if (RISCV_EXPLICIT_CSR_OPS.has(mnemonic) && operands.length >= 3) {
    const csr = describeRiscvCsr(operands[1]!);
    const isWriteSwap = mnemonic.startsWith("csrrw");
    const isImmediate = mnemonic.endsWith("i");
    let direction: HardwareChannelDirection = "read_modify_write";
    if (isWriteSwap && isZeroRegister(operands[0])) direction = "write";
    else if (
      !isWriteSwap &&
      (isImmediate ? isZeroImmediate(operands[2]) : isZeroRegister(operands[2]))
    ) {
      direction = "read";
    }
    return {
      mnemonic,
      category: "csr",
      direction,
      target: csr.target,
      target_description: csr.description,
      target_basis: csr.basis,
    };
  }

  if (mnemonic === "csrr" && operands[1] !== undefined) {
    const csr = describeRiscvCsr(operands[1]);
    return {
      mnemonic,
      category: "csr",
      direction: "read",
      target: csr.target,
      target_description: csr.description,
      target_basis: csr.basis,
    };
  }

  if (RISCV_PSEUDO_WRITE_SET_OPS.has(mnemonic) && operands.length >= 2) {
    const csr = describeRiscvCsr(operands[0]!);
    let direction: HardwareChannelDirection = "read_modify_write";
    if (mnemonic.startsWith("csrw")) {
      direction = "write";
    } else {
      const zeroSource = mnemonic.endsWith("i")
        ? isZeroImmediate(operands[1])
        : isZeroRegister(operands[1]);
      if (zeroSource) direction = "read";
    }
    return {
      mnemonic,
      category: "csr",
      direction,
      target: csr.target,
      target_description: csr.description,
      target_basis: csr.basis,
    };
  }

  return null;
};
