import { createHash } from "node:crypto";
import type { Dir, Stats } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { FileHandle } from "node:fs/promises";
import { OwnedDirectoryHandle } from "../filesystem/OwnedDirectoryHandle.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";

import { err, ok, type Result } from "../domain/result.js";
import {
  sameRegularFileState,
  NonRegularFileReadError,
  RegularFileChangedError,
} from "../filesystem/RegularFile.js";
import { withRegularFile } from "./RegularFileRead.js";
import { RegularFileCleanupFailure } from "../filesystem/OwnedRegularFile.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import {
  readFatContainerHeader,
  validateFatSlice,
} from "../domain/apple/machoContainer.js";
import type {
  BinaryArchitecture,
  MachODebugCompanion,
  UniversalMachOSlice,
} from "../domain/binaryTargetTypes.js";
import { MACHO_ARCHITECTURE_POLICIES } from "../native/MachoArchitectureSelection.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import {
  debugCompanionMatches,
  usableMachOUuid,
  machoUuidReads,
  type MachOImageUuid,
} from "../domain/machoDebugCompanion.js";

/**
 * Per-slice UUID observation: null marks a slice that declared no LC_UUID,
 * so family selection can honor the earlier slice instead of skipping it.
 */
export interface SliceUuidEntry {
  readonly cpuType: number;
  readonly uuid: string | null;
}

/** Keep workflow resource refusal distinct from malformed candidate data. */
interface MachOUuidReadFailure {
  readonly kind: "resource-limit" | "invalid-image";
  readonly reason: string;
}

const resourceLimit = (reason: string): MachOUuidReadFailure => ({
  kind: "resource-limit",
  reason,
});
const traversalLimit = (): MachOUuidReadFailure =>
  resourceLimit(
    `the Mach-O UUID traversal exceeds its aggregate read budget of ${String(TRAVERSAL_BUDGET_BYTES >> 20)} MiB across the target and dSYM members; the budget is fixed and cannot be raised at runtime`,
  );
const invalidImage = (reason: string): MachOUuidReadFailure => ({
  kind: "invalid-image",
  reason,
});

/** Bound on the bytes read to walk Mach-O headers and load commands. */
const HEADER_READ_LIMIT = 64 * 1024;

/** A real dSYM bundle carries one DWARF member per architecture; more is noise. */
const MEMBER_COUNT_LIMIT = 16;

/**
 * Member size admitted for hashing and staging. Real members scale with their
 * executable; one gibibyte covers shipped-app dSYMs while bounding private
 * runtime disk use before any copy starts.
 */
const MEMBER_SIZE_LIMIT_BYTES = 1024 * 1024 * 1024;

const DSYM_DWARF_DIRECTORY = join("Contents", "Resources", "DWARF");

const isExpectedAdmissionPathFailure = (cause: unknown): boolean =>
  cause instanceof Error &&
  "code" in cause &&
  ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(
    String(cause.code),
  );

/**
 * Mach-O cputypes for the provider-neutral CPU families REA admits, taken
 * from the shared architecture-selection owner (arm64_32 is 0x0200000c, not
 * arm64's 0x0100000c). Architectures without a Mach-O policy — MIPS, 6502,
 * RISCV, Hexagon, m68k, PowerPC — have no cputype, so a companion can never
 * match them.
 */
const machoFamilyCpuTypes = (
  architecture: BinaryArchitecture,
): readonly number[] => {
  const policy = MACHO_ARCHITECTURE_POLICIES[architecture];
  return policy === undefined ? [] : [policy.cpuType];
};
const CPU_TYPES: Readonly<Record<BinaryArchitecture, readonly number[]>> = {
  x86: machoFamilyCpuTypes("x86"),
  x86_64: machoFamilyCpuTypes("x86_64"),
  arm: machoFamilyCpuTypes("arm"),
  arm64: machoFamilyCpuTypes("arm64"),
  arm64_32: machoFamilyCpuTypes("arm64_32"),
  mips: machoFamilyCpuTypes("mips"),
  "6502": machoFamilyCpuTypes("6502"),
  riscv: machoFamilyCpuTypes("riscv"),
  hexagon: machoFamilyCpuTypes("hexagon"),
  m68k: machoFamilyCpuTypes("m68k"),
  powerpc: machoFamilyCpuTypes("powerpc"),
};

/** Admitted identity of a caller-selected dSYM companion. */
export type DebugCompanionAdmission = Result<
  MachODebugCompanion,
  DebugCompanionRejection
>;

/** Why a caller-selected debug companion was refused, in caller-facing words. */
export interface DebugCompanionRejection {
  readonly reason: string;
}

const throwIfCancelled = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true)
    throw new AnalysisCancelledError("resolve_binary_target", {
      cause: signal.reason,
    });
};

/** Read a bounded window, charging actual I/O and observing cancellation. */
const readUuidWindow = async (
  handle: FileHandle,
  offset: number,
  length: number,
  ledger: TraversalLedger,
  signal: AbortSignal | undefined,
): Promise<Result<Buffer, MachOUuidReadFailure>> => {
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
    const charged = chargeTraversal(ledger, observed.bytesRead);
    if (!charged.ok) return charged;
    if (observed.bytesRead === 0) break;
    filled += observed.bytesRead;
  }
  return ok(bytes.subarray(0, filled));
};

/** Drive the shared format decoder with one bounded cached window per image. */
const readThinUuidEntry = async (
  handle: FileHandle,
  offset: number,
  length: number,
  ledger: TraversalLedger,
  signal: AbortSignal | undefined,
  prefix?: Buffer,
): Promise<Result<MachOImageUuid, MachOUuidReadFailure>> => {
  const decoder = machoUuidReads(length);
  let step = decoder.next();
  let windowOffset = 0;
  let window = prefix ?? Buffer.alloc(0);
  while (!step.done) {
    throwIfCancelled(signal);
    const request = step.value;
    if (
      request.offset < windowOffset ||
      request.offset + request.length > windowOffset + window.length
    ) {
      const windowLength = Math.min(
        HEADER_READ_LIMIT,
        length - request.offset,
        TRAVERSAL_BUDGET_BYTES - ledger.spent,
      );
      if (windowLength < request.length) return err(traversalLimit());
      const read = await readUuidWindow(
        handle,
        offset + request.offset,
        windowLength,
        ledger,
        signal,
      );
      if (!read.ok) return read;
      windowOffset = request.offset;
      window = read.value;
    }
    const start = request.offset - windowOffset;
    step = decoder.next(window.subarray(start, start + request.length));
  }
  return step.value.ok ? step.value : err(invalidImage(step.value.error));
};

/**
 * Aggregate bytes one admission may spend reading Mach-O headers and load
 * commands across the target and every member candidate. Only bytes actually
 * read are charged, and the ledger is shared for the whole admission.
 */
const TRAVERSAL_BUDGET_BYTES = 64 * 1024 * 1024;

interface TraversalLedger {
  spent: number;
}

const chargeTraversal = (
  ledger: TraversalLedger,
  bytes: number,
): Result<null, MachOUuidReadFailure> => {
  ledger.spent += bytes;
  return ledger.spent > TRAVERSAL_BUDGET_BYTES
    ? err(traversalLimit())
    : ok(null);
};

/**
 * Read every LC_UUID of a Mach-O file with its declaring cputype: a thin
 * image from its start, or each slice of a universal container from its
 * table (a UUID-less slice keeps its place as a null entry). Cancellation
 * and the aggregate traversal budget are honored between slices.
 */
export const readMachoFileUuidEntries = async (
  handle: FileHandle,
  fileSize: number,
  options: {
    readonly signal?: AbortSignal;
    readonly ledger?: TraversalLedger;
  } = {},
): Promise<Result<SliceUuidEntry[], MachOUuidReadFailure>> => {
  const ledger = options.ledger ?? { spent: 0 };
  const signal = options.signal;
  const prefix = await readUuidWindow(
    handle,
    0,
    Math.min(fileSize, HEADER_READ_LIMIT),
    ledger,
    signal,
  );
  if (!prefix.ok) return prefix;
  const container = readFatContainerHeader(prefix.value, fileSize);
  if (container.state === "not-fat") {
    const read = await readThinUuidEntry(
      handle,
      0,
      fileSize,
      ledger,
      signal,
      prefix.value,
    );
    return read.ok
      ? ok([{ cpuType: read.value.cpuType, uuid: read.value.uuid }])
      : read;
  }
  if (container.state === "needs-data")
    return err(
      invalidImage("the universal Mach-O container table is truncated"),
    );
  if (container.state === "malformed")
    return err(invalidImage(container.reason));
  const entries: SliceUuidEntry[] = [];
  for (const declaration of container.slices) {
    throwIfCancelled(signal);
    const rangeIssue = validateFatSlice(
      declaration,
      fileSize,
      container.tableEnd,
    );
    if (rangeIssue !== null) return err(invalidImage(rangeIssue));
    const read = await readThinUuidEntry(
      handle,
      declaration.offset,
      declaration.size,
      ledger,
      signal,
    );
    if (!read.ok) return read;
    const identityIssue = validateFatSlice(
      declaration,
      fileSize,
      container.tableEnd,
      read.value,
    );
    if (identityIssue !== null) return err(invalidImage(identityIssue));
    entries.push({ cpuType: read.value.cpuType, uuid: read.value.uuid });
  }
  return ok(entries);
};

/**
 * Digest a DWARF member through the same handle its UUID was read from, so a
 * member atomically replaced on disk cannot pair another file's digest with
 * the validated UUID. The read loop honors cancellation between chunks.
 */
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
  if (!sameRegularFileState(initial, opened))
    return err("the dSYM DWARF member changed while being read");
  return ok(hash.digest("hex"));
};

/**
 * Admit a caller-selected dSYM bundle for a detected Mach-O target: the
 * bundle must contain a DWARF member whose LC_UUID matches the UUID of the
 * target image slice REA selected for the requested architecture. Only the
 * matched member is retained for staging; a non-Mach-O or unreadable member
 * candidate (for example `.DS_Store`) is skipped, not fatal.
 */
export const admitDebugCompanion = async (input: {
  readonly dsymPath: string;
  readonly targetHandle: FileHandle;
  readonly targetSize: number;
  readonly architecture: BinaryArchitecture;
  readonly targetSlice?: UniversalMachOSlice;
  readonly resources?: ArtifactResourceScope;
  readonly signal?: AbortSignal;
}): Promise<DebugCompanionAdmission> => {
  const { dsymPath, signal } = input;
  throwIfCancelled(signal);
  if (!isAbsolute(dsymPath))
    return err({
      reason:
        "dsym_path must be an absolute local filesystem path to a .dSYM bundle",
    });
  let bundle: Stats;
  try {
    bundle = await stat(dsymPath);
  } catch (cause: unknown) {
    throwIfCancelled(signal);
    if (isExpectedAdmissionPathFailure(cause))
      return err({ reason: `dsym_path is not readable: ${dsymPath}` });
    throw cause;
  }
  throwIfCancelled(signal);
  if (!bundle.isDirectory())
    return err({
      reason: `dsym_path is not a .dSYM bundle directory: ${dsymPath}`,
    });
  const dwarfDirectory = join(dsymPath, DSYM_DWARF_DIRECTORY);
  let directory: Dir;
  try {
    directory = await opendir(dwarfDirectory, {
      bufferSize: MEMBER_COUNT_LIMIT + 1,
    });
  } catch (cause: unknown) {
    throwIfCancelled(signal);
    if (isExpectedAdmissionPathFailure(cause))
      return err({
        reason: `dsym_path has no Contents/Resources/DWARF member directory: ${dsymPath}`,
      });
    throw cause;
  }
  throwIfCancelled(signal);
  const directoryOwner = new OwnedDirectoryHandle(directory);
  const memberPaths: string[] = [];
  let examinedEntries = 0;
  let enumerationReason: string | undefined;
  let enumerationFailure: unknown;
  try {
    for (;;) {
      throwIfCancelled(signal);
      const entry = await directory.read();
      if (entry === null) break;
      examinedEntries += 1;
      if (examinedEntries > MEMBER_COUNT_LIMIT) {
        enumerationReason = `dsym_path contains more than ${String(MEMBER_COUNT_LIMIT)} DWARF directory entries`;
        break;
      }
      const memberPath = join(dwarfDirectory, entry.name);
      let memberStat: Stats;
      try {
        memberStat = await stat(memberPath);
      } catch (cause: unknown) {
        if (isExpectedAdmissionPathFailure(cause)) continue;
        throw cause;
      }
      if (!memberStat.isFile()) continue;
      memberPaths.push(memberPath);
    }
  } catch (cause: unknown) {
    enumerationFailure = cause;
  }
  let cleanupFailure: unknown;
  if (input.resources === undefined) {
    try {
      await directoryOwner.close();
    } catch (cause: unknown) {
      cleanupFailure = cause;
    }
  } else {
    const cleanup = await input.resources.release({
      kind: "directory-handle",
      handle: directoryOwner,
      resource: dwarfDirectory,
    });
    if (cleanup.kind === "failed") cleanupFailure = cleanup.cause;
  }
  if (cleanupFailure !== undefined) {
    const primary =
      enumerationFailure ??
      new Error(enumerationReason ?? "DWARF directory enumeration completed");
    throw ArtifactReaderFailure.withCleanup(
      primary,
      ArtifactReaderFailure.cleanupObservation(cleanupFailure, dwarfDirectory),
    );
  }
  if (enumerationFailure !== undefined) throw enumerationFailure;
  if (enumerationReason !== undefined)
    return err({ reason: enumerationReason });
  if (memberPaths.length === 0)
    return err({
      reason: `dsym_path contains no DWARF member file: ${dsymPath}`,
    });
  const ledger: TraversalLedger = { spent: 0 };
  const traversalOptions = {
    ledger,
    ...(signal === undefined ? {} : { signal }),
  };
  let targetEntries: Result<SliceUuidEntry[], MachOUuidReadFailure>;
  if (input.targetSlice === undefined) {
    targetEntries = await readMachoFileUuidEntries(
      input.targetHandle,
      input.targetSize,
      traversalOptions,
    );
  } else {
    // Target selection already owns the exact FAT entry. Read that region
    // directly instead of selecting a sibling again from a UUID inventory.
    const selected = await readThinUuidEntry(
      input.targetHandle,
      input.targetSlice.offset,
      input.targetSlice.size,
      ledger,
      signal,
    );
    targetEntries = selected.ok
      ? ok([{ cpuType: selected.value.cpuType, uuid: selected.value.uuid }])
      : selected;
  }
  if (!targetEntries.ok) return err({ reason: targetEntries.error.reason });
  // Mirror the target parser's FAT selection: the first slice of each CPU
  // family is the one REA imports — including when that slice declares no
  // LC_UUID, in which case a same-family sibling cannot lend its UUID.
  const selectedCpuTypes = CPU_TYPES[input.architecture];
  const importedFamilies = new Set<number>();
  const selectedUuids: string[] = [];
  for (const { cpuType, uuid } of targetEntries.value) {
    const family = selectedCpuTypes.find((candidate) => candidate === cpuType);
    if (family === undefined || importedFamilies.has(family)) continue;
    importedFamilies.add(family);
    if (usableMachOUuid(uuid)) selectedUuids.push(uuid);
  }
  if (selectedUuids.length === 0)
    return err({
      reason: `the target image declares no usable LC_UUID for the selected ${input.architecture} slice`,
    });
  let admitted: MachODebugCompanion | undefined;
  for (const memberPath of memberPaths.sort()) {
    throwIfCancelled(signal);
    try {
      const candidate = await withRegularFile<
        Result<MachODebugCompanion | null, DebugCompanionRejection>
      >(
        memberPath,
        async (memberHandle, initial) => {
          const memberEntries = await readMachoFileUuidEntries(
            memberHandle,
            initial.size,
            traversalOptions,
          );
          if (!memberEntries.ok)
            return memberEntries.error.kind === "resource-limit"
              ? err({ reason: memberEntries.error.reason })
              : ok(null);
          const matched = debugCompanionMatches({
            executableUuids: selectedUuids,
            companionUuids: memberEntries.value
              .filter(({ cpuType }) => selectedCpuTypes.includes(cpuType))
              .map(({ uuid }) => uuid)
              .filter((uuid): uuid is string => uuid !== null),
          });
          if (!matched.ok) return ok(null);
          if (initial.size > MEMBER_SIZE_LIMIT_BYTES)
            return err({
              reason: `dsym DWARF member exceeds the supported size of ${String(MEMBER_SIZE_LIMIT_BYTES >> 30)} GiB: ${memberPath}`,
            });

          const memberSha256 = await digestOpenHandle(
            memberHandle,
            initial,
            signal,
          );
          if (!memberSha256.ok) return err({ reason: memberSha256.error });
          return ok({
            sourcePath: dsymPath,
            memberPath,
            memberSha256: memberSha256.value,
            memberSizeBytes: initial.size,
            uuid: matched.value.uuid,
          });
        },
        {
          symlinks: "follow",
          ...(signal === undefined ? {} : { signal }),
          ...(input.resources === undefined
            ? {}
            : { resources: input.resources }),
        },
      );
      if (!candidate.ok) return candidate;
      if (candidate.value !== null) {
        if (
          admitted !== undefined &&
          (admitted.memberSha256 !== candidate.value.memberSha256 ||
            admitted.memberSizeBytes !== candidate.value.memberSizeBytes)
        )
          return err({
            reason:
              "dsym_path contains conflicting DWARF members for the selected target UUID",
          });
        admitted ??= candidate.value;
      }
    } catch (cause: unknown) {
      // This exception carries the exact handle owner and the original read
      // outcome. Never downgrade it to a skipped member or lose close authority.
      if (cause instanceof RegularFileCleanupFailure) throw cause;
      throwIfCancelled(signal);
      if (cause instanceof NonRegularFileReadError) continue;
      if (cause instanceof RegularFileChangedError)
        // Expected boundary condition, not a reader fault: report it as a
        // typed admission rejection so session.open keeps its Result shape.
        return err({
          reason: `the dSYM DWARF member changed while being read: ${memberPath}`,
        });
      const code =
        cause instanceof Error && "code" in cause ? cause.code : undefined;
      if (
        code === "ENOENT" ||
        code === "ENOTDIR" ||
        code === "EACCES" ||
        code === "EPERM" ||
        code === "ELOOP"
      )
        continue;
      throw cause;
    }
  }
  if (admitted !== undefined) return ok(admitted);
  return err({
    reason:
      "dsym_path contains no Mach-O DWARF member whose LC_UUID matches the selected target slice",
  });
};
