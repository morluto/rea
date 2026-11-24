import { probeUefiFlashImage } from "../uefi/UefiFormatProbe.js";
import {
  BINARY_TARGET_FORMAT_KINDS,
  type TargetFormatHint,
} from "../domain/targetFormats.js";
import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import {
  artifactNameForClassification,
  namedArtifactFormat,
} from "../domain/artifactNameSelection.js";
import { createCachedPrefixReader } from "../filesystem/readFileHandleRange.js";
import { hasXarMagic } from "../domain/binaryContainer.js";
import {
  readExecutableMetadata,
  readHandleRange,
  throwIfTargetResolutionCancelled,
} from "./BinaryTargetExecutableProbes.js";
import {
  regularFileCancellation,
  RegularFileCleanupFailure,
  RegularFileCancelled,
  withOwnedRegularFile,
  OwnedRegularFileOperationFailure,
} from "../filesystem/OwnedRegularFile.js";
import {
  bindRegularFileCleanup,
  RetainedRegularFileCleanupFailure,
  retryRegularFileCleanup,
} from "../process/RegularFileRead.js";
import {
  type ArtifactResourceScope,
  ArtifactReaderFailure,
} from "../resources/index.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { analysisErrorWithCancellation } from "../domain/analysisErrorCancellation.js";
import { childFailureDiagnostics } from "../domain/analysisErrorProjection.js";
import { constants, type Stats } from "node:fs";
import { access, realpath, stat, type FileHandle } from "node:fs/promises";
import { extname } from "node:path";

import { BinaryTargetError } from "../domain/configurationErrors.js";
import {
  classifyTargetFilesystemFailure,
  type TargetFilesystemStage,
} from "../domain/binaryTargetFilesystemFailure.js";
import {
  assertStableRegularFileIdentity,
  RegularFileChangedError,
  RegularFileOperationCancelled,
  type StableRegularFileDescriptor,
} from "../filesystem/RegularFile.js";
import { hashStableRegularFileDescriptor } from "../filesystem/StableFileHash.js";
import {
  AnalysisCancelledError,
  cancelledBy,
  carriedReason,
} from "../domain/analysisErrorCore.js";
import {
  hasIdaDatabaseSignature,
  type AnalysisDatabaseEngine,
} from "../domain/analysisDatabase.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  resolveAppleBundleExecutable,
  type ResolvedAppBundle,
} from "./AppBundleExecutable.js";
import {
  OPENABLE_APPLE_BUNDLE_TYPES_TEXT,
  isUnopenedAppleBundleExtension,
  openableAppleBundleExtension,
} from "../domain/apple/appleBundleTypes.js";
import { validateDosComLength } from "../domain/dosCom.js";
import {
  admitRawBinary,
  rawBinarySelectionError,
  type NativeLoadSelection,
  type RawBinaryAdmission,
  type RawBinaryAdmissionRejection,
} from "../domain/rawBinary.js";
import { admitGamecubeDol } from "../domain/gamecubeDolAdmission.js";
import { DOL_HEADER_SIZE } from "../domain/gamecubeDol.js";
import {
  createXmlPlistSignatureProbe,
  MAX_XML_PLIST_PROBE_BYTES,
} from "../domain/apple/appleArchiveFormat.js";
import { hasDiskImageSignature } from "../domain/apple/diskImageFormat.js";
import { recognizeArtifactFormat } from "../domain/artifactFormatRecognition.js";
import {
  ISO9660_DESCRIPTOR_OFFSET,
  ISO9660_SIGNATURE_BYTES,
} from "../domain/iso9660/iso9660Structures.js";
import { DFUSE_SUFFIX_BYTES } from "../domain/firmware/dfuse.js";
import {
  locateEspFlashLayout,
  type EspFlashSelection,
} from "../domain/firmware/espFlashLocation.js";
import { espFlashSelectionError } from "../domain/firmware/espFlashSelection.js";
import {
  hasTrailingZipArchive,
  zipRootPackageFormat,
} from "../domain/zipPackageFormat.js";

import { claimsExecutableHeader } from "../domain/binaryTarget.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { localPathStringSchema } from "../domain/localPath.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { errorMessage } from "../kernel/errorMessage.js";

const XML_PLIST_PROBE_CHUNK_BYTES = 64 * 1024;

/** Options for resolving a local binary target and its stable identity. */
export interface BinaryTargetResolverOptions {
  readonly cwd?: string;
  readonly hostArchitecture?: NodeJS.Architecture;
  readonly targetKind?: BinaryTarget["kind"];
  readonly loadSelection?: NativeLoadSelection;
  /** Inputs for format=esp-flash-image; rejected with any other format. */
  readonly espFlash?: EspFlashSelection;
  readonly signal?: AbortSignal;
  readonly resources?: ArtifactResourceScope;
}

/**
 * Resolve and classify a readable local target before a provider is selected.
 * FAT Mach-O inputs select the host-compatible slice. Several subtypes of that
 * family use subtype preference, then the earliest capability variant.
 * Otherwise the first foreign family declared once is selected. Unsupported
 * or ambiguous inputs are returned as typed errors.
 */
export const parseBinaryTarget = async (
  input: string,
  options: BinaryTargetResolverOptions = {},
): Promise<
  Result<BinaryTarget, BinaryTargetError | AnalysisCancelledError>
> => {
  const { signal } = options;
  const admitted = localPathStringSchema.safeParse(input);
  if (!admitted.success) {
    if (signal?.aborted === true)
      return err(cancelledBy("resolve_binary_target", signal));
    return err(
      new BinaryTargetError(
        input,
        admitted.error.issues[0]?.message ?? "Invalid local path",
        { cause: admitted.error },
      ),
    );
  }
  const cwd = options.cwd ?? process.cwd();
  const candidate = absoluteCallerPath(admitted.data, { cwd });
  // Failures before canonicalization concern the selected path itself; later
  // failures concern the canonical path opened with symbolic links rejected.
  let stage: TargetFilesystemStage = "resolve";
  const resolve = async (): Promise<TargetResolution> => {
    throwIfTargetResolutionCancelled(signal);
    await access(candidate, constants.R_OK);
    throwIfTargetResolutionCancelled(signal);
    const canonical = await realpath(candidate);
    stage = "read";
    // Windows native admission must inspect the caller-selected reparse components.
    const sourcePath =
      HOST_PLATFORM.platform === "win32" ? candidate : canonical;
    throwIfTargetResolutionCancelled(signal);
    const resolved = await resolveAppBundle(canonical, options);
    if (!resolved.ok) return resolved;
    throwIfTargetResolutionCancelled(signal);
    const {
      executable: path,
      infoPlist,
      bundleExecutableSelection,
    } = resolved.value;
    const bundle =
      infoPlist === undefined ? {} : { bundleInfoPlist: infoPlist };
    // A bundle directory is selected for its executable, so the executable's
    // own name classifies it; a selected file keeps the caller's spelling.
    const classifiedAs = infoPlist === undefined ? candidate : path;
    return withOwnedRegularFile<TargetResolution>(
      path,
      {
        symlinks: "reject",
        ...(signal === undefined ? {} : { signal }),
      },
      async (source) => {
        try {
          return await readOpenedBinaryTarget(
            source,
            {
              path,
              sourcePath,
              callerInputPath: admitted.data,
              selectedPath: candidate,
              classifiedAs,
              ...bundle,
              ...(bundleExecutableSelection === undefined
                ? {}
                : { bundleExecutableSelection }),
            },
            options,
          );
        } catch (cause: unknown) {
          throw new OwnedRegularFileOperationFailure(cause);
        }
      },
    );
  };
  try {
    const resolved = await (options.resources === undefined
      ? resolve()
      : options.resources.run(resolve));
    return finalizedTargetResolution(resolved, signal);
  } catch (cause: unknown) {
    if (cause instanceof RegularFileCleanupFailure) {
      const fileFailure = cause as RegularFileCleanupFailure<TargetResolution>;
      if (options.resources === undefined)
        return err(
          targetFileCleanupError(
            new RetainedRegularFileCleanupFailure(fileFailure),
            candidate,
            stage,
            signal,
          ),
        );
      const retried = await retryRegularFileCleanup(
        fileFailure,
        options.resources,
        signal,
      );
      if (retried.failure !== undefined)
        return err(
          targetFileCleanupError(retried.failure, candidate, stage, signal),
        );
      // Retry settles ownership. Use the file owner's original outcome so
      // the retry helper's raw cancellation reason cannot be mistaken for I/O.
      const { operationFailure, outcome } = fileFailure;
      if (outcome.kind === "failed")
        return targetResolutionFailure(
          operationFailure ?? outcome.cause,
          candidate,
          stage,
          signal,
        );
      return finalizedTargetResolution(outcome.value, signal);
    }
    if (cause instanceof RegularFileCancelled)
      return finalizedTargetResolution(
        cause.outcome.value as TargetResolution,
        signal,
      );
    if (cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined) {
      const error = new BinaryTargetError(
        candidate,
        "A previous target file could not be closed",
        {
          cause,
          cleanup: cause.cleanup,
          partialObservation: cause.partialObservation,
        },
      );
      bindRegularFileCleanup(cause, error);
      return err(error);
    }
    return targetResolutionFailure(cause, candidate, stage, signal);
  }
};

type TargetResolution = Result<
  BinaryTarget,
  BinaryTargetError | AnalysisCancelledError
>;

/** Classify and hash the one descriptor admitted by the lifetime owner. */
const readOpenedBinaryTarget = async (
  source: StableRegularFileDescriptor,
  selected: {
    readonly path: string;
    readonly sourcePath: string;
    readonly callerInputPath: string;
    readonly selectedPath: string;
    /** Spelling whose name supplies format hints: the selected file, or a bundle's executable. */
    readonly classifiedAs: string;
  } & Pick<BinaryTarget, "bundleInfoPlist" | "bundleExecutableSelection">,
  options: BinaryTargetResolverOptions,
): Promise<TargetResolution> => {
  const { handle, initial: metadata } = source;
  const {
    path,
    sourcePath,
    callerInputPath,
    selectedPath,
    classifiedAs,
    bundleInfoPlist,
    bundleExecutableSelection,
  } = selected;
  const bundle = bundleInfoPlist === undefined ? {} : { bundleInfoPlist };
  // Every admitted target shares one identity; routes add their own facts.
  const identity = async () => ({
    path,
    sourcePath,
    ...(callerInputPath === path ? {} : { callerInputPath }),
    ...bundle,
    ...(bundleExecutableSelection === undefined
      ? {}
      : { bundleExecutableSelection }),
    sha256: await sha256Handle(source, path, signal),
  });
  const hostArchitecture =
    options.hostArchitecture ?? HOST_PLATFORM.architecture;
  const { targetKind, signal, loadSelection = {} } = options;
  const formatHint = loadSelection.format;
  throwIfTargetResolutionCancelled(signal);
  // Flash inputs pair with one format; check before any hint branch.
  const flashPairing = espFlashSelectionError({
    format: formatHint,
    flashOffset: options.espFlash?.flashOffset,
    partitionTableOffset: options.espFlash?.partitionTableOffset,
  });
  if (flashPairing !== undefined)
    return err(
      new BinaryTargetError(path, flashPairing, {
        constraint: "load_selection_rejected",
      }),
    );
  if (formatHint === "raw-binary") {
    if (targetKind !== undefined && targetKind !== "executable")
      return err(
        new BinaryTargetError(
          path,
          "raw-binary format requires an executable target kind",
          { constraint: "load_selection_rejected" },
        ),
      );
    const selected = admitRawBinary({
      architecture: loadSelection.architecture,
      entryPoint: loadSelection.entryPoint,
      baseAddress: loadSelection.baseAddress,
      architectureVariant: loadSelection.architectureVariant,
      vectorTableAddress: loadSelection.vectorTableAddress,
      fileBytes: metadata.size,
    });
    let admitted: Result<RawBinaryAdmission, RawBinaryAdmissionRejection>;
    if (!selected.ok) admitted = selected;
    // An omitted M-profile entry is the Reset word of the selected vector table.
    else if ("admit" in selected.value)
      admitted = selected.value.admit(
        await readHandleRange(
          handle,
          selected.value.fileOffset,
          selected.value.byteLength,
          signal,
        ),
      );
    else admitted = ok(selected.value);
    if (!admitted.ok)
      return err(
        new BinaryTargetError(path, admitted.error.reason, {
          constraint: admitted.error.constraint,
          ...(admitted.error.field === undefined
            ? {}
            : { field: admitted.error.field }),
          ...(admitted.error.diagnostics === undefined
            ? {}
            : { diagnostics: admitted.error.diagnostics }),
        }),
      );
    return ok({
      ...(await identity()),
      kind: "executable",
      format: "raw-binary",
      architecture: admitted.value.architecture,
      availableArchitectures: [admitted.value.architecture],
      rawLoad: admitted.value.load,
    });
  }
  const pairing = rawBinarySelectionError(loadSelection);
  if (pairing !== undefined)
    return err(
      new BinaryTargetError(path, pairing.message, {
        constraint: "load_selection_rejected",
        field: pairing.field,
      }),
    );
  if (formatHint === "gamecube-dol") {
    if (targetKind !== undefined && targetKind !== "executable")
      return err(
        new BinaryTargetError(
          path,
          "gamecube-dol format requires an executable target kind",
          { constraint: "load_selection_rejected" },
        ),
      );
    // Only the fixed header is parsed; section bounds use the file size from metadata.
    const headerBytes = await readLeadingBytes(
      handle,
      Math.min(metadata.size, DOL_HEADER_SIZE),
      path,
      signal,
    );
    const admitted = admitGamecubeDol({
      bytes: headerBytes,
      fileSize: metadata.size,
      entryPoint: loadSelection.entryPoint,
    });
    if (!admitted.ok)
      return err(
        new BinaryTargetError(path, admitted.error.reason, {
          constraint: admitted.error.constraint,
        }),
      );
    return ok({
      ...(await identity()),
      kind: "executable",
      format: "gamecube-dol",
      architecture: admitted.value.architecture,
      availableArchitectures: [admitted.value.architecture],
      byteOrder: "big",
      bits: 32,
      entryPoint: admitted.value.entryPoint,
      entryPointSource: admitted.value.entryPointSource,
      dol: admitted.value.header,
    });
  }
  if (formatHint === "esp-flash-image") {
    if (targetKind !== undefined && targetKind !== "archive")
      return err(
        new BinaryTargetError(
          path,
          "ESP flash image format requires an archive target kind",
          { constraint: "load_selection_rejected" },
        ),
      );
    const selection = options.espFlash ?? {};
    // An encrypted dump has no readable table: unknown, not malformed.
    const located = await locateEspFlashLayout(
      metadata.size,
      (position, length) => readHandleRange(handle, position, length, signal),
      selection,
      { explicit: true, ...(signal === undefined ? {} : { signal }) },
    );
    if (!located.ok)
      return err(
        new BinaryTargetError(
          path,
          `ESP flash image layout is not recognized: ${located.error}`,
          { constraint: "file_format_rejected" },
        ),
      );
    return ok({
      ...(await identity()),
      artifactSelectedPath: selectedPath,
      kind: "archive",
      format: "esp-flash-image",
      espFlash: {
        selected: true,
        flashOffset: selection.flashOffset ?? null,
        partitionTableOffset: selection.partitionTableOffset ?? null,
      },
    });
  }
  if (formatHint === "dos-com") {
    if (targetKind !== undefined && targetKind !== "executable")
      return err(
        new BinaryTargetError(
          path,
          "DOS COM format requires an executable target kind",
          { constraint: "load_selection_rejected" },
        ),
      );
    const length = validateDosComLength(metadata.size);
    if (!length.ok)
      return err(
        new BinaryTargetError(path, length.error, {
          constraint: "file_format_rejected",
        }),
      );
    return ok({
      ...(await identity()),
      kind: "executable",
      format: "dos-com",
      architecture: "x86",
      availableArchitectures: ["x86"],
    });
  }
  // Probe WASM content before suffix-only database routing; an explicit
  // database selection keeps the caller's chosen interpretation. Formats
  // recognized by a fixed content signature (iNES, UEFI, plist, ISO 9660)
  // outrank a `.hop` suffix.
  const classificationPath = artifactNameForClassification(classifiedAs, path);
  const artifactFormat =
    targetKind === "database"
      ? undefined
      : await detectArtifactFormat(classificationPath, source, signal, path);
  const artifactIdentity = async () => ({
    ...(await identity()),
    artifactSelectedPath: selectedPath,
  });
  const databaseEngine =
    targetKind === undefined || targetKind === "database"
      ? await detectDatabaseEngine(path, handle, signal)
      : null;
  if (
    targetKind === "database" ||
    (targetKind === undefined &&
      artifactFormat !== "ines" &&
      artifactFormat !== "uefi" &&
      artifactFormat !== "plist" &&
      artifactFormat !== "iso9660" &&
      databaseEngine !== null)
  )
    return ok({
      ...(await identity()),
      kind: "database",
      format: "analysis-database",
      databaseEngine,
    });
  if (artifactFormat !== undefined) {
    const identity = await artifactIdentity();
    if (artifactFormat === "esp-flash-image")
      return ok({
        ...identity,
        kind: "archive",
        format: artifactFormat,
        espFlash: {
          selected: false,
          flashOffset: null,
          partitionTableOffset: null,
        },
      });
    return isArchiveFormat(artifactFormat)
      ? ok({ ...identity, kind: "archive", format: artifactFormat })
      : ok({ ...identity, kind: "artifact", format: artifactFormat });
  }
  const detected = await readExecutableMetadata(
    source,
    hostArchitecture,
    signal,
  );
  if (!detected.ok) {
    // Only bytes no other format claims may lead a located ZIP, so an
    // executable with an appended archive keeps its executable route.
    if (
      !(await claimsLeadingExecutableHeader(handle, metadata.size, signal)) &&
      (await hasTrailingZipArchive(metadata.size, (position, length) =>
        readHandleRange(handle, position, length, signal),
      ))
    )
      return ok({
        ...(await artifactIdentity()),
        kind: "archive",
        format: zipRootPackageFormat(classificationPath),
      });
    const reason =
      typeof detected.error === "string"
        ? detected.error
        : detected.error.reason;
    const diagnostics =
      typeof detected.error === "string"
        ? undefined
        : detected.error.diagnostics;
    return err(
      new BinaryTargetError(path, reason, {
        constraint: "file_format_rejected",
        ...(diagnostics === undefined ? {} : { diagnostics }),
      }),
    );
  }
  return ok({
    ...(await identity()),
    kind: "executable",
    ...detected.value,
  });
};

/** Retain a later interruption without changing the selected admission failure. */
const retainTargetCancellation = <
  Failure extends BinaryTargetError | AnalysisCancelledError,
>(
  failure: Failure,
  signal: AbortSignal | undefined,
): Failure => {
  if (signal?.aborted === true)
    analysisErrorWithCancellation(
      failure,
      cancelledBy("resolve_binary_target", signal),
    );
  return failure;
};

/** Preserve an earlier admission refusal over an interruption during final close. */
const finalizedTargetResolution = (
  result: TargetResolution,
  signal?: AbortSignal,
): TargetResolution => {
  if (!result.ok) return err(retainTargetCancellation(result.error, signal));
  if (signal?.aborted !== true) return result;
  return err(
    cancelledBy("resolve_binary_target", signal, {
      diagnostics: { completed_target: jsonValueSchema.parse(result.value) },
    }),
  );
};

/** Descriptor cleanup retains the physical result and binds its exact release lease. */
const targetFileCleanupError = (
  failure: RetainedRegularFileCleanupFailure<TargetResolution>,
  candidate: string,
  stage: TargetFilesystemStage,
  signal: AbortSignal | undefined,
): BinaryTargetError => {
  const cancellation = regularFileCancellation(failure);
  const completed =
    failure.outcome.kind === "completed" ? failure.outcome.value : undefined;
  const completedTarget =
    completed?.ok === true ? jsonValueSchema.parse(completed.value) : undefined;
  let primary: BinaryTargetError | AnalysisCancelledError | undefined;
  if (failure.outcome.kind === "failed") {
    const physical = failure.outcome.cause;
    primary =
      physical instanceof BinaryTargetError ||
      physical instanceof AnalysisCancelledError
        ? physical
        : cancellation !== undefined
          ? cancelledBy(
              "resolve_binary_target",
              carriedReason(cancellation.reason),
            )
          : (classifyTargetFilesystemFailure(candidate, physical, stage) ??
            new BinaryTargetError(
              failure.path,
              "Target read failed before file cleanup",
              { cause: physical },
            ));
  } else if (completed?.ok === false) primary = completed.error;
  else if (cancellation !== undefined)
    primary = cancelledBy(
      "resolve_binary_target",
      carriedReason(cancellation.reason),
      completedTarget === undefined
        ? {}
        : { diagnostics: { completed_target: completedTarget } },
    );
  if (primary instanceof BinaryTargetError)
    retainTargetCancellation(primary, signal);
  const error = new BinaryTargetError(
    failure.path,
    "The target file handle could not be closed",
    {
      cause: failure,
      cleanupPrimary: primary,
      cleanup: {
        reason: errorMessage(failure.cleanupCause),
        resources: [failure.path],
      },
      ...childFailureDiagnostics(
        primary === undefined ? {} : { primary_error: { error: primary } },
        completedTarget === undefined
          ? {}
          : { completed_target: completedTarget },
      ),
    },
  );
  bindRegularFileCleanup(failure, error);
  return error;
};

const targetResolutionFailure = (
  cause: unknown,
  candidate: string,
  stage: TargetFilesystemStage,
  signal?: AbortSignal,
): TargetResolution => {
  // Physical rejection values do not grant ownership of foreign descriptors.
  const physical =
    cause instanceof OwnedRegularFileOperationFailure
      ? cause.operationCause
      : cause;
  if (
    physical instanceof AnalysisCancelledError ||
    physical instanceof BinaryTargetError
  )
    return err(retainTargetCancellation(physical, signal));
  if (!(cause instanceof OwnedRegularFileOperationFailure)) {
    const cancellation = regularFileCancellation(cause);
    if (cancellation !== undefined)
      return err(
        cancelledBy(
          "resolve_binary_target",
          carriedReason(cancellation.reason),
        ),
      );
  }
  const failure = classifyTargetFilesystemFailure(candidate, physical, stage);
  if (failure === undefined) throw physical;
  return err(retainTargetCancellation(failure, signal));
};

/** IDA databases carry a signature; Hopper databases are known only by suffix. */
const detectDatabaseEngine = async (
  path: string,
  handle: FileHandle,
  signal?: AbortSignal,
): Promise<AnalysisDatabaseEngine | null> => {
  const magic = await readHandleRange(handle, 0, 4, signal);
  if (hasIdaDatabaseSignature(magic)) return "ida";
  return path.toLowerCase().endsWith(".hop") ? "hopper" : null;
};

const detectArtifactFormat = async (
  path: string,
  source: StableRegularFileDescriptor,
  signal: AbortSignal | undefined,
  sourcePath: string,
): Promise<
  | Exclude<
      BinaryTarget["format"],
      | "analysis-database"
      | "mach-o"
      | "mach-o-universal"
      | "elf"
      | "pe"
      | "dos-mz"
      | "dos-com"
      | "raw-binary"
      | "gamecube-dol"
    >
  | undefined
> => {
  const { handle, initial } = source;
  throwIfTargetResolutionCancelled(signal);
  const lower = path.toLowerCase();
  // Fill the prefix so a short host read cannot hide a signature.
  const magic = Buffer.from(await readHandleRange(handle, 0, 4096, signal));
  try {
    await assertStableRegularFileIdentity(handle, sourcePath, initial, {
      symlinks: "reject",
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (cause: unknown) {
    throwIfTargetResolutionCancelled(signal);
    throw cause;
  }
  throwIfTargetResolutionCancelled(signal);
  if (
    magic.length >= 8 &&
    magic[0] === 0 &&
    magic[1] === 0x61 &&
    magic[2] === 0x73 &&
    magic[3] === 0x6d &&
    magic[4] === 1 &&
    magic[5] === 0 &&
    magic[6] === 0 &&
    magic[7] === 0
  )
    throw new BinaryTargetError(
      path,
      "WebAssembly v1 artifacts are not supported by the native opening route",
      { constraint: "wasm_requires_static_inspection" },
    );
  const readCachedRange = createCachedPrefixReader(
    handle,
    magic,
    initial.size,
    () => throwIfTargetResolutionCancelled(signal),
  );
  // The shared recognizer table decides; this route reads the trailer or
  // locates an ESP flash layout only when a recognizer asks for it, and
  // refuses a file whose header names a format it cannot open.
  let suffix: Uint8Array | undefined;
  let espFlashLayout: boolean | undefined;
  let iso9660Descriptor: Uint8Array | undefined;
  const recognitionInput = () => ({
    prefix: magic,
    fileSize: initial.size,
    suffix,
    espFlashLayout,
    iso9660Descriptor,
  });
  let recognition = recognizeArtifactFormat(recognitionInput());
  while (recognition !== undefined) {
    throwIfTargetResolutionCancelled(signal);
    if (recognition.state === "recognized")
      return recognition.format === "zip"
        ? zipRootPackageFormat(lower)
        : recognition.format;
    if (recognition.state === "refused")
      throw new BinaryTargetError(path, recognition.reason, {
        constraint: "file_format_rejected",
      });
    if (recognition.format === "dfuse")
      suffix =
        initial.size < DFUSE_SUFFIX_BYTES
          ? new Uint8Array(0)
          : await readCachedRange(
              initial.size - DFUSE_SUFFIX_BYTES,
              DFUSE_SUFFIX_BYTES,
            );
    else if (recognition.format === "iso9660")
      iso9660Descriptor = await readHandleRange(
        handle,
        ISO9660_DESCRIPTOR_OFFSET,
        ISO9660_SIGNATURE_BYTES,
        signal,
      );
    else
      espFlashLayout = (
        await locateEspFlashLayout(
          initial.size,
          readCachedRange,
          {},
          { explicit: false, ...(signal === undefined ? {} : { signal }) },
        )
      ).ok;
    recognition = recognizeArtifactFormat(
      recognitionInput(),
      recognition.index,
    );
  }
  const named = namedArtifactFormat(lower);
  if (named !== undefined && !claimsExecutableHeader(magic, initial.size))
    return named;
  if (lower.endsWith(".pkg") && hasXarMagic(magic)) return "pkg";
  if (
    lower.endsWith(".dmg") &&
    (await hasDiskImageSignature(initial.size, readCachedRange))
  )
    return "dmg";
  if (
    await probeUefiFlashImage(handle, signal, {
      fileSize: initial.size,
      prefix: magic,
    })
  )
    return "uefi";
  // XML property lists can use archive-specific suffixes such as .archive.
  // The named-format check above keeps .js, .map, and .asar classifications.
  const xmlProbe = createXmlPlistSignatureProbe();
  let xmlState = xmlProbe.write(magic);
  if (xmlState === "matched") return "plist";
  const chunk = Buffer.alloc(XML_PLIST_PROBE_CHUNK_BYTES);
  let bytesRead = magic.length;
  while (xmlState === "pending" && bytesRead < MAX_XML_PLIST_PROBE_BYTES) {
    throwIfTargetResolutionCancelled(signal);
    const read = await handle.read(
      chunk,
      0,
      Math.min(chunk.length, MAX_XML_PLIST_PROBE_BYTES - bytesRead),
      bytesRead,
    );
    throwIfTargetResolutionCancelled(signal);
    if (read.bytesRead === 0) break;
    bytesRead += read.bytesRead;
    xmlState = xmlProbe.write(chunk.subarray(0, read.bytesRead));
    if (xmlState === "matched") return "plist";
  }
  if (bytesRead === MAX_XML_PLIST_PROBE_BYTES) {
    const { size } = initial;
    throwIfTargetResolutionCancelled(signal);
    if (size > bytesRead)
      throw new BinaryTargetError(
        path,
        "XML plist prolog was not found within the 1 MiB format probe limit",
        { constraint: "file_format_rejected" },
      );
  }
  return undefined;
};

const isArchiveFormat = (
  format: Exclude<
    BinaryTarget["format"],
    | "analysis-database"
    | "mach-o"
    | "mach-o-universal"
    | "elf"
    | "pe"
    | "dos-mz"
    | "dos-com"
    | "raw-binary"
    | "gamecube-dol"
  >,
): format is Extract<BinaryTarget, { kind: "archive" }>["format"] =>
  BINARY_TARGET_FORMAT_KINDS[format] === "archive";

/** Whether the leading bytes begin any executable header family, valid or not. */
const claimsLeadingExecutableHeader = async (
  handle: FileHandle,
  size: number,
  signal?: AbortSignal,
): Promise<boolean> =>
  claimsExecutableHeader(
    Buffer.from(await readHandleRange(handle, 0, Math.min(size, 4096), signal)),
    size,
  );

/** Read exactly `size` bytes by offset; a short read means the file changed or ended early. */
const readLeadingBytes = async (
  handle: FileHandle,
  size: number,
  path: string,
  signal?: AbortSignal,
): Promise<Uint8Array> => {
  const bytes = Buffer.allocUnsafe(size);
  let position = 0;
  while (position < size) {
    throwIfTargetResolutionCancelled(signal);
    const observed = await handle.read(
      bytes,
      position,
      size - position,
      position,
    );
    if (observed.bytesRead === 0)
      throw new BinaryTargetError(path, "target changed while being read");
    position += observed.bytesRead;
  }
  return bytes;
};

/** The admitted target's SHA-256 from the descriptor that was classified. */
const sha256Handle = async (
  source: StableRegularFileDescriptor,
  path: string,
  signal?: AbortSignal,
): Promise<string> => {
  try {
    return (
      await hashStableRegularFileDescriptor(source, path, {
        // Target admission refuses a symbolic-link final component.
        symlinks: "reject",
        ...(signal === undefined ? {} : { signal }),
      })
    ).sha256;
  } catch (cause: unknown) {
    if (cause instanceof RegularFileOperationCancelled)
      throw cancelledBy("resolve_binary_target", carriedReason(cause.reason));
    if (cause instanceof RegularFileChangedError)
      throw new BinaryTargetError(path, "target changed while being read", {
        cause,
      });
    throw cause;
  }
};

const resolveAppBundle = async (
  path: string,
  options: Pick<BinaryTargetResolverOptions, "resources" | "signal">,
): Promise<Result<ResolvedAppBundle, BinaryTargetError>> => {
  const metadata = await stat(path);
  if (!metadata.isDirectory()) return ok({ executable: path });
  if (openableAppleBundleExtension(extname(path)) !== undefined)
    return resolveAppleBundleExecutable(path, options);
  // Another Apple bundle type, such as a driver or kernel extension, is not
  // an application directory and has no JavaScript route.
  if (isUnopenedAppleBundleExtension(extname(path)))
    return err(
      new BinaryTargetError(
        path,
        `${extname(path)} bundle directories are not opened by this route; it opens ${OPENABLE_APPLE_BUNDLE_TYPES_TEXT} bundle directories`,
        { constraint: "bundle_type_unsupported" },
      ),
    );
  return err(
    new BinaryTargetError(
      path,
      "this opening route requires a file or a supported Apple bundle directory",
      {
        constraint: "directory_requires_file",
      },
    ),
  );
};
