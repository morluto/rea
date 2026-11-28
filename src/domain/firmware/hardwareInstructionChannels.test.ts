import { describe, expect, it } from "vitest";
import { hardwareInstructionChannelsResultSchema } from "./hardwareInstructionChannels.js";
import { analyzeProcedureHardwareInstructions } from "./hardwareInstructionClassifiers.js";

const procId = (name: string, address: string) => ({
  name,
  address,
  classification: null,
  body: { available: false as const, reason: "fixture" },
});

describe("analyzeProcedureHardwareInstructions ARM, AArch64, and RISC-V", () => {
  it("classifies ARM Cortex-M and CP15 system registers, interrupt masks, barriers, and sleep instructions", () => {
    const res = analyzeProcedureHardwareInstructions({
      procedure: procId("Reset_Handler", "0x08000100"),
      architecture: "arm",
      instructions: [
        "0x08000100: cpsid i",
        "0x08000102: mrs r0, primask",
        "0x08000106: msr msp_ns, r1",
        "0x0800010a: mcr p15, #0, r0, c12, c0, #0",
        "0x0800010e: dsb.w sy",
        "0x08000112: isb",
        "0x08000116: wfi",
        "0x08000118: bx lr",
      ],
    });
    expect(hardwareInstructionChannelsResultSchema.safeParse(res).success).toBe(
      true,
    );
    expect(res.matched_instruction_count).toBe(7);
    expect(res.channels[0]).toMatchObject({
      instruction_address: "0x08000100",
      mnemonic: "cpsid",
      category: "interrupt_mask",
      direction: "write",
      target: "CPS:I",
    });
    expect(res.channels[1]).toMatchObject({
      mnemonic: "mrs",
      category: "system_register",
      direction: "read",
      target: "PRIMASK",
    });
    expect(res.channels[2]).toMatchObject({
      mnemonic: "msr",
      direction: "write",
      target: "MSP_NS",
      target_description: "Main Stack Pointer (Non-secure)",
    });
    expect(res.channels[3]).toMatchObject({
      mnemonic: "mcr",
      category: "coprocessor",
      direction: "write",
      target: "P15:0,c12,c0,0",
      target_description: "Vector Base Address Register (VBAR)",
    });
  });

  it("classifies conditional A32/T32 hardware instructions while retaining original mnemonics", () => {
    const condArm = analyzeProcedureHardwareInstructions({
      procedure: procId("cond_sys_init", "0x8000"),
      architecture: "arm",
      instructions: [
        "0x8000: mrcne p15, #0, r0, c12, c0, #0",
        "0x8004: mcrgt p15, #0, r0, c1, c0, #0",
        "0x8008: mrsne r0, cpsr",
        "0x800c: msreq cpsr_c, r1",
        "0x8010: cpsie.w i",
        "0x8014: wfene",
        "0x8018: wfine",
        "0x801c: sevne",
        "0x8020: svcne #0",
        "0x8024: addeq r0, r0, #1",
        "0x8028: moveq r1, r2",
        "0x802c: ldrne r3, [r0]",
        "0x8030: bne 0x8000",
      ],
    });
    expect(
      hardwareInstructionChannelsResultSchema.safeParse(condArm).success,
    ).toBe(true);
    expect(condArm.matched_instruction_count).toBe(9);
    expect(condArm.channels[0]).toMatchObject({
      mnemonic: "mrcne",
      category: "coprocessor",
      direction: "read",
      target: "P15:0,c12,c0,0",
      target_description: "Vector Base Address Register (VBAR)",
    });
    expect(condArm.channels[1]).toMatchObject({
      mnemonic: "mcrgt",
      category: "coprocessor",
      direction: "write",
      target: "P15:0,c1,c0,0",
      target_description: "System Control Register (SCTLR)",
    });
    expect(condArm.channels[2]).toMatchObject({
      mnemonic: "mrsne",
      category: "system_register",
      direction: "read",
      target: "CPSR",
    });
    expect(condArm.channels[3]).toMatchObject({
      mnemonic: "msreq",
      category: "system_register",
      direction: "write",
      target: "CPSR_C",
      target_description: "Current Program Status Register (CPSR_C)",
    });
    expect(condArm.channels[4]).toMatchObject({
      mnemonic: "cpsie.w",
      category: "interrupt_mask",
      direction: "write",
      target: "CPS:I",
    });
    expect(condArm.channels.slice(5).map((c) => c.mnemonic)).toEqual([
      "wfene",
      "wfine",
      "sevne",
      "svcne",
    ]);
  });

  it("classifies AArch64 EL system registers and DC/IC/AT/TLBI maintenance without stripping hex-like mnemonics", () => {
    const arm64 = analyzeProcedureHardwareInstructions({
      procedure: procId("el3_init", "0x4000"),
      architecture: "arm64",
      instructions: [
        "0x4000 mrs x0, CurrentEL",
        "0x4004 msr vbar_el1, x1",
        "0x4008 msr s3_0_c15_c2_0, x2",
        "0x400c: dc civac, x0",
        "0x4010: dc zva, x1",
        "0x4014: ic iallu",
        "0x4018: at s1e1r, x0",
        "0x401c: tlbi vmalle1",
        "0x4020 eret",
      ],
    });
    expect(
      hardwareInstructionChannelsResultSchema.safeParse(arm64).success,
    ).toBe(true);
    expect(arm64.matched_instruction_count).toBe(9);
    expect(arm64.channels[1]).toMatchObject({
      target: "VBAR_EL1",
      direction: "write",
      target_basis: "architecture_manual",
    });
    expect(arm64.channels[2]).toMatchObject({
      target: "S3_0_C15_C2_0",
      target_basis: "numeric_encoding",
    });
    expect(arm64.channels[3]).toMatchObject({
      instruction_address: "0x400c",
      mnemonic: "dc",
      category: "cache_or_tlb",
      direction: "control",
      target: "CIVAC",
      target_basis: "architecture_manual",
    });
    expect(arm64.channels[4]).toMatchObject({
      mnemonic: "dc",
      category: "cache_or_tlb",
      target: "ZVA",
    });
    expect(arm64.channels[5]).toMatchObject({
      mnemonic: "ic",
      category: "cache_or_tlb",
      target: "IALLU",
    });
    expect(arm64.channels[6]).toMatchObject({
      mnemonic: "at",
      category: "cache_or_tlb",
      target: "S1E1R",
    });
    expect(arm64.channels[7]).toMatchObject({
      mnemonic: "tlbi",
      category: "cache_or_tlb",
      target: "VMALLE1",
    });
  });

  it("classifies RISC-V CSR pseudo and explicit operations, keeping zero-source set/clear forms as reads", () => {
    const rv = analyzeProcedureHardwareInstructions({
      procedure: procId("trap_init", "0x80000000"),
      architecture: "riscv",
      instructions: [
        "0x80000000: csrrw x0, mtvec, a0",
        "0x80000004: csrrs a1, mcause, x0",
        "0x80000008: csrsi mstatus, 8",
        "0x8000000c: csrsi mstatus, 0",
        "0x80000010: csrci mstatus, 0x0",
        "0x80000014: csrs mstatus, zero",
        "0x80000018: csrc mie, x0",
        "0x8000001c: csrs mie, a0",
        "0x80000020: csrw pmpcfg0, zero",
        "0x80000024: sfence.vma",
        "0x80000028: mret",
      ],
    });
    expect(hardwareInstructionChannelsResultSchema.safeParse(rv).success).toBe(
      true,
    );
    expect(rv.matched_instruction_count).toBe(11);
    expect(rv.channels[0]).toMatchObject({
      category: "csr",
      direction: "write",
      target: "mtvec",
    });
    expect(rv.channels[1]).toMatchObject({
      category: "csr",
      direction: "read",
      target: "mcause",
    });
    expect(rv.channels[2]).toMatchObject({
      mnemonic: "csrsi",
      direction: "read_modify_write",
      target: "mstatus",
    });
    expect(rv.channels[3]).toMatchObject({
      mnemonic: "csrsi",
      direction: "read",
      target: "mstatus",
    });
    expect(rv.channels[4]).toMatchObject({
      mnemonic: "csrci",
      direction: "read",
      target: "mstatus",
    });
    expect(rv.channels[5]).toMatchObject({
      mnemonic: "csrs",
      direction: "read",
      target: "mstatus",
    });
    expect(rv.channels[6]).toMatchObject({
      mnemonic: "csrc",
      direction: "read",
      target: "mie",
    });
    expect(rv.channels[7]).toMatchObject({
      mnemonic: "csrs",
      direction: "read_modify_write",
      target: "mie",
    });
    expect(rv.channels[8]).toMatchObject({
      mnemonic: "csrw",
      direction: "write",
      target: "pmpcfg0",
    });
  });
});

describe("analyzeProcedureHardwareInstructions Xtensa, MIPS, x86, address spaces, and controls", () => {
  it("classifies Xtensa special registers, MIPS CP0, and x86 encodable imm8 vs DX-selected port I/O", () => {
    const xtensa = analyzeProcedureHardwareInstructions({
      procedure: procId("xt_ints_off", "0x40080100"),
      architecture: "xtensa",
      instructions: ["rsil a2, 3", "rsr.ccount a3", "wsr a4, vecbase", "memw"],
    });
    expect(xtensa.matched_instruction_count).toBe(4);
    expect(xtensa.channels[1]).toMatchObject({
      category: "special_register",
      direction: "read",
      target: "CCOUNT",
    });
    expect(xtensa.channels[2]).toMatchObject({
      direction: "write",
      target: "VECBASE",
    });

    const mips = analyzeProcedureHardwareInstructions({
      procedure: procId("mips_exc", "0xbfc00380"),
      architecture: "mips",
      instructions: ["di", "mfc0 $k0, $13", "mtc0 $k0, $12, 0", "eret"],
    });
    expect(mips.matched_instruction_count).toBe(4);
    expect(mips.channels[1]).toMatchObject({
      category: "coprocessor",
      direction: "read",
      target: "CP0:$13",
    });

    const x86 = analyzeProcedureHardwareInstructions({
      procedure: procId("early_io_and_pci", "0xfff00100"),
      architecture: "x86_64",
      instructions: [
        "0xfff00100: cli",
        "0xfff00101: out 0x70, al",
        "0xfff00103: in al, 0x60",
        "0xfff00105: out 80h, al",
        "0xfff00107: in al, 0EDh",
        "0xfff00109: outb %al, $0x80",
        "0xfff0010b: out #0x80, al",
        "0xfff0010d: out 128, al",
        "0xfff0010f: mov dx, 0xcf8",
        "0xfff00113: out dx, eax",
        "0xfff00114: mov dx, 0xcfc",
        "0xfff00118: in eax, dx",
        "0xfff00119: rdmsr",
        "0xfff0011b: mov cr3, rax",
        "0xfff0011e: movq %cr0, %rbx",
        "0xfff00121: out PORT_DIAG, al",
      ],
    });
    expect(hardwareInstructionChannelsResultSchema.safeParse(x86).success).toBe(
      true,
    );
    expect(x86.matched_instruction_count).toBe(14);
    expect(x86.channels[1]).toMatchObject({
      category: "port_io",
      direction: "write",
      target: "0x70",
      target_description: "CMOS RAM / RTC Index (NMI Mask)",
      target_basis: "architecture_manual",
    });
    expect(x86.channels[2]).toMatchObject({
      category: "port_io",
      direction: "read",
      target: "0x60",
      target_description: "8042 KBC / Embedded Controller Data",
      target_basis: "architecture_manual",
    });
    expect(x86.channels[3]).toMatchObject({
      category: "port_io",
      direction: "write",
      target: "0x80",
      target_description: "BIOS POST Diagnostic Code Port",
      target_basis: "architecture_manual",
    });
    expect(x86.channels[4]).toMatchObject({
      category: "port_io",
      direction: "read",
      target: "0xed",
      target_description: null,
      target_basis: "immediate_constant",
    });
    expect(x86.channels[5]).toMatchObject({
      target: "0x80",
      target_basis: "architecture_manual",
    });
    expect(x86.channels[6]).toMatchObject({
      target: "0x80",
      target_basis: "architecture_manual",
    });
    expect(x86.channels[7]).toMatchObject({
      target: "0x80",
      target_basis: "architecture_manual",
    });
    expect(x86.channels[8]).toMatchObject({
      raw_instruction: "0xfff00113: out dx, eax",
      category: "port_io",
      direction: "write",
      target: null,
      target_basis: "unresolved_register",
    });
    expect(x86.channels[9]).toMatchObject({
      raw_instruction: "0xfff00118: in eax, dx",
      category: "port_io",
      direction: "read",
      target: null,
      target_basis: "unresolved_register",
    });
    expect(x86.channels[11]).toMatchObject({
      category: "system_register",
      direction: "write",
      target: "CR3",
    });
    expect(x86.channels[12]).toMatchObject({
      category: "system_register",
      direction: "read",
      target: "CR0",
    });
    expect(x86.channels[13]).toMatchObject({
      raw_instruction: "0xfff00121: out PORT_DIAG, al",
      category: "port_io",
      direction: "write",
      target: null,
      target_basis: "unresolved_operand",
    });
    // Only out dx, in dx, and rdmsr are register-selected; symbolic PORT_DIAG is unresolved_operand.
    expect(x86.summary.unresolved_dynamic_count).toBe(3);
    expect(
      x86.limitations.some((l) => l.includes("general-purpose register")),
    ).toBe(true);
    expect(
      x86.limitations.some((l) =>
        l.includes("symbolic or unparsed target operands"),
      ),
    ).toBe(true);
  });

  it("preserves space-qualified and percent-escaped native instruction addresses", () => {
    const romX86 = analyzeProcedureHardwareInstructions({
      procedure: procId("rom_entry", "rom:0x1000"),
      architecture: "x86",
      instructions: ["rom:0x1000: cli", "rom:0x1001: hlt"],
    });
    expect(
      hardwareInstructionChannelsResultSchema.safeParse(romX86).success,
    ).toBe(true);
    expect(romX86.channels.map((c) => c.instruction_address)).toEqual([
      "rom:0x1000",
      "rom:0x1001",
    ]);

    const overlayArm = analyzeProcedureHardwareInstructions({
      procedure: procId("overlay_sleep", "overlay%3Aspace:0x1000"),
      architecture: "arm",
      instructions: [
        "overlay%3Aspace:0x1000: wfi",
        "overlay%3aspace:0x1004: isb",
      ],
    });
    expect(
      hardwareInstructionChannelsResultSchema.safeParse(overlayArm).success,
    ).toBe(true);
    expect(overlayArm.channels.map((c) => c.instruction_address)).toEqual([
      "overlay%3Aspace:0x1000",
      "overlay%3Aspace:0x1004",
    ]);
  });

  it("returns zero channels for pure ALU and memory load/store instructions", () => {
    const pureAlu = analyzeProcedureHardwareInstructions({
      procedure: procId("memcpy_words", "0x1000"),
      architecture: "arm",
      instructions: [
        "0x1000: push {r4, lr}",
        "0x1002: ldr r3, [r1], #4",
        "0x1006: str r3, [r0], #4",
        "0x100a: subs r2, r2, #1",
        "0x100c: bne 0x1002",
        "0x100e: pop {r4, pc}",
      ],
    });
    expect(pureAlu.matched_instruction_count).toBe(0);
    expect(pureAlu.channels).toEqual([]);
  });
});
