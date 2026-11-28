import type {
  HardwareChannelCategory,
  HardwareChannelDirection,
  HardwareTargetBasis,
} from "./hardwareInstructionChannels.js";
import type { ClassifiedInstruction } from "./hardwareInstructionRiscv.js";

/**
 * Architectural 8-bit x86 I/O ports reachable through immediate `IN`/`OUT`
 * (`imm8`, `0x00..0xff`). 16-bit ports above `0xff` (such as `0x3f8` UART or
 * `0xcf8`/`0xcfc` PCI configuration space) must be selected through `DX`.
 */
const X86_KNOWN_IMM8_PORTS: Readonly<Record<number, string>> = {
  0x20: "8259A Master PIC Command",
  0x21: "8259A Master PIC Data / IMR",
  0x40: "8254 PIT Channel 0",
  0x43: "8254 PIT Mode/Command",
  0x60: "8042 KBC / Embedded Controller Data",
  0x61: "PC Speaker / NMI Status and Control",
  0x64: "8042 KBC / Embedded Controller Command-Status",
  0x70: "CMOS RAM / RTC Index (NMI Mask)",
  0x71: "CMOS RAM / RTC Data",
  0x80: "BIOS POST Diagnostic Code Port",
  0x92: "System Control Port A (Fast A20 / Init)",
  0xa0: "8259A Slave PIC Command",
  0xa1: "8259A Slave PIC Data / IMR",
  0xb2: "APM / SMI Command Port (APM_CNT)",
  0xb3: "APM / SMI Status Port (APM_STS)",
};

const parseImmediatePortValue = (token: string): number | null => {
  const literal = token.replace(/^[$#]\s*/u, "");
  const hexPrefix = /^0x([0-9a-f]+)$/iu.exec(literal);
  if (hexPrefix !== null) return Number.parseInt(hexPrefix[1]!, 16);
  const hexSuffix = /^([0-9][0-9a-f]*)h$/iu.exec(literal);
  if (hexSuffix !== null) return Number.parseInt(hexSuffix[1]!, 16);
  if (/^[0-9]+$/u.test(literal)) return Number.parseInt(literal, 10);
  return null;
};

const parseX86PortOperand = (
  raw: string,
): {
  readonly target: string | null;
  readonly description: string | null;
  readonly basis: HardwareTargetBasis;
} => {
  const trimmed = raw.trim();
  if (/^(?:\(\s*%?dx\s*\)|%?dx)$/iu.test(trimmed)) {
    return {
      target: null,
      description: "Dynamic 16-bit I/O port in DX",
      basis: "unresolved_register",
    };
  }
  const num = parseImmediatePortValue(trimmed);
  if (num !== null && Number.isSafeInteger(num) && num >= 0 && num <= 0xff) {
    const hex = `0x${num.toString(16)}`;
    const known = X86_KNOWN_IMM8_PORTS[num] ?? null;
    return {
      target: hex,
      description: known,
      basis: known !== null ? "architecture_manual" : "immediate_constant",
    };
  }
  return { target: null, description: null, basis: "unresolved_operand" };
};

const X86_SIMPLE_OPS: Readonly<
  Record<
    string,
    {
      readonly category: HardwareChannelCategory;
      readonly direction: HardwareChannelDirection;
      readonly target: string | null;
      readonly description: string;
      readonly basis: HardwareTargetBasis;
    }
  >
> = {
  cli: {
    category: "interrupt_mask",
    direction: "write",
    target: "IF",
    description: "Clear Interrupt Flag (disable maskable interrupts)",
    basis: "architecture_manual",
  },
  sti: {
    category: "interrupt_mask",
    direction: "write",
    target: "IF",
    description: "Set Interrupt Flag (enable maskable interrupts)",
    basis: "architecture_manual",
  },
  rdmsr: {
    category: "system_register",
    direction: "read",
    target: null,
    description: "Read Model-Specific Register indexed by ECX",
    basis: "unresolved_register",
  },
  wrmsr: {
    category: "system_register",
    direction: "write",
    target: null,
    description: "Write Model-Specific Register indexed by ECX",
    basis: "unresolved_register",
  },
  rdtsc: {
    category: "system_register",
    direction: "read",
    target: "TSC",
    description: "Read Time-Stamp Counter",
    basis: "architecture_manual",
  },
  rdtscp: {
    category: "system_register",
    direction: "read",
    target: "TSC",
    description: "Read Time-Stamp Counter and Processor ID",
    basis: "architecture_manual",
  },
  xgetbv: {
    category: "system_register",
    direction: "read",
    target: "XCR",
    description: "Read Extended Control Register indexed by ECX",
    basis: "unresolved_register",
  },
  xsetbv: {
    category: "system_register",
    direction: "write",
    target: "XCR",
    description: "Write Extended Control Register indexed by ECX",
    basis: "unresolved_register",
  },
  cpuid: {
    category: "privilege_or_trap",
    direction: "read",
    target: "CPUID",
    description: "CPU Identification leaf query",
    basis: "architecture_manual",
  },
  wbinvd: {
    category: "cache_or_tlb",
    direction: "control",
    target: null,
    description: "Write Back and Invalidate Cache",
    basis: "not_applicable",
  },
  invd: {
    category: "cache_or_tlb",
    direction: "control",
    target: null,
    description: "Invalidate Internal Caches",
    basis: "not_applicable",
  },
  invlpg: {
    category: "cache_or_tlb",
    direction: "control",
    target: null,
    description: "Invalidate TLB Entry",
    basis: "not_applicable",
  },
  mfence: {
    category: "memory_barrier",
    direction: "control",
    target: null,
    description: "Memory Fence",
    basis: "not_applicable",
  },
  lfence: {
    category: "memory_barrier",
    direction: "control",
    target: null,
    description: "Load Fence",
    basis: "not_applicable",
  },
  sfence: {
    category: "memory_barrier",
    direction: "control",
    target: null,
    description: "Store Fence",
    basis: "not_applicable",
  },
  hlt: {
    category: "power_or_wait",
    direction: "control",
    target: null,
    description: "Halt until next external interrupt",
    basis: "not_applicable",
  },
  rsm: {
    category: "privilege_or_trap",
    direction: "control",
    target: "SMM",
    description: "Resume from System Management Mode",
    basis: "architecture_manual",
  },
  syscall: {
    category: "privilege_or_trap",
    direction: "control",
    target: null,
    description: "Fast System Call",
    basis: "not_applicable",
  },
  sysret: {
    category: "privilege_or_trap",
    direction: "control",
    target: null,
    description: "Return from Fast System Call",
    basis: "not_applicable",
  },
  iret: {
    category: "privilege_or_trap",
    direction: "control",
    target: null,
    description: "Interrupt Return",
    basis: "not_applicable",
  },
  iretd: {
    category: "privilege_or_trap",
    direction: "control",
    target: null,
    description: "Interrupt Return (32-bit)",
    basis: "not_applicable",
  },
  iretq: {
    category: "privilege_or_trap",
    direction: "control",
    target: null,
    description: "Interrupt Return (64-bit)",
    basis: "not_applicable",
  },
  vmcall: {
    category: "privilege_or_trap",
    direction: "control",
    target: null,
    description: "Call to VM Monitor (Hypercall)",
    basis: "not_applicable",
  },
};

const classifyX86ControlRegMove = (
  mnemonic: string,
  operands: readonly string[],
): ClassifiedInstruction | null => {
  if (!/^mov[lq]?$/u.test(mnemonic) || operands.length < 2) return null;
  const op0 = operands[0]!.replace(/^%/u, "").toLowerCase();
  const op1 = operands[1]!.replace(/^%/u, "").toLowerCase();
  const isAtt = operands[0]!.startsWith("%") || operands[1]!.startsWith("%");
  const regPattern = /^(?:cr[02348]|dr[0-7])$/u;
  if (regPattern.test(op0)) {
    return {
      mnemonic,
      category: "system_register",
      direction: isAtt ? "read" : "write",
      target: op0.toUpperCase(),
      target_description: op0.startsWith("cr")
        ? `x86 Control Register ${op0.toUpperCase()}`
        : `x86 Debug Register ${op0.toUpperCase()}`,
      target_basis: "architecture_manual",
    };
  }
  if (regPattern.test(op1)) {
    return {
      mnemonic,
      category: "system_register",
      direction: isAtt ? "write" : "read",
      target: op1.toUpperCase(),
      target_description: op1.startsWith("cr")
        ? `x86 Control Register ${op1.toUpperCase()}`
        : `x86 Debug Register ${op1.toUpperCase()}`,
      target_basis: "architecture_manual",
    };
  }
  return null;
};

const classifyX86PortIo = (
  mnemonic: string,
  operands: readonly string[],
): ClassifiedInstruction | null => {
  if (/^(?:in|in[bwl])$/u.test(mnemonic) && operands.length >= 2) {
    const isAtt =
      operands[0]!.startsWith("$") ||
      operands[0]!.startsWith("(") ||
      operands[1]!.startsWith("%");
    const port = parseX86PortOperand(isAtt ? operands[0]! : operands[1]!);
    return {
      mnemonic,
      category: "port_io",
      direction: "read",
      target: port.target,
      target_description: port.description,
      target_basis: port.basis,
    };
  }
  if (/^(?:out|out[bwl])$/u.test(mnemonic) && operands.length >= 2) {
    const isAtt =
      operands[1]!.startsWith("$") ||
      operands[1]!.startsWith("(") ||
      operands[0]!.startsWith("%");
    const port = parseX86PortOperand(isAtt ? operands[1]! : operands[0]!);
    return {
      mnemonic,
      category: "port_io",
      direction: "write",
      target: port.target,
      target_description: port.description,
      target_basis: port.basis,
    };
  }
  if (/^(?:ins|outs)[bwdl]?$/u.test(mnemonic)) {
    return {
      mnemonic,
      category: "port_io",
      direction: mnemonic.startsWith("ins") ? "read" : "write",
      target: null,
      target_description: "String I/O port indexed by DX",
      target_basis: "unresolved_register",
    };
  }
  return null;
};

export const classifyX86Instruction = (
  mnemonic: string,
  operands: readonly string[],
): ClassifiedInstruction | null => {
  const simple = X86_SIMPLE_OPS[mnemonic];
  if (simple !== undefined) {
    return {
      mnemonic,
      category: simple.category,
      direction: simple.direction,
      target: simple.target,
      target_description: simple.description,
      target_basis: simple.basis,
    };
  }

  const crMove = classifyX86ControlRegMove(mnemonic, operands);
  if (crMove !== null) return crMove;

  const portIo = classifyX86PortIo(mnemonic, operands);
  if (portIo !== null) return portIo;

  if (/^(?:lgdt|lidt|sgdt|sidt|ltr|lldt)$/u.test(mnemonic)) {
    const table = mnemonic.slice(1).toUpperCase();
    return {
      mnemonic,
      category: "system_register",
      direction: mnemonic.startsWith("l") ? "write" : "read",
      target: table,
      target_description: `Descriptor Table Register (${table})`,
      target_basis: "architecture_manual",
    };
  }

  return null;
};
