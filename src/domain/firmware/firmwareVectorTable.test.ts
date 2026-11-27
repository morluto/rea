import { describe, expect, it } from "vitest";
import {
  parseSvdInterruptMap,
  type SvdInterruptMap,
} from "./firmwareSvdInterrupts.js";
import {
  firmwareVectorTableSchema,
  vectorTableCountsMatch,
} from "./firmwareVectorTable.js";
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
  it("decodes ARMv8-M Mainline exceptions, Thumb bit-0 violations, shared stubs, and CMSIS-SVD IRQs", () => {
    const svd = parseSvdInterruptMap(SAMPLE_SVD);
    expect(svd.ok).toBe(true);
    if (!svd.ok) return;

    // 48 slots = 16 system + 32 external IRQs (IRQ 0..31)
    const buf = Buffer.alloc(48 * 4, 0);
    buf.writeUInt32LE(0x20020000, 0); // InitialSP
    buf.writeUInt32LE(0x08000201, 4); // Reset (Thumb)
    buf.writeUInt32LE(0x08000301, 8); // NMI -> Default_Handler
    buf.writeUInt32LE(0x08000301, 12); // HardFault -> Default_Handler
    buf.writeUInt32LE(0x08000401, 28); // Slot 7 = SecureFault on armv8-m.main
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
      architecture: "armv8-m.main",
      baseAddressHex: "0x08000000",
      vectorTableOffset: 0,
      maxEntries: 64,
      tableBytes: buf,
      svdSupplied: true,
      svdMap: svd.value.byIrq,
      svdSkipped: svd.value.skipped,
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const report = parsed.value;
    expect(firmwareVectorTableSchema.safeParse(report).success).toBe(true);
    expect(report.initial_stack_pointer).toBe("0x20020000");
    expect(report.reset_code_address).toBe("0x8000200");
    expect(report.trap_entry_address).toBeNull();
    expect(report.vtor_aligned).toBe(true);

    // Slot 7 on armv8-m.main is SecureFault
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
      svdSkipped: [],
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
      svdSkipped: [],
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
    const irq0 = deduped.value.byIrq.get(0);
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

    // Rejected <interrupt> and nameless <peripheral> diagnostics also charge max_svd_expanded_chars
    const invalidIrqs = Array.from(
      { length: 32 },
      () => `<interrupt><value>5</value></interrupt>`,
    ).join("");
    const rejectedExpansionSvd = `<device><peripherals><peripheral><name>${longPeriph}</name>${invalidIrqs}</peripheral></peripherals></device>`;
    const rejectedRefused = parseSvdInterruptMap(rejectedExpansionSvd, {
      maxExpandedChars: 16_384,
    });
    expect(rejectedRefused.ok).toBe(false);
    if (!rejectedRefused.ok && rejectedRefused.error.failure.kind === "limit") {
      expect(rejectedRefused.error.failure.limit.name).toBe(
        "max_svd_expanded_chars",
      );
    }

    const namelessPeriphRefused = parseSvdInterruptMap(
      `<device><peripherals><peripheral><interrupt><name>X</name><value>0</value></interrupt></peripheral></peripherals></device>`,
      { maxExpandedChars: 32 },
    );
    expect(namelessPeriphRefused.ok).toBe(false);
    if (
      !namelessPeriphRefused.ok &&
      namelessPeriphRefused.error.failure.kind === "limit"
    ) {
      expect(namelessPeriphRefused.error.failure.limit.name).toBe(
        "max_svd_expanded_chars",
      );
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
      svdSkipped: [],
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

  it("pairs AUIPC+JALR up to 0xfffffff8..0xffffffff and refuses pairs that cross 0xffffffff", () => {
    const auipcX5 = 0x0000_0297; // auipc x5, 0
    const jalrX0X5 = (0x10 << 20) | (5 << 15) | 0x67; // jalr x0, 0x10(x5)

    // At 0xfffffff8, word 1 occupies 0xfffffff8..0xfffffffb and word 2 occupies 0xfffffffc..0xffffffff
    const fitsBuf = Buffer.alloc(16, 0);
    fitsBuf.writeUInt32LE(auipcX5, 0);
    fitsBuf.writeUInt32LE(jalrX0X5, 4);
    const fits = parseFirmwareVectorTable({
      artifact: {
        path: "/tmp/rv-top-fits.bin",
        sha256: "f".repeat(64),
        bytes: fitsBuf.length,
      },
      architecture: "riscv",
      baseAddressHex: "0xfffffff8",
      vectorTableOffset: 0,
      maxEntries: 8,
      tableBytes: fitsBuf,
      svdSupplied: false,
      svdMap: new Map(),
      svdSkipped: [],
    });
    expect(fits.ok).toBe(true);
    if (!fits.ok) return;
    expect(fits.value.examined_entries).toBe(2);
    expect(fits.value.riscv_slots[0]).toMatchObject({
      slot_address: "0xfffffff8",
      encoding: "auipc_jalr",
      raw_words: ["0x297", "0x1028067"],
      target_code_address: "0x8",
    });
    expect(fits.value.riscv_table_shape).toBe("single_entry_or_inline");

    // At 0xfffffffc, word 2 in tableBytes would lie at 0x1_0000_0000 and must not be paired
    const wrapsBuf = Buffer.alloc(16, 0);
    wrapsBuf.writeUInt32LE(auipcX5, 0);
    wrapsBuf.writeUInt32LE(jalrX0X5, 4);
    const wraps = parseFirmwareVectorTable({
      artifact: {
        path: "/tmp/rv-top-wraps.bin",
        sha256: "e".repeat(64),
        bytes: wrapsBuf.length,
      },
      architecture: "riscv",
      baseAddressHex: "0xfffffffc",
      vectorTableOffset: 0,
      maxEntries: 8,
      tableBytes: wrapsBuf,
      svdSupplied: false,
      svdMap: new Map(),
      svdSkipped: [],
    });
    expect(wraps.ok).toBe(true);
    if (!wraps.ok) return;
    expect(wraps.value.examined_entries).toBe(1);
    expect(wraps.value.riscv_slots[0]).toMatchObject({
      slot_address: "0xfffffffc",
      encoding: "unrecognized",
      raw_words: ["0x297"],
      decoded_mnemonic: null,
      target_code_address: null,
    });
    expect(wraps.value.riscv_table_shape).toBe("empty_or_unrecognized");
  });
});

describe("parseFirmwareVectorTable variant rules", () => {
  const parse = (
    tableBytes: Buffer,
    architecture: Parameters<
      typeof parseFirmwareVectorTable
    >[0]["architecture"],
    baseAddressHex = "0x08000000",
    svd?: SvdInterruptMap,
  ) => {
    const parsed = parseFirmwareVectorTable({
      artifact: {
        path: "/tmp/fw.bin",
        sha256: "b".repeat(64),
        bytes: tableBytes.length,
      },
      architecture,
      baseAddressHex,
      vectorTableOffset: 0,
      maxEntries: 256,
      tableBytes,
      svdSupplied: svd !== undefined,
      svdMap: svd?.byIrq ?? new Map(),
      svdSkipped: svd?.skipped ?? [],
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(firmwareVectorTableSchema.safeParse(parsed.value).success).toBe(
      true,
    );
    return parsed.value;
  };

  it("names only ARMv6-M's exceptions on ARMv8-M Baseline", () => {
    const table = Buffer.alloc(16 * 4);
    table.writeUInt32LE(0x2000_8000, 0);
    const report = parse(table, "armv8-m.base");
    expect(
      [4, 5, 6, 7, 12].map((slot) => report.arm_entries[slot]?.kind),
    ).toEqual(["reserved", "reserved", "reserved", "reserved", "reserved"]);
    const mainline = parse(table, "armv8-m.main");
    expect(
      [4, 5, 6, 7, 12].map((slot) => mainline.arm_entries[slot]?.name),
    ).toEqual([
      "MemManage",
      "BusFault",
      "UsageFault",
      "SecureFault",
      "DebugMonitor",
    ]);
  });

  it("reports ARMv6-M VTOR alignment as unknown and checks the 128-byte minimum elsewhere", () => {
    const table = Buffer.alloc(16 * 4);
    table.writeUInt32LE(0x2000_8000, 0);
    expect(parse(table, "armv6-m", "0x08000040").vtor_aligned).toBeNull();
    expect(parse(table, "armv7-m", "0x08000040").vtor_aligned).toBe(false);
    expect(parse(table, "armv7-m", "0x08000080").vtor_aligned).toBe(true);
  });

  it("stops at the end of the 32-bit address space instead of wrapping slot addresses", () => {
    const table = Buffer.alloc(256 * 4);
    table.writeUInt32LE(0x2000_8000, 0);
    const report = parse(table, "armv7-m", "0xffffff00");
    expect(report.examined_entries).toBe(64);
    expect(report.arm_entries.at(-1)?.slot_address).toBe("0xfffffffc");
    expect(report.coverage.status).toBe("partial");
    expect(report.limitations.join("\n")).toContain(
      "past the end of the 32-bit address space",
    );
  });

  it("flags an initial stack pointer whose low two bits the processor ignores", () => {
    const table = Buffer.alloc(16 * 4);
    table.writeUInt32LE(0x2000_8002, 0);
    expect(parse(table, "armv7-m").anomalies.join("\n")).toContain(
      "not word-aligned",
    );
  });

  it("reports CMSIS-SVD interrupts it cannot bind instead of dropping them", () => {
    const svd = parseSvdInterruptMap(`<device><peripherals>
      <peripheral><name>UART0</name>
        <interrupt><name>UART0_IRQ</name><value>0X1F</value></interrupt>
        <interrupt><name>UART0_ERR</name><value>-3</value></interrupt>
        <interrupt><name>UART0_WAKE</name></interrupt>
        <interrupt><value>5</value></interrupt>
        <interrupt><value>-9</value></interrupt>
        <interrupt></interrupt>
      </peripheral>
      <peripheral><interrupt><name>ORPHAN</name><value>4</value></interrupt></peripheral>
    </peripherals></device>`);
    if (!svd.ok) throw new Error(svd.error.message);
    expect([...svd.value.byIrq.keys()]).toEqual([31]);
    expect(svd.value.skipped).toEqual([
      'CMSIS-SVD interrupt UART0_ERR of peripheral UART0 has value "-3", which is not a non-negative integer; it was not bound.',
      "CMSIS-SVD interrupt UART0_WAKE of peripheral UART0 has no <value>; it was not bound.",
      'CMSIS-SVD interrupt with <value> "5" of peripheral UART0 has no <name>; it was not bound.',
      'CMSIS-SVD interrupt of peripheral UART0 has no <name> and value "-9", which is not a non-negative integer; it was not bound.',
      "CMSIS-SVD interrupt of peripheral UART0 has no <name> and no <value>; it was not bound.",
      "CMSIS-SVD peripheral 1 has no <name>; its 1 interrupt declaration(s) were not bound.",
    ]);
    const table = Buffer.alloc(48 * 4);
    table.writeUInt32LE(0x2000_8000, 0);
    const report = parse(table, "armv7-m", "0x08000000", svd.value);
    expect(
      report.anomalies.filter(
        (item) =>
          item.includes("was not bound") || item.includes("were not bound"),
      ),
    ).toHaveLength(6);
  });

  it("states RISC-V dispatch, CLIC and SVD numbering assumptions", () => {
    const table = Buffer.alloc(32 * 4);
    const limitations = parse(table, "riscv", "0x40000000", {
      byIrq: new Map(),
      skipped: [],
    }).limitations.join("\n");
    expect(limitations).toContain(
      "slot 0 also receives every synchronous exception",
    );
    expect(limitations).toContain("CLIC table");
    expect(limitations).toContain("mcause codes 16 and up");
  });
});

describe("vector table size and SVD duplicate rules", () => {
  it("decodes a single-instruction RISC-V table and still requires InitialSP and Reset on ARM", () => {
    const jal = Buffer.alloc(4);
    jal.writeUInt32LE(0x0080_006f, 0); // jal x0, +8
    const options = {
      artifact: { path: "/tmp/one.bin", sha256: "c".repeat(64), bytes: 4 },
      baseAddressHex: "0x40000000",
      vectorTableOffset: 0,
      maxEntries: 1,
      tableBytes: jal,
      svdSupplied: false,
      svdMap: new Map(),
      svdSkipped: [],
    } as const;
    const riscv = parseFirmwareVectorTable({
      ...options,
      architecture: "riscv",
    });
    expect(riscv.ok && riscv.value.trap_entry_address).toBe("0x40000008");
    const arm = parseFirmwareVectorTable({
      ...options,
      architecture: "armv7-m",
    });
    expect(arm.ok).toBe(false);
    if (!arm.ok) expect(arm.error.message).toContain("fewer than 8 bytes");
  });

  it("records the full 8-byte AUIPC+JALR extent in table_file_range and coverage when max_entries is 1", () => {
    const pair = Buffer.alloc(16);
    pair.writeUInt32LE(0x0000_1297, 4); // auipc x5, 0x1 at offset 4
    pair.writeUInt32LE((0x20 << 20) | (5 << 15) | 0x67, 8); // jalr x0, 0x20(x5) at offset 8
    const parsed = parseFirmwareVectorTable({
      artifact: { path: "/tmp/pair.bin", sha256: "d".repeat(64), bytes: 12 },
      architecture: "riscv",
      baseAddressHex: "0x80000000",
      vectorTableOffset: 4,
      maxEntries: 1,
      tableBytes: pair.subarray(4, 12),
      svdSupplied: false,
      svdMap: new Map(),
      svdSkipped: [],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.examined_entries).toBe(1);
    expect(parsed.value.table_file_range).toEqual({ start: 4, end: 12 });
    expect(parsed.value.coverage).toEqual({
      status: "complete",
      examined_bytes: 8,
      available_from_offset_bytes: 8,
    });
    expect(parsed.value.trap_entry_address).toBe("0x80001024");
  });

  it("binds repeated declarations once, including across <peripheral> elements with one name", () => {
    const repeats =
      "<interrupt><name>IRQ</name><value>3</value></interrupt>".repeat(3);
    const svd = `<device><peripherals>
      <peripheral><name>UART</name>${repeats}</peripheral>
      <peripheral><name>UART</name>${repeats}<interrupt><name>ERR</name><value>3</value></interrupt></peripheral>
    </peripherals></device>`;
    const parsed = parseSvdInterruptMap(svd);
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.value.byIrq.get(3)?.ambiguousNames).toEqual([
      "UART:IRQ",
      "UART:ERR",
    ]);
  });
});

describe("stored vector-table slot counts", () => {
  const report = (architecture: "armv7-m" | "riscv", tableBytes: Buffer) => {
    const parsed = parseFirmwareVectorTable({
      artifact: {
        path: "/tmp/counts.bin",
        sha256: "e".repeat(64),
        bytes: tableBytes.length,
      },
      architecture,
      baseAddressHex: "0x08000000",
      vectorTableOffset: 0,
      maxEntries: 64,
      tableBytes,
      svdSupplied: false,
      svdMap: new Map(),
      svdSkipped: [],
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    return parsed.value;
  };

  it("counts active ARM entries and recognized RISC-V slots once, matching the slots", () => {
    const arm = Buffer.alloc(20 * 4);
    arm.writeUInt32LE(0x2000_8000, 0);
    arm.writeUInt32LE(0x0800_0201, 4); // Reset, active
    arm.writeUInt32LE(0x0800_0300, 8); // NMI, even: not active
    arm.writeUInt32LE(0x0800_0301, 12); // HardFault, active
    arm.writeUInt32LE(0xffff_ffff, 16 * 4); // IRQ 0, erased
    arm.writeUInt32LE(0x0800_0401, 17 * 4); // IRQ 1, active
    const armReport = report("armv7-m", arm);
    expect(armReport.active_arm_entry_count).toBe(3);
    expect(armReport.recognized_riscv_slot_count).toBe(0);
    expect(vectorTableCountsMatch(armReport)).toBe(true);

    const riscv = Buffer.alloc(4 * 4);
    riscv.writeUInt32LE(0x0080_006f, 0); // jal x0, +8
    riscv.writeUInt32LE(0x1234_5678, 4); // unrecognized
    riscv.writeUInt32LE(0x0040_006f, 8); // jal x0, +4
    const riscvReport = report("riscv", riscv);
    expect(riscvReport.recognized_riscv_slot_count).toBe(2);
    expect(riscvReport.active_arm_entry_count).toBe(0);
    expect(vectorTableCountsMatch(riscvReport)).toBe(true);

    expect(
      vectorTableCountsMatch({ ...armReport, active_arm_entry_count: 2 }),
    ).toBe(false);
  });
});
