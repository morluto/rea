import {
  fitsPeRvaSpan as fitsRva,
  appendPeConsumedSpan as consume,
  PE_RVA_END,
} from "./PeRvaSpans.js";
import { createPefileReadCompatibility } from "./PefileReadCompatibility.js";
import { setImmediate } from "node:timers/promises";
import { assertArtifactReadActive } from "../../resources/index.js";
import {
  BinaryFormatFailure,
  BinaryMappingFailure,
  BinaryReader,
  BinaryResourceFailure,
  isBinaryFormatOrStringLimitFailure,
  createFileMappingIndex,
  imageFileMappings,
} from "../../domain/binaryContainer.js";
import {
  readPeImage,
  readPeImageFromReader,
  type PeImage,
} from "../../domain/native/peImage.js";
import {
  MAX_INSPECT_PE_IMPORT_RETAINED_TEXT_BYTES,
  type InspectPeImportsInput,
  type PeDelayImportDll,
  type PeImportDll,
  type PeImportFunction,
  type PeImportIssue,
  type PeImports,
} from "../../domain/native/peImports.js";
import {
  IMPORT_DESCRIPTOR_BYTES,
  PEFILE_MAX_IMPORT_SYMBOLS,
  pefileImphash,
} from "./pefileImphash.js";
import type { PrefixedByteSource } from "../../domain/byteSource.js";
import type { PeHeaderAnomaly } from "../../domain/native/peHeaderAnomalies.js";

type Artifact = PeImports["artifact"];

const PE_IMPORT_DIRECTORY = 1;
const PE_DELAY_IMPORT_DIRECTORY = 13;
const DELAY_DESCRIPTOR_BYTES = 32;
const MAXIMUM_NAME_BYTES = 4096;
/** Table entries decoded between event-loop yields and cancellation checks. */
const ENTRIES_PER_YIELD = 1024;
const ORDINAL_FLAG32 = 0x80000000n;
const ORDINAL_FLAG64 = 0x8000000000000000n;

const requireRva = (rva: number, size: number): void => {
  if (!fitsRva(rva, size))
    throw new BinaryFormatFailure(
      "malformed",
      `PE RVA ${hex(rva)} span of ${String(size)} bytes extends beyond the 32-bit RVA space`,
    );
};

const PE_LIMITATIONS = [
  "Rows reproduce the PE import and delay-load directories; they do not establish that an import is bound, forwarded or reachable at runtime.",
  "Bound import snapshots, the import address table as loaded, and export-forward resolution in another DLL remain unobserved.",
];

/** The parser-owned allowances an image can exhaust. */
export const PE_IMPORT_LIMITS = ["dlls", "functions", "retained_text"] as const;
export type PeImportLimit = (typeof PE_IMPORT_LIMITS)[number];

/** Consumers read the exhausted allowance with `binaryResourceAllowance`. */
const peImportLimit = (
  limit: PeImportLimit,
  allowance: number,
  message: string,
): BinaryResourceFailure =>
  new BinaryResourceFailure("structure", allowance, message, limit);

const hex = (value: bigint | number): string => `0x${value.toString(16)}`;

const dllBudget = (count: number, max: number): void => {
  if (count > max)
    throw peImportLimit(
      "dlls",
      max,
      `Import inventory declares ${String(count)} descriptors, above the ${String(max)}-entry DLL allowance`,
    );
};

const functionBudget = (count: number, max: number): void => {
  if (count > max)
    throw peImportLimit(
      "functions",
      max,
      `Import inventory declares ${String(count)} functions, above the ${String(max)}-entry function allowance`,
    );
};

const createRetention = () => {
  let text = 0;
  return (value: string): void => {
    text += value.length;
    if (text > MAX_INSPECT_PE_IMPORT_RETAINED_TEXT_BYTES)
      throw peImportLimit(
        "retained_text",
        MAX_INSPECT_PE_IMPORT_RETAINED_TEXT_BYTES,
        `Import names exceed the fixed ${String(MAX_INSPECT_PE_IMPORT_RETAINED_TEXT_BYTES)}-byte retained-text allowance`,
      );
  };
};

const failureMessage = (cause: unknown): string => {
  if (isBinaryFormatOrStringLimitFailure(cause)) return cause.message;
  throw cause;
};

const coverage = (
  issues: readonly PeImportIssue[],
  examinedDlls: number,
  imports: number,
  delayImports: number,
): PeImports["coverage"] =>
  issues.length === 0
    ? {
        status: "complete",
        reason: null,
        examined_dlls: examinedDlls,
        imports,
        delay_imports: delayImports,
      }
    : {
        status: "partial",
        reason: `${String(issues.length)} import table issue(s) affect reported rows or metadata; see issues`,
        examined_dlls: examinedDlls,
        imports,
        delay_imports: delayImports,
      };

const WINDOW_READ_BYTES = 4096;
// The lookup table, address table, and names can occupy different file ranges.
const RETAINED_WINDOWS = 3;

interface PeImportReader {
  readonly fileSize: number;
  readRange(offset: number, length: number): Promise<Buffer>;
  readPrefix(offset: number, maximum: number): Promise<Buffer>;
  u16(offset: number): Promise<number>;
  u32(offset: number): Promise<number>;
  word(offset: number, bits: 32 | 64): Promise<bigint>;
}

const createBufferPeImportReader = (bytes: Buffer): PeImportReader => {
  const reader = new BinaryReader(bytes, true, "pe");
  return {
    fileSize: bytes.length,
    readRange: async (offset, length) =>
      bytes.subarray(offset, offset + length),
    readPrefix: async (offset, maximum) =>
      bytes.subarray(offset, offset + maximum),
    u16: async (offset) => reader.u16(offset),
    u32: async (offset) => reader.u32(offset),
    word: async (offset, bits) => reader.word(offset, bits),
  };
};

const createHandlePeImportReader = (
  source: PrefixedByteSource,
): PeImportReader => {
  const prefix = new BinaryReader(source.prefix, true, "pe");
  const windows: Array<{
    readonly offset: number;
    readonly reader: BinaryReader;
  }> = [];

  const windowFor = async (offset: number, length: number) => {
    const end = offset + length;
    if (end <= source.prefix.length) return { offset: 0, reader: prefix };
    const hit = windows.findIndex(
      (window) =>
        offset >= window.offset &&
        end <= window.offset + window.reader.bytes.length,
    );
    const cached = windows[hit];
    if (cached !== undefined) {
      windows.splice(hit, 1);
      windows.unshift(cached);
      return cached;
    }
    const fetchLength = Math.min(
      Math.max(length, WINDOW_READ_BYTES),
      source.size - offset,
    );
    const window = {
      offset,
      reader: new BinaryReader(
        await source.readRange(offset, fetchLength),
        true,
        "pe",
      ),
    };
    if (fetchLength <= WINDOW_READ_BYTES) {
      windows.unshift(window);
      if (windows.length > RETAINED_WINDOWS) windows.pop();
    }
    return window;
  };

  return {
    fileSize: source.size,
    async readRange(offset, length) {
      if (length === 0) return Buffer.alloc(0);
      const window = await windowFor(offset, length);
      const rel = offset - window.offset;
      return window.reader.bytes.subarray(rel, rel + length);
    },
    async readPrefix(offset, maximum) {
      const window = await windowFor(offset, 1);
      const rel = offset - window.offset;
      return window.reader.bytes.subarray(rel, rel + maximum);
    },
    async u16(offset) {
      const window = await windowFor(offset, 2);
      return window.reader.u16(offset - window.offset);
    },
    async u32(offset) {
      const window = await windowFor(offset, 4);
      return window.reader.u32(offset - window.offset);
    },
    async word(offset, bits) {
      const window = await windowFor(offset, bits === 64 ? 8 : 4);
      return window.reader.word(offset - window.offset, bits);
    },
  };
};

const parsePeImportsCore = async (
  image: PeImage,
  reader: PeImportReader,
  artifact: Artifact,
  input: InspectPeImportsInput,
  signal?: AbortSignal,
): Promise<PeImports> => {
  const bits = image.bits;
  const base = image.image_base;
  const lookup = createFileMappingIndex(
    imageFileMappings(image),
    image.zero_fills,
  );
  const compatibleRead = createPefileReadCompatibility(image, reader.fileSize);
  let mappingCompatibility = true;
  const map = (rva: number, size: number): number => {
    requireRva(rva, size);
    const offset = lookup.offset(base + BigInt(rva), size);
    mappingCompatibility &&= compatibleRead(rva, size, offset);
    return offset;
  };
  const format = bits === 64 ? ("pe32-plus" as const) : ("pe32" as const);
  const result = {
    artifact,
    format,
    machine: image.pe_machine,
    bits,
    architecture: image.architecture,
  };
  const issues: PeImportIssue[] = [];
  const admitRva = (rva: number, size: number, label: string): boolean => {
    if (fitsRva(rva, size)) return true;
    issues.push({
      code: "malformed_entry",
      location: hex(rva),
      message: `${label} span of ${String(size)} bytes extends beyond the 32-bit RVA space`,
    });
    return false;
  };
  const mapDescriptor = (
    rva: number,
    size: number,
    label: string,
  ): number | null => {
    if (!admitRva(rva, size, label)) return null;
    try {
      return map(rva, size);
    } catch (cause) {
      if (!(cause instanceof BinaryMappingFailure)) throw cause;
      issues.push({
        code: "descriptor_unreadable",
        location: hex(rva),
        message: `${label}: ${cause.message}`,
      });
      return null;
    }
  };
  const retain = createRetention();
  let examinedDlls = 0;
  let examinedFunctions = 0;
  let entries = 0;
  const checkpoint = async (): Promise<void> => {
    await setImmediate();
    assertArtifactReadActive(signal);
  };

  const cString = async (rva: number): Promise<string> => {
    requireRva(rva, 1);
    const raw = await lookup.readCStringFromReader(
      (offset, maximum) => reader.readPrefix(offset, maximum),
      base + BigInt(rva),
      Math.min(MAXIMUM_NAME_BYTES, PE_RVA_END - rva - 1),
    );
    if (raw.length === 0)
      throw new BinaryFormatFailure(
        "malformed",
        `Import name at RVA ${hex(rva)} is empty`,
      );
    // CString decoding may span physically discontiguous sections. A pefile
    // hash is only justified when its single-section read sees the whole name.
    if (mappingCompatibility) {
      try {
        const size = raw.length + 1;
        const offset = lookup.offset(base + BigInt(rva), size);
        mappingCompatibility = compatibleRead(rva, size, offset);
      } catch (cause) {
        if (!(cause instanceof BinaryFormatFailure)) throw cause;
        mappingCompatibility = false;
      }
    }
    return raw.toString("latin1");
  };

  const readName = async (
    rva: number,
    label: string,
  ): Promise<string | null> => {
    try {
      const name = await cString(rva);
      retain(name);
      return name;
    } catch (cause) {
      issues.push({
        code: "name_unreadable",
        location: hex(rva),
        message: `${label}: ${failureMessage(cause)}`,
      });
      return null;
    }
  };

  const readFunctions = async (
    nameTableRva: number,
    addressTableRva: number,
  ): Promise<PeImportFunction[]> => {
    const thunkWidth = bits === 64 ? 8 : 4;
    const ordinalFlag = bits === 64 ? ORDINAL_FLAG64 : ORDINAL_FLAG32;
    const functions: PeImportFunction[] = [];
    for (let index = 0; ; index++) {
      if (++entries % ENTRIES_PER_YIELD === 0) await checkpoint();
      const nameRva = nameTableRva + index * thunkWidth;
      const iatRva = addressTableRva + index * thunkWidth;
      if (!admitRva(nameRva, thunkWidth, "Import lookup table")) break;
      let thunk: bigint;
      try {
        thunk = await reader.word(map(nameRva, thunkWidth), bits);
      } catch (cause) {
        issues.push({
          code: "thunk_unreadable",
          location: hex(nameRva),
          message: failureMessage(cause),
        });
        break;
      }
      if (thunk === 0n) break;
      if (!admitRva(iatRva, thunkWidth, "Import address table")) break;
      examinedFunctions += 1;
      functionBudget(examinedFunctions, input.max_functions);
      const thunkHex = thunk.toString(16);
      if ((thunk & ordinalFlag) !== 0n) {
        functions.push({
          hint: null,
          name: null,
          ordinal: Number(thunk & 0xffffn),
          ilt_rva: nameTableRva === addressTableRva ? null : nameRva,
          iat_rva: iatRva,
          thunk_hex: thunkHex,
        });
        continue;
      }
      if (thunk > 0x7fffffffn) {
        issues.push({
          code: "malformed_entry",
          location: `0x${thunkHex}`,
          message:
            "A named import thunk uses bits outside its 31-bit hint/name RVA",
        });
        continue;
      }
      const hintNameRva = Number(thunk);
      try {
        // The two-byte hint and the separately mapped name may occupy adjacent
        // RVA sections with different file translations.
        const hintAt = map(hintNameRva, 2);
        const hint = await reader.u16(hintAt);
        const name = await cString(hintNameRva + 2);
        retain(name);
        functions.push({
          hint,
          name,
          ordinal: null,
          ilt_rva: nameTableRva === addressTableRva ? null : nameRva,
          iat_rva: iatRva,
          thunk_hex: thunkHex,
        });
      } catch (cause) {
        issues.push({
          code: "name_unreadable",
          location: hex(hintNameRva),
          message: failureMessage(cause),
        });
      }
    }
    return functions;
  };

  // pefile counts every ILT and IAT thunk iteration against one image-wide cap
  // and silently truncates tables past it. Replay that count (reading IAT
  // entries only until the cap) to know when its import hash covers a prefix.
  let pefileThunkReads = 0;
  let pefileTruncatedDescriptor: number | null = null;
  const pefileTableWalk = async (
    rva: number,
    entries: number | null,
  ): Promise<number> => {
    if (entries !== null) {
      const remaining = PEFILE_MAX_IMPORT_SYMBOLS + 1 - pefileThunkReads;
      if (remaining <= 0) return 0;
      const steps = Math.min(entries + 1, remaining);
      pefileThunkReads += steps;
      return Math.min(entries, remaining);
    }
    const width = bits === 64 ? 8 : 4;
    let processed = 0;
    for (let index = 0; ; index++) {
      if (pefileThunkReads > PEFILE_MAX_IMPORT_SYMBOLS) break;
      pefileThunkReads += 1;
      let offset: number;
      try {
        offset = map(rva + index * width, width);
      } catch (cause) {
        if (!(cause instanceof BinaryFormatFailure)) throw cause;
        break;
      }
      const zero =
        width === 4
          ? (await reader.u32(offset)) === 0
          : (await reader.u32(offset)) === 0 &&
            (await reader.u32(offset + 4)) === 0;
      if (zero) break;
      processed += 1;
    }
    return processed;
  };
  const replayPefileSymbolCap = async (
    index: number,
    originalFirstThunk: number,
    firstThunk: number,
    entries: number,
  ): Promise<void> => {
    const table =
      originalFirstThunk === 0
        ? await pefileTableWalk(firstThunk, entries)
        : await pefileTableWalk(originalFirstThunk, entries);
    if (originalFirstThunk !== 0) await pefileTableWalk(firstThunk, null);
    if (table < entries) pefileTruncatedDescriptor ??= index;
  };

  const missingTable = (descriptorRva: number, message: string): [] => {
    issues.push({
      code: "malformed_entry",
      location: hex(descriptorRva),
      message,
    });
    return [];
  };

  const importDirectory = image.pe_data_directories?.[PE_IMPORT_DIRECTORY];
  const delayDirectory = image.pe_data_directories?.[PE_DELAY_IMPORT_DIRECTORY];
  const headerAnomalies: PeHeaderAnomaly[] = [...image.pe_header_anomalies];
  const sizeExceeded = new Set<object>();
  const imports: PeImportDll[] = [];
  let importDirectoryResult: PeImports["import_directory"] = null;
  if (importDirectory !== undefined && importDirectory.address !== 0) {
    const spans: { offset: number; bytes: number }[] = [];
    for (let index = 0; ; index++) {
      if (++entries % ENTRIES_PER_YIELD === 0) await checkpoint();
      const descriptorRva =
        importDirectory.address + index * IMPORT_DESCRIPTOR_BYTES;
      // The loader walks descriptors to the null terminator without
      // consulting Size, so neither does this walk.
      if (
        index * IMPORT_DESCRIPTOR_BYTES + IMPORT_DESCRIPTOR_BYTES >
          importDirectory.size &&
        !sizeExceeded.has(importDirectory)
      ) {
        sizeExceeded.add(importDirectory);
        headerAnomalies.push({
          code: "directory_size_below_structure",
          message: `Data directory ${String(importDirectory === importDirectory ? PE_IMPORT_DIRECTORY : PE_DELAY_IMPORT_DIRECTORY)} (import) declares Size ${String(importDirectory.size)}, which ends before descriptor ${String(index)}; the loader ignores this Size and reads descriptors to the null terminator, and so did this read.`,
        });
      }
      const descriptor = mapDescriptor(
        descriptorRva,
        IMPORT_DESCRIPTOR_BYTES,
        "Import descriptor",
      );
      if (descriptor === null) break;
      consume(spans, descriptor, IMPORT_DESCRIPTOR_BYTES);
      const originalFirstThunk = await reader.u32(descriptor);
      const timeDateStamp = await reader.u32(descriptor + 4);
      const forwarderChain = await reader.u32(descriptor + 8);
      const nameRva = await reader.u32(descriptor + 12);
      const firstThunk = await reader.u32(descriptor + 16);
      if (
        originalFirstThunk === 0 &&
        timeDateStamp === 0 &&
        forwarderChain === 0 &&
        nameRva === 0 &&
        firstThunk === 0
      )
        break;
      examinedDlls += 1;
      dllBudget(examinedDlls, input.max_dlls);
      const name = await readName(nameRva, "Import descriptor DLL name");
      const functions =
        firstThunk === 0
          ? missingTable(
              descriptorRva,
              originalFirstThunk === 0
                ? "Import descriptor declares neither a lookup table nor an import address table (FirstThunk is zero); its functions are unknown"
                : `Import descriptor has a zero FirstThunk (import address table RVA); its lookup table at ${hex(originalFirstThunk)} is not decoded`,
            )
          : await readFunctions(
              originalFirstThunk === 0 ? firstThunk : originalFirstThunk,
              firstThunk,
            );
      if (firstThunk !== 0)
        await replayPefileSymbolCap(
          index,
          originalFirstThunk,
          firstThunk,
          functions.length,
        );
      imports.push({
        index,
        name,
        name_rva: nameRva,
        original_first_thunk_rva: originalFirstThunk,
        first_thunk_rva: firstThunk,
        time_date_stamp: timeDateStamp,
        forwarder_chain: forwarderChain,
        location: {
          offset: descriptor,
          bytes: IMPORT_DESCRIPTOR_BYTES,
        },
        functions,
      });
    }
    importDirectoryResult = {
      rva: importDirectory.address,
      size: importDirectory.size,
      locations: spans,
    };
  }
  const standardIssues = issues.length;
  const standardMappingCompatibility = mappingCompatibility;

  const delayImports: PeDelayImportDll[] = [];
  let delayDirectoryResult: PeImports["delay_import_directory"] = null;
  if (delayDirectory !== undefined && delayDirectory.address !== 0) {
    const spans: { offset: number; bytes: number }[] = [];
    for (let index = 0; ; index++) {
      if (++entries % ENTRIES_PER_YIELD === 0) await checkpoint();
      const descriptorRva =
        delayDirectory.address + index * DELAY_DESCRIPTOR_BYTES;
      // The loader walks descriptors to the null terminator without
      // consulting Size, so neither does this walk.
      if (
        index * DELAY_DESCRIPTOR_BYTES + DELAY_DESCRIPTOR_BYTES >
          delayDirectory.size &&
        !sizeExceeded.has(delayDirectory)
      ) {
        sizeExceeded.add(delayDirectory);
        headerAnomalies.push({
          code: "directory_size_below_structure",
          message: `Data directory ${String(delayDirectory === importDirectory ? PE_IMPORT_DIRECTORY : PE_DELAY_IMPORT_DIRECTORY)} (delay-load import) declares Size ${String(delayDirectory.size)}, which ends before descriptor ${String(index)}; the loader ignores this Size and reads descriptors to the null terminator, and so did this read.`,
        });
      }
      const descriptor = mapDescriptor(
        descriptorRva,
        DELAY_DESCRIPTOR_BYTES,
        "Delay-load descriptor",
      );
      if (descriptor === null) break;
      consume(spans, descriptor, DELAY_DESCRIPTOR_BYTES);
      const attributes = await reader.u32(descriptor);
      const nameRva = await reader.u32(descriptor + 4);
      const moduleHandleRva = await reader.u32(descriptor + 8);
      const importAddressTableRva = await reader.u32(descriptor + 12);
      const importNameTableRva = await reader.u32(descriptor + 16);
      const boundImportRva = await reader.u32(descriptor + 20);
      const unloadInformationTableRva = await reader.u32(descriptor + 24);
      const timeDateStamp = await reader.u32(descriptor + 28);
      if (
        attributes === 0 &&
        nameRva === 0 &&
        moduleHandleRva === 0 &&
        importAddressTableRva === 0 &&
        importNameTableRva === 0 &&
        boundImportRva === 0 &&
        unloadInformationTableRva === 0 &&
        timeDateStamp === 0
      )
        break;
      examinedDlls += 1;
      dllBudget(examinedDlls, input.max_dlls);
      if ((attributes & 1) === 0) {
        issues.push({
          code: "unsupported_form",
          location: hex(descriptorRva),
          message:
            "Delay-load descriptor uses virtual addresses rather than RVAs; those entries are not decoded",
        });
        continue;
      }
      const name = await readName(nameRva, "Delay-load DLL name");
      delayImports.push({
        index,
        name,
        name_rva: nameRva,
        attributes,
        import_address_table_rva: importAddressTableRva,
        import_name_table_rva: importNameTableRva,
        bound_import_rva: boundImportRva,
        unload_information_table_rva: unloadInformationTableRva,
        module_handle_rva: moduleHandleRva,
        time_date_stamp: timeDateStamp,
        location: { offset: descriptor, bytes: DELAY_DESCRIPTOR_BYTES },
        functions:
          importAddressTableRva === 0
            ? missingTable(
                descriptorRva,
                "Delay-load descriptor has a zero import address table RVA; its functions are not decoded",
              )
            : importNameTableRva === 0
              ? missingTable(
                  descriptorRva,
                  "Delay-load descriptor has a zero import name table RVA; its address table holds loader thunks rather than names, so its functions are not decoded",
                )
              : await readFunctions(importNameTableRva, importAddressTableRva),
      });
    }
    delayDirectoryResult = {
      rva: delayDirectory.address,
      size: delayDirectory.size,
      locations: spans,
    };
  }

  const limitations =
    importDirectoryResult === null
      ? [
          "IMAGE_DIRECTORY_ENTRY_IMPORT is absent. That is not proof the image never imported APIs through another table or overlay.",
          ...PE_LIMITATIONS,
        ]
      : PE_LIMITATIONS;

  return {
    ...result,
    import_directory: importDirectoryResult,
    delay_import_directory: delayDirectoryResult,
    imports,
    delay_imports: delayImports,
    imphash: pefileImphash(imports, {
      standardIssues,
      mappingCompatibility: standardMappingCompatibility,
      truncatedDescriptor: pefileTruncatedDescriptor,
      bits,
      directoryRva: importDirectory?.address ?? 0,
      fileBytes: reader.fileSize,
    }),
    coverage: coverage(
      issues,
      examinedDlls,
      imports.reduce((count, dll) => count + dll.functions.length, 0),
      delayImports.reduce((count, dll) => count + dll.functions.length, 0),
    ),
    issues,
    header_anomalies: headerAnomalies,
    limitations,
  };
};

/**
 * Read PE import and delay-load directories without executing the image.
 * Yields to the event loop and honors cancellation every
 * `ENTRIES_PER_YIELD` descriptors or thunks.
 */
export const parsePeImports = async (
  bytes: Buffer,
  artifact: Artifact,
  input: InspectPeImportsInput,
  signal?: AbortSignal,
): Promise<PeImports> => {
  assertArtifactReadActive(signal);
  return parsePeImportsCore(
    readPeImage(bytes),
    createBufferPeImportReader(bytes),
    artifact,
    input,
    signal,
  );
};

/** Read PE import and delay-load directories positionally over a bounded file handle. */
export const parsePeImportsFromHandle = async (
  source: PrefixedByteSource,
  artifact: Artifact,
  input: InspectPeImportsInput,
  signal?: AbortSignal,
): Promise<PeImports> => {
  assertArtifactReadActive(signal);
  const reader = createHandlePeImportReader(source);
  const image = await readPeImageFromReader({
    size: source.size,
    prefix: source.prefix,
    readRange: (offset, length) => reader.readRange(offset, length),
  });
  return parsePeImportsCore(image, reader, artifact, input, signal);
};
