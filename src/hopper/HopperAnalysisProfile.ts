import {
  AnalysisCleanupLease,
  bindArtifactFileCleanup,
  ArtifactResourceRetryFailure,
} from "../resources/index.js";
import {
  observeStableFileIdentity,
  stableFileHashCause,
  type StableFileHashOptions,
} from "../filesystem/StableFileHash.js";
import {
  RegularFileCleanupFailure,
  RegularFileCancelled,
  regularFileCancellation,
  withOwnedRegularFile,
} from "../filesystem/OwnedRegularFile.js";

import { stat } from "node:fs/promises";
import {
  assertRegularFileActive,
  sameRegularFileState,
  type RegularFileState,
} from "../filesystem/RegularFile.js";
import { readFileHandleRange } from "../filesystem/readFileHandleRange.js";

import type {
  AnalysisProfileResolution,
  RetainedResourceScope,
  ProviderIdentity,
} from "../ports/AnalysisProvider.js";
import { createFunctionCoordinateContext } from "../domain/native/functionCoordinateContext.js";
import { createAnalysisProfile } from "../domain/analysisProfile.js";
import { withSecondaryCleanupFailure } from "../domain/analysisErrorCleanup.js";
import {
  isMachOFormat,
  type BinaryArchitecture,
  type BinaryTarget,
} from "../domain/binaryTargetTypes.js";
import {
  AnalysisCapabilityUnavailableError,
  cancelledBy,
  carriedReason,
} from "../domain/analysisErrorCore.js";
import { BinaryTargetError } from "../domain/configurationErrors.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import {
  machoTargetSelectionSchema,
  type MachoTargetSelection,
} from "../domain/apple/machoTargetSelection.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { machoContainerKindFromMagic } from "../domain/apple/machoContainer.js";
import { BinaryReader } from "../domain/binaryContainer.js";
import { err, ok, type Result } from "../domain/result.js";

import {
  resolveHopperMachOImage,
  type HopperMachOImageResolutionFileSystem,
  type HopperMachOImage,
} from "./HopperMachOImage.js";
import { hopperProducerIdentity } from "./HopperBridgeSources.js";
import { errorMessage } from "../kernel/errorMessage.js";

interface HopperProfileOptions {
  readonly launcherPath: string;
  readonly loaderArgsOverride: readonly string[];
  readonly provider: ProviderIdentity;
  readonly resourceScope: RetainedResourceScope;
  readonly imageFileSystem?: HopperMachOImageResolutionFileSystem;
  readonly signal?: AbortSignal;
}

/** Resolve Hopper open semantics without placing its CLI flags in BinaryTarget. */
export const resolveHopperAnalysisProfile = async (
  target: BinaryTarget,
  options: HopperProfileOptions,
): Promise<Result<AnalysisProfileResolution, AnalysisError>> => {
  try {
    return await options.resourceScope.run(() =>
      resolveHopperAnalysisProfileInScope(target, options),
    );
  } catch (cause: unknown) {
    if (cause instanceof AnalysisError) return err(cause);
    const failure = new ProviderAdapterError(
      "hopper",
      "resolve_analysis_profile",
      {
        cause,
        ...(cause instanceof ArtifactResourceRetryFailure
          ? { cleanup: cause.cleanup }
          : {}),
      },
    );
    bindArtifactFileCleanup(cause, failure);
    return err(failure);
  }
};

const resolveHopperAnalysisProfileInScope = async (
  target: BinaryTarget,
  options: HopperProfileOptions,
): Promise<Result<AnalysisProfileResolution, AnalysisError>> => {
  if (target.kind !== "executable" && target.kind !== "database")
    return ok({ profile: null });
  let machoContainer: "thin" | "fat32" | "fat64" | undefined;
  if (target.kind === "executable" && isMachOFormat(target.format)) {
    const header = await readMachoMagic(
      target.path,
      options.resourceScope,
      options.signal,
    );
    if (!header.ok) return header;
    const observed = machoContainerKindFromMagic(header.value);
    if (
      observed === null ||
      (observed === "thin") !== (target.format === "mach-o")
    )
      return err(
        new BinaryTargetError(
          target.path,
          "The selected file's container signature disagrees with its admitted Mach-O format. Open the stable source again.",
        ),
      );
    machoContainer = observed;
  }
  let preparedImage: HopperMachOImage | undefined;
  if (
    target.kind === "executable" &&
    machoContainer !== undefined &&
    options.loaderArgsOverride.length === 0
  ) {
    const resolved = await resolveHopperMachOImage(target, {
      resourceScope: options.resourceScope,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.imageFileSystem === undefined
        ? {}
        : { fileSystem: options.imageFileSystem }),
    });
    if (!resolved.ok) return resolved;
    preparedImage = resolved.value;
  }
  let targetSelection: MachoTargetSelection | undefined;
  if (preparedImage?.method === "thin_verified_copy") {
    targetSelection = machoTargetSelectionSchema.parse({
      kind: "macho-selected-image-v1",
      container: "thin",
      offset: 0,
      byte_length: preparedImage.byte_length,
      cpu_type: preparedImage.cpu_type,
      cpu_subtype: preparedImage.cpu_subtype,
      container_table_sha256: null,
    });
  } else if (preparedImage !== undefined) {
    targetSelection = machoTargetSelectionSchema.parse({
      kind: "macho-selected-image-v1",
      container: "fat",
      offset: preparedImage.source_offset,
      byte_length: preparedImage.byte_length,
      cpu_type: preparedImage.cpu_type,
      cpu_subtype: preparedImage.cpu_subtype,
      container_table_sha256: preparedImage.container_table_sha256,
    });
  }
  const derived = hopperLoaderArgsForTarget(
    target,
    preparedImage === undefined ? machoContainer : "thin",
  );
  if (!derived.ok) return derived;
  const loaderArgs =
    options.loaderArgsOverride.length === 0
      ? derived.value
      : [...options.loaderArgsOverride];
  const launcherDigest = await sha256File(
    options.launcherPath,
    options.resourceScope,
    options.signal,
  );
  if (!launcherDigest.ok) return launcherDigest;
  const provider = {
    id: options.provider.id,
    name: options.provider.name,
    version: `launcher-sha256:${launcherDigest.value}`,
  };
  return ok({
    profile: createAnalysisProfile(provider, {
      ...(target.kind === "executable" &&
      options.loaderArgsOverride.length === 0 &&
      (machoContainer === undefined || targetSelection !== undefined)
        ? {
            function_coordinate_context: createFunctionCoordinateContext(
              { loader_arguments: [...loaderArgs] },
              targetSelection ?? null,
            ),
          }
        : {}),
      target_kind: target.kind,
      target_format: target.format,
      producer: hopperProducerIdentity(),
      architecture: target.architecture ?? null,
      available_architectures: [
        ...(target.availableArchitectures ?? []),
      ].sort(),
      ...(machoContainer === undefined
        ? {}
        : { macho_container: machoContainer }),
      ...(preparedImage === undefined
        ? {}
        : { prepared_image: { ...preparedImage } }),
      ...(targetSelection === undefined
        ? {}
        : { target_selection: targetSelection }),
      loader: {
        source:
          options.loaderArgsOverride.length === 0
            ? "derived"
            : "configured_override",
        arguments: [...loaderArgs],
      },
    }),
  });
};

// Raw-only families keep the existing format refusal before loader selection.
const HOPPER_ARCHITECTURE_FLAGS = {
  x86: "--intel-32",
  x86_64: "--intel-64",
  arm: "--armv7",
  arm64: "--aarch64",
  arm64_32: null,
  mips: null,
  "6502": "raw-only",
  riscv: null,
  powerpc: null,
  m68k: "raw-only",
  hexagon: null,
  xtensa: null,
} as const satisfies Record<BinaryArchitecture, string | null>;

type HopperDeclinedArchitecture = {
  [
    Architecture in BinaryArchitecture
  ]: (typeof HOPPER_ARCHITECTURE_FLAGS)[Architecture] extends null
    ? Architecture
    : never;
}[BinaryArchitecture];

export const isHopperDeclinedArchitecture = (
  architecture: BinaryArchitecture,
): architecture is HopperDeclinedArchitecture =>
  HOPPER_ARCHITECTURE_FLAGS[architecture] === null;

/**
 * Hopper states only what it owns: it does not admit the family. It routes the
 * caller to the Ghidra provider without restating or promising Ghidra's lane
 * facts.
 */
export const hopperDeclinedArchitectureReason = (
  architecture: HopperDeclinedArchitecture,
): string =>
  architecture === "arm64_32"
    ? "REA's Hopper adapter has no verified arm64_32 lane."
    : `REA's Hopper adapter does not admit ${architecture} targets. Select the Ghidra provider instead.`;

/** Derive Hopper's complete non-interactive CLI loader selection. */
export const hopperLoaderArgsForTarget = (
  target: BinaryTarget,
  machoContainer?: "thin" | "fat32" | "fat64",
): Result<
  readonly string[],
  ProviderAdapterError | AnalysisCapabilityUnavailableError
> => {
  if (target.kind === "database") return ok([]);
  if (target.kind !== "executable")
    return err(new ProviderAdapterError("hopper", "resolve_analysis_profile"));
  if (target.format === "raw-binary")
    return err(new ProviderAdapterError("hopper", "resolve_analysis_profile"));
  const architecture = target.architecture;
  if (isHopperDeclinedArchitecture(architecture))
    return err(
      new AnalysisCapabilityUnavailableError(
        "hopper",
        "resolve_analysis_profile",
        hopperDeclinedArchitectureReason(architecture),
      ),
    );
  const flag = HOPPER_ARCHITECTURE_FLAGS[architecture];
  if (isMachOFormat(target.format)) {
    if (machoContainer === undefined)
      return err(
        new AnalysisCapabilityUnavailableError(
          "hopper",
          "resolve_analysis_profile",
          "Mach-O container kind is unknown; resolve the Hopper analysis profile before starting its client.",
        ),
      );
    return ok(
      machoContainer === "fat32" || machoContainer === "fat64"
        ? ["-l", "FAT", flag, "-l", "Mach-O"]
        : ["-l", "Mach-O", flag],
    );
  }
  switch (target.format) {
    case "elf":
      return ok(["-l", "ELF", flag]);
    case "pe":
      return ok(["-l", "WinPE", flag]);
    case "dos-mz":
    case "dos-com":
    case "gamecube-dol":
      return err(
        new ProviderAdapterError("hopper", "resolve_analysis_profile"),
      );
  }
};

const readMachoMagic = (
  path: string,
  resources: RetainedResourceScope,
  signal?: AbortSignal,
): Promise<Result<number, AnalysisError>> =>
  readHopperProfileFile(
    { path, kind: "header" },
    resources,
    signal,
    (options) =>
      withOwnedRegularFile(path, options, async ({ handle }) => {
        const magicBytes = 4;
        const bytes = await readFileHandleRange(
          handle,
          0,
          magicBytes,
          (read) => {
            if (read < magicBytes) assertRegularFileActive(signal);
          },
        );
        if (bytes.length < magicBytes)
          throw new BinaryTargetError(
            path,
            "Mach-O header became truncated before Hopper loader selection",
          );
        return new BinaryReader(bytes, false, "Mach-O").u32(0);
      }),
  );

const verifiedLauncherDigests = new Map<
  string,
  { readonly state: RegularFileState; readonly sha256: string }
>();

const sha256File = async (
  path: string,
  resources: RetainedResourceScope,
  signal: AbortSignal | undefined,
): Promise<Result<string, AnalysisError>> => {
  const cached = verifiedLauncherDigests.get(path);
  if (cached !== undefined) {
    const current = await stat(path).catch(() => undefined);
    if (
      signal?.aborted !== true &&
      current !== undefined &&
      sameRegularFileState(cached.state, current)
    )
      return ok(cached.sha256);
  }
  const hashed = await readHopperProfileFile(
    { path, kind: "launcher" },
    resources,
    signal,
    (options) => observeStableFileIdentity(path, options),
  );
  if (!hashed.ok) return hashed;
  const { state, sha256 } = hashed.value;
  verifiedLauncherDigests.set(path, { state, sha256 });
  return ok(sha256);
};

/** Both profile reads retain the exact descriptor through final close and retry. */
const readHopperProfileFile = async <Value>(
  source: { readonly path: string; readonly kind: "header" | "launcher" },
  resources: RetainedResourceScope,
  signal: AbortSignal | undefined,
  read: (options: StableFileHashOptions) => Promise<Value>,
): Promise<Result<Value, AnalysisError>> => {
  const { path, kind } = source;
  let closeLease: AnalysisCleanupLease | undefined;
  try {
    return ok(
      await read({
        ...(signal === undefined ? {} : { signal }),
        retainFailedClose: (owner) => {
          closeLease = AnalysisCleanupLease.forCloseOwner(owner, path);
          resources.retain(
            {
              close: () => closeLease!.release(),
              get cleanupResources() {
                return closeLease!.cleanupResources;
              },
            },
            path,
          );
        },
      }),
    );
  } catch (cause: unknown) {
    const physical = stableFileHashCause(
      cause instanceof RegularFileCleanupFailure
        ? cause.outcome.kind === "failed"
          ? cause.outcome.cause
          : cause.cleanupCause
        : cause,
    );
    const cleanup =
      cause instanceof RegularFileCleanupFailure
        ? {
            reason: errorMessage(cause.cleanupCause),
            resources: [path],
          }
        : undefined;
    const cancellation = regularFileCancellation(cause);
    const completed =
      (cause instanceof RegularFileCleanupFailure ||
        cause instanceof RegularFileCancelled) &&
      cause.outcome.kind === "completed"
        ? { completed_profile_read: jsonValueSchema.parse(cause.outcome.value) }
        : {};
    const diagnostics = { profile_file: { kind, path }, ...completed };
    const failure =
      cancellation !== undefined
        ? cancelledBy("open_binary", carriedReason(cancellation.reason), {
            cleanup,
            diagnostics,
          })
        : physical instanceof AnalysisError
          ? physical
          : kind === "header"
            ? new BinaryTargetError(
                path,
                `Cannot read the Mach-O container header: ${errorMessage(physical)}`,
                { cause: physical, cleanup },
              )
            : new ProviderAdapterError("hopper", "resolve_analysis_profile", {
                cause: physical,
                cleanup,
                userMessage: `Cannot fingerprint the selected Hopper launcher ${path}: ${errorMessage(physical)}`,
                remediationAction:
                  "Select a readable regular Hopper launcher, then retry provider selection.",
                diagnostics: {
                  launcher_path: path,
                  ...diagnostics,
                  system_code:
                    physical instanceof Error &&
                    typeof Reflect.get(physical, "code") === "string"
                      ? (Reflect.get(physical, "code") as string)
                      : null,
                },
              });
    if (cause instanceof RegularFileCleanupFailure) {
      const cleanupFailure = new ProviderCleanupError(
        "hopper",
        [path],
        diagnostics,
        { cause, operation: "resolve_analysis_profile" },
      );
      closeLease?.bindCleanupError(cleanupFailure);
      withSecondaryCleanupFailure(failure, cleanupFailure);
    }
    return err(failure);
  }
};
