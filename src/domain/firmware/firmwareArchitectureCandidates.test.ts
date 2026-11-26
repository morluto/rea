import { describe, expect, it, vi } from "vitest";
import { buildUImage } from "../../../tests/fixtures/uimage.js";
import {
  firmwareArchitectureCandidatesSchema,
  buildRawBinarySuggestion,
} from "./firmwareArchitectureCandidates.js";
import {
  HEADER_SCAN_WINDOW_BYTES,
  MAX_RETAINED_UIMAGE_HEADERS,
  MAX_RETAINED_VECTOR_TABLES,
  scanUImageHeaders,
} from "./firmwareArchitectureHeaderDetectors.js";
import { scanFirmwareArchitectureCandidates } from "./firmwareArchitectureScanner.js";

const buildMinimalElfHeader = (options: {
  readonly elfClass: 32 | 64;
  readonly littleEndian: boolean;
  readonly machine: number;
  readonly type?: number;
}): Buffer => {
  const size = options.elfClass === 32 ? 52 : 64;
  const buf = Buffer.alloc(size, 0);
  buf[0] = 0x7f;
  buf[1] = 0x45;
  buf[2] = 0x4c;
  buf[3] = 0x46;
  buf[4] = options.elfClass === 32 ? 1 : 2;
  buf[5] = options.littleEndian ? 1 : 2;
  buf[6] = 1;
  const write16 = options.littleEndian
    ? (offset: number, v: number) => buf.writeUInt16LE(v, offset)
    : (offset: number, v: number) => buf.writeUInt16BE(v, offset);
  const write32 = options.littleEndian
    ? (offset: number, v: number) => buf.writeUInt32LE(v, offset)
    : (offset: number, v: number) => buf.writeUInt32BE(v, offset);
  write16(16, options.type ?? 2);
  write16(18, options.machine);
  write32(20, 1);
  write16(options.elfClass === 32 ? 40 : 52, size);
  return buf;
};

const buildCortexMImage = (options?: {
  readonly baseAddress?: number;
  readonly headerPadBytes?: number;
}): Buffer => {
  const base = options?.baseAddress ?? 0x08000000;
  const pad = options?.headerPadBytes ?? 0;
  const image = Buffer.alloc(pad + 512, 0);
  if (pad > 0) image.fill(0xaa, 0, pad);
  const vt = pad;
  image.writeUInt32LE(0x20020000, vt + 0); // Initial SP in SRAM
  image.writeUInt32LE((base + vt + 0x100) | 1, vt + 4); // Reset
  image.writeUInt32LE((base + vt + 0x120) | 1, vt + 8); // NMI
  image.writeUInt32LE((base + vt + 0x124) | 1, vt + 12); // HardFault
  image.writeUInt32LE((base + vt + 0x130) | 1, vt + 44); // SVCall
  image.writeUInt32LE((base + vt + 0x138) | 1, vt + 56); // PendSV
  image.writeUInt32LE((base + vt + 0x140) | 1, vt + 60); // SysTick
  // Emit a few Thumb functions: push {r4, lr} (0xb510), nop (0xbf00), pop {r4, pc} (0xbd10), bx lr (0x4770)
  for (let i = 0; i < 6; i += 1) {
    const fnOff = vt + 0x100 + i * 8;
    image.writeUInt16LE(0xb510, fnOff);
    image.writeUInt16LE(0xbf00, fnOff + 2);
    image.writeUInt16LE(0xbd10, fnOff + 4);
    image.writeUInt16LE(0x4770, fnOff + 6);
  }
  return image;
};

describe("scanFirmwareArchitectureCandidates", () => {
  it("parses embedded U-Boot uImage headers at non-zero offsets and qualifies payload-relative addresses", async () => {
    const prefix = Buffer.alloc(256, 0xff);
    // arch=5 (mips), compression=3 (lzma)
    const uimage = buildUImage({
      arch: 5,
      compression: 3,
      loadAddress: 0x80010000,
      entryPoint: 0x80010400,
      name: "OpenWrt MIPS Kernel",
      payload: Buffer.from("compressed-payload-bytes"),
    });
    const combined = Buffer.concat([prefix, uimage]);
    const report = await scanFirmwareArchitectureCandidates({
      artifact: {
        path: "/tmp/router.bin",
        sha256: "a".repeat(64),
        bytes: combined.length,
      },
      prefixBytes: combined,
    });

    expect(firmwareArchitectureCandidatesSchema.safeParse(report).success).toBe(
      true,
    );
    expect(report.status).toBe("candidates_found");
    expect(report.uimage_headers.total).toBe(1);
    expect(report.uimage_headers.items[0]).toMatchObject({
      file_offset: 256,
      header_end: 320,
      raw_ih_arch: 5,
      ih_arch_name: "mips",
      raw_ih_comp: 3,
      ih_comp_name: "lzma",
      load_address: "0x80010000",
      entry_point: "0x80010400",
      image_name: "OpenWrt MIPS Kernel",
    });
    expect(report.uimage_headers.items[0]?.payload_mapping_note).toContain(
      "after the 64-byte uImage header",
    );
    expect(report.candidates[0]).toMatchObject({
      rank: 1,
      cpu_family: "mips",
      word_size: 32,
      byte_order: "unknown",
      detector: "uimage-header",
      confidence: "derived",
      raw_binary_support: {
        admitted_today: false,
        open_binary_arguments: null,
        rizin_decoder_hint: { asm_arch: "mips", asm_bits: 32 },
      },
    });
  });

  it("tallies embedded ELF headers and reports mixed rather than a false winner when tied", async () => {
    const mipsBe1 = buildMinimalElfHeader({
      elfClass: 32,
      littleEndian: false,
      machine: 8, // EM_MIPS
    });
    const mipsBe2 = buildMinimalElfHeader({
      elfClass: 32,
      littleEndian: false,
      machine: 8,
    });
    const armLe = buildMinimalElfHeader({
      elfClass: 32,
      littleEndian: true,
      machine: 40, // EM_ARM
    });

    const majorityBlob = Buffer.concat([
      Buffer.alloc(32, 0),
      mipsBe1,
      Buffer.alloc(64, 0),
      mipsBe2,
      Buffer.alloc(64, 0),
      armLe,
    ]);
    const majorityReport = await scanFirmwareArchitectureCandidates({
      artifact: {
        path: "/tmp/rootfs.bin",
        sha256: "b".repeat(64),
        bytes: majorityBlob.length,
      },
      prefixBytes: majorityBlob,
    });
    expect(majorityReport.elf_census.consensus).toBe("majority");
    expect(majorityReport.candidates[0]).toMatchObject({
      cpu_family: "mips",
      word_size: 32,
      byte_order: "big",
      detector: "embedded-elf-census",
      confidence: "observed",
    });

    const tiedBlob = Buffer.concat([mipsBe1, Buffer.alloc(32, 0), armLe]);
    const tiedReport = await scanFirmwareArchitectureCandidates({
      artifact: {
        path: "/tmp/mixed.bin",
        sha256: "c".repeat(64),
        bytes: tiedBlob.length,
      },
      prefixBytes: tiedBlob,
    });
    expect(tiedReport.elf_census.consensus).toBe("mixed");
    expect(
      tiedReport.candidates.some((c) => c.detector === "embedded-elf-census"),
    ).toBe(false);
    expect(
      tiedReport.limitations.some((l) => l.includes("no strict majority")),
    ).toBe(true);
  });
});

describe("scanFirmwareArchitectureCandidates Cortex-M vector tables", () => {
  it("detects ARM M-profile vector tables and derives STM32 0x08000000 and RP2040 0x10000000+0x100 load bases", async () => {
    const stm32 = buildCortexMImage({ baseAddress: 0x08000000 });
    const stmReport = await scanFirmwareArchitectureCandidates({
      artifact: {
        path: "/tmp/stm32.bin",
        sha256: "d".repeat(64),
        bytes: stm32.length,
      },
      prefixBytes: stm32,
    });
    const vtCandidate = stmReport.candidates.find(
      (c) => c.detector === "cortex-m-vector-table",
    );
    expect(vtCandidate).toBeDefined();
    expect(vtCandidate?.load_base_candidates?.[0]).toMatchObject({
      table_file_offset: 0,
      base_address: "0x8000000",
      vector_table_address: "0x8000000",
      initial_sp: "0x20020000",
      reset_code_address: "0x8000100",
    });
    expect(vtCandidate?.raw_binary_support).toMatchObject({
      admitted_today: true,
      open_binary_arguments: {
        format: "raw-binary",
        architecture: "arm",
        architecture_variant: "armv7-m",
        base_address: "0x8000000",
        entry_point_required: false,
      },
    });

    const rp2040 = buildCortexMImage({
      baseAddress: 0x10000000,
      headerPadBytes: 0x100, // 256-byte boot2 stage
    });
    const rpReport = await scanFirmwareArchitectureCandidates({
      artifact: {
        path: "/tmp/rp2040.bin",
        sha256: "e".repeat(64),
        bytes: rp2040.length,
      },
      prefixBytes: rp2040,
    });
    const rpVt = rpReport.candidates.find(
      (c) => c.detector === "cortex-m-vector-table",
    );
    expect(rpVt?.load_base_candidates?.[0]).toMatchObject({
      table_file_offset: 0x100,
      base_address: "0x10000000",
      vector_table_address: "0x10000100",
    });
    expect(rpVt?.raw_binary_support.open_binary_arguments).toMatchObject({
      base_address: "0x10000000",
      vector_table_address: "0x10000100",
    });
  });
});

describe("scanFirmwareArchitectureCandidates instruction census and controls", () => {
  it("identifies AArch64 and big-endian PowerPC blobs from prologue/return censuses with runner-up margins", async () => {
    const aarch64 = Buffer.alloc(128, 0);
    for (let i = 0; i < 5; i += 1) {
      const base = i * 16;
      aarch64.writeUInt32LE(0xa9bf7bfd, base); // stp x29, x30, [sp, #-16]!
      aarch64.writeUInt32LE(0xd503233f, base + 4); // paciasp
      aarch64.writeUInt32LE(0xd65f03c0, base + 8); // ret
    }
    const arm64Report = await scanFirmwareArchitectureCandidates({
      artifact: {
        path: "/tmp/bl31.bin",
        sha256: "1".repeat(64),
        bytes: aarch64.length,
      },
      prefixBytes: aarch64,
    });
    expect(arm64Report.instruction_census.leader_profile_id).toBe("arm64-le");
    expect(arm64Report.instruction_census.margin_hits).toBeGreaterThanOrEqual(
      10,
    );
    expect(arm64Report.candidates[0]).toMatchObject({
      cpu_family: "arm64",
      word_size: 64,
      byte_order: "little",
      detector: "instruction-signature-census",
      confidence: "inferred",
      raw_binary_support: {
        admitted_today: true,
        open_binary_arguments: {
          format: "raw-binary",
          architecture: "arm64",
          entry_point_required: true,
        },
      },
    });

    const ppc = Buffer.alloc(128, 0);
    for (let i = 0; i < 4; i += 1) {
      const base = i * 16;
      ppc.writeUInt32BE(0x9421ffe0, base); // stwu r1, -32(r1)
      ppc.writeUInt32BE(0x7c0802a6, base + 4); // mflr r0
      ppc.writeUInt32BE(0x4e800020, base + 8); // blr
    }
    const ppcReport = await scanFirmwareArchitectureCandidates({
      artifact: {
        path: "/tmp/uboot-ppc.bin",
        sha256: "2".repeat(64),
        bytes: ppc.length,
      },
      prefixBytes: ppc,
    });
    expect(ppcReport.instruction_census.leader_profile_id).toBe("powerpc-be");
    expect(ppcReport.candidates[0]).toMatchObject({
      cpu_family: "powerpc",
      byte_order: "big",
      raw_binary_support: { admitted_today: false },
    });
  });

  it("returns explicit unknown for deterministic PRNG, zero-filled, and 0xFF erased flash controls", async () => {
    const prng = Buffer.alloc(65536);
    let state = 0x12345678;
    for (let i = 0; i < prng.length; i += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      prng[i] = state & 0xff;
    }

    for (const [label, buf] of [
      ["prng", prng],
      ["zeros", Buffer.alloc(8192, 0x00)],
      ["erased", Buffer.alloc(8192, 0xff)],
    ] as const) {
      const report = await scanFirmwareArchitectureCandidates({
        artifact: {
          path: `/tmp/${label}.bin`,
          sha256: "f".repeat(64),
          bytes: buf.length,
        },
        prefixBytes: buf,
      });
      expect(report.status).toBe("unknown");
      expect(report.candidates).toEqual([]);
      expect(report.detectors).toHaveLength(4);
      expect(report.coverage).toEqual({
        status: "complete",
        examined_bytes: buf.length,
        total_bytes: buf.length,
      });
    }
  });

  it("maps m68k big-endian to raw-binary and leaves unknown-endianness arm unconfirmed", () => {
    expect(
      buildRawBinarySuggestion({
        cpuFamily: "m68k",
        byteOrder: "big",
        wordSize: 32,
      }),
    ).toMatchObject({
      admitted_today: true,
      open_binary_arguments: {
        format: "raw-binary",
        architecture: "m68k",
        entry_point_required: true,
      },
    });
    expect(
      buildRawBinarySuggestion({
        cpuFamily: "arm",
        byteOrder: "unknown",
        wordSize: 32,
      }),
    ).toMatchObject({
      admitted_today: false,
      open_binary_arguments: null,
    });
  });

  it("keeps census margins non-negative when an unqualified single-opcode run has more raw hits than a qualified profile", async () => {
    const blob = Buffer.alloc(128, 0);
    // 20 AArch64 `ret` words (single signature family -> unqualified)
    for (let i = 0; i < 20; i += 1) {
      blob.writeUInt32LE(0xd65f03c0, i * 4);
    }
    // 4 PowerPC prologue/return groups = 12 qualifying hits across 3 signature families
    for (let g = 0; g < 4; g += 1) {
      const base = 80 + g * 12;
      blob.writeUInt32BE(0x9421ffe0, base); // stwu r1, -32(r1)
      blob.writeUInt32BE(0x7c0802a6, base + 4); // mflr r0
      blob.writeUInt32BE(0x4e800020, base + 8); // blr
    }

    const report = await scanFirmwareArchitectureCandidates({
      artifact: {
        path: "/tmp/ppc-with-ret-padding.bin",
        sha256: "3".repeat(64),
        bytes: blob.length,
      },
      prefixBytes: blob,
    });

    expect(firmwareArchitectureCandidatesSchema.safeParse(report).success).toBe(
      true,
    );
    expect(report.instruction_census.leader_profile_id).toBe("powerpc-be");
    expect(report.instruction_census.runner_up_profile_id).toBeNull();
    expect(report.instruction_census.margin_hits).toBe(12);
    const arm64Profile = report.instruction_census.profiles.find(
      (p) => p.profile_id === "arm64-le",
    );
    expect(arm64Profile).toMatchObject({
      total_hits: 20,
      distinct_signatures_matched: 1,
      meets_threshold: false,
    });
  });

  it("leaves ARM profile and load addresses unresolved for census-only Thumb code without a vector table", async () => {
    const thumbOnly = Buffer.alloc(128, 0);
    for (let i = 0; i < 8; i += 1) {
      const off = i * 8;
      thumbOnly.writeUInt16LE(0xb510, off); // push {r4, lr}
      thumbOnly.writeUInt16LE(0xbf00, off + 2); // nop
      thumbOnly.writeUInt16LE(0xbd10, off + 4); // pop {r4, pc}
      thumbOnly.writeUInt16LE(0x4770, off + 6); // bx lr
    }

    const report = await scanFirmwareArchitectureCandidates({
      artifact: {
        path: "/tmp/thumb-fragment.bin",
        sha256: "4".repeat(64),
        bytes: thumbOnly.length,
      },
      prefixBytes: thumbOnly,
    });

    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0]).toMatchObject({
      cpu_family: "arm",
      isa_mode: "thumb",
      detector: "instruction-signature-census",
      raw_binary_support: {
        admitted_today: false,
        open_binary_arguments: null,
        rizin_decoder_hint: { asm_arch: "arm", asm_bits: 16 },
      },
    });
  });

  it("preserves unknown word size and omits fixed-width decoder hints for shared RV32/RV64 compressed instructions", async () => {
    const rvCompressed = Buffer.alloc(128, 0);
    for (let i = 0; i < 10; i += 1) {
      const off = i * 4;
      rvCompressed.writeUInt16LE(0x7179, off); // c.addi16sp sp, -32 (valid in RV32C and RV64C)
      rvCompressed.writeUInt16LE(0x8082, off + 2); // c.jr ra (valid in RV32C and RV64C)
    }

    const report = await scanFirmwareArchitectureCandidates({
      artifact: {
        path: "/tmp/rv64-fragment.bin",
        sha256: "5".repeat(64),
        bytes: rvCompressed.length,
      },
      prefixBytes: rvCompressed,
    });

    expect(firmwareArchitectureCandidatesSchema.safeParse(report).success).toBe(
      true,
    );
    expect(report.instruction_census.leader_profile_id).toBe("riscv-le");
    expect(report.candidates[0]).toMatchObject({
      cpu_family: "riscv",
      word_size: "unknown",
      byte_order: "little",
      detector: "instruction-signature-census",
      raw_binary_support: {
        admitted_today: false,
        open_binary_arguments: null,
        rizin_decoder_hint: null,
      },
    });

    const rv64Elf = buildMinimalElfHeader({
      elfClass: 64,
      littleEndian: true,
      machine: 243, // EM_RISCV
    });
    const elfReport = await scanFirmwareArchitectureCandidates({
      artifact: {
        path: "/tmp/rv64-elf.bin",
        sha256: "6".repeat(64),
        bytes: rv64Elf.length,
      },
      prefixBytes: rv64Elf,
    });
    expect(elfReport.candidates[0]).toMatchObject({
      cpu_family: "riscv",
      word_size: 64,
      detector: "embedded-elf-census",
      raw_binary_support: {
        rizin_decoder_hint: { asm_arch: "riscv", asm_bits: 64 },
      },
    });
  });
});

describe("scanFirmwareArchitectureCandidates bounded window and sampling invariants", () => {
  it("detects headers straddling 1 MiB scan windows without scanning unbounded buffer suffixes", async () => {
    const uimage = buildUImage({
      arch: 2, // arm
      compression: 0,
      loadAddress: 0x80008000,
      entryPoint: 0x80008000,
      payload: Buffer.alloc(16, 0),
    });
    const elf = buildMinimalElfHeader({
      elfClass: 64,
      littleEndian: true,
      machine: 183, // EM_AARCH64
    });

    const buf = Buffer.alloc(2 * HEADER_SCAN_WINDOW_BYTES + 256, 0xff);
    // Place 4-byte uImage magic across window 0 -> window 1 boundary (3 bytes in window 0, 1 byte in window 1)
    const straddleUImageOffset = HEADER_SCAN_WINDOW_BYTES - 3;
    uimage.copy(buf, straddleUImageOffset);
    // Place 4-byte ELF magic across window 1 -> window 2 boundary (1 byte in window 1, 3 bytes in window 2)
    const straddleElfOffset = 2 * HEADER_SCAN_WINDOW_BYTES - 1;
    elf.copy(buf, straddleElfOffset);

    let maxSubarrayLength = 0;
    const origSubarray = buf.subarray.bind(buf);
    const spy = vi.spyOn(buf, "subarray").mockImplementation((start, end) => {
      const slice = origSubarray(start, end);
      if (slice.length > maxSubarrayLength) maxSubarrayLength = slice.length;
      return slice;
    });

    let activeChecks = 0;
    const uimageResult = await scanUImageHeaders(buf, buf.length, () => {
      activeChecks += 1;
    });
    spy.mockRestore();

    expect(uimageResult.report.total).toBe(1);
    expect(uimageResult.report.items[0]?.file_offset).toBe(
      straddleUImageOffset,
    );
    expect(maxSubarrayLength).toBeLessThanOrEqual(HEADER_SCAN_WINDOW_BYTES + 4);
    expect(activeChecks).toBeGreaterThanOrEqual(4);

    const fullReport = await scanFirmwareArchitectureCandidates({
      artifact: {
        path: "/tmp/straddle.bin",
        sha256: "7".repeat(64),
        bytes: buf.length,
      },
      prefixBytes: buf,
    });
    expect(fullReport.uimage_headers.total).toBe(1);
    expect(fullReport.elf_census.total_valid_headers).toBe(1);
    expect(fullReport.elf_census.tallies[0]?.sample_locations[0]?.start).toBe(
      straddleElfOffset,
    );
  });

  it("proposes CPU families declared past the 64-item uImage display sample and reports omitted vector-table locations honestly", async () => {
    const armUImage = buildUImage({
      arch: 2, // arm
      compression: 0,
      loadAddress: 0x80008000,
      entryPoint: 0x80008000,
      payload: Buffer.alloc(0),
    });
    const mipsUImage = buildUImage({
      arch: 5, // mips
      compression: 0,
      loadAddress: 0x80010000,
      entryPoint: 0x80010000,
      payload: Buffer.alloc(0),
    });

    const parts: Buffer[] = [];
    for (let i = 0; i < MAX_RETAINED_UIMAGE_HEADERS; i += 1) {
      parts.push(armUImage);
    }
    parts.push(mipsUImage); // Header #65 with a distinct CPU family
    const multiUImageBlob = Buffer.concat(parts);

    const uimageReport = await scanFirmwareArchitectureCandidates({
      artifact: {
        path: "/tmp/65-uimages.bin",
        sha256: "8".repeat(64),
        bytes: multiUImageBlob.length,
      },
      prefixBytes: multiUImageBlob,
    });
    expect(uimageReport.uimage_headers.total).toBe(
      MAX_RETAINED_UIMAGE_HEADERS + 1,
    );
    expect(uimageReport.uimage_headers.items).toHaveLength(
      MAX_RETAINED_UIMAGE_HEADERS,
    );
    expect(uimageReport.uimage_headers.omitted).toBe(1);
    const uimageFamilies = uimageReport.candidates
      .filter((c) => c.detector === "uimage-header")
      .map((c) => c.cpu_family);
    expect(uimageFamilies).toEqual(["arm", "mips"]);
    const armCandidate = uimageReport.candidates.find(
      (c) => c.detector === "uimage-header" && c.cpu_family === "arm",
    );
    expect(armCandidate?.omitted_locations).toBe(
      MAX_RETAINED_UIMAGE_HEADERS - 16,
    );

    // Build 10 valid 128-byte aligned Cortex-M vector tables within a 4 KiB image
    const totalTables = MAX_RETAINED_VECTOR_TABLES + 2;
    const vtImage = Buffer.alloc(4096, 0);
    for (let t = 0; t < totalTables; t += 1) {
      const vt = t * 128;
      vtImage.writeUInt32LE(0x20020000, vt + 0); // Initial SP
      vtImage.writeUInt32LE((0x08000800 + t * 16) | 1, vt + 4); // Reset
      vtImage.writeUInt32LE((0x08000804 + t * 16) | 1, vt + 8); // NMI
      vtImage.writeUInt32LE((0x08000808 + t * 16) | 1, vt + 12); // HardFault
    }

    const vtReport = await scanFirmwareArchitectureCandidates({
      artifact: {
        path: "/tmp/multi-vt.bin",
        sha256: "9".repeat(64),
        bytes: vtImage.length,
      },
      prefixBytes: vtImage,
    });
    const vtDetector = vtReport.detectors.find(
      (d) => d.detector === "cortex-m-vector-table",
    );
    expect(vtDetector).toMatchObject({
      examined_bytes: vtImage.length,
      status: "matched",
    });
    expect(vtDetector?.detail).toContain(
      `Found ${String(totalTables)} candidate`,
    );
    const vtCandidate = vtReport.candidates.find(
      (c) => c.detector === "cortex-m-vector-table",
    );
    expect(vtCandidate?.load_base_candidates).toHaveLength(
      MAX_RETAINED_VECTOR_TABLES,
    );
    expect(vtCandidate?.locations).toHaveLength(MAX_RETAINED_VECTOR_TABLES);
    expect(vtCandidate?.omitted_locations).toBe(2);
  });
});
