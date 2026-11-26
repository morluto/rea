import { readUint32At } from "../binaryContainer.js";
import { BoundedListCollector } from "../boundedList.js";
import { elfFixedHeaderWidth, readElfFixedHeader } from "../elfFixedHeader.js";
import {
  UIMAGE_HEADER_SIZE,
  parseUImageHeaderFields,
} from "../uimageFormat.js";
import type {
  CortexMLoadBaseCandidate,
  ElfMachineTally,
  FileOffsetRange,
  FirmwareByteOrder,
  FirmwareCpuFamily,
  FirmwareWordSize,
  UImageCandidateObservation,
} from "./firmwareArchitectureCandidates.js";

const UIMAGE_MAGIC_BYTES = Buffer.from([0x27, 0x05, 0x19, 0x56]);
const ELF_MAGIC_BYTES = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
export const HEADER_SCAN_WINDOW_BYTES = 1024 * 1024;
export const MAX_RETAINED_UIMAGE_HEADERS = 64;
export const MAX_RETAINED_VECTOR_TABLES = 8;
export const MAX_SAMPLE_LOCATIONS = 16;
export const MAX_VECTOR_SCAN_OFFSET = 65536;

const hex32 = (value: number): string => `0x${(value >>> 0).toString(16)}`;

export interface UImageArchTraits {
  readonly cpuFamily: FirmwareCpuFamily;
  readonly wordSize: FirmwareWordSize;
  readonly byteOrder: FirmwareByteOrder;
}

const UIMAGE_IGNORED_ARCH = new Set(["invalid", "sandbox", "unknown"]);
const UIMAGE_ARCH_MAP: Readonly<Record<string, UImageArchTraits>> = {
  arm: { cpuFamily: "arm", wordSize: 32, byteOrder: "unknown" },
  arm64: { cpuFamily: "arm64", wordSize: 64, byteOrder: "little" },
  x86: { cpuFamily: "x86", wordSize: 32, byteOrder: "little" },
  x86_64: { cpuFamily: "x86_64", wordSize: 64, byteOrder: "little" },
  mips: { cpuFamily: "mips", wordSize: 32, byteOrder: "unknown" },
  mips64: { cpuFamily: "mips64", wordSize: 64, byteOrder: "unknown" },
  ppc: { cpuFamily: "powerpc", wordSize: 32, byteOrder: "big" },
  riscv: { cpuFamily: "riscv", wordSize: "unknown", byteOrder: "little" },
  xtensa: { cpuFamily: "xtensa", wordSize: 32, byteOrder: "unknown" },
  m68k: { cpuFamily: "m68k", wordSize: 32, byteOrder: "big" },
  sh: { cpuFamily: "sh", wordSize: 32, byteOrder: "unknown" },
  sparc: { cpuFamily: "sparc", wordSize: 32, byteOrder: "big" },
  sparc64: { cpuFamily: "sparc64", wordSize: 64, byteOrder: "big" },
  microblaze: { cpuFamily: "microblaze", wordSize: 32, byteOrder: "unknown" },
  nios2: { cpuFamily: "nios2", wordSize: 32, byteOrder: "little" },
  arc: { cpuFamily: "arc", wordSize: 32, byteOrder: "unknown" },
  avr32: { cpuFamily: "avr32", wordSize: 32, byteOrder: "big" },
};

export const mapUImageArch = (archName: string): UImageArchTraits | null => {
  if (UIMAGE_IGNORED_ARCH.has(archName)) return null;
  return (
    UIMAGE_ARCH_MAP[archName] ?? {
      cpuFamily: "other",
      wordSize: "unknown",
      byteOrder: "unknown",
    }
  );
};

const ELF_ARCH_BY_NAME: Readonly<Record<string, FirmwareCpuFamily>> = {
  x86: "x86",
  x86_64: "x86_64",
  arm: "arm",
  arm64: "arm64",
  mips: "mips",
  powerpc: "powerpc",
  riscv: "riscv",
  xtensa: "xtensa",
  hexagon: "hexagon",
};

const ELF_ARCH_BY_MACHINE: Readonly<Record<number, FirmwareCpuFamily>> = {
  2: "sparc",
  4: "m68k",
  18: "sparc",
  42: "sh",
  43: "sparc64",
  113: "nios2",
  185: "avr32",
  189: "microblaze",
  195: "arc",
};

const mapElfCpuFamily = (
  machine: number,
  architecture: string | null,
): FirmwareCpuFamily => {
  if (architecture !== null && ELF_ARCH_BY_NAME[architecture] !== undefined) {
    return ELF_ARCH_BY_NAME[architecture];
  }
  return ELF_ARCH_BY_MACHINE[machine] ?? "other";
};

const scanMagicOffsets = async (options: {
  readonly bytes: Buffer;
  readonly limit: number;
  readonly magic: Buffer;
  readonly minRemaining: number;
  readonly onOffset: (offset: number) => void;
  readonly checkActive?: (() => void) | undefined;
}): Promise<void> => {
  const { bytes, limit, magic, minRemaining, onOffset, checkActive } = options;
  const maxStart = limit - minRemaining;
  if (maxStart < 0) return;
  for (
    // not-an-allowance: windowed byte scan cursor
    let winStart = 0;
    winStart <= maxStart;
    winStart += HEADER_SCAN_WINDOW_BYTES
  ) {
    if (winStart > 0) {
      checkActive?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      checkActive?.();
    }
    const lastStart = Math.min(
      maxStart,
      winStart + HEADER_SCAN_WINDOW_BYTES - 1,
    );
    const winSliceEnd = Math.min(limit, lastStart + magic.length);
    const windowView = bytes.subarray(winStart, winSliceEnd);
    let relIdx = windowView.indexOf(magic, 0);
    while (relIdx !== -1) {
      const absIdx = winStart + relIdx;
      if (absIdx <= lastStart) onOffset(absIdx);
      relIdx = windowView.indexOf(magic, relIdx + 1);
    }
  }
};

export interface UImageArchGroup {
  readonly ih_arch_name: string;
  readonly mapped: UImageArchTraits;
  readonly first: UImageCandidateObservation;
  readonly count: number;
  readonly sample_locations: readonly FileOffsetRange[];
  readonly omitted_locations: number;
}

interface UImageArchAccumulator {
  readonly ih_arch_name: string;
  readonly mapped: UImageArchTraits;
  readonly first: UImageCandidateObservation;
  // not-an-allowance: total verified uImage headers for this architecture
  count: number;
  readonly locations: BoundedListCollector<FileOffsetRange>;
}

export const scanUImageHeaders = async (
  bytes: Buffer,
  limit: number,
  checkActive?: () => void,
) => {
  const collector = new BoundedListCollector<UImageCandidateObservation>(
    MAX_RETAINED_UIMAGE_HEADERS,
  );
  const archMap = new Map<string, UImageArchAccumulator>();
  // not-an-allowance: total verified uImage headers found
  let total = 0;
  await scanMagicOffsets({
    bytes,
    limit,
    magic: UIMAGE_MAGIC_BYTES,
    minRemaining: UIMAGE_HEADER_SIZE,
    checkActive,
    onOffset: (offset) => {
      const parsed = parseUImageHeaderFields(
        bytes.subarray(offset, offset + UIMAGE_HEADER_SIZE),
      );
      if (!parsed.ok) return;
      const h = parsed.value;
      total += 1;
      const observation: UImageCandidateObservation = {
        file_offset: offset,
        header_end: offset + UIMAGE_HEADER_SIZE,
        raw_ih_arch: h.arch,
        ih_arch_name: `${h.archName}`,
        raw_ih_comp: h.compression,
        ih_comp_name: `${h.compressionName}`,
        ih_type_name: `${h.typeName}`,
        load_address: hex32(h.loadAddress),
        entry_point: hex32(h.entryPoint),
        payload_size: h.payloadSize,
        image_name: h.name === null ? null : `${h.name}`,
        payload_mapping_note: `load_address and entry_point describe the payload after the 64-byte uImage header (compression: ${h.compressionName}), not a file-offset-0 mapping of the input.`,
      };
      collector.push(observation);

      const mapped = mapUImageArch(observation.ih_arch_name);
      if (mapped !== null) {
        let acc = archMap.get(observation.ih_arch_name);
        if (acc === undefined) {
          acc = {
            ih_arch_name: observation.ih_arch_name,
            mapped,
            first: observation,
            count: 0,
            locations: new BoundedListCollector<FileOffsetRange>(
              MAX_SAMPLE_LOCATIONS,
            ),
          };
          archMap.set(observation.ih_arch_name, acc);
        }
        acc.count += 1;
        acc.locations.push({
          start: observation.file_offset,
          end: observation.header_end,
        });
      }
    },
  });
  const bounded = collector.toList();
  const archGroups: UImageArchGroup[] = [...archMap.values()].map((acc) => {
    const locs = acc.locations.toList();
    return {
      ih_arch_name: acc.ih_arch_name,
      mapped: acc.mapped,
      first: acc.first,
      count: acc.count,
      sample_locations: [...locs.items],
      omitted_locations: locs.omitted,
    };
  });
  return {
    report: { total, omitted: bounded.omitted, items: [...bounded.items] },
    archGroups,
  };
};

interface ElfBucket {
  readonly machine: number;
  readonly cpuFamily: FirmwareCpuFamily;
  readonly elfClass: 32 | 64;
  readonly byteOrder: "little" | "big";
  // not-an-allowance: valid ELF header tally
  count: number;
  readonly locations: BoundedListCollector<FileOffsetRange>;
}

export const scanEmbeddedElfHeaders = async (
  bytes: Buffer,
  limit: number,
  totalArtifactBytes: number,
  checkActive?: () => void,
) => {
  const buckets = new Map<string, ElfBucket>();
  // not-an-allowance: total valid ELF headers found
  let totalValid = 0;
  await scanMagicOffsets({
    bytes,
    limit,
    magic: ELF_MAGIC_BYTES,
    minRemaining: 52,
    checkActive,
    onOffset: (offset) => {
      const slice = bytes.subarray(offset, Math.min(limit, offset + 64));
      const parsed = readElfFixedHeader(slice, totalArtifactBytes - offset);
      if (!parsed.ok || parsed.value.machine === 0) return;
      const h = parsed.value;
      if (h.type === 0 || h.type > 4) return;
      totalValid += 1;
      const cpuFamily = mapElfCpuFamily(h.machine, h.architecture);
      const key = `${h.machine}:${h.elfClass}:${h.byteOrder}`;
      let bucket = buckets.get(key);
      if (bucket === undefined) {
        bucket = {
          machine: h.machine,
          cpuFamily,
          elfClass: h.elfClass,
          byteOrder: h.byteOrder,
          count: 0,
          locations: new BoundedListCollector<FileOffsetRange>(
            MAX_SAMPLE_LOCATIONS,
          ),
        };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      bucket.locations.push({
        start: offset,
        end: offset + elfFixedHeaderWidth(h.elfClass),
      });
    },
  });

  const tallies: ElfMachineTally[] = [...buckets.values()]
    .sort((a, b) =>
      b.count !== a.count ? b.count - a.count : a.machine - b.machine,
    )
    .map((b) => {
      const locs = b.locations.toList();
      return {
        machine: b.machine,
        cpu_family: b.cpuFamily,
        elf_class: b.elfClass,
        byte_order: b.byteOrder,
        count: b.count,
        sample_locations: [...locs.items],
        omitted_locations: locs.omitted,
      };
    });

  let consensus: "absent" | "unanimous" | "majority" | "mixed" = "absent";
  if (tallies.length === 1) consensus = "unanimous";
  else if (tallies.length > 1) {
    const top = tallies[0]!;
    const second = tallies[1]!;
    consensus =
      top.count * 2 > totalValid && top.count > second.count
        ? "majority"
        : "mixed";
  }
  return { total_valid_headers: totalValid, consensus, tallies };
};

const isCortexMSramPointer = (sp: number): boolean =>
  (sp & 3) === 0 &&
  ((sp >= 0x20000100 && sp <= 0x40000000) ||
    (sp >= 0x10000100 && sp <= 0x10040000));

const deriveCortexMBase = (
  minHandlerCode: number,
  resetCode: number,
  tableOffset: number,
  totalBytes: number,
): {
  readonly base: number;
  readonly basis: CortexMLoadBaseCandidate["basis"];
} | null => {
  for (const win of [0x08000000, 0x10000000, 0x00000000]) {
    if (
      minHandlerCode >= win + tableOffset + 8 &&
      resetCode >= win + tableOffset + 8 &&
      resetCode - win < totalBytes
    ) {
      return { base: win, basis: "standard-flash-window" };
    }
  }
  const pageAligned = (minHandlerCode - tableOffset) & ~0xffff;
  if (
    pageAligned >= 0 &&
    resetCode >= pageAligned + tableOffset + 8 &&
    resetCode - pageAligned < totalBytes
  ) {
    return { base: pageAligned >>> 0, basis: "page-aligned-minimum-handler" };
  }
  return null;
};

const probeVectorTableAt = (
  bytes: Buffer,
  offset: number,
  totalBytes: number,
): CortexMLoadBaseCandidate | null => {
  const sp = readUint32At(bytes, offset, true);
  const reset = readUint32At(bytes, offset + 4, true);
  if (!isCortexMSramPointer(sp)) return null;
  if ((reset & 1) !== 1 || reset === 0xffffffff) return null;
  const resetCode = (reset & ~1) >>> 0;
  if (resetCode >= 0x40000000) return null;

  for (const reservedIdx of [8, 9, 10]) {
    if (readUint32At(bytes, offset + reservedIdx * 4, true) !== 0) return null;
  }

  let validVectors = 1;
  let minHandler = resetCode;
  const resetRegion = (resetCode >>> 24) & 0xff;
  for (const idx of [2, 3, 11, 14, 15]) {
    const word = readUint32At(bytes, offset + idx * 4, true);
    if (word === 0) continue;
    if ((word & 1) !== 1 || word === 0xffffffff) return null;
    const codeAddr = (word & ~1) >>> 0;
    if (((codeAddr >>> 24) & 0xff) !== resetRegion) return null;
    validVectors += 1;
    if (codeAddr < minHandler) minHandler = codeAddr;
  }
  if (validVectors < 2) return null;

  const derived = deriveCortexMBase(minHandler, resetCode, offset, totalBytes);
  if (derived === null) return null;
  return {
    table_file_offset: offset,
    base_address: hex32(derived.base),
    vector_table_address: hex32((derived.base + offset) >>> 0),
    initial_sp: hex32(sp),
    reset_vector: hex32(reset),
    reset_code_address: hex32(resetCode),
    valid_exception_vectors: validVectors,
    basis: derived.basis,
  };
};

export interface CortexMVectorScanResult {
  readonly examined_bytes: number;
  readonly total: number;
  readonly omitted: number;
  readonly items: readonly CortexMLoadBaseCandidate[];
}

export const scanCortexMVectorTableCandidates = (
  bytes: Buffer,
  limit: number,
  totalBytes: number,
): CortexMVectorScanResult => {
  const cap = Math.min(limit, MAX_VECTOR_SCAN_OFFSET);
  const collector = new BoundedListCollector<CortexMLoadBaseCandidate>(
    MAX_RETAINED_VECTOR_TABLES,
  );
  // not-an-allowance: total qualifying vector tables across the examined prefix
  let total = 0;
  for (let offset = 0; offset + 64 <= cap; offset += 128) {
    const hit = probeVectorTableAt(bytes, offset, totalBytes);
    if (hit !== null) {
      total += 1;
      collector.push(hit);
    }
  }
  const bounded = collector.toList();
  return {
    examined_bytes: cap,
    total,
    omitted: bounded.omitted,
    items: [...bounded.items],
  };
};
