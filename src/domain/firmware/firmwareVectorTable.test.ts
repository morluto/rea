import { describe, expect, it } from "vitest";
import { parseSvdInterruptMap } from "./firmwareSvdInterrupts.js";
import { firmwareVectorTableSchema } from "./firmwareVectorTable.js";
import { parseFirmwareVectorTable } from "./firmwareVectorTableParser.js";

const SAMPLE_SVD = `<?xml version="1.0" encoding="utf-8"?>
<device>
  <name>STM32F405</name>
  <peripherals>
    <peripheral>
      <name>TIM2</name>
      <interrupt><name>TIM2_IRQ</name><value>28</value></interrupt>
    </peripheral>
    <peripheral>
      <name>CAN1</name>
      <interrupt><name>CAN1_SCE</name><value>22</value></interrupt>
    </peripheral>
    <peripheral>
      <name>USB_LP</name>
      <interrupt><name>USB_LP_CAN1_RX0</name><value>20</value></interrupt>
    </peripheral>
    <peripheral>
      <name>CAN1_DUP</name>
      <interrupt><name>CAN1_RX0_ALIAS</name><value>20</value></interrupt>
    </peripheral>
  </peripherals>
</device>`;

describe("parseFirmwareVectorTable ARM M-profile", () => {
  it("decodes ARMv8-M exceptions, Thumb bit-0 violations, shared stubs, and CMSIS-SVD IRQs", () => {
    const svd = parseSvdInterruptMap(SAMPLE_SVD);
    expect(svd.ok).toBe(true);
    if (!svd.ok) return;

    // 48 slots = 16 system + 32 external IRQs (IRQ 0..31)
    const buf = Buffer.alloc(48 * 4, 0);
    buf.writeUInt32LE(0x20020000, 0); // InitialSP
    buf.writeUInt32LE(0x08000201, 4); // Reset (Thumb)
    buf.writeUInt32LE(0x08000301, 8); // NMI -> Default_Handler
    buf.writeUInt32LE(0x08000301, 12); // HardFault -> Default_Handler
    buf.writeUInt32LE(0x08000401, 28); // Slot 7 = SecureFault on armv8-m
    buf.writeUInt32LE(0xdeadbeef, 32); // Slot 8 = Reserved non-zero anomaly
    buf.writeUInt32LE(0x08000500, 15 * 4); // SysTick even address (Thumb bit 0 clear!)
    buf.writeUInt32LE(0x08000601, (16 + 28) * 4); // IRQ 28 -> TIM2_IRQ
    buf.writeUInt32LE(0x08000701, (16 + 20) * 4); // IRQ 20 -> ambiguous in SVD
    buf.writeUInt32LE(0x08000301, (16 + 5) * 4); // IRQ 5 -> unmapped, shares Default_Handler

    const parsed = parseFirmwareVectorTable({
      artifact: {
        path: "/tmp/fw.bin",
        sha256: "a".repeat(64),
        bytes: buf.length,
      },
      architecture: "armv8-m",
      baseAddressHex: "0x08000000",
      vectorTableOffset: 0,
      maxEntries: 64,
      tableBytes: buf,
      svdSupplied: true,
      svdMap: svd.value,
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const report = parsed.value;
    expect(firmwareVectorTableSchema.safeParse(report).success).toBe(true);
    expect(report.initial_stack_pointer).toBe("0x20020000");
    expect(report.reset_code_address).toBe("0x8000200");
    expect(report.trap_entry_address).toBeNull();
    expect(report.vtor_aligned).toBe(true);

    // Slot 7 on armv8-m is SecureFault
    expect(report.arm_entries[7]).toMatchObject({
      kind: "system_exception",
      name: "SecureFault",
      name_basis: "architecture_manual",
      target_code_address: "0x8000400",
      status: "active",
    });
    // Slot 8 non-zero reserved
    expect(report.arm_entries[8]?.status).toBe("nonzero_reserved");
    // Slot 15 SysTick missing Thumb bit 0
    expect(report.arm_entries[15]).toMatchObject({
      name: "SysTick",
      thumb_bit_set: false,
      status: "invalid_even_thumb_address",
    });
    // IRQ 28 mapped from SVD
    expect(report.arm_entries[16 + 28]).toMatchObject({
      kind: "external_irq",
      irq_number: 28,
      name: "TIM2_IRQ",
      name_basis: "explicit_profile",
      peripheral_name: "TIM2",
      target_code_address: "0x8000600",
    });
    // IRQ 20 ambiguous in SVD -> name stays null, candidates preserved
    expect(report.arm_entries[16 + 20]).toMatchObject({
      irq_number: 20,
      name: null,
      name_basis: "observed_slot",
      ambiguous_profile_names: [
        "USB_LP:USB_LP_CAN1_RX0",
        "CAN1_DUP:CAN1_RX0_ALIAS",
      ],
    });
    expect(report.shared_handler_groups[0]).toEqual({
      target_code_address: "0x8000300",
      slot_count: 3,
      slot_indices: [2, 3, 21],
      likely_default_stub: true,
    });
    expect(report.svd_interrupts).toEqual({
      supplied: true,
      mapped_irq_count: 1,
      ambiguous_irq_count: 1,
      unmapped_active_irq_count: 1,
    });
  });

  it("treats slots 4, 5, 6, and 12 as architecturally reserved on armv6-m", () => {
    const buf = Buffer.alloc(16 * 4, 0);
    buf.writeUInt32LE(0x20004000, 0); // InitialSP
    buf.writeUInt32LE(0x08000101, 1 * 4); // Reset
    buf.writeUInt32LE(0x08000201, 4 * 4); // Reserved on ARMv6-M (MemManage on v7-M)
    buf.writeUInt32LE(0x08000201, 5 * 4); // Reserved on ARMv6-M (BusFault on v7-M)
    buf.writeUInt32LE(0x08000201, 6 * 4); // Reserved on ARMv6-M (UsageFault on v7-M)
    buf.writeUInt32LE(0x08000301, 11 * 4); // SVCall (present on ARMv6-M)
    buf.writeUInt32LE(0x08000201, 12 * 4); // Reserved on ARMv6-M (DebugMonitor on v7-M)
    buf.writeUInt32LE(0x08000401, 14 * 4); // PendSV
    buf.writeUInt32LE(0x08000501, 15 * 4); // SysTick

    const parsed = parseFirmwareVectorTable({
      artifact: {
        path: "/tmp/cortex-m0.bin",
        sha256: "d".repeat(64),
        bytes: buf.length,
      },
      architecture: "armv6-m",
      baseAddressHex: "0x08000000",
      vectorTableOffset: 0,
      maxEntries: 16,
      tableBytes: buf,
      svdSupplied: false,
      svdMap: new Map(),
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const report = parsed.value;
    for (const reservedSlot of [4, 5, 6, 12]) {
      expect(report.arm_entries[reservedSlot]).toMatchObject({
        kind: "reserved",
        name: null,
        name_basis: "architecture_manual",
        target_code_address: null,
        status: "nonzero_reserved",
      });
      expect(
        report.anomalies.some((a) =>
          a.includes(
            `Architecturally reserved slot ${String(reservedSlot)} is non-zero`,
          ),
        ),
      ).toBe(true);
    }
    expect(report.arm_entries[11]).toMatchObject({
      kind: "system_exception",
      name: "SVCall",
      status: "active",
    });
  });

  it("refuses DOCTYPE in svd_xml and flags unaligned VTOR offsets", () => {
    const doctypeSvd = `<!DOCTYPE device SYSTEM "x.dtd"><device><peripherals/></device>`;
    expect(parseSvdInterruptMap(doctypeSvd).ok).toBe(false);

    const buf = Buffer.alloc(64, 0);
    buf.writeUInt32LE(0x20010000, 0x20);
    buf.writeUInt32LE(0x08000101, 0x24);
    const parsed = parseFirmwareVectorTable({
      artifact: { path: "/tmp/u.bin", sha256: "b".repeat(64), bytes: 64 },
      architecture: "armv7-m",
      baseAddressHex: "0x08000000",
      vectorTableOffset: 0x20,
      maxEntries: 8,
      tableBytes: buf.subarray(0x20),
      svdSupplied: false,
      svdMap: new Map(),
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.vtor_aligned).toBe(false);
    expect(
      parsed.value.anomalies.some((a) => a.includes("not 128-byte aligned")),
    ).toBe(true);
  });

  it("deduplicates conflicting SVD IRQ declarations in linear time and bounds expanded SVD names", () => {
    // 2,500 conflicting declarations on IRQ 0 plus exact duplicates
    const interruptsXml = Array.from(
      { length: 2500 },
      (_, idx) =>
        `<interrupt><name>IRQ0_ALT_${String(idx % 1250)}</name><value>0</value></interrupt>`,
    ).join("");
    const manyConflictsSvd = `<device><peripherals><peripheral><name>MUX</name>${interruptsXml}</peripheral></peripherals></device>`;
    const deduped = parseSvdInterruptMap(manyConflictsSvd);
    expect(deduped.ok).toBe(true);
    if (!deduped.ok) return;
    const irq0 = deduped.value.get(0);
    expect(irq0?.primaryName).toBeNull();
    expect(irq0?.ambiguousNames).toHaveLength(1250);
    expect(irq0?.ambiguousNames[0]).toBe("MUX:IRQ0_ALT_0");

    // Repeated long peripheral name across many IRQs refuses before multiplying GBs of strings
    const longPeriph = "P".repeat(4096);
    const repeatedIrqs = Array.from(
      { length: 64 },
      (_, idx) =>
        `<interrupt><name>I${String(idx)}</name><value>${String(idx)}</value></interrupt>`,
    ).join("");
    const expansionSvd = `<device><peripherals><peripheral><name>${longPeriph}</name>${repeatedIrqs}</peripheral></peripherals></device>`;
    const refusedSvd = parseSvdInterruptMap(expansionSvd, {
      maxExpandedChars: 16_384,
    });
    expect(refusedSvd.ok).toBe(false);
    if (!refusedSvd.ok && refusedSvd.error.failure.kind === "limit") {
      expect(refusedSvd.error.failure.limit.name).toBe(
        "max_svd_expanded_chars",
      );
    }

    // Node limit reports max_svd_xml_nodes
    const nodeRefused = parseSvdInterruptMap(SAMPLE_SVD, { maxXmlNodes: 5 });
    expect(nodeRefused.ok).toBe(false);
    if (!nodeRefused.ok && nodeRefused.error.failure.kind === "limit") {
      expect(nodeRefused.error.failure.limit).toEqual({
        name: "max_svd_xml_nodes",
        maximum: 5,
      });
    }
  });
});

describe("parseFirmwareVectorTable RISC-V mtvec", () => {
  it("decodes JAL, C.J, and odd-immediate AUIPC+JALR slots while keeping reset_code_address null", () => {
    const buf = Buffer.alloc(20 * 4, 0);
    // JAL x0, +0x200 -> imm=0x200: imm[10:1]=0x100 << 21 = 0x20000000 | 0x6f
    buf.writeUInt32LE(0x2000006f, 0); // slot 0 (trap entry) -> base + 0x200
    buf.writeUInt32LE(0x3000006f, 3 * 4); // slot 3 (MachineSoftwareInterrupt) -> slotAddr + 0x300
    buf.writeUInt32LE(0x4000006f, 7 * 4); // slot 7 (MachineTimerInterrupt) -> slotAddr + 0x400
    // Slot 11 (MachineExternalInterrupt): compressed C.J +0x10 -> b4=1 (bit 11): 0xa801
    buf.writeUInt16LE(0xa801, 11 * 4);
    // Slot 16 (local IRQ 16): auipc x5, 0x1 (0x00001297); jalr x0, 0x101(x5) -> clears bit 0 to +0x1100!
    buf.writeUInt32LE(0x00001297, 16 * 4);
    buf.writeUInt32LE((0x101 << 20) | (5 << 15) | 0x67, 17 * 4);

    const parsed = parseFirmwareVectorTable({
      artifact: {
        path: "/tmp/rv.bin",
        sha256: "c".repeat(64),
        bytes: buf.length,
      },
      architecture: "riscv",
      baseAddressHex: "0x80000000",
      vectorTableOffset: 0,
      maxEntries: 20,
      tableBytes: buf,
      svdSupplied: false,
      svdMap: new Map(),
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const report = parsed.value;
    expect(firmwareVectorTableSchema.safeParse(report).success).toBe(true);
    expect(report.riscv_table_shape).toBe("vectored_jumps");
    expect(report.reset_code_address).toBeNull();
    expect(report.trap_entry_address).toBe("0x80000200");
    expect(report.riscv_slots[3]).toMatchObject({
      cause_code: 3,
      name: "MachineSoftwareInterrupt",
      name_basis: "architecture_manual",
      encoding: "jal",
      target_code_address: "0x8000030c",
    });
    expect(report.riscv_slots[7]).toMatchObject({
      cause_code: 7,
      name: "MachineTimerInterrupt",
      target_code_address: "0x8000041c",
    });
    expect(report.riscv_slots[11]).toMatchObject({
      cause_code: 11,
      name: "MachineExternalInterrupt",
      encoding: "c_j",
      target_code_address: "0x8000003c",
    });
    // slot 16 slotAddress = 0x80000040; + 0x1000 + 0x101 = 0x80001141 -> & ~1 = 0x80001140
    expect(report.riscv_slots[16]).toMatchObject({
      cause_code: 16,
      encoding: "auipc_jalr",
      target_code_address: "0x80001140",
    });
    expect(report.svd_interrupts.unmapped_active_irq_count).toBe(1);
  });
});
