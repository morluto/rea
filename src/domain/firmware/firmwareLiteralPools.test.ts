import { describe, expect, it } from "vitest";
import {
  classifyLoadedConstant,
  EMPTY_SVD_PERIPHERAL_PROFILE,
  parseSvdPeripheralSpans,
} from "./firmwareLiteralPoolRegions.js";
import { scanFirmwareLiteralPools } from "./firmwareLiteralPoolScanner.js";

const SAMPLE_SVD = `<device>
  <name>STM32F4</name>
  <peripherals>
    <peripheral>
      <name>USART1</name>
      <baseAddress>0x40011000</baseAddress>
      <addressBlock>
        <offset>0x0</offset>
        <size>0x400</size>
        <usage>registers</usage>
      </addressBlock>
    </peripheral>
    <peripheral derivedFrom="USART1">
      <name>USART2</name>
      <baseAddress>0x40004400</baseAddress>
    </peripheral>
  </peripherals>
</device>`;

describe("firmwareLiteralPools domain scanner", () => {
  it("decodes Thumb-1 LDR and Thumb-2 LDR.W loads, attributes SCB.VTOR and SVD peripherals, and skips forward pool data words", () => {
    const buf = Buffer.alloc(32, 0x00);
    buf.writeUInt16LE(0x4804, 0x00);
    buf.writeUInt16LE(0xbf00, 0x02);
    buf.writeUInt16LE(0xf8df, 0x04);
    buf.writeUInt16LE(0x4010, 0x06);
    buf.writeUInt16LE(0x4904, 0x08);
    for (let p = 0x0a; p < 0x14; p += 2) buf.writeUInt16LE(0xbf00, p);
    buf.writeUInt32LE(0xe000_ed08, 0x14);
    buf.writeUInt32LE(0x4001_1004, 0x18);
    buf.writeUInt32LE(0x4000_440c, 0x1c);

    const svd = parseSvdPeripheralSpans(SAMPLE_SVD);
    expect(svd.ok).toBe(true);
    if (!svd.ok) return;

    const res = scanFirmwareLiteralPools({
      artifact: {
        path: "/tmp/fw.bin",
        sha256: "a".repeat(64),
        bytes: buf.length,
      },
      fileBytes: buf,
      isa: "arm-thumb",
      baseAddressHex: "0x08000000",
      scanOffset: 0,
      maxScanBytes: 64,
      maxReferences: 16,
      svdSupplied: true,
      svdProfile: svd.value,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.counts.resolved_pool_loads).toBe(3);
    expect(res.value.counts.mmio_pool_loads).toBe(3);
    expect(res.value.svd_profile.matched_load_count).toBe(2);
    expect(res.value.references[0]).toMatchObject({
      instruction_address: "0x8000000",
      mnemonic: "ldr",
      target_register: "r0",
      loaded_value: "0xe000ed08",
      region_kind: "cortex_m_ppb_scs",
      architectural_block: "SCB.VTOR",
    });
    expect(res.value.references[1]).toMatchObject({
      instruction_address: "0x8000004",
      mnemonic: "ldr.w",
      target_register: "r4",
      loaded_value: "0x40011004",
      region_kind: "cortex_m_peripheral",
      basis: "explicit_profile",
      svd_peripheral: "USART1",
      svd_register_offset: "0x4",
    });
    expect(res.value.references[2]).toMatchObject({
      instruction_address: "0x8000008",
      svd_peripheral: "USART2",
      svd_register_offset: "0xc",
    });
  });

  it("suppresses pool halfwords at non-4-byte file offsets when arm-thumb base_address ends in 2", () => {
    // base_address = 0x08000002:
    // offset 0 (0x08000002): 0x4800 (`ldr r0, [pc, #0x0]`) -> Align(0x08000006, 4) = 0x08000004 -> file offset 2..5
    // offset 2..5: pool word 0x40004801 -> halfword at offset 2 is 0x4801 (`ldr r0, [pc, #0x4]` targeting 0x0800000c = offset 10!)
    // offset 6: 0x4770 (`bx lr`)
    // offset 10..13: 0x50000000 (would be falsely loaded if 0x4801 at offset 2 were decoded as code!)
    const forwardBuf = Buffer.alloc(16, 0x00);
    forwardBuf.writeUInt16LE(0x4800, 0x00);
    forwardBuf.writeUInt32LE(0x4000_4801, 0x02);
    forwardBuf.writeUInt16LE(0x4770, 0x06);
    forwardBuf.writeUInt32LE(0x5000_0000, 0x0a);

    const forwardRes = scanFirmwareLiteralPools({
      artifact: {
        path: "/tmp/thumb_base2.bin",
        sha256: "1".repeat(64),
        bytes: forwardBuf.length,
      },
      fileBytes: forwardBuf,
      isa: "arm-thumb",
      baseAddressHex: "0x08000002",
      scanOffset: 0,
      maxScanBytes: 64,
      maxReferences: 16,
      svdSupplied: false,
    });
    expect(forwardRes.ok).toBe(true);
    if (!forwardRes.ok) return;
    expect(forwardRes.value.references).toHaveLength(1);
    expect(forwardRes.value.counts.suppressed_pool_slot_overlaps).toBe(1);
    expect(forwardRes.value.references[0]).toMatchObject({
      instruction_offset: 0,
      instruction_address: "0x8000002",
      pool_offset: 2,
      pool_address: "0x8000004",
      loaded_value: "0x40004801",
    });

    // Backward Thumb-2 `ldr.w r1, [pc, #-0x8]` at offset 6 (0x08000008):
    // Align(0x0800000c, 4) - 8 = 0x08000004 -> file offset 2..5 holding 0x40004801!
    // Pad to 16 bytes so halfword 0x4801 at offset 2 targets offset 10..13 in-image and is suppressed.
    const backwardBuf = Buffer.alloc(16, 0x00);
    backwardBuf.writeUInt16LE(0xbf00, 0x00);
    backwardBuf.writeUInt32LE(0x4000_4801, 0x02);
    backwardBuf.writeUInt16LE(0xf85f, 0x06);
    backwardBuf.writeUInt16LE(0x1008, 0x08);
    backwardBuf.writeUInt32LE(0x5000_0000, 0x0a);
    backwardBuf.writeUInt16LE(0xbf00, 0x0e);

    const backwardRes = scanFirmwareLiteralPools({
      artifact: {
        path: "/tmp/thumb_back_base2.bin",
        sha256: "2".repeat(64),
        bytes: backwardBuf.length,
      },
      fileBytes: backwardBuf,
      isa: "arm-thumb",
      baseAddressHex: "0x08000002",
      scanOffset: 0,
      maxScanBytes: 64,
      maxReferences: 16,
      svdSupplied: false,
    });
    expect(backwardRes.ok).toBe(true);
    if (!backwardRes.ok) return;
    expect(backwardRes.value.references).toHaveLength(1);
    expect(backwardRes.value.counts.suppressed_pool_slot_overlaps).toBe(1);
    expect(backwardRes.value.references[0]).toMatchObject({
      instruction_offset: 6,
      mnemonic: "ldr.w",
      pool_offset: 2,
      loaded_value: "0x40004801",
    });
  });

  it("discovers leading Xtensa literal pools without misaligning subsequent L32R instructions", () => {
    // Exact leading-pool fixture: 00 03 00 60 (0x60000300 at offset 0) + 21 ff ff (l32r a2, [0] at offset 4) + 0d f0 (ret.n)
    const leading = Uint8Array.from([
      0x00, 0x03, 0x00, 0x60, 0x21, 0xff, 0xff, 0x0d, 0xf0,
    ]);
    const leadRes = scanFirmwareLiteralPools({
      artifact: {
        path: "/tmp/xtensa_leading.bin",
        sha256: "3".repeat(64),
        bytes: leading.length,
      },
      fileBytes: leading,
      isa: "xtensa",
      baseAddressHex: "0x400d0000",
      scanOffset: 0,
      maxScanBytes: 64,
      maxReferences: 16,
      svdSupplied: false,
    });
    expect(leadRes.ok).toBe(true);
    if (!leadRes.ok) return;
    expect(leadRes.value.references).toHaveLength(1);
    expect(leadRes.value.references[0]).toMatchObject({
      instruction_offset: 4,
      instruction_address: "0x400d0004",
      mnemonic: "l32r",
      target_register: "a2",
      pool_offset: 0,
      pool_address: "0x400d0000",
      loaded_value: "0x60000300",
      region_kind: "esp_peripheral",
    });

    // Multi-slot leading pool where slot 1 (0x3fffff01) resembles an L32R opcode:
    const xtensa = Buffer.alloc(16, 0x00);
    xtensa.writeUInt32LE(0x3ff4_4004, 0x00);
    xtensa.writeUInt32LE(0x3fff_ff01, 0x04);
    xtensa[0x08] = 0x0d;
    xtensa[0x09] = 0x23;
    xtensa[0x0a] = 0x41;
    xtensa[0x0b] = 0xfd;
    xtensa[0x0c] = 0xff;
    xtensa[0x0d] = 0x51;
    xtensa[0x0e] = 0xfd;
    xtensa[0x0f] = 0xff;

    const xtRes = scanFirmwareLiteralPools({
      artifact: {
        path: "/tmp/esp32_irom.bin",
        sha256: "c".repeat(64),
        bytes: xtensa.length,
      },
      fileBytes: xtensa,
      isa: "xtensa",
      baseAddressHex: "0x400d0000",
      scanOffset: 0,
      maxScanBytes: 64,
      maxReferences: 16,
      svdSupplied: false,
    });
    expect(xtRes.ok).toBe(true);
    if (!xtRes.ok) return;
    expect(xtRes.value.counts.suppressed_pool_slot_overlaps).toBe(1);
    expect(xtRes.value.counts.resolved_pool_loads).toBe(2);
    expect(xtRes.value.references).toHaveLength(2);
  });

  it("preserves Xtensa L32R encoded as 21 36 01 at an address ending in 3", () => {
    // offset 0x44..0x48: pool word 0x60000300 (0x400d0044)
    // offset 0x3fb68..0x3fb6b: 3-byte `addi a2, a2, 0` (`22 c2 00`)
    // offset 0x3fb6b..0x3fb6e (address 0x4010fb6b, ending in 3 mod 4):
    //   `21 36 01` -> offset16 = 0x0136 = 310 -> signedWords = -65226 (-0x3fb28 bytes)
    //   Align(0x4010fb6b + 3, 4) = 0x4010fb6c -> 0x4010fb6c - 0x3fb28 = 0x400d0044 (offset 0x44 = 68)!
    const image = Buffer.alloc(0x3fb70, 0x00);
    image.writeUInt32LE(0x6000_0300, 0x44);
    image[0x3fb68] = 0x22;
    image[0x3fb69] = 0xc2;
    image[0x3fb6a] = 0x00;
    image[0x3fb6b] = 0x21;
    image[0x3fb6c] = 0x36;
    image[0x3fb6d] = 0x01;
    image[0x3fb6e] = 0x0d;
    image[0x3fb6f] = 0xf0;

    for (const scanOffset of [0x3fb68, 0x3fb6b]) {
      const res = scanFirmwareLiteralPools({
        artifact: {
          path: "/tmp/xtensa_entry_disp.bin",
          sha256: "4".repeat(64),
          bytes: image.length,
        },
        fileBytes: image,
        isa: "xtensa",
        baseAddressHex: "0x400d0000",
        scanOffset,
        maxScanBytes: 32,
        maxReferences: 16,
        svdSupplied: false,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.references).toHaveLength(1);
      expect(res.value.references[0]).toMatchObject({
        instruction_offset: 0x3fb6b,
        instruction_address: "0x4010fb6b",
        mnemonic: "l32r",
        target_register: "a2",
        pool_offset: 0x44,
        loaded_value: "0x60000300",
      });
    }
  });

  it("checks mapped_image before conventions and does not invent Cortex-M claims for arm-a32", () => {
    // A32 image mapped at 0x40000000 loading in-image pointer 0x40000008 and unprofiled 0xe000ed00:
    const a32 = Buffer.alloc(16, 0x00);
    a32.writeUInt32LE(0x059f_2000, 0x00); // ldreq r2, [pc, #0x0] -> pool at 0x08 (0x40000008)
    a32.writeUInt32LE(0xe59f_3000, 0x04); // ldr r3, [pc, #0x0] -> pool at 0x0c (0x4000000c)
    a32.writeUInt32LE(0x4000_0008, 0x08);
    a32.writeUInt32LE(0xe000_ed00, 0x0c);

    const unprofiled = scanFirmwareLiteralPools({
      artifact: {
        path: "/tmp/a32_ram.bin",
        sha256: "5".repeat(64),
        bytes: a32.length,
      },
      fileBytes: a32,
      isa: "arm-a32",
      baseAddressHex: "0x40000000",
      scanOffset: 0,
      maxScanBytes: 64,
      maxReferences: 16,
      svdSupplied: false,
    });
    expect(unprofiled.ok).toBe(true);
    if (!unprofiled.ok) return;
    expect(unprofiled.value.references[0]).toMatchObject({
      disassembly: "ldreq r2, [pc, #0x0]",
      loaded_value: "0x40000008",
      region_kind: "mapped_image",
      basis: "observed_bounds",
    });
    expect(unprofiled.value.references[1]).toMatchObject({
      loaded_value: "0xe000ed00",
      region_kind: "other",
      basis: "unclassified",
      architectural_block: null,
    });

    // With explicit SVD, A32 attributes to svd_peripheral:
    const a32Svd = parseSvdPeripheralSpans(`<device>
      <name>CustomSoC</name>
      <peripherals>
        <peripheral>
          <name>SYSCTL</name>
          <baseAddress>0xe000ed00</baseAddress>
          <addressBlock><offset>0x0</offset><size>0x100</size><usage>registers</usage></addressBlock>
        </peripheral>
      </peripherals>
    </device>`);
    expect(a32Svd.ok).toBe(true);
    if (!a32Svd.ok) return;
    const profiled = classifyLoadedConstant({
      value: 0xe000_ed04,
      isa: "arm-a32",
      baseAddress: 0x4000_0000,
      fileBytes: 16,
      svdProfile: a32Svd.value,
    });
    expect(profiled).toEqual({
      regionKind: "svd_peripheral",
      basis: "explicit_profile",
      architecturalBlock: null,
      svdPeripheral: "SYSCTL",
      svdRegisterOffset: "0x4",
      mmioBaseAddress: 0xe000_ed00,
    });
  });

  it("resolves multi-hop SVD derivedFrom chains, leaves unknown extents unmatched, and preserves disjoint addressBlock gaps", () => {
    const complexSvd = `<device>
      <name>ComplexMCU</name>
      <peripherals>
        <peripheral>
          <name>TIM_BASE</name>
          <baseAddress>0x40000000</baseAddress>
          <addressBlock><offset>0x0</offset><size>0x1000</size><usage>registers</usage></addressBlock>
        </peripheral>
        <peripheral derivedFrom="TIM_BASE">
          <name>TIM_MID</name>
          <baseAddress>0x40002000</baseAddress>
        </peripheral>
        <peripheral derivedFrom="TIM_MID">
          <name>TIM_LEAF</name>
          <baseAddress>0x40004000</baseAddress>
        </peripheral>
        <peripheral>
          <name>NO_EXTENT</name>
          <baseAddress>0x40008000</baseAddress>
        </peripheral>
        <peripheral>
          <name>SPARSE_A</name>
          <baseAddress>0x50000000</baseAddress>
          <addressBlock><offset>0x0</offset><size>0x100</size><usage>registers</usage></addressBlock>
          <addressBlock><offset>0x100</offset><size>0xf00</size><usage>reserved</usage></addressBlock>
          <addressBlock><offset>0x1000</offset><size>0x100</size><usage>registers</usage></addressBlock>
        </peripheral>
        <peripheral>
          <name>GAP_B</name>
          <baseAddress>0x50000800</baseAddress>
          <addressBlock><offset>0x0</offset><size>0x100</size><usage>registers</usage></addressBlock>
        </peripheral>
      </peripherals>
    </device>`;

    const parsed = parseSvdPeripheralSpans(complexSvd);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const leafHit = classifyLoadedConstant({
      value: 0x4000_4800,
      isa: "arm-thumb",
      baseAddress: 0x0800_0000,
      fileBytes: 64,
      svdProfile: parsed.value,
    });
    expect(leafHit).toMatchObject({
      basis: "explicit_profile",
      svdPeripheral: "TIM_LEAF",
      svdRegisterOffset: "0x800",
    });

    const unknownExtent = classifyLoadedConstant({
      value: 0x4000_8010,
      isa: "arm-thumb",
      baseAddress: 0x0800_0000,
      fileBytes: 64,
      svdProfile: parsed.value,
    });
    expect(unknownExtent).toMatchObject({
      basis: "address_map_convention",
      svdPeripheral: null,
    });

    const inGapB = classifyLoadedConstant({
      value: 0x5000_0804,
      isa: "arm-thumb",
      baseAddress: 0x0800_0000,
      fileBytes: 64,
      svdProfile: parsed.value,
    });
    expect(inGapB).toMatchObject({
      basis: "explicit_profile",
      svdPeripheral: "GAP_B",
      svdRegisterOffset: "0x4",
    });

    const unmappedGap = classifyLoadedConstant({
      value: 0x5000_0400,
      isa: "arm-thumb",
      baseAddress: 0x0800_0000,
      fileBytes: 64,
      svdProfile: parsed.value,
    });
    expect(unmappedGap.svdPeripheral).toBeNull();

    const secondBlockA = classifyLoadedConstant({
      value: 0x5000_1020,
      isa: "arm-thumb",
      baseAddress: 0x0800_0000,
      fileBytes: 64,
      svdProfile: parsed.value,
    });
    expect(secondBlockA).toMatchObject({
      basis: "explicit_profile",
      svdPeripheral: "SPARSE_A",
      svdRegisterOffset: "0x1020",
    });
  });

  it("attributes ARMv7-M and ARMv8-M SCS register blocks (NVIC STIR, SAU, MPU, FPU) and leaves reserved PPB gaps unnamed", () => {
    const checkBlock = (addr: number) =>
      classifyLoadedConstant({
        value: addr,
        isa: "arm-thumb",
        baseAddress: 0x0800_0000,
        fileBytes: 64,
        svdProfile: EMPTY_SVD_PERIPHERAL_PROFILE,
      }).architecturalBlock;

    expect(checkBlock(0xe000_ef00)).toBe("NVIC");
    expect(checkBlock(0xe000_edd0)).toBe("SAU");
    expect(checkBlock(0xe000_ed90)).toBe("MPU");
    expect(checkBlock(0xe000_ef34)).toBe("FPU");
    expect(checkBlock(0xe000_ee00)).toBeNull();
    expect(checkBlock(0xe000_ef10)).toBeNull();
  });

  it("reports misaligned base_address and scan_offset as field-specific input issues", () => {
    const buf = Buffer.alloc(16, 0x00);
    const thumbOdd = scanFirmwareLiteralPools({
      artifact: { path: "/tmp/fw.bin", sha256: "0".repeat(64), bytes: 16 },
      fileBytes: buf,
      isa: "arm-thumb",
      baseAddressHex: "0x08000001",
      scanOffset: 1,
      maxScanBytes: 16,
      maxReferences: 16,
      svdSupplied: false,
    });
    expect(thumbOdd.ok).toBe(false);
    if (thumbOdd.ok || !("issues" in thumbOdd.error)) return;
    expect(thumbOdd.error.issues.map((i) => i.path)).toEqual([
      ["base_address"],
      ["scan_offset"],
    ]);

    const a32Misaligned = scanFirmwareLiteralPools({
      artifact: { path: "/tmp/fw.bin", sha256: "0".repeat(64), bytes: 16 },
      fileBytes: buf,
      isa: "arm-a32",
      baseAddressHex: "0x08000002",
      scanOffset: 0,
      maxScanBytes: 16,
      maxReferences: 16,
      svdSupplied: false,
    });
    expect(a32Misaligned.ok).toBe(false);
    if (a32Misaligned.ok || !("issues" in a32Misaligned.error)) return;
    expect(a32Misaligned.error.issues.map((i) => i.path)).toEqual([
      ["base_address"],
    ]);
  });

  it("recovers real Thumb loads after an earlier fake pool word is invalidated by a backward ldr.w", () => {
    // offset 0: 0x40004801 (halfword 0x4801 looks like `ldr r0, [pc, #0x4]` targeting 8..11)
    // offset 4: 0xf85f 0x1008 (`ldr.w r1, [pc, #-0x8]` targeting 0..3 -> proves 0..3 is pool data!)
    // offset 8: 0x4a01 (`ldr r2, [pc, #0x4]` targeting 16..19 -> real MMIO load!)
    // offset 16: 0x40011004 (USART1)
    const buf = Buffer.alloc(20, 0x00);
    buf.writeUInt32LE(0x4000_4801, 0x00);
    buf.writeUInt16LE(0xf85f, 0x04);
    buf.writeUInt16LE(0x1008, 0x06);
    buf.writeUInt16LE(0x4a01, 0x08);
    for (let p = 0x0a; p < 0x10; p += 2) buf.writeUInt16LE(0xbf00, p);
    buf.writeUInt32LE(0x4001_1004, 0x10);

    const res = scanFirmwareLiteralPools({
      artifact: {
        path: "/tmp/thumb_backward_invalidate.bin",
        sha256: "7".repeat(64),
        bytes: buf.length,
      },
      fileBytes: buf,
      isa: "arm-thumb",
      baseAddressHex: "0x08000000",
      scanOffset: 0,
      maxScanBytes: 64,
      maxReferences: 16,
      svdSupplied: false,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.counts.suppressed_pool_slot_overlaps).toBe(1);
    expect(res.value.references).toHaveLength(2);
    expect(res.value.references[0]).toMatchObject({
      instruction_offset: 4,
      mnemonic: "ldr.w",
      target_register: "r1",
      pool_offset: 0,
      loaded_value: "0x40004801",
    });
    expect(res.value.references[1]).toMatchObject({
      instruction_offset: 8,
      mnemonic: "ldr",
      target_register: "r2",
      pool_offset: 16,
      loaded_value: "0x40011004",
    });
  });

  it("prevents alternate Xtensa traces inside 3-byte instruction operands from overriding established L32R loads", () => {
    const bytes = Uint8Array.from([
      0x00, 0x03, 0x00, 0x60, 0x21, 0xff, 0xff, 0x22, 0x21, 0xff, 0xff, 0x08,
      0xf0, 0x08, 0x00, 0x0d, 0xf0,
    ]);
    const res = scanFirmwareLiteralPools({
      artifact: {
        path: "/tmp/xtensa_operand_guard.bin",
        sha256: "8".repeat(64),
        bytes: bytes.length,
      },
      fileBytes: bytes,
      isa: "xtensa",
      baseAddressHex: "0x400d0000",
      scanOffset: 4,
      maxScanBytes: 64,
      maxReferences: 16,
      svdSupplied: false,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.references).toHaveLength(1);
    expect(res.value.references[0]).toMatchObject({
      instruction_offset: 4,
      instruction_address: "0x400d0004",
      mnemonic: "l32r",
      target_register: "a2",
      pool_offset: 0,
      loaded_value: "0x60000300",
    });
  });

  it("preserves gapped SVD register arrays, detects duplicate-span peripheral ties, and bounds derivedFrom interval amplification", () => {
    const gappedAndTiedSvd = `<device>
      <name>TieAndGapMCU</name>
      <peripherals>
        <peripheral>
          <name>GAPPED_PERIPH</name>
          <baseAddress>0x40020000</baseAddress>
          <registers>
            <register>
              <name>CH%s_CR</name>
              <addressOffset>0x0</addressOffset>
              <size>32</size>
              <dim>2</dim>
              <dimIncrement>0x1000</dimIncrement>
            </register>
          </registers>
        </peripheral>
        <peripheral>
          <name>TIE_A</name>
          <baseAddress>0x40030000</baseAddress>
          <registers>
            <register><name>ALT0</name><addressOffset>0x0</addressOffset><size>32</size></register>
            <register><name>ALT1</name><addressOffset>0x0</addressOffset><size>32</size></register>
          </registers>
        </peripheral>
        <peripheral>
          <name>TIE_B</name>
          <baseAddress>0x40030000</baseAddress>
          <registers>
            <register><name>REG0</name><addressOffset>0x0</addressOffset><size>32</size></register>
          </registers>
        </peripheral>
      </peripherals>
    </device>`;

    const parsed = parseSvdPeripheralSpans(gappedAndTiedSvd);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // Element 0 (0x40020000) and element 1 (0x40021000) match, while unmapped gap 0x40020800 stays null.
    expect(
      classifyLoadedConstant({
        value: 0x4002_0000,
        isa: "arm-thumb",
        baseAddress: 0x0800_0000,
        fileBytes: 64,
        svdProfile: parsed.value,
      }).svdPeripheral,
    ).toBe("GAPPED_PERIPH");
    expect(
      classifyLoadedConstant({
        value: 0x4002_1000,
        isa: "arm-thumb",
        baseAddress: 0x0800_0000,
        fileBytes: 64,
        svdProfile: parsed.value,
      }).svdPeripheral,
    ).toBe("GAPPED_PERIPH");
    expect(
      classifyLoadedConstant({
        value: 0x4002_0800,
        isa: "arm-thumb",
        baseAddress: 0x0800_0000,
        fileBytes: 64,
        svdProfile: parsed.value,
      }).svdPeripheral,
    ).toBeNull();

    // Duplicate alternate registers in TIE_A must not hide competing equal-span TIE_B.
    expect(
      classifyLoadedConstant({
        value: 0x4003_0000,
        isa: "arm-thumb",
        baseAddress: 0x0800_0000,
        fileBytes: 64,
        svdProfile: parsed.value,
      }).svdPeripheral,
    ).toBeNull();

    // Derived peripheral amplification exceeding max_svd_nodes fails before allocating intervals and reports required count.
    const baseBlocks = Array.from(
      { length: 32 },
      (_, idx) =>
        `<addressBlock><offset>0x${(idx * 16).toString(16)}</offset><size>0x4</size><usage>registers</usage></addressBlock>`,
    ).join("");
    const derivedClones = Array.from(
      { length: 32 },
      (_, idx) =>
        `<peripheral derivedFrom="BASE_P"><name>CLONE_${String(idx)}</name><baseAddress>0x${(0x4000_0000 + (idx + 1) * 0x1000).toString(16)}</baseAddress></peripheral>`,
    ).join("");
    const amplifiedXml = `<device><peripherals><peripheral><name>BASE_P</name><baseAddress>0x40000000</baseAddress>${baseBlocks}</peripheral>${derivedClones}</peripherals></device>`;
    const amplifiedRes = parseSvdPeripheralSpans(amplifiedXml, 500);
    expect(amplifiedRes.ok).toBe(false);
    if (amplifiedRes.ok || amplifiedRes.error.failure.kind !== "limit") return;
    expect(amplifiedRes.error.failure.limit).toMatchObject({
      name: "max_svd_nodes",
      maximum: 500,
      required: 33 * 32,
    });

    // Deep acyclic derivedFrom chain (15,000 hops, reverse-declared) resolves iteratively without stack overflow.
    const chainDepth = 15_000;
    const chainParts: string[] = [];
    for (let idx = chainDepth; idx >= 1; idx -= 1) {
      chainParts.push(
        `<peripheral derivedFrom="P_${String(idx - 1)}"><name>P_${String(idx)}</name><baseAddress>0x${(0x4000_0000 + idx * 0x10).toString(16)}</baseAddress></peripheral>`,
      );
    }
    chainParts.push(
      `<peripheral><name>P_0</name><baseAddress>0x40000000</baseAddress><addressBlock><offset>0x0</offset><size>0x4</size><usage>registers</usage></addressBlock></peripheral>`,
    );
    const deepChainRes = parseSvdPeripheralSpans(
      `<device><peripherals>${chainParts.join("")}</peripherals></device>`,
      200_000,
    );
    expect(deepChainRes.ok).toBe(true);
    if (!deepChainRes.ok) return;
    expect(
      classifyLoadedConstant({
        value: 0x4000_0000 + chainDepth * 0x10,
        isa: "arm-thumb",
        baseAddress: 0x0800_0000,
        fileBytes: 64,
        svdProfile: deepChainRes.value,
      }).svdPeripheral,
    ).toBe(`P_${String(chainDepth)}`);
  });

  it("counts compact self-targeting A32 literal loads and reports exact required_value on max_references refusal", () => {
    // 1024 words of 0xe51f0008 (`ldr r0, [pc, #-0x8]` targeting its own instruction word)
    const selfLoads = Buffer.alloc(1024 * 4);
    for (let off = 0; off < selfLoads.length; off += 4) {
      selfLoads.writeUInt32LE(0xe51f_0008, off);
    }
    const refused = scanFirmwareLiteralPools({
      artifact: {
        path: "/tmp/self_loads.bin",
        sha256: "9".repeat(64),
        bytes: selfLoads.length,
      },
      fileBytes: selfLoads,
      isa: "arm-a32",
      baseAddressHex: "0x08000000",
      scanOffset: 0,
      maxScanBytes: selfLoads.length,
      maxReferences: 1,
      svdSupplied: false,
    });
    expect(refused.ok).toBe(false);
    if (
      refused.ok ||
      !("failure" in refused.error) ||
      refused.error.failure.kind !== "limit"
    ) {
      return;
    }
    expect(refused.error.failure.limit).toMatchObject({
      name: "max_references",
      maximum: 1,
      required: 1024,
    });
  });
});
