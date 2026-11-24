import {
  readPeImage,
  type PeImageSection,
} from "../../domain/native/peImage.js";
import { MAX_INSPECT_PE_CERTIFICATE_ENTRIES } from "../../domain/native/peCertificates.js";
import { errorMessage } from "../../kernel/errorMessage.js";
import {
  calculateShannonEntropy,
  isLikelyPackedOrEncrypted,
} from "../ShannonEntropy.js";
import { parsePeCertificates } from "./PeCertificateParser.js";
import { parsePeRichHeader, type PeRichHeader } from "./PeRichHeaderParser.js";

export interface PeSectionInfo {
  readonly name: string;
  readonly virtualSize: number;
  readonly virtualAddress: number;
  readonly rawSize: number;
  readonly rawOffset: number;
  readonly characteristics: number;
  readonly entropy?: number | undefined;
  readonly isPackedOrEncrypted?: boolean | undefined;
  readonly isExecutable: boolean;
  readonly isWritable: boolean;
}

export interface PeDataDirectory {
  readonly name: string;
  readonly virtualAddress: number;
  readonly size: number;
}

export interface PeAuthenticodeInfo {
  readonly fileOffset: number;
  readonly size: number;
  readonly revision?: number | undefined;
  readonly certificateType?: number | undefined;
}

export interface PeFormatReport {
  readonly machine: string;
  readonly machineCode: number;
  readonly is64Bit: boolean;
  readonly numberOfSections: number;
  readonly timestamp: Date;
  readonly entryPointRva: number;
  readonly imageBase: bigint;
  readonly subsystem: string;
  readonly subsystemCode: number;
  readonly dllCharacteristics: readonly string[];
  readonly sections: readonly PeSectionInfo[];
  readonly dataDirectories: readonly PeDataDirectory[];
  readonly richHeader?: PeRichHeader | undefined;
  readonly authenticode?: PeAuthenticodeInfo | undefined;
  readonly overallEntropy?: number | undefined;
  readonly limitations: readonly string[];
}

const MACHINE_NAMES: Readonly<Record<number, string>> = {
  0x014c: "i386 (32-bit x86)",
  0x8664: "AMD64 (64-bit x86-64)",
  0x01c0: "ARM",
  0xaa64: "ARM64",
  0x0200: "IA64 (Intel Itanium)",
};

const SUBSYSTEM_NAMES: Readonly<Record<number, string>> = {
  1: "NATIVE",
  2: "WINDOWS_GUI",
  3: "WINDOWS_CUI (Console)",
  7: "POSIX_CUI",
  9: "WINDOWS_CE_GUI",
  10: "EFI_APPLICATION",
  11: "EFI_BOOT_SERVICE_DRIVER",
  12: "EFI_RUNTIME_DRIVER",
  14: "XBOX",
};

const DATA_DIRECTORY_NAMES = [
  "EXPORT",
  "IMPORT",
  "RESOURCE",
  "EXCEPTION",
  "CERTIFICATE",
  "BASE_RELOC",
  "DEBUG",
  "ARCHITECTURE",
  "GLOBAL_PTR",
  "TLS",
  "LOAD_CONFIG",
  "BOUND_IMPORT",
  "IAT",
  "DELAY_IMPORT",
  "CLR_RUNTIME_HEADER",
  "RESERVED",
] as const;

const isExecutableSection = (characteristics: number): boolean =>
  (characteristics & 0x20000000) !== 0; // IMAGE_SCN_MEM_EXECUTE

const isWritableSection = (characteristics: number): boolean =>
  (characteristics & 0x80000000) !== 0; // IMAGE_SCN_MEM_WRITE

const decodeDllCharacteristics = (dllCharValue: number): string[] => {
  const flags: string[] = [];
  if ((dllCharValue & 0x0020) !== 0) flags.push("HIGH_ENTROPY_VA");
  if ((dllCharValue & 0x0040) !== 0) flags.push("DYNAMIC_BASE (ASLR)");
  if ((dllCharValue & 0x0100) !== 0) flags.push("NX_COMPAT (DEP)");
  if ((dllCharValue & 0x0400) !== 0) flags.push("NO_SEH");
  if ((dllCharValue & 0x4000) !== 0) flags.push("GUARD_CF");
  return flags;
};

export const MAX_TOTAL_SECTION_SCAN_BYTES = 64 * 1024 * 1024; // 64 MiB budget
const MAX_PE_SECTIONS = 1024;

const buildSectionInfo = (
  buffer: Buffer,
  peSections: readonly PeImageSection[],
): { sections: PeSectionInfo[]; scannedBytes: number } => {
  const sections: PeSectionInfo[] = [];
  const entropyCache = new Map<string, number>();
  let totalScannedBytes = 0;

  for (const sec of peSections) {
    const rawOffset = sec.raw_offset;
    const rawSize = sec.raw_size;
    const isRangeComplete =
      rawSize === 0 ||
      (rawOffset >= 0 &&
        rawOffset <= buffer.length &&
        rawOffset + rawSize <= buffer.length);

    let entropy: number | undefined;
    if (isRangeComplete) {
      const sectionBytes =
        rawSize > 0
          ? buffer.subarray(rawOffset, rawOffset + rawSize)
          : new Uint8Array(0);
      const rangeKey = `${rawOffset}:${sectionBytes.length}`;
      const cached = entropyCache.get(rangeKey);
      if (cached !== undefined) {
        entropy = cached;
      } else if (
        totalScannedBytes + sectionBytes.length <=
        MAX_TOTAL_SECTION_SCAN_BYTES
      ) {
        entropy = calculateShannonEntropy(sectionBytes);
        totalScannedBytes += sectionBytes.length;
        entropyCache.set(rangeKey, entropy);
      }
    }

    const isPacked =
      entropy !== undefined ? isLikelyPackedOrEncrypted(entropy) : undefined;

    sections.push({
      name: sec.name,
      virtualSize: sec.virtual_size,
      virtualAddress: sec.virtual_address,
      rawSize,
      rawOffset,
      characteristics: sec.characteristics,
      entropy: entropy !== undefined ? Number(entropy.toFixed(3)) : undefined,
      isPackedOrEncrypted: isPacked,
      isExecutable: isExecutableSection(sec.characteristics),
      isWritable: isWritableSection(sec.characteristics),
    });
  }

  return { sections, scannedBytes: totalScannedBytes };
};

const inspectAuthenticode = (
  buffer: Buffer,
): {
  readonly authenticode?: PeAuthenticodeInfo | undefined;
  readonly limitation?: string | undefined;
} => {
  try {
    const parsed = parsePeCertificates(
      buffer,
      { path: "<buffer>", sha256: "0".repeat(64), bytes: buffer.length },
      {
        path: "/buffer",
        max_file_bytes: Math.max(64, buffer.length),
        max_entries: MAX_INSPECT_PE_CERTIFICATE_ENTRIES,
      },
    );
    if (parsed.table === null || parsed.entries.length === 0) {
      return {};
    }
    const first = parsed.entries[0]!;
    return {
      authenticode: {
        fileOffset: parsed.table.location.offset,
        size: parsed.table.location.bytes,
        revision: first.revision,
        certificateType: first.certificate_type,
      },
    };
  } catch (cause: unknown) {
    return {
      limitation: `PE certificate table could not be decoded: ${errorMessage(cause)}`,
    };
  }
};

/**
 * Deep-inspect Windows PE executable (PE32 / PE32+) structures, entropy, and telemetry.
 * Delegates PE header and Authenticode table decoding to `readPeImage` and `parsePeCertificates`.
 */
export const inspectPeFormat = (buffer: Buffer): PeFormatReport | null => {
  let image;
  try {
    image = readPeImage(buffer, "headers");
  } catch {
    return null;
  }

  if (image.sections.length > MAX_PE_SECTIONS) {
    return null;
  }

  const limitations: string[] = image.pe_header_anomalies.map(
    (anomaly) => anomaly.message,
  );
  const dataDirectories: PeDataDirectory[] = image.pe_data_directories.map(
    (dir, index) => ({
      name: DATA_DIRECTORY_NAMES[index] ?? `DIR_${index}`,
      virtualAddress: dir.address,
      size: dir.size,
    }),
  );

  const { authenticode, limitation: certLimitation } =
    inspectAuthenticode(buffer);
  if (certLimitation !== undefined) {
    limitations.push(certLimitation);
  }

  const { sections, scannedBytes } = buildSectionInfo(buffer, image.sections);
  const overallEntropy =
    scannedBytes + buffer.length <= MAX_TOTAL_SECTION_SCAN_BYTES
      ? Number(calculateShannonEntropy(buffer).toFixed(3))
      : undefined;

  const machineCode = image.pe_machine;
  const subsystemCode = image.pe_subsystem;

  return {
    machine:
      MACHINE_NAMES[machineCode] ?? `Machine-0x${machineCode.toString(16)}`,
    machineCode,
    is64Bit: image.bits === 64,
    numberOfSections: image.sections.length,
    timestamp: new Date(image.pe_timestamp * 1000),
    entryPointRva: image.pe_entry_point_rva,
    imageBase: image.image_base,
    subsystem: SUBSYSTEM_NAMES[subsystemCode] ?? `Subsystem-${subsystemCode}`,
    subsystemCode,
    dllCharacteristics: decodeDllCharacteristics(image.dll_characteristics),
    sections,
    dataDirectories,
    richHeader: parsePeRichHeader(buffer) ?? undefined,
    authenticode,
    overallEntropy,
    limitations,
  };
};
