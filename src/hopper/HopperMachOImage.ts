import {
  withOwnedFileHandle,
  RegularFileCancelled,
  RegularFileCleanupFailure,
} from "../filesystem/OwnedRegularFile.js";
import {
  NonRegularFileReadError,
  RegularFileOperationCancelled,
} from "../filesystem/RegularFile.js";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { z } from "zod";

import {
  type ArtifactResourceScope,
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
} from "../resources/index.js";
import type { RetainedResourceScope } from "../ports/AnalysisProvider.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { BinaryTargetError } from "../domain/configurationErrors.js";
import {
  AnalysisCancelledError,
  cancelledBy,
  carriedReason,
} from "../domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import {
  findOverlappingFatSlices,
  inspectFatSliceBounds,
  readFatSliceDeclarations,
  readFatHeaderPrefix,
  readMachoHeaderPrefixFacts,
  validateFatSlice,
  validateFatSliceIdentity,
  type FatSliceDeclaration,
} from "../domain/apple/machoContainer.js";
import { MACHO_CPU_TYPES } from "../domain/apple/machoTargetSelection.js";
import { HopperCancelledError, HopperStartError } from "./HopperErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { readFileHandleChunks } from "../filesystem/readFileHandleChunks.js";
import { readFileHandleRange } from "../filesystem/readFileHandleRange.js";

import {
  copyHopperSource,
  type HopperImageCopyOptions,
} from "./HopperImageCopy.js";
import { errorMessage } from "../kernel/errorMessage.js";

const hopperFatMachOImageSchema = z.strictObject({
  method: z.enum(["fat32_thin_slice", "fat64_thin_slice"]),
  architecture_count: z.int().min(1).max(128),
  container_table_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  source_offset: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  byte_length: z.int().positive().max(Number.MAX_SAFE_INTEGER),
  cpu_type: z.int().nonnegative(),
  cpu_subtype: z.int().nonnegative(),
});

const hopperThinMachOImageSchema = z.strictObject({
  method: z.literal("thin_verified_copy"),
  byte_length: z.int().positive().max(Number.MAX_SAFE_INTEGER),
  cpu_type: z.int().nonnegative(),
  cpu_subtype: z.int().nonnegative(),
});

/** Stable source coordinates committed before preparing an owned thin image. */
export const hopperMachOImageSchema = z.discriminatedUnion("method", [
  hopperFatMachOImageSchema,
  hopperThinMachOImageSchema,
]);

export type HopperMachOImage = z.infer<typeof hopperMachOImageSchema>;
type HopperMachOImageResolutionError =
  | BinaryTargetError
  | AnalysisCancelledError;

/** Filesystem access used by the admitted Mach-O preflight. */
export interface HopperMachOImageResolutionFileSystem {
  readonly open: typeof open;
}

export interface HopperMachOImageResolutionOptions {
  readonly resourceScope: RetainedResourceScope;
  readonly signal?: AbortSignal;
  readonly fileSystem?: HopperMachOImageResolutionFileSystem;
}

const defaultHopperMachOImageResolutionFileSystem: HopperMachOImageResolutionFileSystem =
  {
    open,
  };

/** Validate the selected Mach-O image without depending on Apple's lipo tool. */
export const resolveHopperMachOImage = async (
  target: BinaryTarget & { readonly kind: "executable" },
  options: HopperMachOImageResolutionOptions,
): Promise<Result<HopperMachOImage, AnalysisError>> => {
  const invalid = (reason: string, cause?: unknown) =>
    err(
      new BinaryTargetError(
        target.path,
        reason,
        cause === undefined ? undefined : { cause },
      ),
    );
  if (options.signal?.aborted)
    return err(cancelledBy("open_binary", options.signal));
  if (target.format !== "mach-o" && target.format !== "mach-o-universal")
    return invalid("Hopper image preparation requires a Mach-O target");
  let opened: FileHandle;
  try {
    opened = await (
      options.fileSystem ?? defaultHopperMachOImageResolutionFileSystem
    ).open(
      target.path,
      constants.O_RDONLY |
        (constants.O_NONBLOCK ?? 0) |
        (constants.O_NOCTTY ?? 0),
    );
  } catch (cause: unknown) {
    // Keep the OS error so a read-permission denial reports access_denied.
    return invalid(
      `Cannot read Mach-O source for Hopper image preparation: ${errorMessage(cause)}`,
      cause,
    );
  }
  return inspectAndFinalizeHopperMachOImage(
    target,
    new OwnedFileHandle(opened),
    options,
  );
};

const inspectAndFinalizeHopperMachOImage = async (
  target: BinaryTarget & { readonly kind: "executable" },
  owner: OwnedFileHandle,
  options: HopperMachOImageResolutionOptions,
): Promise<Result<HopperMachOImage, AnalysisError>> => {
  let cancellationBeforeClose = false;
  const readFailure = (cause: unknown): HopperMachOImageResolutionError =>
    cause instanceof BinaryTargetError ||
    cause instanceof AnalysisCancelledError
      ? cause
      : cause instanceof RegularFileOperationCancelled
        ? cancelledBy("open_binary", carriedReason(cause.reason))
        : new BinaryTargetError(
            target.path,
            `Cannot validate Mach-O image: ${errorMessage(cause)}`,
            { cause },
          );
  try {
    const image = await withOwnedFileHandle(
      target.path,
      owner,
      options.signal === undefined ? {} : { signal: options.signal },
      async (handle) => {
        try {
          const inspected = await inspectHopperMachOImage(
            target,
            handle,
            options.signal,
          );
          if (!inspected.ok) throw inspected.error;
          return inspected.value;
        } finally {
          cancellationBeforeClose = options.signal?.aborted === true;
        }
      },
    );
    return ok(image);
  } catch (cause: unknown) {
    if (cause instanceof RegularFileCancelled)
      return err(cancelledBy("open_binary", carriedReason(cause.reason)));
    if (!(cause instanceof RegularFileCleanupFailure))
      return err(readFailure(cause));
    return retainHopperPreflightCloseFailure({
      target,
      owner: cause.owner,
      resourceScope: options.resourceScope,
      failure:
        cause.outcome.kind === "failed"
          ? readFailure(cause.outcome.cause)
          : undefined,
      cancellationBeforeClose,
      signal: options.signal,
      closeFailure: cause.cleanupCause,
    });
  }
};

const retainHopperPreflightCloseFailure = (options: {
  readonly target: BinaryTarget & { readonly kind: "executable" };
  readonly owner: OwnedFileHandle;
  readonly resourceScope: RetainedResourceScope;
  readonly failure: HopperMachOImageResolutionError | undefined;
  readonly cancellationBeforeClose: boolean;
  readonly signal: AbortSignal | undefined;
  readonly closeFailure: unknown;
}): Result<HopperMachOImage, AnalysisError> => {
  const resource = `hopper-macho-preflight:${options.target.path}`;
  const lease = AnalysisCleanupLease.forCloseOwner(options.owner, resource);
  options.resourceScope.retain(
    {
      close: () => lease.release(),
      get cleanupResources() {
        return lease.cleanupResources;
      },
    },
    resource,
  );
  const cleanup = {
    reason: errorMessage(options.closeFailure),
    resources: [resource],
  };
  const cancellationIsPrimary =
    options.failure instanceof AnalysisCancelledError ||
    (options.failure === undefined && options.cancellationBeforeClose);
  let failure: AnalysisError;
  let closeIsPrimary = false;
  if (options.failure !== undefined) {
    failure =
      options.failure instanceof BinaryTargetError
        ? new BinaryTargetError(options.failure.path, options.failure.reason, {
            ...(options.failure.cause === undefined
              ? {}
              : { cause: options.failure.cause }),
            ...(options.failure.constraint === undefined
              ? {}
              : { constraint: options.failure.constraint }),
            cleanup,
          })
        : cancelledBy("open_binary", carriedReason(options.failure.cause), {
            cleanup,
          });
  } else if (options.cancellationBeforeClose) {
    // cancellationBeforeClose records that the caller's signal had aborted.
    failure = cancelledBy(
      "open_binary",
      carriedReason(options.signal?.reason),
      {
        cleanup,
      },
    );
  } else {
    failure = new BinaryTargetError(
      options.target.path,
      "Could not confirm closure of the Mach-O preflight handle",
      { cause: options.closeFailure, cleanup },
    );
    closeIsPrimary = true;
  }
  const cleanupError = new ProviderCleanupError(
    "hopper",
    [resource],
    { reason: cleanup.reason },
    {
      cause: options.closeFailure,
      operation: "resolve_analysis_profile",
    },
  );
  if (!closeIsPrimary) {
    lease.bindCleanupError(cleanupError);
    failure.retainSecondaryFailure(cleanupError);
  }
  if (options.signal?.aborted && !cancellationIsPrimary)
    failure.retainSecondaryFailure(cancelledBy("open_binary", options.signal));
  new AnalysisCleanupLeaseGroup(failure, [lease]);
  return err(failure);
};

const inspectHopperMachOImage = async (
  target: BinaryTarget & { readonly kind: "executable" },
  file: FileHandle,
  signal: AbortSignal | undefined,
): Promise<Result<HopperMachOImage, HopperMachOImageResolutionError>> => {
  const invalid = (reason: string, cause?: unknown) =>
    err(
      new BinaryTargetError(
        target.path,
        reason,
        cause === undefined ? undefined : { cause },
      ),
    );
  const stats = await file.stat();
  if (!stats.isFile())
    return invalid(
      `Selected input must be a regular file: ${target.path}`,
      new NonRegularFileReadError(target.path, stats.isDirectory()),
    );
  const read = (offset: number, length: number): Promise<Buffer> =>
    readFileHandleRange(file, offset, length, () => {
      if (signal?.aborted) throw cancelledBy("open_binary", signal);
    });
  const header = await read(0, 8);
  const fatPrefix = readFatHeaderPrefix(header);
  const thinPrefix = readMachoHeaderPrefixFacts(header);
  if (header.length === 8 && thinPrefix.format !== null) {
    if (target.format !== "mach-o")
      return invalid("Thin Mach-O source disagrees with its admitted format");
    const prefix = Buffer.alloc(12);
    const hash = createHash("sha256");
    let prefixLength = 0;
    let size = 0;
    for await (const chunk of readFileHandleChunks(file, {
      ...(signal === undefined ? {} : { signal }),
      cancellationFailure: (reason) =>
        cancelledBy("open_binary", carriedReason(reason)),
    })) {
      if (signal?.aborted) return err(cancelledBy("open_binary", signal));
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(bytes);
      size += bytes.length;
      if (!Number.isSafeInteger(size))
        return invalid("Thin Mach-O exceeds exact selection coordinates");
      const copied = Math.min(prefix.length - prefixLength, bytes.length);
      if (copied > 0) {
        bytes.copy(prefix, prefixLength, 0, copied);
        prefixLength += copied;
      }
    }
    if (signal?.aborted) return err(cancelledBy("open_binary", signal));
    if (prefixLength !== prefix.length)
      return invalid("Thin Mach-O header is truncated");
    const observedSha256 = hash.digest("hex");
    if (observedSha256 !== target.sha256)
      return invalid(
        `Thin Mach-O source changed after target admission: expected SHA-256 ${target.sha256}, observed ${observedSha256}`,
      );
    const facts = readMachoHeaderPrefixFacts(prefix);
    if (facts.magic !== thinPrefix.magic || facts.identity === null)
      return invalid("Thin Mach-O header changed during profile resolution");
    return ok({
      method: "thin_verified_copy",
      byte_length: size,
      cpu_type: facts.identity.cpuType,
      cpu_subtype: facts.identity.cpuSubtype,
    });
  }
  if (fatPrefix.state !== "parsed")
    return invalid(
      "Mach-O source header changed before Hopper image preparation",
    );
  const { wide, littleEndian, count, tableEnd } = fatPrefix;
  const size = stats.size;
  if (count === 0 || count > 128 || tableEnd > size)
    return invalid(
      "FAT architecture table is truncated or exceeds the supported 128 entries",
    );
  const table = await read(8, tableEnd - 8);
  const parsed = readFatSliceDeclarations(table, {
    count,
    wide,
    littleEndian,
  });
  if (parsed.status === "malformed") return invalid(parsed.reason);
  if (target.format !== "mach-o-universal")
    return invalid(
      "Universal Mach-O source disagrees with its admitted format",
    );
  if (
    target.architecture !== "x86" &&
    target.architecture !== "x86_64" &&
    target.architecture !== "arm" &&
    target.architecture !== "arm64"
  )
    return invalid("Hopper cannot select the admitted Mach-O architecture");
  const architecture = target.architecture;
  // Target admission chose the slice; reading another one would analyze bytes
  // the session's Evidence does not name. Check container-level bounds and
  // overlaps across the table, then validate only the selected slice's
  // alignment, reserved word, and thin Mach-O header identity.
  const admitted = target.universalSlice;
  const matches: FatSliceDeclaration[] = [];
  for (const slice of parsed.slices) {
    if (signal?.aborted) return err(cancelledBy("open_binary", signal));
    const boundsIssue = inspectFatSliceBounds(slice, size, tableEnd);
    if (boundsIssue !== null) return invalid(boundsIssue.detail);
    if (slice.offset === admitted.offset && slice.size === admitted.size)
      matches.push(slice);
  }
  if (findOverlappingFatSlices(parsed.slices) !== null)
    return invalid("FAT slices overlap");
  const [selected] = matches;
  if (selected === undefined || matches.length > 1)
    return invalid(
      `The admitted ${architecture} slice at file offset ${String(admitted.offset)} is ${selected === undefined ? "not declared by" : "declared more than once in"} the FAT table; open the stable source again`,
    );
  if (selected.cpuType !== MACHO_CPU_TYPES[architecture])
    return invalid(
      `The admitted slice at file offset ${String(admitted.offset)} is not ${architecture}; open the stable source again`,
    );
  const rangeError = validateFatSlice(selected, size, tableEnd);
  if (rangeError !== null) return invalid(rangeError);
  if (selected.reserved !== null && selected.reserved !== 0)
    return invalid(
      `FAT64 architecture ${selected.index} has a nonzero reserved field`,
    );
  if (selected.size < 12)
    return invalid(
      `FAT architecture ${selected.index} has a truncated Mach-O header`,
    );
  const embedded = await read(selected.offset, 12);
  if (embedded.length !== 12)
    return invalid(`FAT architecture ${selected.index} became truncated`);
  const identity = readMachoHeaderPrefixFacts(embedded).identity;
  if (identity === null)
    return invalid(
      `FAT architecture ${selected.index} does not contain a Mach-O image`,
    );
  const identityError = validateFatSliceIdentity(selected, identity);
  if (identityError !== null) return invalid(identityError);
  return ok({
    method: wide ? "fat64_thin_slice" : "fat32_thin_slice",
    architecture_count: count,
    container_table_sha256: createHash("sha256")
      .update(header)
      .update(table)
      .digest("hex"),
    source_offset: selected.offset,
    byte_length: selected.size,
    cpu_type: selected.cpuType,
    cpu_subtype: selected.cpuSubtype,
  });
};

/** Copy a selected slice and verify the entire original source in the same pass. */
export const prepareHopperMachOImage = async (
  sourcePath: string,
  sourceSha256: string,
  image: HopperMachOImage,
  destination: string,
  options: HopperImageCopyOptions,
): Promise<Result<string, HopperStartError | HopperCancelledError>> => {
  const copyDependencies = {
    resourceScope: options.resourceScope,
    fileSystem: options.fileSystem,
  };
  const { signal } = options;
  if (signal?.aborted) return err(new HopperCancelledError(signal.reason));
  if (image.method === "thin_verified_copy") {
    const prepared = await prepareThinHopperMachOImage(
      sourcePath,
      sourceSha256,
      image,
      destination,
      { signal, ...copyDependencies },
    );
    return signal?.aborted && prepared.ok
      ? err(new HopperCancelledError(signal.reason))
      : prepared;
  }
  const tableEntrySize = image.method === "fat64_thin_slice" ? 32 : 20;
  const hash = createHash("sha256");
  const tableHash = createHash("sha256");
  const tableEnd = 8 + image.architecture_count * tableEntrySize;
  const thinHeader: Buffer[] = [];
  let copied = 0;
  const copiedResult = await copyHopperSource({
    sourcePath,
    destination,
    signal,
    ...copyDependencies,
    selectBytes: (bytes, position) => {
      hash.update(bytes);
      if (position < tableEnd)
        tableHash.update(
          bytes.subarray(0, Math.min(bytes.length, tableEnd - position)),
        );
      const start = Math.max(0, image.source_offset - position);
      const end = Math.min(
        bytes.length,
        image.source_offset + image.byte_length - position,
      );
      if (end <= start) return undefined;
      if (copied < 12)
        thinHeader.push(
          bytes.subarray(start, Math.min(end, start + 12 - copied)),
        );
      copied += end - start;
      return bytes.subarray(start, end);
    },
    failureContext: `Cannot prepare the selected FAT image from ${sourcePath}`,
  });
  if (!copiedResult.ok) return copiedResult;
  const observed = hash.digest("hex");
  const header = Buffer.concat(thinHeader);
  const identity = readMachoHeaderPrefixFacts(header).identity;
  const headerMatches =
    header.length === 12 &&
    identity !== null &&
    identity.cpuType === image.cpu_type &&
    identity.cpuSubtype === image.cpu_subtype;
  if (
    tableHash.digest("hex") !== image.container_table_sha256 ||
    !headerMatches
  )
    return err(
      new HopperStartError({
        userMessage: `FAT source ${sourcePath} no longer agrees with its committed architecture table or selected Mach-O header. Open the stable source again.`,
      }),
    );
  if (observed !== sourceSha256 || copied !== image.byte_length)
    return err(
      new HopperStartError({
        userMessage: `FAT source ${sourcePath} changed before launch: expected SHA-256 ${sourceSha256}, observed ${observed}; copied ${copied} of ${image.byte_length} selected bytes. Open the stable source again.`,
      }),
    );
  return signal?.aborted
    ? err(new HopperCancelledError(signal.reason))
    : ok(destination);
};

const prepareThinHopperMachOImage = async (
  sourcePath: string,
  sourceSha256: string,
  image: Extract<HopperMachOImage, { method: "thin_verified_copy" }>,
  destination: string,
  options: {
    readonly signal: AbortSignal | undefined;
    readonly resourceScope: ArtifactResourceScope;
    readonly fileSystem?: HopperImageCopyOptions["fileSystem"];
  },
): Promise<Result<string, HopperStartError | HopperCancelledError>> => {
  const { signal, resourceScope, fileSystem } = options;
  const hash = createHash("sha256");
  const prefix = Buffer.alloc(12);
  let prefixLength = 0;
  const copiedResult = await copyHopperSource({
    sourcePath,
    destination,
    signal,
    resourceScope,
    fileSystem,
    selectBytes: (bytes) => {
      hash.update(bytes);
      const prefixBytes = Math.min(prefix.length - prefixLength, bytes.length);
      if (prefixBytes > 0) {
        bytes.copy(prefix, prefixLength, 0, prefixBytes);
        prefixLength += prefixBytes;
      }
      return bytes;
    },
    failureContext: `Cannot prepare the verified thin image from ${sourcePath}`,
  });
  if (!copiedResult.ok) return copiedResult;
  const copied = copiedResult.value;
  if (!Number.isSafeInteger(copied))
    return err(
      new HopperStartError({
        userMessage: `Thin Mach-O source ${sourcePath} exceeds exact copy coordinates.`,
      }),
    );
  const observed = hash.digest("hex");
  const identity = readMachoHeaderPrefixFacts(
    prefix.subarray(0, prefixLength),
  ).identity;
  const headerMatches =
    prefixLength === prefix.length &&
    identity !== null &&
    identity.cpuType === image.cpu_type &&
    identity.cpuSubtype === image.cpu_subtype;
  if (
    observed !== sourceSha256 ||
    copied !== image.byte_length ||
    !headerMatches
  )
    return err(
      new HopperStartError({
        userMessage: `Thin Mach-O source ${sourcePath} no longer agrees with its admitted digest, size, or selected header. Open the stable source again.`,
      }),
    );
  return signal?.aborted
    ? err(new HopperCancelledError(signal.reason))
    : ok(destination);
};
