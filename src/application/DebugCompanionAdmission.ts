import { createHash } from "node:crypto";
import type { Dir, Stats } from "node:fs";
import { opendir, stat, type FileHandle } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import {
  findOverlappingFatSlices,
  readFatContainerHeader,
  readMachoHeaderPrefixFacts,
  validateFatSlice,
  type FatSliceDeclaration,
} from "../domain/apple/machoContainer.js";
import { machoCpuSubtypeBase } from "../domain/apple/machoCpuIdentity.js";
import {
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
} from "../domain/analysisErrorCore.js";
import type {
  BinaryArchitecture,
  MachODebugCompanion,
  UniversalMachOSlice,
  UniversalMachOSliceIdentity,
} from "../domain/binaryTargetTypes.js";
import { BinaryTargetError } from "../domain/configurationErrors.js";
import type { JsonValue } from "../domain/jsonValue.js";
import {
  machoUuidReads,
  matchMachOCompanionEntries,
  usableMachOUuid,
  type MachOImageUuid,
} from "../domain/machoDebugCompanion.js";
import { err, ok, type Result } from "../domain/result.js";
import { OwnedDirectoryHandle } from "../filesystem/OwnedDirectoryHandle.js";
import {
  OwnedRegularFileOperationFailure,
  RegularFileCleanupFailure,
  regularFileCancellation,
} from "../filesystem/OwnedRegularFile.js";
import {
  isSelectedRegularFileError,
  NonRegularFileReadError,
  RegularFileChangedError,
  RegularFileOperationCancelled,
  sameRegularFileState,
} from "../filesystem/RegularFile.js";
import {
  absoluteCallerPath,
  appendCallerPath,
} from "../filesystem/callerPath.js";
import {
  hasDuplicateMachoCpuSubtype,
  MACHO_ARCHITECTURE_POLICIES,
  selectRankedMachoSlice,
} from "../native/MachoArchitectureSelection.js";
import {
  RetainedRegularFileCleanupFailure,
  retryRegularFileCleanup,
  withRegularFileCompletion,
} from "./RegularFileRead.js";

const DSYM_DWARF_DIRECTORY = "Contents/Resources/DWARF";
const HEADER_READ_LIMIT = 64 * 1024;
const MEMBER_COUNT_LIMIT = 16;
const MEMBER_SIZE_LIMIT_BYTES = 1024 * 1024 * 1024;
const TRAVERSAL_BUDGET_BYTES = 64 * 1024 * 1024;
const FIXED_LIMIT_NOTICE =
  "This release has no runtime override; host memory and NODE_OPTIONS do not raise this limit.";
const COMPANION_IO_CODES = new Set([
  "EMFILE",
  "ENFILE",
  "EIO",
  "ENOSPC",
  "EROFS",
  "ETIMEDOUT",
  "ECONNRESET",
]);

/** Per-slice UUID observation with its declaring CPU type and base subtype. */
export interface SliceUuidEntry {
  readonly cpuType: number;
  readonly cpuSubtypeBase: number;
  readonly uuid: string | null;
}

/** Admitted identity of a caller-selected dSYM companion. */
export type DebugCompanionAdmission = Result<
  MachODebugCompanion,
  DebugCompanionRejection
>;

/** Why a caller-selected debug companion was refused, in caller-facing words. */
export interface DebugCompanionRejection {
  readonly reason: string;
  readonly remediationAction?: string;
  readonly diagnostics?: Readonly<Record<string, JsonValue>>;
}

interface MachOUuidReadFailure extends DebugCompanionRejection {
  readonly kind: "resource-limit" | "invalid-image";
}

interface TraversalLedger {
  spent: number;
}

interface TraversalContext {
  readonly ledger: TraversalLedger;
  readonly signal: AbortSignal | undefined;
}

interface SelectedSliceUuid {
  readonly cpuType: number;
  readonly cpuSubtypeBase: number;
  readonly uuid: string;
}

interface AdmissionState extends TraversalContext {
  readonly dsymPath: string;
  readonly targetPath: string;
  readonly architecture: BinaryArchitecture;
  readonly resources: ArtifactResourceScope | undefined;
  readonly digestedIdentities: Map<string, string>;
  digestBudgetBytes: number;
}

/** Convert a structured companion rejection into the public target error. */
export const debugCompanionRejectedError = (
  targetPath: string,
  rejection: DebugCompanionRejection,
): BinaryTargetError =>
  new BinaryTargetError(targetPath, rejection.reason, {
    constraint: "debug_companion_rejected",
    ...(rejection.remediationAction === undefined
      ? {}
      : { remediationAction: rejection.remediationAction }),
    ...(rejection.diagnostics === undefined
      ? {}
      : { diagnostics: rejection.diagnostics }),
  });

const traversalLimit = (): MachOUuidReadFailure => ({
  kind: "resource-limit",
  reason: `the Mach-O UUID traversal exceeds its aggregate read budget of ${String(TRAVERSAL_BUDGET_BYTES >> 20)} MiB (${String(TRAVERSAL_BUDGET_BYTES)} bytes) across the target and dSYM members; the budget is fixed and cannot be raised at runtime`,
  remediationAction: `Select a target and .dSYM bundle whose Mach-O header and load-command reads stay within the ${String(TRAVERSAL_BUDGET_BYTES >> 20)} MiB (${String(TRAVERSAL_BUDGET_BYTES)} bytes) UUID traversal budget, or omit dsym_path (--dsym-path on the CLI) to analyze without debug types. ${FIXED_LIMIT_NOTICE}`,
  diagnostics: {
    limit: "dsym_uuid_traversal_bytes",
    maximum_bytes: TRAVERSAL_BUDGET_BYTES,
    runtime_override: false,
  },
});

const directoryEntryLimit = (): DebugCompanionRejection => ({
  reason: `dsym_path contains more than ${String(MEMBER_COUNT_LIMIT)} DWARF directory entries; the limit is fixed and cannot be raised at runtime`,
  remediationAction: `Select a .dSYM bundle whose Contents/Resources/DWARF directory contains at most ${String(MEMBER_COUNT_LIMIT)} entries, or omit dsym_path (--dsym-path on the CLI) to analyze without debug types. ${FIXED_LIMIT_NOTICE}`,
  diagnostics: {
    limit: "dsym_dwarf_directory_entries",
    maximum_entries: MEMBER_COUNT_LIMIT,
    runtime_override: false,
  },
});

const memberSizeLimit = (
  memberPath: string,
  observedBytes: number,
): DebugCompanionRejection => ({
  reason: `dsym DWARF member exceeds the supported size of ${String(MEMBER_SIZE_LIMIT_BYTES >> 30)} GiB (${String(MEMBER_SIZE_LIMIT_BYTES)} bytes; the limit is fixed and cannot be raised at runtime): ${memberPath}`,
  remediationAction: `Select a .dSYM bundle whose matching DWARF member is at most ${String(MEMBER_SIZE_LIMIT_BYTES >> 30)} GiB (${String(MEMBER_SIZE_LIMIT_BYTES)} bytes), or omit dsym_path (--dsym-path on the CLI) to analyze without debug types. ${FIXED_LIMIT_NOTICE}`,
  diagnostics: {
    limit: "dsym_member_size_bytes",
    maximum_bytes: MEMBER_SIZE_LIMIT_BYTES,
    observed_bytes: observedBytes,
    member_path: memberPath,
    runtime_override: false,
  },
});

const aggregateDigestLimit = (): DebugCompanionRejection => ({
  reason: `the matching dSYM DWARF members exceed the aggregate digest budget of ${String(MEMBER_SIZE_LIMIT_BYTES >> 30)} GiB (${String(MEMBER_SIZE_LIMIT_BYTES)} bytes); the budget is fixed and cannot be raised at runtime`,
  remediationAction: `Remove duplicate or extra matching DWARF members so the distinct matching members in Contents/Resources/DWARF total at most ${String(MEMBER_SIZE_LIMIT_BYTES >> 30)} GiB (${String(MEMBER_SIZE_LIMIT_BYTES)} bytes), or omit dsym_path (--dsym-path on the CLI) to analyze without debug types. ${FIXED_LIMIT_NOTICE}`,
  diagnostics: {
    limit: "dsym_aggregate_digest_bytes",
    maximum_bytes: MEMBER_SIZE_LIMIT_BYTES,
    runtime_override: false,
  },
});

const invalidImage = (reason: string): MachOUuidReadFailure => ({
  kind: "invalid-image",
  reason,
});

const isExpectedAdmissionPathFailure = (cause: unknown): boolean =>
  cause instanceof Error &&
  "code" in cause &&
  ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(
    String(cause.code),
  );

const companionIoFailure = (
  resourcePath: string,
  description: string,
  cause: unknown,
  admitted = false,
): BinaryTargetError | undefined => {
  if (!(cause instanceof Error) || !("code" in cause)) return undefined;
  const code = String(cause.code);
  return admitted || COMPANION_IO_CODES.has(code)
    ? new BinaryTargetError(
        resourcePath,
        `${description} failed with ${code}`,
        { cause },
      )
    : undefined;
};

const throwIfCancelled = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true)
    throw new AnalysisCancelledError("resolve_binary_target", {
      cause: signal.reason,
    });
};

const readUuidWindow = async (
  handle: FileHandle,
  offset: number,
  length: number,
  context: TraversalContext,
): Promise<Result<Buffer, MachOUuidReadFailure>> => {
  const { ledger, signal } = context;
  throwIfCancelled(signal);
  if (length > TRAVERSAL_BUDGET_BYTES - ledger.spent)
    return err(traversalLimit());
  const bytes = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    throwIfCancelled(signal);
    const observed = await handle.read(
      bytes,
      filled,
      length - filled,
      offset + filled,
    );
    throwIfCancelled(signal);
    ledger.spent += observed.bytesRead;
    if (ledger.spent > TRAVERSAL_BUDGET_BYTES) return err(traversalLimit());
    if (observed.bytesRead === 0) break;
    filled += observed.bytesRead;
  }
  return ok(bytes.subarray(0, filled));
};

const readThinUuidEntry = async (
  handle: FileHandle,
  range: { readonly offset: number; readonly length: number },
  context: TraversalContext,
  prefix?: Buffer,
): Promise<Result<MachOImageUuid, MachOUuidReadFailure>> => {
  const decoder = machoUuidReads(range.length);
  let step = decoder.next();
  let windowOffset = 0;
  let window = prefix ?? Buffer.alloc(0);
  while (!step.done) {
    throwIfCancelled(context.signal);
    const req = step.value;
    const neededEnd = Math.min(range.length, req.offset + req.length);
    if (
      req.offset < range.length &&
      (req.offset < windowOffset || neededEnd > windowOffset + window.length)
    ) {
      const bufferedPrefix =
        req.offset >= windowOffset && req.offset < windowOffset + window.length
          ? window.subarray(req.offset - windowOffset)
          : Buffer.alloc(0);
      const unreadOffset = req.offset + bufferedPrefix.length;
      const neededUnread = neededEnd - unreadOffset;
      const remainingRange = range.length - unreadOffset;
      const desiredLength = Math.min(HEADER_READ_LIMIT, remainingRange);
      const remainingBudget = TRAVERSAL_BUDGET_BYTES - context.ledger.spent;
      if (remainingBudget < neededUnread) return err(traversalLimit());
      const read = await readUuidWindow(
        handle,
        range.offset + unreadOffset,
        Math.min(desiredLength, remainingBudget),
        context,
      );
      if (!read.ok) return read;
      windowOffset = req.offset;
      window =
        bufferedPrefix.length === 0
          ? read.value
          : Buffer.concat([bufferedPrefix, read.value]);
    }
    const slice =
      req.offset >= range.length
        ? Buffer.alloc(0)
        : window.subarray(
            req.offset - windowOffset,
            Math.min(window.length, neededEnd - windowOffset),
          );
    step = decoder.next(slice);
  }
  return step.value.ok ? step.value : err(invalidImage(step.value.error));
};

type ValidatedMachoContainer =
  | {
      readonly kind: "thin";
      readonly prefix: Buffer;
    }
  | {
      readonly kind: "fat";
      readonly prefix: Buffer;
      readonly tableEnd: number;
      readonly slices: readonly FatSliceDeclaration[];
    };

const readValidatedMachoContainer = async (
  handle: FileHandle,
  fileSize: number,
  context: TraversalContext,
): Promise<Result<ValidatedMachoContainer, MachOUuidReadFailure>> => {
  const remainingBudget = Math.max(
    0,
    TRAVERSAL_BUDGET_BYTES - context.ledger.spent,
  );
  const prefixLength = Math.min(fileSize, HEADER_READ_LIMIT, remainingBudget);
  const prefix = await readUuidWindow(handle, 0, prefixLength, context);
  if (!prefix.ok) return prefix;
  const container = readFatContainerHeader(prefix.value, fileSize);
  if (container.state === "not-fat")
    return ok({ kind: "thin", prefix: prefix.value });
  if (container.state === "needs-data")
    return err(
      prefixLength < container.requiredBytes
        ? traversalLimit()
        : invalidImage("the universal Mach-O container table is truncated"),
    );
  if (container.state === "malformed")
    return err(invalidImage(container.reason));
  for (const slice of container.slices) {
    throwIfCancelled(context.signal);
    const rangeIssue = validateFatSlice(slice, fileSize, container.tableEnd);
    if (rangeIssue !== null) return err(invalidImage(rangeIssue));
  }
  const overlap = findOverlappingFatSlices(container.slices);
  if (overlap !== null)
    return err(
      invalidImage(
        `FAT architectures ${overlap[0].index} and ${overlap[1].index} have overlapping slice ranges`,
      ),
    );
  return ok({
    kind: "fat",
    prefix: prefix.value,
    tableEnd: container.tableEnd,
    slices: container.slices,
  });
};

/**
 * Read every LC_UUID of a Mach-O file with its declaring CPU identity: a thin
 * image from its start, or each slice of a universal container from its table.
 */
export const readMachoFileUuidEntries = async (
  handle: FileHandle,
  fileSize: number,
  options: {
    readonly signal?: AbortSignal;
    readonly ledger?: TraversalLedger;
  } = {},
): Promise<Result<SliceUuidEntry[], MachOUuidReadFailure>> => {
  const context: TraversalContext = {
    ledger: options.ledger ?? { spent: 0 },
    signal: options.signal,
  };
  const container = await readValidatedMachoContainer(
    handle,
    fileSize,
    context,
  );
  if (!container.ok) return container;
  if (container.value.kind === "thin") {
    const read = await readThinUuidEntry(
      handle,
      { offset: 0, length: fileSize },
      context,
      container.value.prefix,
    );
    return read.ok
      ? ok([
          {
            cpuType: read.value.cpuType,
            cpuSubtypeBase: machoCpuSubtypeBase(read.value.cpuSubtype),
            uuid: read.value.uuid,
          },
        ])
      : read;
  }
  const entries: SliceUuidEntry[] = [];
  for (const slice of container.value.slices) {
    throwIfCancelled(context.signal);
    const read = await readThinUuidEntry(
      handle,
      { offset: slice.offset, length: slice.size },
      context,
    );
    if (!read.ok) return read;
    const idIssue = validateFatSlice(
      slice,
      fileSize,
      container.value.tableEnd,
      read.value,
    );
    if (idIssue !== null) return err(invalidImage(idIssue));
    entries.push({
      cpuType: slice.cpuType,
      cpuSubtypeBase: machoCpuSubtypeBase(slice.cpuSubtype),
      uuid: read.value.uuid,
    });
  }
  return ok(entries);
};

const digestOpenHandle = async (
  handle: FileHandle,
  initial: Stats,
  signal: AbortSignal | undefined,
): Promise<Result<string, string>> => {
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (position < initial.size) {
    throwIfCancelled(signal);
    const observed = await handle.read(chunk, 0, chunk.length, position);
    throwIfCancelled(signal);
    if (observed.bytesRead === 0) break;
    hash.update(chunk.subarray(0, observed.bytesRead));
    position += observed.bytesRead;
  }
  const opened = await handle.stat();
  throwIfCancelled(signal);
  return position === initial.size && sameRegularFileState(initial, opened)
    ? ok(hash.digest("hex"))
    : err("the dSYM DWARF member changed while being read");
};

const dwarfDirectoryCleanupPrimary = (
  state: AdmissionState,
  dwarfDirectory: string,
  outcome: {
    readonly failure: unknown;
    readonly rejection: DebugCompanionRejection | undefined;
  },
): AnalysisCancelledError | BinaryTargetError | undefined => {
  const { failure, rejection } = outcome;
  if (failure !== undefined) {
    return failure instanceof AnalysisCancelledError ||
      failure instanceof BinaryTargetError
      ? failure
      : new BinaryTargetError(
          dwarfDirectory,
          "Reading the dSYM DWARF directory failed before directory cleanup",
          { cause: failure },
        );
  }
  if (rejection !== undefined)
    return debugCompanionRejectedError(state.targetPath, rejection);
  if (state.signal?.aborted === true)
    return new AnalysisCancelledError("resolve_binary_target", {
      cause: state.signal.reason,
    });
  return undefined;
};

const closeDwarfDirectory = async (
  state: AdmissionState,
  directoryOwner: OwnedDirectoryHandle,
  dwarfDirectory: string,
  outcome: {
    readonly failure: unknown;
    readonly rejection: DebugCompanionRejection | undefined;
  },
): Promise<void> => {
  if (state.resources !== undefined) {
    const cleanup = await state.resources.release({
      kind: "directory-handle",
      handle: directoryOwner,
      resource: dwarfDirectory,
    });
    if (cleanup.kind === "failed") {
      const primary = dwarfDirectoryCleanupPrimary(
        state,
        dwarfDirectory,
        outcome,
      );
      throw state.resources.cleanupFailure(
        primary === undefined
          ? { kind: "completed" }
          : { kind: "failed", cause: primary },
        [cleanup],
      );
    }
    return;
  }
  const lease = AnalysisCleanupLease.forCloseOwner(
    directoryOwner,
    dwarfDirectory,
  );
  try {
    await lease.release();
  } catch (cause: unknown) {
    const primary = dwarfDirectoryCleanupPrimary(
      state,
      dwarfDirectory,
      outcome,
    );
    throw ArtifactReaderFailure.withCleanup(
      primary ?? cause,
      ArtifactReaderFailure.cleanupObservation(cause, dwarfDirectory),
      undefined,
      [lease],
    );
  }
};

const readDwarfDirectoryEntries = async (
  directory: Dir,
  dwarfDirectory: string,
  signal: AbortSignal | undefined,
): Promise<Result<string[], DebugCompanionRejection>> => {
  const memberPaths: string[] = [];
  let examinedEntries = 0;
  for (;;) {
    throwIfCancelled(signal);
    const entry = await directory.read();
    throwIfCancelled(signal);
    if (entry === null) return ok(memberPaths);
    examinedEntries += 1;
    if (examinedEntries > MEMBER_COUNT_LIMIT) return err(directoryEntryLimit());
    const memberPath = appendCallerPath(dwarfDirectory, entry.name);
    try {
      if ((await stat(memberPath)).isFile()) memberPaths.push(memberPath);
    } catch (cause: unknown) {
      if (isExpectedAdmissionPathFailure(cause)) continue;
      throw (
        companionIoFailure(
          memberPath,
          "reading the dSYM DWARF member",
          cause,
        ) ?? cause
      );
    }
  }
};

const enumerateDwarfMembers = async (
  state: AdmissionState,
): Promise<Result<string[], DebugCompanionRejection>> => {
  const dwarfDirectory = appendCallerPath(state.dsymPath, DSYM_DWARF_DIRECTORY);
  let directory: Dir;
  try {
    directory = await opendir(dwarfDirectory, {
      bufferSize: MEMBER_COUNT_LIMIT + 1,
    });
  } catch (cause: unknown) {
    if (!isExpectedAdmissionPathFailure(cause))
      throw (
        companionIoFailure(
          dwarfDirectory,
          "reading the dSYM DWARF directory",
          cause,
        ) ?? cause
      );
    throwIfCancelled(state.signal);
    return err({
      reason: `dsym_path has no Contents/Resources/DWARF member directory: ${state.dsymPath}`,
    });
  }
  const directoryOwner = new OwnedDirectoryHandle(directory);
  let memberPaths: string[] = [];
  let rejection: DebugCompanionRejection | undefined;
  let failure: unknown;
  try {
    const listed = await readDwarfDirectoryEntries(
      directory,
      dwarfDirectory,
      state.signal,
    );
    if (listed.ok) memberPaths = listed.value;
    else rejection = listed.error;
  } catch (cause: unknown) {
    failure =
      state.signal?.aborted === true && cause === state.signal.reason
        ? new AnalysisCancelledError("resolve_binary_target", { cause })
        : (companionIoFailure(
            dwarfDirectory,
            "reading the dSYM DWARF directory",
            cause,
          ) ?? cause);
  }
  if (
    failure === undefined &&
    rejection === undefined &&
    state.signal?.aborted !== true &&
    memberPaths.length === 0
  )
    rejection = {
      reason: `dsym_path contains no DWARF member file: ${state.dsymPath}`,
    };
  await closeDwarfDirectory(state, directoryOwner, dwarfDirectory, {
    failure,
    rejection,
  });
  if (failure !== undefined) throw failure;
  if (rejection !== undefined) return err(rejection);
  throwIfCancelled(state.signal);
  return ok(memberPaths.sort());
};

const ambiguousTargetSliceRejection = (
  state: AdmissionState,
  architecture: BinaryArchitecture,
): DebugCompanionRejection => ({
  reason: `the target image declares ambiguous FAT slices for ${architecture}`,
  diagnostics: {
    dsym_path: state.dsymPath,
    architecture,
    rejection: "ambiguous_target_slice",
  },
});

const targetUuidAbsentRejection = (
  state: AdmissionState,
  architecture: BinaryArchitecture,
): DebugCompanionRejection => ({
  reason: `the target image declares no usable LC_UUID for the selected ${architecture} slice`,
  diagnostics: {
    dsym_path: state.dsymPath,
    architecture,
    rejection: "target_uuid_absent",
  },
});

const validateProvidedTargetSlices = (
  declarations: readonly UniversalMachOSliceIdentity[],
  targetSize: number,
): Result<readonly UniversalMachOSliceIdentity[], MachOUuidReadFailure> => {
  if (declarations.length === 0)
    return err(invalidImage("FAT header declares no architectures"));
  for (const slice of declarations) {
    if (
      !Number.isSafeInteger(slice.offset) ||
      !Number.isSafeInteger(slice.size) ||
      slice.offset < 0 ||
      slice.size <= 0 ||
      slice.offset > targetSize ||
      slice.size > targetSize - slice.offset
    )
      return err(
        invalidImage(
          "the universal Mach-O slice range extends beyond the file",
        ),
      );
  }
  const overlap = findOverlappingFatSlices(declarations);
  if (overlap !== null)
    return err(
      invalidImage("universal Mach-O slices have overlapping byte ranges"),
    );
  return ok(declarations);
};

const inspectTargetContainerForSlice = async (
  handle: FileHandle,
  fileSize: number,
  context: TraversalContext,
): Promise<
  Result<
    | { readonly kind: "thin"; readonly prefix: Buffer }
    | {
        readonly kind: "fat";
        readonly prefix: Buffer;
        readonly slices: readonly UniversalMachOSliceIdentity[];
      },
    MachOUuidReadFailure
  >
> => {
  const container = await readValidatedMachoContainer(
    handle,
    fileSize,
    context,
  );
  if (!container.ok) return container;
  if (container.value.kind === "thin") return container;
  const validated: UniversalMachOSliceIdentity[] = [];
  for (const slice of container.value.slices) {
    throwIfCancelled(context.signal);
    if (slice.size < 12)
      return err(
        invalidImage(
          `FAT architecture ${slice.index} is shorter than its Mach-O header`,
        ),
      );
    let headerBytes: Buffer;
    if (slice.offset + 12 <= container.value.prefix.length) {
      headerBytes = container.value.prefix.subarray(
        slice.offset,
        slice.offset + 12,
      );
    } else {
      const headerRead = await readUuidWindow(
        handle,
        slice.offset,
        12,
        context,
      );
      if (!headerRead.ok) return headerRead;
      headerBytes = headerRead.value;
    }
    const facts = readMachoHeaderPrefixFacts(headerBytes);
    if (facts.identity === null)
      return err(
        invalidImage(
          `FAT architecture ${slice.index} does not start with a complete Mach-O header`,
        ),
      );
    const idIssue = validateFatSlice(
      slice,
      fileSize,
      container.value.tableEnd,
      facts.identity,
    );
    if (idIssue !== null) return err(invalidImage(idIssue));
    validated.push({
      offset: slice.offset,
      size: slice.size,
      cpuType: slice.cpuType,
      cpuSubtype: slice.cpuSubtype,
    });
  }
  return ok({
    kind: "fat",
    prefix: container.value.prefix,
    slices: validated,
  });
};

const selectTargetSliceUuid = async (
  input: {
    readonly targetHandle: FileHandle;
    readonly targetSize: number;
    readonly architecture: BinaryArchitecture;
    readonly targetSlice?: UniversalMachOSlice;
    readonly targetSlices?: readonly UniversalMachOSliceIdentity[];
  },
  state: AdmissionState,
): Promise<Result<SelectedSliceUuid, DebugCompanionRejection>> => {
  const policy = MACHO_ARCHITECTURE_POLICIES[input.architecture];
  if (input.targetSlice !== undefined) {
    let prefix: Buffer | undefined;
    let declarations: readonly UniversalMachOSliceIdentity[];
    if (input.targetSlices !== undefined) {
      const validated = validateProvidedTargetSlices(
        input.targetSlices,
        input.targetSize,
      );
      if (!validated.ok) return err(validated.error);
      declarations = validated.value;
    } else {
      const inspected = await inspectTargetContainerForSlice(
        input.targetHandle,
        input.targetSize,
        state,
      );
      if (!inspected.ok) return err(inspected.error);
      if (inspected.value.kind === "thin") {
        if (
          input.targetSlice.offset !== 0 ||
          input.targetSlice.size !== input.targetSize
        )
          return err(
            invalidImage(
              "the selected Mach-O target slice does not match the thin image bounds",
            ),
          );
        const thin = await readThinUuidEntry(
          input.targetHandle,
          { offset: 0, length: input.targetSize },
          state,
          inspected.value.prefix,
        );
        if (!thin.ok) return err(thin.error);
        if (
          policy !== undefined &&
          thin.value.cpuType === policy.cpuType &&
          usableMachOUuid(thin.value.uuid)
        )
          return ok({
            cpuType: thin.value.cpuType,
            cpuSubtypeBase: machoCpuSubtypeBase(thin.value.cpuSubtype),
            uuid: thin.value.uuid,
          });
        return err(targetUuidAbsentRejection(state, input.architecture));
      }
      prefix = inspected.value.prefix;
      declarations = inspected.value.slices;
    }
    const selectedDeclaration = declarations.find(
      (slice) =>
        slice.offset === input.targetSlice?.offset &&
        slice.size === input.targetSlice?.size,
    );
    if (selectedDeclaration === undefined)
      return err(
        invalidImage(
          "the selected Mach-O target slice is absent from the universal container table",
        ),
      );
    if (policy === undefined)
      return err(targetUuidAbsentRejection(state, input.architecture));
    if (hasDuplicateMachoCpuSubtype(policy.cpuType, declarations))
      return err(ambiguousTargetSliceRejection(state, input.architecture));
    if (selectedDeclaration.cpuType !== policy.cpuType)
      return err(targetUuidAbsentRejection(state, input.architecture));
    const slicePrefix =
      prefix !== undefined && selectedDeclaration.offset < prefix.length
        ? prefix.subarray(
            selectedDeclaration.offset,
            Math.min(
              prefix.length,
              selectedDeclaration.offset + selectedDeclaration.size,
            ),
          )
        : undefined;
    const selected = await readThinUuidEntry(
      input.targetHandle,
      {
        offset: selectedDeclaration.offset,
        length: selectedDeclaration.size,
      },
      state,
      slicePrefix,
    );
    if (!selected.ok) return err(selected.error);
    if (
      selected.value.cpuType !== selectedDeclaration.cpuType ||
      selected.value.cpuSubtype !== selectedDeclaration.cpuSubtype
    )
      return err(
        invalidImage(
          "the selected FAT slice CPU type/subtype disagrees with its Mach-O header",
        ),
      );
    return usableMachOUuid(selected.value.uuid)
      ? ok({
          cpuType: selected.value.cpuType,
          cpuSubtypeBase: machoCpuSubtypeBase(selected.value.cpuSubtype),
          uuid: selected.value.uuid,
        })
      : err(targetUuidAbsentRejection(state, input.architecture));
  }
  const targetEntries = await readMachoFileUuidEntries(
    input.targetHandle,
    input.targetSize,
    {
      ledger: state.ledger,
      ...(state.signal === undefined ? {} : { signal: state.signal }),
    },
  );
  if (!targetEntries.ok) return err(targetEntries.error);
  if (policy === undefined)
    return err(targetUuidAbsentRejection(state, input.architecture));
  if (hasDuplicateMachoCpuSubtype(policy.cpuType, targetEntries.value))
    return err(ambiguousTargetSliceRejection(state, input.architecture));
  const selection = selectRankedMachoSlice(policy, targetEntries.value);
  if (selection.status === "selected" && usableMachOUuid(selection.slice.uuid))
    return ok({
      cpuType: selection.slice.cpuType,
      cpuSubtypeBase: selection.slice.cpuSubtypeBase,
      uuid: selection.slice.uuid,
    });
  return err(targetUuidAbsentRejection(state, input.architecture));
};

type NormalizedMemberFailure =
  | { readonly kind: "skip" }
  | { readonly kind: "failed"; readonly cause: unknown };

const normalizeMemberFailure = (
  failureCause: unknown,
  memberPath: string,
  state: AdmissionState,
  memberAdmitted: boolean,
): NormalizedMemberFailure => {
  const rawCause =
    failureCause instanceof OwnedRegularFileOperationFailure
      ? failureCause.operationCause
      : failureCause;
  if (
    state.signal?.aborted === true &&
    (failureCause === state.signal.reason || rawCause === state.signal.reason)
  )
    return {
      kind: "failed",
      cause: new AnalysisCancelledError("resolve_binary_target", {
        cause: state.signal.reason,
      }),
    };
  if (
    rawCause instanceof AnalysisCancelledError ||
    rawCause instanceof AnalysisArtifactChangedError ||
    rawCause instanceof BinaryTargetError
  )
    return { kind: "failed", cause: rawCause };
  if (rawCause instanceof RegularFileOperationCancelled)
    return {
      kind: "failed",
      cause: new AnalysisCancelledError("resolve_binary_target", {
        cause: rawCause.reason,
      }),
    };
  if (
    rawCause instanceof RegularFileChangedError ||
    (memberAdmitted && isSelectedRegularFileError(rawCause))
  )
    return {
      kind: "failed",
      cause: new AnalysisArtifactChangedError(
        "open_binary",
        memberPath,
        "the dSYM DWARF member changed while being read",
        { cause: rawCause },
      ),
    };
  const ioFailure = companionIoFailure(
    memberPath,
    "reading the dSYM DWARF member",
    rawCause,
    memberAdmitted,
  );
  if (ioFailure !== undefined) return { kind: "failed", cause: ioFailure };
  if (
    !memberAdmitted &&
    (rawCause instanceof NonRegularFileReadError ||
      isExpectedAdmissionPathFailure(rawCause))
  ) {
    return state.signal?.aborted === true
      ? {
          kind: "failed",
          cause: new AnalysisCancelledError("resolve_binary_target", {
            cause: state.signal.reason,
          }),
        }
      : { kind: "skip" };
  }
  return { kind: "failed", cause: rawCause };
};

const normalizeMemberCleanupFailure = (
  failure: RegularFileCleanupFailure,
  memberPath: string,
  state: AdmissionState,
  memberAdmitted: boolean,
): RegularFileCleanupFailure<undefined> => {
  const rawOutcome = failure.outcome;
  let outcome:
    | { readonly kind: "completed"; readonly value: undefined }
    | { readonly kind: "failed"; readonly cause: unknown };
  if (rawOutcome.kind === "completed") {
    const result = rawOutcome.value as Result<
      MachODebugCompanion | null,
      DebugCompanionRejection
    >;
    outcome = result.ok
      ? { kind: "completed", value: undefined }
      : {
          kind: "failed",
          cause: debugCompanionRejectedError(state.targetPath, result.error),
        };
  } else {
    const normalized = normalizeMemberFailure(
      rawOutcome.cause,
      memberPath,
      state,
      memberAdmitted,
    );
    outcome =
      normalized.kind === "skip"
        ? { kind: "completed", value: undefined }
        : { kind: "failed", cause: normalized.cause };
  }
  const rebuilt = new RegularFileCleanupFailure({
    ...failure,
    outcome,
  });
  return failure instanceof RetainedRegularFileCleanupFailure
    ? new RetainedRegularFileCleanupFailure(rebuilt, failure)
    : rebuilt;
};

const readMemberWithBorrowedResources = async (
  memberPath: string,
  state: AdmissionState,
  read: (
    handle: FileHandle,
    initial: Stats,
  ) => Promise<Result<MachODebugCompanion | null, DebugCompanionRejection>>,
): Promise<Result<MachODebugCompanion | null, DebugCompanionRejection>> => {
  let memberAdmitted = false;
  try {
    const completion = await withRegularFileCompletion(
      memberPath,
      async (handle, initial) => {
        memberAdmitted = true;
        return await read(handle, initial);
      },
      {
        symlinks: "follow",
        ...(state.signal === undefined ? {} : { signal: state.signal }),
      },
    );
    if (!completion.value.ok) return completion.value;
    if (completion.cancellation !== undefined)
      throw new AnalysisCancelledError("resolve_binary_target", {
        cause: completion.cancellation.reason,
      });
    throwIfCancelled(state.signal);
    return completion.value;
  } catch (cause: unknown) {
    if (
      !(cause instanceof RegularFileCleanupFailure) ||
      (state.signal?.aborted === true && cause === state.signal.reason)
    ) {
      const normalized = normalizeMemberFailure(
        cause,
        memberPath,
        state,
        memberAdmitted,
      );
      if (normalized.kind === "failed") throw normalized.cause;
      return ok(null);
    }
    const normalized = normalizeMemberCleanupFailure(
      cause,
      memberPath,
      state,
      memberAdmitted,
    );
    if (state.resources === undefined)
      throw normalized instanceof RetainedRegularFileCleanupFailure
        ? normalized
        : new RetainedRegularFileCleanupFailure(normalized);
    const retried = await retryRegularFileCleanup(
      normalized,
      state.resources,
      state.signal,
    );
    if (retried.failure !== undefined) throw retried.failure;
    if (cause.outcome.kind === "failed") {
      // Every failure after openRegularFile admits the member (memberAdmitted === true)
      // produces normalized.outcome.kind === "failed" and rethrows here; ok(null) is
      // reached only when normalizeMemberFailure returned { kind: "skip" } for a
      // pre-admission NonRegularFileReadError / expected path failure and
      // retryRegularFileCleanup closed its handle.
      if (normalized.outcome.kind === "failed") throw normalized.outcome.cause;
      throwIfCancelled(state.signal);
      return ok(null);
    }
    const completed = cause.outcome.value as Result<
      MachODebugCompanion | null,
      DebugCompanionRejection
    >;
    if (!completed.ok) return completed;
    const cancellation = regularFileCancellation(cause);
    if (cancellation !== undefined)
      throw new AnalysisCancelledError("resolve_binary_target", {
        cause: cancellation.reason,
      });
    throwIfCancelled(state.signal);
    return completed;
  }
};

const memberDigestIdentityKey = async (
  memberHandle: FileHandle,
  initial: Stats,
  signal: AbortSignal | undefined,
): Promise<string | null> => {
  throwIfCancelled(signal);
  const exact = await memberHandle.stat({ bigint: true });
  throwIfCancelled(signal);
  if (
    !exact.isFile() ||
    exact.ino === 0n ||
    exact.size !== BigInt(initial.size)
  )
    return null;
  return `${exact.dev.toString()}:${exact.ino.toString()}:${exact.size.toString()}:${exact.mtimeNs.toString()}:${exact.ctimeNs.toString()}`;
};

const inspectMemberHandle = async (
  memberPath: string,
  member: { readonly handle: FileHandle; readonly initial: Stats },
  selected: SelectedSliceUuid,
  state: AdmissionState,
): Promise<Result<MachODebugCompanion | null, DebugCompanionRejection>> => {
  const { handle: memberHandle, initial } = member;
  const memberEntries = await readMachoFileUuidEntries(
    memberHandle,
    initial.size,
    {
      ledger: state.ledger,
      ...(state.signal === undefined ? {} : { signal: state.signal }),
    },
  );
  if (!memberEntries.ok)
    return memberEntries.error.kind === "resource-limit"
      ? err(memberEntries.error)
      : ok(null);
  const matched = matchMachOCompanionEntries(selected, memberEntries.value);
  if (!matched.ok || matched.value.status === "no-match") return ok(null);
  if (matched.value.status === "ambiguous-slice")
    return err({
      reason: `dsym DWARF member declares duplicate slices for the selected ${state.architecture} CPU identity, leaving the matching slice ambiguous: ${memberPath}`,
      diagnostics: {
        dsym_path: state.dsymPath,
        member_path: memberPath,
        architecture: state.architecture,
        target_uuid: selected.uuid,
        rejection: "ambiguous_member_slice",
      },
    });
  if (initial.size > MEMBER_SIZE_LIMIT_BYTES)
    return err(memberSizeLimit(memberPath, initial.size));
  const identityKey = await memberDigestIdentityKey(
    memberHandle,
    initial,
    state.signal,
  );
  let memberSha256Value =
    identityKey === null
      ? undefined
      : state.digestedIdentities.get(identityKey);
  if (memberSha256Value === undefined) {
    if (initial.size > state.digestBudgetBytes)
      return err(aggregateDigestLimit());
    const memberSha256 = await digestOpenHandle(
      memberHandle,
      initial,
      state.signal,
    );
    if (!memberSha256.ok)
      throw new AnalysisArtifactChangedError(
        "open_binary",
        memberPath,
        memberSha256.error,
      );
    state.digestBudgetBytes -= initial.size;
    if (identityKey !== null)
      state.digestedIdentities.set(identityKey, memberSha256.value);
    memberSha256Value = memberSha256.value;
  }
  return ok({
    sourcePath: state.dsymPath,
    memberPath,
    memberSha256: memberSha256Value,
    memberSizeBytes: initial.size,
    uuid: matched.value.uuid,
  });
};

const isDsymBundlePath = (dsymPath: string): boolean =>
  extname(basename(absoluteCallerPath(dsymPath))) === ".dSYM";

const notDsymBundleRejection = (dsymPath: string): DebugCompanionRejection => ({
  reason: `dsym_path is not a .dSYM bundle directory: ${dsymPath}`,
  diagnostics: {
    dsym_path: dsymPath,
    rejection: "not_dsym_bundle",
  },
});

const validateDsymBundleDirectory = async (
  dsymPath: string,
  signal: AbortSignal | undefined,
): Promise<Result<null, DebugCompanionRejection>> => {
  throwIfCancelled(signal);
  if (!isAbsolute(dsymPath))
    return err({
      reason:
        "dsym_path must be an absolute local filesystem path to a .dSYM bundle",
    });
  if (!isDsymBundlePath(dsymPath)) return err(notDsymBundleRejection(dsymPath));
  let bundle: Stats;
  try {
    bundle = await stat(dsymPath);
  } catch (cause: unknown) {
    if (!isExpectedAdmissionPathFailure(cause))
      throw companionIoFailure(dsymPath, "reading dsym_path", cause) ?? cause;
    throwIfCancelled(signal);
    return err({ reason: `dsym_path is not readable: ${dsymPath}` });
  }
  throwIfCancelled(signal);
  return bundle.isDirectory()
    ? ok(null)
    : err(notDsymBundleRejection(dsymPath));
};

/**
 * Admit a caller-selected dSYM bundle for a detected Mach-O target: the
 * bundle must contain a DWARF member whose LC_UUID matches the UUID of the
 * target image slice REA selected for the requested architecture.
 */
export const admitDebugCompanion = async (input: {
  readonly dsymPath: string;
  readonly targetPath?: string;
  readonly targetHandle: FileHandle;
  readonly targetSize: number;
  readonly architecture: BinaryArchitecture;
  readonly targetSlice?: UniversalMachOSlice;
  readonly targetSlices?: readonly UniversalMachOSliceIdentity[];
  readonly resources?: ArtifactResourceScope;
  readonly signal?: AbortSignal;
}): Promise<DebugCompanionAdmission> => {
  const state: AdmissionState = {
    dsymPath: input.dsymPath,
    targetPath: input.targetPath ?? input.dsymPath,
    architecture: input.architecture,
    resources: input.resources,
    signal: input.signal,
    ledger: { spent: 0 },
    digestedIdentities: new Map<string, string>(),
    digestBudgetBytes: MEMBER_SIZE_LIMIT_BYTES,
  };
  const validBundle = await validateDsymBundleDirectory(
    state.dsymPath,
    state.signal,
  );
  if (!validBundle.ok) return validBundle;
  const memberPaths = await enumerateDwarfMembers(state);
  if (!memberPaths.ok) return memberPaths;
  const selected = await selectTargetSliceUuid(input, state);
  if (!selected.ok) return selected;
  let admitted: MachODebugCompanion | undefined;
  for (const memberPath of memberPaths.value) {
    throwIfCancelled(state.signal);
    const candidate = await readMemberWithBorrowedResources(
      memberPath,
      state,
      async (handle, initial) => {
        const inspected = await inspectMemberHandle(
          memberPath,
          { handle, initial },
          selected.value,
          state,
        );
        if (
          inspected.ok &&
          inspected.value !== null &&
          admitted !== undefined &&
          (admitted.memberSha256 !== inspected.value.memberSha256 ||
            admitted.memberSizeBytes !== inspected.value.memberSizeBytes)
        )
          return err({
            reason:
              "dsym_path contains conflicting DWARF members for the selected target UUID",
            diagnostics: {
              dsym_path: state.dsymPath,
              architecture: input.architecture,
              target_uuid: selected.value.uuid,
              rejection: "conflicting_matching_members",
            },
          });
        return inspected;
      },
    );
    if (!candidate.ok) return candidate;
    if (candidate.value !== null) admitted ??= candidate.value;
  }
  return admitted !== undefined
    ? ok(admitted)
    : err({
        reason:
          "dsym_path contains no Mach-O DWARF member whose LC_UUID matches the selected target slice",
        diagnostics: {
          dsym_path: state.dsymPath,
          architecture: input.architecture,
          target_uuid: selected.value.uuid,
          rejection: "uuid_mismatch",
        },
      });
};
