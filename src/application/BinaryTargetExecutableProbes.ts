import type { FileHandle } from "node:fs/promises";
import { cancelledBy } from "../domain/analysisErrorCore.js";
import {
  hasJvmClassHeader,
  isJvmClassFile,
  MAX_JVM_CLASS_IDENTITY_BYTES,
} from "../domain/apple/jvmClassFile.js";
import {
  classifyFatContainerIdentity,
  readFatContainerHeader,
  readFatJvmIdentityLimitIssue,
  readFatSliceHeaders,
  type FatSliceHeaderEvidence,
} from "../domain/apple/machoContainer.js";
import {
  MachoLoadCommandCursor,
  readMachoLoadCommandTableHeader,
  type MachoLoadCommandTableHeader,
} from "../domain/apple/machoLoadCommands.js";
import {
  parseCodeViewData,
  parseExecutableHeader,
  parseMzExecutableMetadata,
  parsePeRecordFacts,
  peCodeViewDirectoryEntries,
  peDebugDirectoryEntry,
  peRvaToFileOffset,
  type ExecutableMetadata,
} from "../domain/binaryTarget.js";
import {
  PE_CODEVIEW_PREFIX_BYTES,
  type PeCodeViewRecord,
  type UniversalMachOSlice,
} from "../domain/binaryTargetTypes.js";
import {
  hasDosMzMagic,
  mzWindowsHeaderLayoutLimitation,
  parseMzHeaderEvidence,
  withMzWindowsHeaderSignature,
  type DosMzHeader,
  type MzHeaderEvidence,
  type MzWindowsHeaderObservation,
} from "../domain/dosMz.js";
import {
  validateElfDeclaredRanges,
  type ElfDeclarationRead,
} from "../domain/elfDeclaredRanges.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { readPeCoffHeader } from "../domain/peCoffHeader.js";
import { err, ok, type Result } from "../domain/result.js";
import { readRiscvElfDeclarations } from "../domain/riscvIsaDeclaration.js";
import { readFileHandleRange } from "../filesystem/readFileHandleRange.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";
import { readMipsElfMetadata } from "./MipsElfMetadata.js";

export type ExecutableMetadataFailure =
  | string
  | {
      readonly reason: string;
      readonly diagnostics: Readonly<Record<string, JsonValue>>;
    };

export const throwIfTargetResolutionCancelled = (
  signal?: AbortSignal,
): void => {
  if (signal?.aborted === true)
    throw cancelledBy("resolve_binary_target", signal);
};

/** Fill one bounded range, honoring cancellation; a short result means end of file. */
export const readHandleRange = async (
  handle: FileHandle,
  position: number,
  length: number,
  signal?: AbortSignal,
): Promise<Buffer> => {
  const bytes = await readFileHandleRange(handle, position, length, () =>
    throwIfTargetResolutionCancelled(signal),
  );
  throwIfTargetResolutionCancelled(signal);
  return bytes;
};

/** Probe native executable headers (MZ/PE, ELF, thin/FAT Mach-O) over a stable descriptor. */
export const readExecutableMetadata = async (
  source: StableRegularFileDescriptor,
  hostArchitecture: NodeJS.Architecture,
  signal?: AbortSignal,
): Promise<Result<ExecutableMetadata, ExecutableMetadataFailure>> => {
  const { handle, initial } = source;
  throwIfTargetResolutionCancelled(signal);
  const bytes = await readHandleRange(handle, 0, 4096, signal);
  // Header commitments such as Mach-O load commands and FAT slices are
  // checked against the whole file, not the probed prefix.
  const fileSize = initial.size;
  if (hasDosMzMagic(bytes)) {
    let evidence = parseMzHeaderEvidence(bytes, fileSize);
    let signatureEvidence:
      | { readonly offset: number; readonly bytes: Buffer }
      | undefined;
    if (evidence.windowsHeader.state === "signature-needed") {
      const { offset } = evidence.windowsHeader;
      signatureEvidence = {
        offset,
        bytes: await readHandleRange(
          handle,
          offset,
          Math.min(4, fileSize - offset),
          signal,
        ),
      };
      evidence = withMzWindowsHeaderSignature(
        bytes,
        fileSize,
        evidence,
        signatureEvidence,
      );
    }
    const { windowsHeader } = evidence;
    if (windowsHeader.state === "declared") {
      const limitation = mzWindowsHeaderLayoutLimitation(windowsHeader);
      if (limitation !== undefined)
        return err({
          reason: limitation,
          diagnostics: {
            unsupported_layout: true,
            mz_windows_header: { ...windowsHeader },
          },
        });
      return readPeMetadata(handle, windowsHeader.offset, {
        mzPrefix: bytes,
        fileSize,
        mzEvidence: evidence,
        signal,
      });
    }
    // MZ relocation records may extend past the initial probe; their format
    // bounds are at most 65535 records inside a 65535-paragraph header.
    const { relocationTableRead } = evidence;
    if (relocationTableRead !== undefined) {
      const observedBytes = await readHandleRange(
        handle,
        relocationTableRead.offset,
        relocationTableRead.byteLength,
        signal,
      );
      evidence = parseMzHeaderEvidence(
        observedBytes,
        fileSize,
        signatureEvidence,
      );
      if (evidence.windowsHeader.state === "candidate")
        return err(
          unresolvedMzHeaderFailure(evidence.windowsHeader, evidence.dos),
        );
      return parseMzExecutableMetadata(observedBytes, evidence);
    }
    if (windowsHeader.state === "candidate")
      return err(unresolvedMzHeaderFailure(windowsHeader, evidence.dos));
    return parseMzExecutableMetadata(bytes, evidence);
  }
  if (bytes.length >= 4 && bytes.toString("hex", 0, 4) === "7f454c46")
    return readElfMetadata(handle, bytes, {
      fileSize,
      hostArchitecture,
      signal,
    });
  const thin = await readThinMachoMetadata(handle, bytes, {
    fileSize,
    hostArchitecture,
    signal,
  });
  if (thin !== null) return thin;
  const mayBeJvmClass = hasJvmClassHeader(bytes);
  if (
    mayBeJvmClass &&
    fileSize > bytes.length &&
    fileSize <= MAX_JVM_CLASS_IDENTITY_BYTES
  ) {
    const complete = await readHandleRange(handle, 0, fileSize, signal);
    if (complete.byteLength === fileSize && isJvmClassFile(complete))
      return err("unsupported binary format");
  }
  const fatEvidence = await readFatSliceHeaderEvidence(
    handle,
    bytes,
    fileSize,
    signal,
  );
  if (
    mayBeJvmClass &&
    fileSize > MAX_JVM_CLASS_IDENTITY_BYTES &&
    fatEvidence !== undefined
  ) {
    const { header, sliceHeadersByOffset } = fatEvidence;
    const identity = classifyFatContainerIdentity(
      header,
      (offset) => sliceHeadersByOffset.get(offset)?.magic,
    );
    const limitIssue = await readFatJvmIdentityLimitIssue(
      header,
      identity,
      (offset, length) => readHandleRange(handle, offset, length, signal),
    );
    if (limitIssue !== null) return err(limitIssue);
  }
  const parsed = parseExecutableHeader(
    bytes,
    hostArchitecture,
    fileSize,
    undefined,
    fatEvidence,
  );
  if (
    parsed.ok &&
    parsed.value.format === "mach-o-universal" &&
    fatEvidence !== undefined
  ) {
    for (const slice of fatEvidence.header.slices) {
      const framed = await readMachoSliceCommandFrames(handle, slice, signal);
      if (!framed.ok) return framed;
    }
  }
  return parsed;
};

const ET_EXEC = 2;
const ET_DYN = 3;

/** ELF structure and family declarations share one descriptor before provider selection. */
const readElfMetadata = async (
  handle: FileHandle,
  bytes: Buffer,
  options: {
    readonly fileSize: number;
    readonly hostArchitecture: NodeJS.Architecture;
    readonly signal?: AbortSignal | undefined;
  },
): Promise<Result<ExecutableMetadata, ExecutableMetadataFailure>> => {
  const { fileSize, hostArchitecture, signal } = options;
  const parsed = parseExecutableHeader(bytes, hostArchitecture, fileSize);
  if (!parsed.ok || parsed.value.format !== "elf") return parsed;
  const ranges = await readElfDeclarations(
    handle,
    bytes,
    validateElfDeclaredRanges(bytes, fileSize),
    signal,
  );
  if (!ranges.ok) return ranges;
  if (parsed.value.architecture === "riscv")
    return ok({
      ...parsed.value,
      riscv: {
        ...parsed.value.riscv,
        ...(ranges.value.hasInterpreter ? { hasInterpreter: true } : {}),
        ...(await readElfDeclarations(
          handle,
          bytes,
          readRiscvElfDeclarations(bytes, fileSize, {
            // Executable section addresses are load addresses, offset by the
            // load base in a PIE; relocatable sections have no addresses yet.
            sectionOverlap:
              parsed.value.riscv.type === ET_EXEC ||
              parsed.value.riscv.type === ET_DYN,
          }),
          signal,
        )),
      },
    });
  if (parsed.value.architecture !== "mips" || parsed.value.mips.elfClass !== 32)
    return parsed;
  const declarations = await readMipsElfMetadata(
    handle,
    parsed.value.mips,
    () => throwIfTargetResolutionCancelled(signal),
  );
  if (!declarations.ok) return declarations;
  return ok({
    ...parsed.value,
    mips: {
      ...parsed.value.mips,
      abiFlags: declarations.value.abiFlags,
      gnuAttributes: declarations.value.gnuAttributes,
      ...(ranges.value.hasInterpreter ? { hasInterpreter: true } : {}),
      ...(declarations.value.sharedLoad === undefined
        ? {}
        : { sharedLoad: declarations.value.sharedLoad }),
      ...(declarations.value.limitations.length === 0
        ? {}
        : { limitations: declarations.value.limitations }),
    },
  });
};

/**
 * Satisfy one ELF declaration reader from the admitted descriptor. Every
 * request is at most one 64 KiB chunk, and the reader consumes each chunk
 * before its next request reuses the window.
 */
const readElfDeclarations = async <T>(
  handle: FileHandle,
  prefix: Buffer,
  steps: Generator<ElfDeclarationRead, T, Buffer>,
  signal?: AbortSignal,
): Promise<T> => {
  let next = steps.next();
  let window: Buffer | undefined;
  while (!next.done) {
    throwIfTargetResolutionCancelled(signal);
    const { offset, size } = next.value;
    let bytes: Buffer;
    if (offset + size <= prefix.length)
      bytes = prefix.subarray(offset, offset + size);
    else {
      window ??= Buffer.allocUnsafe(64 * 1024);
      bytes = window.subarray(0, size);
      let length = 0;
      while (length < size) {
        const read = await handle.read(
          bytes,
          length,
          size - length,
          offset + length,
        );
        throwIfTargetResolutionCancelled(signal);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      bytes = bytes.subarray(0, length);
    }
    next = steps.next(bytes);
  }
  return next.value;
};

const unresolvedMzHeaderFailure = (
  windowsHeader: Extract<MzWindowsHeaderObservation, { state: "candidate" }>,
  dos: Result<DosMzHeader, string>,
): Exclude<ExecutableMetadataFailure, string> => {
  return {
    reason: "MZ Windows new-header candidate is unresolved",
    diagnostics: {
      mz_windows_header: {
        state: windowsHeader.state,
        offset: windowsHeader.offset,
        signature: windowsHeader.signature,
      },
      mz_dos: dos.ok
        ? {
            state: "valid",
            header_bytes: dos.value.headerBytes,
            image_bytes: dos.value.imageBytes,
            module_bytes: dos.value.moduleBytes,
            overlay_bytes: dos.value.overlayBytes,
            relocation_count: dos.value.relocationCount,
            relocation_table_offset: dos.value.relocationTableOffset,
            entry_segment: dos.value.entrySegment,
            entry_offset: dos.value.entryOffset,
          }
        : { state: "invalid", reason: dos.error },
    },
  };
};

/** Establish a complete thin-command framing proof before provider admission. */
const readThinMachoMetadata = async (
  handle: FileHandle,
  prefix: Buffer,
  input: {
    readonly fileSize: number;
    readonly hostArchitecture: NodeJS.Architecture;
    readonly signal?: AbortSignal | undefined;
  },
): Promise<Result<ExecutableMetadata, string> | null> => {
  const table = readMachoLoadCommandTableHeader(prefix, input.fileSize);
  if (!table.ok) return table;
  if (table.value === null) return null;
  const parsed = parseExecutableHeader(
    prefix.subarray(0, table.value.headerSize),
    input.hostArchitecture,
    input.fileSize,
  );
  if (!parsed.ok) return parsed;
  const framed = await readMachoCommandFrames(handle, table.value, {
    prefix,
    fileSize: input.fileSize,
    signal: input.signal,
  });
  return framed.ok ? parsed : framed;
};

/** Walk thin command headers through one probe window, skipping payload bytes. */
const readMachoCommandFrames = async (
  handle: FileHandle,
  table: MachoLoadCommandTableHeader,
  input: {
    readonly prefix: Buffer;
    readonly fileSize: number;
    readonly fileOffset?: number | undefined;
    readonly signal?: AbortSignal | undefined;
  },
): Promise<Result<null, string>> => {
  const commands = new MachoLoadCommandCursor(table);
  let window = input.prefix;
  let windowOffset = 0;
  while (commands.nextOffset !== null) {
    const offset = table.headerSize + commands.nextOffset;
    if (
      offset + 8 <= input.fileSize &&
      (offset < windowOffset || offset + 8 > windowOffset + window.length)
    ) {
      windowOffset = offset;
      window = await readHandleRange(
        handle,
        (input.fileOffset ?? 0) + offset,
        Math.min(4096, input.fileSize - offset),
        input.signal,
      );
    }
    const relative = offset - windowOffset;
    const frame = commands.read(
      relative >= 0 ? window.subarray(relative, relative + 8) : Buffer.alloc(0),
    );
    if (!frame.ok) return frame;
  }
  return commands.finish();
};

/** Validate declared FAT slices after the canonical table/identity admission succeeds. */
const readMachoSliceCommandFrames = async (
  handle: FileHandle,
  slice: UniversalMachOSlice,
  signal?: AbortSignal,
): Promise<Result<null, string>> => {
  const bytes = await readHandleRange(
    handle,
    slice.offset,
    Math.min(4096, slice.size),
    signal,
  );
  const table = readMachoLoadCommandTableHeader(bytes, slice.size);
  if (!table.ok) return table;
  if (table.value === null)
    return err("FAT slice does not identify a thin Mach-O image");
  return readMachoCommandFrames(handle, table.value, {
    prefix: bytes,
    fileSize: slice.size,
    fileOffset: slice.offset,
    signal,
  });
};

/** Read the validated FAT table and bounded thin-header identity prefixes. */
const readFatSliceHeaderEvidence = async (
  handle: FileHandle,
  prefix: Buffer,
  fileSize: number,
  signal?: AbortSignal,
): Promise<FatSliceHeaderEvidence | undefined> => {
  let header = readFatContainerHeader(prefix, fileSize);
  if (header.state === "needs-data") {
    // readFatContainerHeader enforces the 128-entry format bound before this
    // allocation; this is only the table, never a synthesized file image.
    const table = await readHandleRange(
      handle,
      0,
      header.requiredBytes,
      signal,
    );
    header = readFatContainerHeader(table, fileSize);
  }
  if (header.state !== "parsed") return undefined;

  return readFatSliceHeaders(header, (offset, length) =>
    readHandleRange(handle, offset, length, signal),
  );
};

const readPeMetadata = async (
  handle: FileHandle,
  offset: number,
  {
    mzPrefix,
    fileSize,
    mzEvidence,
    signal,
  }: {
    readonly mzPrefix: Buffer;
    readonly fileSize: number;
    readonly mzEvidence: MzHeaderEvidence;
    readonly signal: AbortSignal | undefined;
  },
): Promise<Result<ExecutableMetadata, string>> => {
  throwIfTargetResolutionCancelled(signal);
  const fileHeader = await readHandleRange(handle, offset, 24, signal);
  if (fileHeader.length !== 24) return err("invalid or truncated PE header");
  const { windowsHeader } = withMzWindowsHeaderSignature(
    mzPrefix,
    fileSize,
    mzEvidence,
    { offset, bytes: fileHeader.subarray(0, 4) },
  );
  if (windowsHeader.state !== "declared")
    return err("invalid Windows new-header signature in MZ image");
  if (["NE", "LE", "LX"].includes(windowsHeader.signature))
    return err(`unsupported ${windowsHeader.signature} executable in MZ image`);
  const coff = readPeCoffHeader(fileHeader.subarray(4));
  if (!coff.ok) return err("invalid or truncated PE header");
  const optionalHeaderSize = coff.value.optionalHeaderSize;
  if (optionalHeaderSize > 4096) return err("invalid PE optional header size");
  const numberOfSections = coff.value.sectionCount;
  const record = await readHandleRange(
    handle,
    offset,
    24 + optionalHeaderSize,
    signal,
  );
  if (record.length !== 24 + optionalHeaderSize)
    return err("invalid or truncated PE header");
  const codeView = await readPeCodeView(
    handle,
    offset,
    numberOfSections,
    record.subarray(24),
    optionalHeaderSize,
    signal,
  );
  const parsed = parsePeRecordFacts(record, codeView);
  return parsed.ok ? ok(parsed.value.metadata) : parsed;
};

const readPeCodeView = async (
  handle: FileHandle,
  peOffset: number,
  numberOfSections: number,
  optionalHeader: Buffer,
  optionalHeaderSize: number,
  signal?: AbortSignal,
): Promise<PeCodeViewRecord | undefined> => {
  throwIfTargetResolutionCancelled(signal);
  const debugDir = peDebugDirectoryEntry(optionalHeader);
  if (debugDir === undefined || numberOfSections > 96) return undefined;
  const sectionTableOffset = peOffset + 24 + optionalHeaderSize;
  const sectionTableSize = numberOfSections * 40;
  const sectionTable = await readHandleRange(
    handle,
    sectionTableOffset,
    sectionTableSize,
    signal,
  );
  if (sectionTable.length !== sectionTableSize) return undefined;
  const debugFileOffset = peRvaToFileOffset(
    debugDir.debugRva,
    sectionTable,
    numberOfSections,
    debugDir.sizeOfHeaders,
    Math.min(debugDir.debugSize, 4096),
  );
  if (debugFileOffset === undefined) return undefined;
  const maxDebugSize = Math.min(debugDir.debugSize, 4096);
  const debugDirectoryBuffer = await readHandleRange(
    handle,
    debugFileOffset,
    maxDebugSize,
    signal,
  );
  for (const {
    fileOffset: pointerToRawData,
    declaredSize: sizeOfData,
  } of peCodeViewDirectoryEntries(
    debugDirectoryBuffer,
    sectionTable,
    numberOfSections,
    debugDir.sizeOfHeaders,
  )) {
    if (pointerToRawData === undefined) continue;
    const maxCodeViewRead = Math.min(sizeOfData, PE_CODEVIEW_PREFIX_BYTES);
    const codeViewBuffer = await readHandleRange(
      handle,
      pointerToRawData,
      maxCodeViewRead,
      signal,
    );
    const parsed = parseCodeViewData(codeViewBuffer, sizeOfData);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
};
