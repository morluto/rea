import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, mkdtemp, opendir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

import type {
  ReleaseExposurePort,
  ReleaseExposureScanVisitor,
  ReleaseExposureTextVisitor,
} from "../application/releaseExposure/ReleaseExposurePort.js";
import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import {
  ArtifactReaderFailure,
  type ArtifactEntry,
  type ArtifactReader,
} from "./ArtifactReader.js";
import {
  ArtifactResourceScope,
  type ArtifactCleanupAttempt,
  type ArtifactResourceOwner,
} from "./ArtifactResourceScope.js";
import {
  artifactFileCancellationCause,
  artifactFilePrimaryFacts,
  type ArtifactFilePrimaryFacts,
} from "./ArtifactFileOperation.js";
import { decodeBinaryPlistText } from "./apple/BinaryPlistMaterializer.js";
import { ArtifactEmbeddedFormatProbes } from "./ArtifactEmbeddedFormatProbes.js";
import {
  asarHeaderAdmissionRecovery,
  createAsarHeaderSignatureProbe,
} from "./AsarHeader.js";
import {
  DEFAULT_ASAR_HEADER_ADMISSION,
  type AsarHeaderAdmission,
} from "../config/asarHeaderAdmission.js";
import { analysisSettingLimit } from "../domain/analysisSettingDefinitions.js";
import { ArtifactTraversalObservation } from "./ArtifactTraversalObservation.js";
import { classifyEmbeddedExecutablePackage } from "./inventory/classify.js";
import { inventoryArtifactInScope } from "./inventory/ArtifactInventory.js";
import {
  openRootArtifact,
  releaseRootArtifact,
} from "./inventory/hashStableRootArtifact.js";
import { createArtifactReader } from "./createArtifactReader.js";
import { readStableArtifact } from "./readStableArtifact.js";
import {
  projectArtifactCloseFailure,
  projectStableArtifactFailure,
} from "./StableArtifactFailure.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import type {
  ArtifactInventoryResult,
  ArtifactOccurrence,
} from "../domain/artifactGraph.js";
import {
  classifyFatContainerEvidence,
  readFatContainerHeader,
  readMachoHeaderPrefixFacts,
} from "../domain/apple/machoContainer.js";
import { inspectPeCodeViewFromBuffer } from "../domain/binaryTarget.js";
import { hasBinaryPlistSignature } from "../domain/apple/appleArchiveFormat.js";
import { logicalPathNfc } from "../domain/artifactIdentity.js";
import type { ArtifactAdmissionLimit } from "../domain/artifactOperationError.js";
import { observeMzWindowsHeader } from "../domain/dosMz.js";
import { evidenceSubjectFormatSchema } from "../domain/evidenceSubject.js";
import { byteOrderMarkEncoding } from "../domain/textByteOrderMark.js";
import { fixedAllowanceOptions } from "../domain/fixedAllowanceRemediation.js";
import { RELEASE_EXPOSURE_PROVIDER } from "../domain/investigationProviders.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  PACKAGED_NATIVE_IMAGES,
  MAX_RELEASE_EXPOSURE_FILE_BYTES,
  MAX_RELEASE_EXPOSURE_INVENTORY_BYTES,
  MAX_RELEASE_EXPOSURE_INVENTORY_ENTRIES,
  MAX_RELEASE_EXPOSURE_MEMBER_PROBE_BYTES,
  MAX_RELEASE_EXPOSURE_PACKAGED_PE_BYTES,
  MAX_RELEASE_EXPOSURE_PACKAGED_PE_READS,
  MAX_RELEASE_EXPOSURE_SAMPLES,
  MAX_RELEASE_EXPOSURE_MAP_TARGET_BYTES,
  MAX_RELEASE_EXPOSURE_SCRIPT_TARGET_BYTES,
  MAX_RELEASE_EXPOSURE_SOURCE_MAP_BYTES,
  MAX_RELEASE_EXPOSURE_SOURCE_MAPS,
  MAX_RELEASE_EXPOSURE_TEXT_BYTES,
  MAX_RELEASE_EXPOSURE_TEXT_MEMBER_BYTES,
  type ReleaseExposureScan,
} from "../domain/releaseExposure.js";
import { OwnedDirectoryHandle } from "../filesystem/OwnedDirectoryHandle.js";
import { appendCallerPath } from "../filesystem/callerPath.js";
import { readFileHandleRange } from "../filesystem/readFileHandleRange.js";
import {
  isSelectedRegularFileError,
  RegularFileChangedError,
  sameRegularFileState,
  type StableRegularFileDescriptor,
} from "../filesystem/RegularFile.js";
import {
  classifySourceMapSection,
  classifySourceMapSections,
  sourceMapJsonText,
} from "../domain/sourceMapEnvelope.js";
import { WEB_SOURCE_MAP_LIMITS } from "../domain/webSourceLocation.js";
import {
  inspectSourceMap,
  inspectSourceMapValue,
  SourceMapFormatFailure,
} from "../javascript/sourceMaps/SourceMapFormat.js";
import { htmlArtifactReferences } from "../domain/javascript/htmlArtifactReferences.js";
import { parseJavaScriptSource } from "../domain/javascript/javascriptSourceParser.js";
import { addSourceMapDirectives } from "../domain/javascript/javascriptStaticAnalysisCalls.js";
import { createJavaScriptAnalysisAccumulator } from "../domain/javascript/javascriptStaticAnalysisState.js";

const OPERATION = "audit_release_exposure";
type PackageFormat = Extract<
  ArtifactOccurrence["artifact_format"],
  "asar" | "bun-standalone" | "dotnet-bundle" | "node-sea" | "pyinstaller"
>;
const PACKAGE_FORMATS = [
  "asar",
  "bun-standalone",
  "dotnet-bundle",
  "node-sea",
  "pyinstaller",
] as const satisfies readonly PackageFormat[];
const EXTRACTABLE = new Set<string>(PACKAGE_FORMATS);
const asPackageFormat = (format: string): PackageFormat | null =>
  EXTRACTABLE.has(format) ? (format as PackageFormat) : null;
const NATIVE = new Set(["elf", "mach-o", "mach-o-universal", "pe"]);
const TEXT_EXTENSION =
  /\.(?:cjs|css|cts|env|html|htm|ini|js|json|jsx|map|md|mjs|mts|pem|plist|toml|ts|tsx|txt|xml|yaml|yml)$/iu;
const SIBLING_LIST_LIMIT = 4096;
const CONTAINER_LIST_LIMIT = 4096;
const OPEN_CONTAINER_LIMIT = 8;
const EMBEDDED_PROBE_LIMIT = 8;
const PDB_READ_LIMIT = 4;
const LIMITATION_CAP = 8;
const SCAN_INTERRUPTED =
  "The member scan stopped on unfinished cleanup. Members it did not reach are unknown.";
/** Decoded representation bound for one binary plist text member. */
const RELEASE_EXPOSURE_PLIST_DECODE_BYTES = 16 * 1024 * 1024;
/** Bytes of a member that decide how its NULs are read. */
const MEMBER_ENCODING_HEADER_BYTES = 512;
/** One header byte in this many being NUL is too many for UTF-8 text. */
const WIDE_TEXT_NUL_DIVISOR = 8;
const PE_MEMBER_NAME = /\.(?:dll|exe|sys)$/iu;
const JAVASCRIPT_MEMBER_NAME = /\.(?:[cm]?[jt]s|[jt]sx)$/iu;
/** Markup that `htmlArtifactReferences` reads for scripts. SVG can carry them too. */
const SCRIPT_PAGE_NAME = /\.(?:html?|svg)$/iu;

type NativeFormat = "elf" | "mach-o" | "mach-o-universal" | "pe";
type InventoryOccurrence = ArtifactInventoryResult["occurrences"][number];

/** One read attempt. Allowance and read failure are different facts. */
type MemberRead =
  | { readonly kind: "bytes"; readonly bytes: Buffer }
  | { readonly kind: "over_allowance"; readonly prefix: Buffer | null }
  | { readonly kind: "unread" };
type ReadMember = (budget: number) => Promise<MemberRead>;

interface OpenContainer {
  readonly path: string;
  readonly reader: ArtifactReader;
  entries: readonly ArtifactEntry[] | null;
  /**
   * Entries by container-relative logical path, in listing order. Inventory
   * numbers same-path occurrences in that order, so an occurrence's duplicate
   * ordinal selects its entry no matter which read path reaches it first.
   */
  readonly byPath: Map<string, ArtifactEntry[]>;
}

/** Read-only inventory and bounded member scan for one shipped artifact. */
export class ReleaseExposureReader implements ReleaseExposurePort {
  readonly identity = RELEASE_EXPOSURE_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  /**
   * @param asarHeaderAdmission The shared ASAR header/index admission the
   * composition resolved from REA_ASAR_MAX_HEADER_BYTES and the runtime
   * asar.max_header_bytes setting; read on each use, so a runtime change
   * applies to the next audit.
   */
  constructor(
    private readonly asarHeaderAdmission: AsarHeaderAdmission = DEFAULT_ASAR_HEADER_ADMISSION,
  ) {}

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        RELEASE_EXPOSURE_PROVIDER.id,
        OPERATION,
      );
    }
  }

  async inspect(
    input: { readonly path: string; readonly max_file_bytes?: number },
    options: ExecutionOptions | undefined,
    visitText: ReleaseExposureTextVisitor,
    visitInterruptedScan?: ReleaseExposureScanVisitor,
  ): Promise<Result<ReleaseExposureScan, AnalysisError>> {
    const maxFileBytes =
      input.max_file_bytes ?? MAX_RELEASE_EXPOSURE_FILE_BYTES;
    const context: ScanContext = {
      signal: options?.signal,
      resources: this.#resources,
      maxFileBytes,
      asarHeaderAdmission: this.asarHeaderAdmission,
      visitText,
      visitInterruptedScan,
      siblingCleanup: [],
    };
    try {
      return await this.#resources.run(async () => {
        if (options?.signal?.aborted)
          throw new AnalysisCancelledError(OPERATION, {
            cause: options.signal.reason,
          });
        const info = await lstat(input.path);
        if (info.isSymbolicLink())
          throw new AnalysisInputError(OPERATION, undefined, [
            {
              path: ["path"],
              reason: "invalid_format",
              message: `Selected artifact is a symlink: ${input.path}.`,
            },
          ]);
        if (info.isDirectory())
          return ok(await scanDirectory(input.path, context));
        const snapshot = await readStableArtifact(
          input.path,
          maxFileBytes,
          options?.signal,
          undefined,
          this.#resources,
        );
        return ok(
          await scanFile(input.path, snapshot.bytes, snapshot.sha256, context),
        );
      });
    } catch (cause) {
      return err(releaseExposureFailure(cause, input.path, maxFileBytes));
    }
  }
}

const scanDirectory = async (
  path: string,
  context: ScanContext,
): Promise<ReleaseExposureScan> => {
  const inventory = await inventoryArtifactInScope(path, {
    acquisitionLimits: {
      maximumEntries: MAX_RELEASE_EXPOSURE_INVENTORY_ENTRIES,
      maximumBytes: MAX_RELEASE_EXPOSURE_INVENTORY_BYTES,
    },
    // Signing an unpacked native module after packaging is routine. Record the
    // contradiction instead of refusing the whole audit.
    integrity: "record-and-continue",
    resourceScope: context.resources,
    signal: context.signal,
    selectedPath: path,
    asarHeaderAdmission: context.asarHeaderAdmission,
  });
  return consumeInventory({
    ...context,
    path,
    directory: true,
    sha256: null,
    subjectSha256: inventory.manifest.root_sha256,
    snapshot: null,
    inventory,
  });
};

const scanFile = async (
  path: string,
  bytes: Buffer,
  sha256: string,
  context: ScanContext,
): Promise<ReleaseExposureScan> => {
  let inventory: ArtifactInventoryResult | undefined;
  const limitations: string[] = [];
  try {
    inventory = await inventoryArtifactInScope(path, {
      acquisitionLimits: {
        maximumEntries: MAX_RELEASE_EXPOSURE_INVENTORY_ENTRIES,
        maximumBytes: MAX_RELEASE_EXPOSURE_INVENTORY_BYTES,
      },
      integrity: "record-and-continue",
      resourceScope: context.resources,
      signal: context.signal,
      selectedPath: path,
      expectedRootSha256: sha256,
      asarHeaderAdmission: context.asarHeaderAdmission,
    });
  } catch (cause) {
    rethrowReadFailure(cause);
    limitations.push(
      "Artifact inventory did not complete. Member coverage is unknown.",
    );
  }
  const scanned = await consumeInventory({
    ...context,
    path,
    directory: false,
    sha256,
    subjectSha256: sha256,
    snapshot: bytes,
    inventory,
  });
  return {
    ...scanned,
    coverage: inventory === undefined ? "unknown" : scanned.coverage,
    limitations: [...limitations, ...scanned.limitations].slice(
      0,
      LIMITATION_CAP,
    ),
  };
};

interface ScanContext {
  readonly signal: AbortSignal | undefined;
  readonly resources: ArtifactResourceScope;
  readonly maxFileBytes: number;
  readonly asarHeaderAdmission: AsarHeaderAdmission;
  readonly visitText: ReleaseExposureTextVisitor;
  readonly visitInterruptedScan: ReleaseExposureScanVisitor | undefined;
  readonly siblingCleanup: Extract<
    ArtifactCleanupAttempt,
    { kind: "failed" }
  >[];
}

interface ConsumeInput extends ScanContext {
  readonly path: string;
  readonly directory: boolean;
  readonly sha256: string | null;
  readonly subjectSha256: string;
  readonly snapshot: Buffer | null;
  readonly inventory: ArtifactInventoryResult | undefined;
}

const consumeInventory = async (
  input: ConsumeInput,
): Promise<ReleaseExposureScan> => {
  const containers = new Map<string, OpenContainer>();
  const progress: ScanProgress = {};
  let result: ReleaseExposureScan | undefined;
  let failure: unknown;
  let failed = false;
  try {
    result = await scanOccurrences(input, containers, progress);
  } catch (cause) {
    failure = cause;
    failed = true;
  }
  const [firstCleanup, ...remainingCleanup] = [
    ...input.siblingCleanup,
    ...(await releaseContainers(containers, input.resources)),
  ];
  if (firstCleanup !== undefined || (failed && leftCleanupUnfinished(failure)))
    reportInterruptedScan(input, result ?? progress.assemble?.());
  if (firstCleanup !== undefined) {
    const primary = failed
      ? releaseExposureFailure(failure, input.path, input.maxFileBytes)
      : new ProviderAdapterError(RELEASE_EXPOSURE_PROVIDER.id, OPERATION, {
          cause: firstCleanup.cause,
          diagnostics:
            result === undefined
              ? undefined
              : { scan: jsonValueSchema.parse(result) },
        });
    throw projectStableArtifactFailure(
      input.resources.cleanupFailure({ kind: "completed" }, [
        firstCleanup,
        ...remainingCleanup,
      ]),
      primary,
      input.path,
      RELEASE_EXPOSURE_PROVIDER.id,
      OPERATION,
    );
  }
  if (failed) throw failure;
  if (result === undefined)
    throw new Error("Release exposure scan produced no result.");
  return result;
};

/** What a failed scan can still assemble once it has somewhere to record facts. */
interface ScanProgress {
  assemble?: () => ReleaseExposureScan;
}

const leftCleanupUnfinished = (cause: unknown): boolean => {
  const failure = asReadFailure(cause);
  if (failure instanceof AnalysisError) return failure.cleanupIncomplete;
  return (
    failure instanceof ArtifactReaderFailure && failure.cleanup !== undefined
  );
};

/** Completed findings survive the failure; what was not reached stays unknown. */
const reportInterruptedScan = (
  input: ConsumeInput,
  scan: ReleaseExposureScan | undefined,
): void => {
  if (scan === undefined) return;
  input.visitInterruptedScan?.({
    ...scan,
    coverage: "unknown",
    limitations: [SCAN_INTERRUPTED, ...scan.limitations].slice(
      0,
      LIMITATION_CAP,
    ),
  });
};

/** Hand each package reader to the resource scope so a failed close keeps its path and can be retried. */
const releaseContainers = async (
  containers: Map<string, OpenContainer>,
  resources: ArtifactResourceScope,
): Promise<Extract<ArtifactCleanupAttempt, { kind: "failed" }>[]> => {
  const owned = [...containers.values()].reverse();
  containers.clear();
  const failures: Extract<ArtifactCleanupAttempt, { kind: "failed" }>[] = [];
  for (const container of owned) {
    const outcome = await resources.release({
      kind: "reader",
      resource: container.path,
      reader: container.reader,
    });
    if (outcome.kind === "failed") failures.push(outcome);
  }
  return failures;
};

const scanOccurrences = async (
  input: ConsumeInput,
  containers: Map<string, OpenContainer>,
  progress: ScanProgress,
): Promise<ReleaseExposureScan> => {
  const occurrences = input.inventory?.occurrences ?? [];
  const byId = new Map(
    occurrences.map((occurrence) => [occurrence.occurrence_id, occurrence]),
  );
  // Inventory numbers same-path occurrences in listing order; keep that
  // number as the occurrence's identity within its container.
  const ordinals = new Map<string, number>();
  const seenPaths = new Map<string, number>();
  for (const occurrence of occurrences) {
    const ordinal = seenPaths.get(occurrence.logical_path) ?? 0;
    seenPaths.set(occurrence.logical_path, ordinal + 1);
    ordinals.set(occurrence.occurrence_id, ordinal);
  }
  const nodeFormat = new Map(
    (input.inventory?.nodes ?? []).map((node) => [
      node.artifact_id,
      node.format,
    ]),
  );
  const nodeSha = new Map(
    (input.inventory?.nodes ?? []).map((node) => [
      node.artifact_id,
      node.sha256,
    ]),
  );
  const parentsWithChildren = new Set(
    occurrences.flatMap((occurrence) =>
      occurrence.parent_occurrence_id === null
        ? []
        : [occurrence.parent_occurrence_id],
    ),
  );
  const formatOf = (occurrence: InventoryOccurrence): string => {
    const fromNode =
      occurrence.artifact_id === null
        ? undefined
        : nodeFormat.get(occurrence.artifact_id);
    if (fromNode !== undefined && EXTRACTABLE.has(fromNode)) return fromNode;
    return occurrence.artifact_format;
  };
  const rootFormat =
    input.inventory?.manifest.root_format ??
    (input.snapshot === null
      ? "directory"
      : sniffNativeFormat(input.snapshot)) ??
    "file";
  const state = createState(input.visitText, input.asarHeaderAdmission);
  progress.assemble = () => assembleScan(input, state, rootFormat);
  if (EXTRACTABLE.has(rootFormat)) state.formats.add(rootFormat);
  if (input.snapshot !== null)
    await examineSelectedFile(state, input, rootFormat, input.snapshot);
  for (const occurrence of occurrences) {
    if (input.signal?.aborted)
      throw new AnalysisCancelledError(OPERATION, {
        cause: input.signal.reason,
      });
    if (
      !input.directory &&
      occurrence.parent_occurrence_id === null &&
      input.snapshot !== null
    )
      continue;
    const packaged = packageAncestor(occurrence, byId, formatOf);
    const format = formatOf(occurrence);
    const logical = occurrence.logical_path;
    const location = diskPath(input, occurrence, byId, formatOf) ?? logical;
    if (hasCompanionName(logical)) state.companionPaths.add(location);
    noteUnfollowedMapLink(state, occurrence.entry_kind, logical, location);
    if (occurrence.entry_kind !== "file") continue;
    const nativeFormat = nativeFormatOf(occurrence, nodeFormat);
    const onDisk =
      nativeFormat !== null &&
      !hasExtractableAncestor(occurrence, byId, formatOf) &&
      isAbsolute(location);
    if (onDisk && nativeFormat !== null) {
      if (!state.native.has(location)) {
        state.native.set(location, nativeFormat);
        const sha256 = shaOf(occurrence, nodeSha);
        if (sha256 !== undefined) state.nativeDigests.set(location, sha256);
        if (nativeFormat === "pe")
          await examinePdb(location, sha256, state, input);
        await scanEmbeddedPackage(
          input,
          occurrence,
          location,
          nativeFormat,
          containers,
          state,
        );
      }
      continue;
    }
    const packageKind = asPackageFormat(format);
    if (
      packageKind !== null &&
      !hasExtractableAncestor(occurrence, byId, formatOf)
    ) {
      state.formats.add(packageKind);
      if (
        !parentsWithChildren.has(occurrence.occurrence_id) &&
        isAbsolute(location)
      )
        await scanUnexpandedContainer(
          input,
          occurrence,
          location,
          packageKind,
          containers,
          state,
        );
      continue;
    }
    // A nested package that inventory recognized but did not expand was
    // never assessed, so its members leave coverage unknown. The nested
    // package itself is still an unencrypted member of its parent that
    // inventory already read, so it counts as a readable payload.
    if (
      packageKind !== null &&
      !parentsWithChildren.has(occurrence.occurrence_id)
    ) {
      noteNestedPackage(state, packageKind, location);
      if (!occurrence.encrypted) {
        state.readable += 1;
        pushSample(state.memberSamples, location);
      }
      continue;
    }
    await examineMember(state, input, {
      logical,
      format: nativeFormat ?? format,
      kind:
        ownerStatedKind(occurrence.format_metadata) ?? occurrence.artifact_kind,
      kindStated: ownerStatedKind(occurrence.format_metadata) !== null,
      encrypted: occurrence.encrypted,
      declaredSize: occurrence.declared_size,
      location,
      packageFormat:
        packaged === undefined ? null : asPackageFormat(formatOf(packaged)),
      read: (budget) =>
        readOccurrence(
          input,
          occurrence,
          ordinals,
          containers,
          byId,
          formatOf,
          nodeSha,
          state,
          budget,
        ),
    });
  }
  if (!input.directory) await scanSiblings(input, state);
  noteUnreachedTargets(state);
  return assembleScan(input, state, rootFormat);
};

const assembleScan = (
  input: ConsumeInput,
  state: ScanState,
  rootFormat: string,
): ReleaseExposureScan => {
  const kind = targetKind(input.path, rootFormat, input.directory);
  const nativeImages = [...state.native.entries()].map(([path, format]) => {
    const sha256 = state.nativeDigests.get(path);
    return { path, format, ...(sha256 === undefined ? {} : { sha256 }) };
  });
  return {
    target: {
      selected_path: input.path,
      kind,
      format: rootFormat,
      sha256: input.sha256,
    },
    subject: {
      path: input.path,
      sha256: input.subjectSha256,
      format: evidenceSubjectFormatSchema.safeParse(rootFormat).success
        ? rootFormat
        : "file",
    },
    native_images: nativeImages,
    fuse_candidates: [
      ...(kind === "app"
        ? [{ path: input.path, role: "app-bundle" as const }]
        : []),
      ...nativeImages.map((image) => ({
        path: image.path,
        role: "native-image" as const,
      })),
    ],
    source_maps: {
      embedded: state.embedded,
      without_sources: state.withoutSources,
      unparsed: state.unparsedMaps,
      skipped: state.skippedMaps,
      samples: [...state.mapSamples],
      embedded_paths: [...state.embeddedPaths],
      plain_paths: [...state.plainPaths],
    },
    extractable: {
      formats: [...state.formats],
      readable_members: state.readable,
      unreadable_members: state.unreadable,
      samples: [...state.memberSamples],
    },
    debug_companions: {
      paths: [
        ...state.companionPaths,
        ...[...state.linkerMapGuesses.values()].flatMap((paths) => [...paths]),
      ],
      skipped: state.skippedCompanions,
    },
    pdb: {
      examined: state.pdbExamined,
      paths: [...state.pdbPaths],
      image_paths: [...state.pdbImagePaths],
      failed: state.pdbFailed,
    },
    text_members: {
      scanned: state.scannedText,
      skipped: state.skippedText,
    },
    coverage:
      input.inventory === undefined || state.coverageUnknown
        ? "unknown"
        : input.inventory.coverage.status === "complete"
          ? "complete"
          : "unknown",
    omitted: [
      ...(state.skippedMaps > 0
        ? [
            {
              subject: "source maps",
              count: state.skippedMaps,
              reason:
                "A source map exceeded the map count or byte allowance, could not be read, was a link that is not followed, was past the package entry cap or the HTML inline script limit, was declared but not found, or sat in a script an HTML file loads that was not examined as one; inline CSS source-map directives are not inspected.",
            },
          ]
        : []),
      ...(state.skippedText > 0
        ? [
            {
              subject: "text members",
              count: state.skippedText,
              reason:
                "A text member exceeded the text byte allowance, could not be read, or was past the package entry cap.",
            },
          ]
        : []),
      ...(state.skippedCompanions > 0
        ? [
            {
              subject: "debug companions",
              count: state.skippedCompanions,
              reason:
                "A .map file without a JavaScript name could not be classified, or the listing beside the selected file was incomplete.",
            },
          ]
        : []),
      ...(state.packagedNative > 0
        ? [
            {
              subject: PACKAGED_NATIVE_IMAGES,
              count: state.packagedNative,
              reason:
                "Go, Rust, and Electron fuse readers run on files on disk, not on images stored inside a package.",
            },
          ]
        : []),
      ...(state.unprobedImages > 0
        ? [
            {
              subject: "embedded package probes",
              count: state.unprobedImages,
              reason: `Only ${String(EMBEDDED_PROBE_LIMIT)} native images on disk, and packaged images up to the file byte allowance in total, are probed for an embedded package.`,
            },
          ]
        : []),
    ],
    limitations: [
      ...(input.inventory?.limitations ?? []),
      ...state.limitations,
    ].slice(0, LIMITATION_CAP),
  };
};

interface ScanState {
  embedded: number;
  withoutSources: number;
  unparsedMaps: number;
  skippedMaps: number;
  mapSamples: string[];
  embeddedPaths: string[];
  plainPaths: string[];
  formats: Set<string>;
  readable: number;
  unreadable: number;
  memberSamples: string[];
  /** Companions identified by name. A later declaration does not change them. */
  companionPaths: Set<string>;
  /**
   * Maps read as non-JSON, by lookup identity, each with its reported spellings,
   * which symlinks can make differ. A later map or script declaration
   * retracts the guess.
   */
  linkerMapGuesses: Map<string, Set<string>>;
  skippedCompanions: number;
  pdbExamined: number;
  pdbPaths: string[];
  pdbImagePaths: string[];
  pdbFailed: number;
  coverageUnknown: boolean;
  pdbAttempts: number;
  packagedPeReads: number;
  packagedNative: number;
  scannedText: number;
  skippedText: number;
  textBytes: number;
  /** Bytes member reads produced, kept even when the read then failed. */
  memberBytesRead: number;
  embeddedProbes: number;
  /** Member bytes spent probing packaged images for an embedded package. */
  packagedProbeBytes: number;
  unprobedImages: number;
  native: Map<string, NativeFormat>;
  nativeDigests: Map<string, string>;
  limitations: string[];
  mapsRead: number;
  /** Local targets of source-map declarations, whatever their file name. */
  mapTargets: Set<string>;
  /** Members already examined as something other than a source map. */
  examinedLocations: Set<string>;
  /** Members already examined as a source map. */
  examinedMaps: Set<string>;
  /** Local script elements' targets whose names do not say JavaScript. */
  scriptTargets: Set<string>;
  /** Bytes of resolved path offered to `scriptTargets`, kept or refused. */
  scriptTargetBytes: number;
  mapTargetBytes: number;
  /**
   * A declared map or script target was refused by its allowance. A later
   * `.map` may be that target, so it can no longer settle as a linker map.
   */
  mapTargetsDiscarded: boolean;
  /** Members already examined as a script. */
  examinedScripts: Set<string>;
  visitText: ReleaseExposureTextVisitor;
  readonly asarHeaderAdmission: AsarHeaderAdmission;
}

const createState = (
  visitText: ReleaseExposureTextVisitor,
  asarHeaderAdmission: AsarHeaderAdmission,
): ScanState => ({
  asarHeaderAdmission,
  embedded: 0,
  withoutSources: 0,
  unparsedMaps: 0,
  skippedMaps: 0,
  mapSamples: [],
  embeddedPaths: [],
  plainPaths: [],
  formats: new Set(),
  readable: 0,
  unreadable: 0,
  memberSamples: [],
  companionPaths: new Set(),
  linkerMapGuesses: new Map(),
  skippedCompanions: 0,
  pdbExamined: 0,
  pdbPaths: [],
  pdbImagePaths: [],
  pdbFailed: 0,
  coverageUnknown: false,
  pdbAttempts: 0,
  packagedPeReads: 0,
  packagedNative: 0,
  scannedText: 0,
  skippedText: 0,
  textBytes: 0,
  memberBytesRead: 0,
  embeddedProbes: 0,
  packagedProbeBytes: 0,
  unprobedImages: 0,
  native: new Map(),
  nativeDigests: new Map(),
  limitations: [],
  mapsRead: 0,
  mapTargets: new Set(),
  examinedLocations: new Set(),
  examinedMaps: new Set(),
  scriptTargets: new Set(),
  scriptTargetBytes: 0,
  mapTargetBytes: 0,
  mapTargetsDiscarded: false,
  examinedScripts: new Set(),
  visitText,
});

interface MemberView {
  readonly logical: string;
  readonly format: string;
  readonly kind: string;
  /**
   * The package owner established `kind` from its own records. Inventory's
   * path roles, such as `resource` for `payload.json`, are only name hints.
   */
  readonly kindStated: boolean;
  readonly encrypted: boolean;
  /** Full member size its owner declared, when one did. */
  readonly declaredSize: number | null;
  /** Reported path. A package member names its host file. */
  readonly location: string;
  readonly packageFormat: PackageFormat | null;
  readonly read: ReadMember;
}

type MemberRole = Pick<MemberView, "kind" | "logical">;

const isJavaScriptMember = (member: MemberRole): boolean =>
  member.kind === "javascript" || JAVASCRIPT_MEMBER_NAME.test(member.logical);

const isCssMember = (member: MemberRole): boolean =>
  member.logical.toLowerCase().endsWith(".css");

const isScriptPageMember = (member: MemberRole): boolean =>
  SCRIPT_PAGE_NAME.test(member.logical);

/** A member whose scripts can declare a map the directive parser reads. */
const holdsScripts = (member: MemberRole): boolean =>
  isJavaScriptMember(member) || isScriptPageMember(member);

/** A member that can declare a map, whether or not the parser reads it. */
const canDeclareMap = (member: MemberRole): boolean =>
  holdsScripts(member) || isCssMember(member);

/** Bun loaders whose module contents a compiled executable ships as JavaScript. */
const BUN_SCRIPT_LOADERS = new Set(["js", "jsx", "ts", "tsx"]);

/**
 * The role a package reader states for its entry, or null when it states none.
 * A Bun sourcemap region is named `.bunmap`, a Bun module such as
 * `$bunfs/root/release` need not name a script, and a SEA entry's code path
 * need not either, so their names alone do not say what they are.
 */
const ownerStatedKind = (
  metadata: ArtifactOccurrence["format_metadata"],
): string | null => {
  if (metadata?.kind === "bun-standalone-entry") {
    if (metadata.region === "sourcemap") return "source-map";
    if (
      metadata.region === "contents" &&
      BUN_SCRIPT_LOADERS.has(metadata.loader_name ?? "")
    )
      return "javascript";
    return null;
  }
  if (metadata?.kind === "node-sea-entry" && metadata.role === "main-script")
    return "javascript";
  return null;
};

const asNativeFormat = (
  format: string | null | undefined,
): NativeFormat | null =>
  format !== undefined && format !== null && NATIVE.has(format)
    ? (format as NativeFormat)
    : null;

const nativeFormatOf = (
  occurrence: InventoryOccurrence,
  nodeFormat: Map<string, string>,
): NativeFormat | null => {
  // An embedded package keeps its container format. The host node may still
  // be pe or elf, and that native label must not hide the package.
  if (EXTRACTABLE.has(occurrence.artifact_format)) return null;
  const fromNode =
    occurrence.artifact_id === null
      ? undefined
      : nodeFormat.get(occurrence.artifact_id);
  if (fromNode !== undefined && EXTRACTABLE.has(fromNode)) return null;
  return asNativeFormat(occurrence.artifact_format) ?? asNativeFormat(fromNode);
};

const shaOf = (
  occurrence: InventoryOccurrence,
  nodeSha: Map<string, string>,
): string | undefined =>
  occurrence.artifact_id === null
    ? undefined
    : nodeSha.get(occurrence.artifact_id);

const overAllowance = (bytes: Buffer): MemberRead => ({
  kind: "over_allowance",
  prefix: bytes.subarray(0, MAX_RELEASE_EXPOSURE_MEMBER_PROBE_BYTES),
});

const fitAllowance = (bytes: Buffer, budget: number): MemberRead =>
  bytes.length <= budget ? { kind: "bytes", bytes } : overAllowance(bytes);

const examineSelectedFile = async (
  state: ScanState,
  input: ConsumeInput,
  rootFormat: string,
  bytes: Buffer,
): Promise<void> => {
  const nativeFormat = asNativeFormat(rootFormat) ?? sniffNativeFormat(bytes);
  if (nativeFormat !== null) {
    state.native.set(input.path, nativeFormat);
    if (input.sha256 !== null)
      state.nativeDigests.set(input.path, input.sha256);
  }
  if (nativeFormat === "pe") readPdb(state, bytes, input.path);
  await examineMember(state, input, {
    logical: basename(input.path),
    // A selected package executable keeps its native carrier here, so its
    // name cannot route it as a linker map.
    format: nativeFormat ?? rootFormat,
    kind: "file",
    kindStated: false,
    encrypted: false,
    declaredSize: bytes.length,
    location: input.path,
    packageFormat: null,
    read: (budget) => Promise.resolve(fitAllowance(bytes, budget)),
  });
};

/**
 * Examine one file member for the checks it can affect.
 * A listed, unencrypted package member is readable even when a read allowance
 * skips it, because the allowance belongs to this audit and not to the format.
 */
const examineMember = async (
  state: ScanState,
  context: ScanContext,
  listed: MemberView,
): Promise<void> => {
  const { packageFormat } = listed;
  if (packageFormat !== null) state.formats.add(packageFormat);
  let readable = false;
  const key = memberLocationKey(listed.location);
  const map = isDeclaredMap(state, listed);
  const member =
    !map &&
    asNativeFormat(listed.format) === null &&
    state.scriptTargets.has(key)
      ? { ...listed, kind: "javascript" }
      : listed;
  (map ? state.examinedMaps : state.examinedLocations).add(key);
  if (!map && isJavaScriptMember(member)) state.examinedScripts.add(key);
  // An owner's native format outranks anything the member's name suggests,
  // for a packaged member and for a selected or listed native image alike.
  const native = asNativeFormat(member.format) !== null;
  if (member.encrypted) noteUnreadMember(state, member);
  else if (native) {
    if (packageFormat !== null)
      readable = await examinePackagedBinary(state, member, context);
  } else if (map) readable = await examineMapMember(state, member, context);
  else if (isText(member.logical, member.kind))
    readable = await examineTextMember(state, member, context);
  else if (packageFormat !== null)
    readable = await examinePackagedBinary(state, member, context);
  else
    await examineProbedText(
      state,
      member,
      await member.read(MAX_RELEASE_EXPOSURE_MEMBER_PROBE_BYTES),
      context,
    );
  if (packageFormat === null) return;
  if (!readable) {
    state.unreadable += 1;
    return;
  }
  state.readable += 1;
  pushSample(state.memberSamples, member.location);
};

const noteUnreadMember = (state: ScanState, member: MemberView): void => {
  if (canDeclareMap(member)) state.skippedMaps += 1;
  if (asNativeFormat(member.format) !== null) noteUnreadBinary(state, member);
  else if (isDeclaredMap(state, member)) {
    noteUnreadMap(state, member, null);
    state.skippedText += 1;
  } else if (isText(member.logical, member.kind)) state.skippedText += 1;
  else noteUnreadBinary(state, member);
};

/**
 * A member whose bytes were not read. A native one may carry a package that
 * nothing here can clear, so member coverage stays unknown, as it does for a
 * packaged image the embedded-package probe could not read. An unclassified
 * one whose header was never read may be such an image too, so it leaves
 * coverage unknown as well. A caller that counts the failed read itself passes
 * `countUnreadable: false`, so the member is counted once.
 */
const noteUnreadBinary = (
  state: ScanState,
  member: MemberView,
  countUnreadable = true,
): void => {
  const native = asNativeFormat(member.format);
  if (native !== null) {
    state.packagedNative += 1;
    if (countUnreadable) noteUnexaminedPackage(state);
    else state.coverageUnknown = true;
    pushLimitation(
      state,
      `Did not probe ${member.location} for an embedded package.`,
    );
  } else {
    state.skippedText += 1;
    state.coverageUnknown = true;
    pushLimitation(
      state,
      `Could not read ${member.location} to rule out a native image or package.`,
    );
  }
  if (native === "pe" || PE_MEMBER_NAME.test(member.logical))
    notePeNotExamined(state, member.location);
};

const notePeNotExamined = (state: ScanState, location: string): void => {
  state.pdbFailed += 1;
  pushLimitation(state, `Did not examine PE debug records in ${location}.`);
};

const examineMapMember = async (
  state: ScanState,
  member: MemberView,
  context: ScanContext,
): Promise<boolean> => {
  // A member a script names or an owner marks as a map is a JavaScript map
  // whatever it is called. Only an undeclared `.map` may be a linker map.
  const undeclared =
    member.logical.toLowerCase().endsWith(".map") &&
    !state.mapTargets.has(memberLocationKey(member.location));
  const declared = undeclared
    ? member
    : { ...member, logical: `${member.logical}.js.map` };
  const read = await readMap(state, declared);
  const header = read === null ? null : headerOfRead(read.loaded);
  if (undeclared && read !== null && header !== null && hasNodeShebang(header))
    return examineShebangMap(state, member, read.hasSlot, context);
  const packaged =
    read === null ? null : packagedFormatOfRead(state, member, read.loaded);
  if (packaged === "asar") {
    noteNestedPackage(state, "asar", member.location);
    return true;
  }
  if (packaged !== null)
    return examinePackagedBinary(
      state,
      { ...member, format: packaged },
      context,
    );
  if (read !== null) settleMapRead(state, declared, read);
  const loaded = read?.loaded ?? null;
  if (loaded?.kind === "bytes")
    scanText(
      state,
      member,
      loaded.bytes.length,
      decodeMemberText(loaded.bytes),
    );
  else state.skippedText += 1;
  return loaded?.kind !== "unread";
};

/**
 * An undeclared `.map` that starts with a Node shebang is a script, such as
 * `runner.map`, so it is not a linker map. Its map slot is returned and the
 * text reader examines it as JavaScript, which reads its inline maps.
 */
const examineShebangMap = async (
  state: ScanState,
  member: MemberView,
  hasSlot: boolean,
  context: ScanContext,
): Promise<boolean> => {
  if (hasSlot) state.mapsRead -= 1;
  const key = memberLocationKey(member.location);
  state.examinedMaps.delete(key);
  state.examinedLocations.add(key);
  state.examinedScripts.add(key);
  return examineTextMember(state, { ...member, kind: "javascript" }, context);
};

/** The first bytes a read returned, or null when it returned none. */
const headerOfRead = (loaded: MemberRead): Buffer | null =>
  loaded.kind === "bytes"
    ? loaded.bytes
    : loaded.kind === "over_allowance"
      ? loaded.prefix
      : null;

/**
 * Take a slot from the map count and return the bytes this read may use. The
 * read is what the count bounds, so it is charged before the file is opened:
 * an oversized or unreadable map spends its slot like a parsed one. With no
 * slot left, only the probe is read, which can still settle a linker map.
 */
const chargeMapRead = (
  state: ScanState,
): { hasSlot: boolean; bytes: number } => {
  if (state.mapsRead >= MAX_RELEASE_EXPOSURE_SOURCE_MAPS)
    return { hasSlot: false, bytes: MAX_RELEASE_EXPOSURE_MEMBER_PROBE_BYTES };
  state.mapsRead += 1;
  return { hasSlot: true, bytes: MAX_RELEASE_EXPOSURE_SOURCE_MAP_BYTES };
};

interface MapRead {
  readonly hasSlot: boolean;
  readonly loaded: MemberRead;
}

/** The bytes a map read may use, or null when no read is allowed. */
const readMap = async (
  state: ScanState,
  map: Pick<MemberView, "logical" | "read">,
): Promise<MapRead | null> => {
  const { hasSlot, bytes } = chargeMapRead(state);
  if (!hasSlot && isJavaScriptSourceMapName(map.logical)) {
    state.skippedMaps += 1;
    return null;
  }
  return { hasSlot, loaded: await map.read(bytes) };
};

const settleMapRead = (
  state: ScanState,
  map: Pick<MemberView, "logical" | "location">,
  { hasSlot, loaded }: MapRead,
): void => {
  if (loaded.kind === "unread") noteUnreadMap(state, map, null);
  else if (loaded.kind === "over_allowance")
    noteUnreadMap(state, map, loaded.prefix);
  else if (hasSlot) readSourceMap(state, map, loaded.bytes);
  else noteUnreadMap(state, map, loaded.bytes);
};

/** Returns the read so a caller can also scan its text, or null when nothing was read. */
const examineMap = async (
  state: ScanState,
  map: Pick<MemberView, "logical" | "location" | "read">,
): Promise<MemberRead | null> => {
  const read = await readMap(state, map);
  if (read !== null) settleMapRead(state, map, read);
  return read?.loaded ?? null;
};

/**
 * Settle a .map whose body was not parsed. A JavaScript name, JSON prefix,
 * or whitespace-only prefix keeps it a possible source map. Other prefixes
 * cannot parse as one, which is the same evidence that classifies a small
 * linker map.
 */
const noteUnreadMap = (
  state: ScanState,
  map: Pick<MemberView, "logical" | "location">,
  prefix: Buffer | null,
): void => {
  if (isJavaScriptSourceMapName(map.logical)) {
    state.skippedMaps += 1;
    return;
  }
  if (prefix !== null && !mayHaveSourceMapPrefix(prefix)) {
    noteLinkerMapGuess(state, map.location);
    return;
  }
  state.skippedMaps += 1;
  state.skippedCompanions += 1;
};

/**
 * A map's text in the encoding its byte order mark names, or null for one this
 * reader does not decode, which leaves the map unresolved. Unmarked bytes are
 * read as UTF-8, as a source map is.
 */
const mapText = (bytes: Buffer): string | null => {
  const encoding = byteOrderMarkEncoding(bytes);
  if (encoding === null) return bytes.toString("utf8");
  if (encoding === "utf-32") return null;
  return new TextDecoder(encoding).decode(bytes);
};

const mayHaveSourceMapPrefix = (prefix: Buffer): boolean => {
  const text = mapText(prefix);
  return text === null || mayHaveSourceMapText(text);
};

const mayHaveSourceMapText = (decoded: string): boolean => {
  const text = sourceMapJsonText(decoded).trimStart();
  return text.length === 0 || text.startsWith("{");
};

/**
 * Leaf maps reachable within the decoder's section depth and record budgets.
 * Deeper or excess sections are dropped rather than expanded, so a map the
 * decoder refused for its limits cannot allocate past them here.
 */
const boundedSourceMapLeaves = (root: unknown): Record<string, unknown>[] => {
  const leaves: Record<string, unknown>[] = [];
  if (
    typeof root !== "object" ||
    root === null ||
    Array.isArray(root) ||
    (root as { version?: unknown }).version !== 3
  )
    return leaves;
  const pending: { map: unknown; depth: number }[] = [{ map: root, depth: 0 }];
  let records = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    const sections = classifySourceMapSections(current.map);
    if (sections.kind === "invalid") continue;
    if (sections.kind === "regular") {
      leaves.push(current.map as Record<string, unknown>);
      continue;
    }
    if (current.depth >= WEB_SOURCE_MAP_LIMITS.sectionDepth) continue;
    records += sections.sections.length;
    if (records > WEB_SOURCE_MAP_LIMITS.decodedRecords) break;
    for (let index = sections.sections.length - 1; index >= 0; index -= 1) {
      const section = classifySourceMapSection(sections.sections[index]);
      if (section.kind === "embedded")
        pending.push({ map: section.map, depth: current.depth + 1 });
    }
  }
  return leaves;
};

const readSourceMap = (
  state: ScanState,
  map: Pick<MemberView, "logical" | "location">,
  bytes: Buffer,
): void => {
  const text = mapText(bytes);
  if (text !== null) {
    readSourceMapText(state, map, text);
    return;
  }
  pushSample(state.mapSamples, map.location);
  state.unparsedMaps += 1;
};

/** Read map text already decoded by the member's owner, such as a UTF-16 script. */
const readSourceMapText = (
  state: ScanState,
  map: Pick<MemberView, "logical" | "location">,
  text: string,
): void => {
  try {
    const inspected = inspectSourceMap(text);
    const embedded = inspected.declarations.some(
      (declaration) =>
        declaration.content !== null && declaration.content.length > 0,
    );
    pushSample(state.mapSamples, map.location);
    if (embedded) {
      state.embedded += 1;
      pushSample(state.embeddedPaths, map.location);
    } else {
      state.withoutSources += 1;
      pushSample(state.plainPaths, map.location);
    }
  } catch (cause) {
    // Any format failure may still leave independently valid indexed leaves.
    if (cause instanceof SourceMapFormatFailure) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(sourceMapJsonText(text));
      } catch {
        parsed = undefined;
      }
      const budget = { records: 0 };
      let embedded = false;
      for (const leaf of boundedSourceMapLeaves(parsed)) {
        try {
          const inspected = inspectSourceMapValue(leaf, { budget });
          embedded ||= inspected.declarations.some(
            (declaration) =>
              declaration.content !== null && declaration.content.length > 0,
          );
        } catch {
          // An unresolved leaf must not discard observations from other leaves.
        }
      }
      if (embedded) {
        state.embedded += 1;
        pushSample(state.embeddedPaths, map.location);
      }
    }
    // Linker maps share the suffix but are not JavaScript source maps.
    // JSON-looking maps remain unresolved when decoding fails or hits a limit.
    if (
      !isJavaScriptSourceMapName(map.logical) &&
      !mayHaveSourceMapText(text)
    ) {
      noteLinkerMapGuess(state, map.location);
      return;
    }
    pushSample(state.mapSamples, map.location);
    state.unparsedMaps += 1;
  }
};

/**
 * A script role says how a member is loaded, not what its bytes are. A `.map`
 * or script target whose text parses as a source map is read as one, so a
 * page that loads `main.map` as a script cannot hide the sources it ships.
 */
const scriptHoldsMap = (
  state: ScanState,
  member: MemberView,
  text: string,
): boolean => {
  if (!isJavaScriptMember(member)) return false;
  if (
    !member.logical.toLowerCase().endsWith(".map") &&
    !state.scriptTargets.has(memberLocationKey(member.location))
  )
    return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceMapJsonText(text));
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return false;
  return (
    "version" in parsed &&
    ("mappings" in parsed || "sources" in parsed || "sections" in parsed)
  );
};

/**
 * Read a script member as the source map it holds, from the text that
 * recognized it, so a byte order mark decides the encoding for both reads.
 */
const readScriptAsMap = (
  state: ScanState,
  member: MemberView,
  bytes: Buffer,
  text: string,
): void => {
  const { hasSlot } = chargeMapRead(state);
  if (hasSlot && bytes.length <= MAX_RELEASE_EXPOSURE_SOURCE_MAP_BYTES)
    readSourceMapText(state, member, text);
  else state.skippedMaps += 1;
};

const examineTextMember = async (
  state: ScanState,
  member: MemberView,
  context: ScanContext,
): Promise<boolean> => {
  // CSS can declare inline maps, but the directive parser only handles JavaScript.
  if (isCssMember(member)) state.skippedMaps += 1;
  const remaining = MAX_RELEASE_EXPOSURE_TEXT_BYTES - state.textBytes;
  if (remaining <= 0) {
    // A packaged member's name is not its format, so one whose header was
    // never read may be a native image or package, as an unread `.bin` may.
    if (member.packageFormat !== null && !member.kindStated) {
      state.coverageUnknown = true;
      pushLimitation(
        state,
        `Did not read ${member.location} past the text allowance to rule out a native image or package.`,
      );
    }
    state.skippedText += 1;
    if (holdsScripts(member)) state.skippedMaps += 1;
    return true;
  }
  const bytesReadBefore = state.memberBytesRead;
  const loaded = await member.read(
    Math.min(MAX_RELEASE_EXPOSURE_TEXT_MEMBER_BYTES, remaining),
  );
  const packaged = packagedFormatOfRead(state, member, loaded);
  if (packaged !== null) {
    state.textBytes += state.memberBytesRead - bytesReadBefore;
    if (packaged !== "asar")
      return examinePackagedBinary(
        state,
        { ...member, format: packaged },
        context,
      );
    noteNestedPackage(state, "asar", member.location);
    return true;
  }
  return examineLoadedText(
    state,
    scriptRoleOfRead(state, member, loaded),
    loaded,
    bytesReadBefore,
  );
};

/**
 * A text member's name may not say it is a script: `runner.txt` can start
 * with a Node shebang. The bytes this read returned decide, so every route
 * into the text reader gives such a file its JavaScript role.
 */
const scriptRoleOfRead = (
  state: ScanState,
  member: MemberView,
  loaded: MemberRead,
): MemberView => {
  if (holdsScripts(member)) return member;
  const header = headerOfRead(loaded);
  if (header === null || !hasNodeShebang(header)) return member;
  state.examinedScripts.add(memberLocationKey(member.location));
  return { ...member, kind: "javascript" };
};

const examineLoadedText = (
  state: ScanState,
  member: MemberView,
  loaded: MemberRead,
  bytesReadBefore: number,
): boolean => {
  if (loaded.kind === "bytes") {
    const text = decodeMemberText(loaded.bytes);
    scanText(state, member, loaded.bytes.length, text);
    if (holdsScripts(member)) {
      if (text === null) state.skippedMaps += 1;
      else if (scriptHoldsMap(state, member, text.text))
        readScriptAsMap(state, member, loaded.bytes, text.text);
      else {
        if (isJavaScriptMember(member))
          examineInlineMaps(state, member, text.text, member.logical);
        // A page another page loads as a script still ships as a page.
        if (isScriptPageMember(member))
          examineHtmlScripts(state, member, text.text);
      }
    }
  } else {
    // The allowance bounds the read, so a read that yielded no text still spends it.
    state.textBytes += state.memberBytesRead - bytesReadBefore;
    // A packaged member's name is not its format, so one whose header was
    // never read may be a native image or package, as an unread `.bin` may.
    if (
      loaded.kind === "unread" &&
      member.packageFormat !== null &&
      !member.kindStated
    )
      noteUnreadBinary(state, member);
    else state.skippedText += 1;
    if (holdsScripts(member)) state.skippedMaps += 1;
  }
  return loaded.kind !== "unread";
};

/**
 * A shebang that runs Node makes a file a script whatever it is called. The
 * path classifier cannot see this, so the first bytes read establish it.
 */
const hasNodeShebang = (prefix: Buffer): boolean => {
  if (prefix.toString("latin1", 0, 2) !== "#!") return false;
  const [line = ""] = prefix.toString("latin1", 2).split("\n", 1);
  const [interpreter = "", ...args] = line.trim().split(/[ \t]+/u);
  const program =
    basename(interpreter) === "env" ? envProgram(args) : interpreter;
  return program !== undefined && /^node(?:js)?$/u.test(basename(program));
};

/** `env` options whose argument is the next field, as in `-u NODE_OPTIONS`. */
const ENV_OPTION_WITH_ARGUMENT = new Set([
  "-u",
  "--unset",
  "-C",
  "--chdir",
  "-P",
]);

/**
 * The program an `env` shebang runs: the first field that is neither an
 * option, an option's argument, nor a `NAME=value` setting. `-S` splits the
 * rest of the line, so its attached text is read as the next fields.
 */
const envProgram = (args: string[]): string | undefined => {
  const fields = [...args];
  while (fields.length > 0) {
    const field = fields.shift() ?? "";
    // Past `--` nothing is an option, but settings still come first.
    if (field === "--") return fields.find((rest) => !rest.includes("="));
    if (ENV_OPTION_WITH_ARGUMENT.has(field)) {
      fields.shift();
      continue;
    }
    if (/^-[0iv]*S./u.test(field)) {
      fields.unshift(field.slice(field.indexOf("S") + 1));
      continue;
    }
    if (field.startsWith("--split-string=")) {
      fields.unshift(field.slice("--split-string=".length));
      continue;
    }
    if (field.startsWith("-") || field.includes("=")) continue;
    return field;
  }
  return undefined;
};

/**
 * A name is not a format: a package member called `payload.json` or
 * `payload.js.map` can be a PE or an ASAR, and a script or map declaration
 * names whatever is at its target, and inventory's role for a member is a
 * guess from that name. The route's own read decides, so real text and maps
 * cost no further read. Only a kind the package owner stated is kept.
 */
const packagedFormatOfRead = (
  state: ScanState,
  member: MemberView,
  loaded: MemberRead,
): NativeFormat | "asar" | null => {
  if (member.packageFormat === null || member.kindStated) return null;
  if (loaded.kind === "unread") return null;
  const header = loaded.kind === "bytes" ? loaded.bytes : loaded.prefix;
  if (header === null) return null;
  const native = sniffNativeFormat(
    header,
    loaded.kind === "bytes" ? header.length : member.declaredSize,
  );
  if (native !== null) return native;
  return probeNestedAsar(
    state,
    member.location,
    header,
    loaded.kind === "bytes",
  )
    ? "asar"
    : null;
};

/**
 * Recognize text from bounded content. A name such as `.env.production`,
 * `server.key`, or `credentials` is not a complete statement of what a file is.
 * Content that could not be probed leaves text coverage undecided.
 */
const examineProbedText = async (
  state: ScanState,
  member: MemberView,
  probe: MemberRead,
  context: ScanContext,
): Promise<void> => {
  const prefix =
    probe.kind === "bytes"
      ? probe.bytes
      : probe.kind === "over_allowance"
        ? probe.prefix
        : null;
  if (prefix === null) state.skippedText += 1;
  else if (hasNodeShebang(prefix)) {
    // The probe already read the header, so the role holds even when the
    // text allowance is spent before the text reader reads it again.
    state.examinedScripts.add(memberLocationKey(member.location));
    await examineTextMember(state, { ...member, kind: "javascript" }, context);
  } else if (
    prefix.length > 0 &&
    (!prefix.includes(0) || declaresTextEncoding(prefix))
  )
    await examineTextMember(state, member, context);
};

/**
 * A script element's body declares maps as a script file does. Bodies past the
 * HTML owner's retained limit were not read, so each counts as a skipped map.
 */
const examineHtmlScripts = (
  state: ScanState,
  member: MemberView,
  source: string,
): void => {
  const { baseHref, scripts, inlineScripts, inlineScriptCount } =
    htmlArtifactReferences(source);
  for (const { scriptPath, scriptType } of scripts)
    if (scriptType !== null)
      noteScriptReference(state, member, scriptPath, baseHref);
  for (const script of inlineScripts)
    examineInlineMaps(
      state,
      member,
      script.text,
      script.scriptType === "module" ? "inline.mjs" : "inline.js",
    );
  state.skippedMaps += inlineScriptCount - inlineScripts.length;
};

/**
 * A script element loads its target whatever the file is called, and a remote
 * script is not shipped. Every local target is recorded so it is examined as a
 * script when it is reached, and one that is never reached, such as a sibling
 * of a selected file, stays unassessed rather than absent. A target that cannot
 * be placed on disk stays unassessed.
 */
const noteScriptReference = (
  state: ScanState,
  member: MemberView,
  scriptPath: string,
  baseHref: string | null,
): void => {
  try {
    const page = pathToFileURL(member.location);
    const url = new URL(
      scriptPath,
      baseHref === null ? page : new URL(baseHref, page),
    );
    if (url.protocol === "http:" || url.protocol === "https:") return;
    noteScriptTarget(state, fileURLToPath(url));
  } catch {
    state.skippedMaps += 1;
  }
};

/**
 * A base href is copied into every target it resolves, so a page's paths can
 * outgrow its text many times over. A target past the allowance stays unassessed.
 * A target already read is not a linker map, whatever its first read guessed,
 * and its script was not examined, so its source-map coverage stays unknown.
 */
const noteScriptTarget = (state: ScanState, location: string): void => {
  const target = memberLocationKey(location);
  if (state.examinedScripts.has(target) || state.scriptTargets.has(target))
    return;
  if (state.examinedLocations.has(target) || state.examinedMaps.has(target)) {
    state.linkerMapGuesses.delete(target);
    state.skippedMaps += 1;
    return;
  }
  state.scriptTargetBytes += Buffer.byteLength(target);
  if (state.scriptTargetBytes > MAX_RELEASE_EXPOSURE_SCRIPT_TARGET_BYTES) {
    state.skippedMaps += 1;
    state.mapTargetsDiscarded = true;
  } else state.scriptTargets.add(target);
};

const examineInlineMaps = (
  state: ScanState,
  member: MemberView,
  source: string,
  sourcePath: string,
): void => {
  const parsed = parseJavaScriptSource(source, sourcePath);
  if (parsed === null) {
    state.skippedMaps += 1;
    return;
  }
  const directives = createJavaScriptAnalysisAccumulator(source.length);
  addSourceMapDirectives(source, parsed.comments ?? [], directives);
  for (const { declared_url: url } of directives.sourceMaps) {
    // URL schemes are case-insensitive (RFC 3986 section 3.1).
    if (!/^data:/iu.test(url)) {
      noteLocalMapReference(state, member, url);
      continue;
    }
    const comma = url.indexOf(",");
    if (state.mapsRead >= MAX_RELEASE_EXPOSURE_SOURCE_MAPS || comma < 0) {
      state.skippedMaps += 1;
      continue;
    }
    try {
      const metadata = url.slice(0, comma);
      const payload = url.slice(comma + 1);
      const decoded = /;base64$/iu.test(metadata)
        ? Buffer.from(decodeURIComponent(payload), "base64")
        : Buffer.from(decodeURIComponent(payload), "utf8");
      if (decoded.length > MAX_RELEASE_EXPOSURE_SOURCE_MAP_BYTES) {
        state.skippedMaps += 1;
        continue;
      }
      state.mapsRead += 1;
      // An inline declaration is a JavaScript map even if its JSON is invalid.
      readSourceMap(
        state,
        { logical: "inline.js.map", location: member.location },
        decoded,
      );
    } catch {
      state.unparsedMaps += 1;
    }
  }
};

/**
 * A declaration names its map by location, not by file name. Every local
 * target is recorded so it is examined as a map when it is reached, and one
 * that is never reached, such as a sibling of a selected file, stays
 * unassessed rather than absent. A target already
 * examined as ordinary text was not assessed as a map, so coverage is unknown.
 * A `file:` URL names one absolute location rather than a path beside the
 * script, so even a `.map` target stays unassessed until that location is
 * reached. Any other scheme is remote.
 */
const noteLocalMapReference = (
  state: ScanState,
  member: MemberView,
  url: string,
): void => {
  if (/^file:/iu.test(url)) {
    try {
      noteMapTarget(state, fileURLToPath(url));
    } catch {
      state.skippedMaps += 1;
    }
    return;
  }
  if (/^[a-z][a-z0-9+.-]+:/iu.test(url)) return;
  const path = url.replace(/[?#].*$/su, "");
  if (path.length === 0) return;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    state.skippedMaps += 1;
    return;
  }
  noteMapTarget(state, resolve(dirname(member.location), decoded));
};

/**
 * A short URL is expanded by the declaring member's directory, so declared
 * paths can outgrow their text many times over. A target past the allowance
 * stays unassessed.
 */
const noteMapTarget = (state: ScanState, location: string): void => {
  const target = memberLocationKey(location);
  // A map read before its declaration may have settled as a linker map.
  state.skippedMaps += state.linkerMapGuesses.get(target)?.size ?? 0;
  state.linkerMapGuesses.delete(target);
  if (state.examinedMaps.has(target) || state.mapTargets.has(target)) return;
  if (state.examinedLocations.has(target)) {
    state.skippedMaps += 1;
    return;
  }
  state.mapTargetBytes += Buffer.byteLength(target);
  if (state.mapTargetBytes > MAX_RELEASE_EXPOSURE_MAP_TARGET_BYTES) {
    state.skippedMaps += 1;
    state.mapTargetsDiscarded = true;
  } else state.mapTargets.add(target);
};

/**
 * Lookup identity for a member location. Inventory reports logical paths in
 * NFC, so a declared target spelled in another normalization form still
 * names the same member. The declared URL itself is left as written.
 */
const memberLocationKey = (location: string): string =>
  logicalPathNfc(resolve(location));

const noteLinkerMapGuess = (state: ScanState, location: string): void => {
  // Once a map or script declaration was discarded, this map may be its target.
  if (state.mapTargetsDiscarded) {
    state.skippedMaps += 1;
    state.skippedCompanions += 1;
    return;
  }
  const key = memberLocationKey(location);
  const paths = state.linkerMapGuesses.get(key) ?? new Set();
  state.linkerMapGuesses.set(key, paths.add(location));
};

/**
 * An owner's stated role or a declaration outranks the member's name, and an
 * inventory path role is only that name: a `.map` that an owner marks as
 * JavaScript or a page loads as a script is not a map.
 */
const isDeclaredMap = (state: ScanState, member: MemberView): boolean => {
  if (member.kindStated && member.kind === "source-map") return true;
  const key = memberLocationKey(member.location);
  if (state.mapTargets.has(key)) return true;
  if (member.kind === "javascript" || state.scriptTargets.has(key))
    return false;
  return isSourceMap(member.logical, member.kind);
};

/** A declared map or script target that was never reached was not assessed. */
const noteUnreachedTargets = (state: ScanState): void => {
  for (const target of state.mapTargets)
    if (!state.examinedMaps.has(target)) state.skippedMaps += 1;
  for (const target of state.scriptTargets)
    if (!state.examinedScripts.has(target)) state.skippedMaps += 1;
};

/** Text decoded from a member; `complete` is false when part of it went unread. */
interface MemberText {
  readonly text: string;
  readonly complete: boolean;
}

/**
 * A binary plist that cannot be fully decoded keeps its raw bytes in the scan,
 * for the ASCII strings they show, beside whatever text it did decode, but its
 * other strings were not examined.
 */
const decodeBinaryPlistMember = (bytes: Buffer): MemberText => {
  try {
    const decoded = decodeBinaryPlistText(
      bytes,
      RELEASE_EXPOSURE_PLIST_DECODE_BYTES,
    );
    return decoded.complete
      ? decoded
      : { text: `${decoded.text}\n${bytes.toString("utf8")}`, complete: false };
  } catch {
    return { text: bytes.toString("utf8"), complete: false };
  }
};

/**
 * Bytes that name their own text encoding, whose NULs are that encoding's
 * structure rather than a sign of binary data. `decodeMemberText` reads each of
 * these; a probe that admits on NULs alone would drop them unexamined.
 */
const declaresTextEncoding = (bytes: Buffer): boolean =>
  byteOrderMarkEncoding(bytes) !== null || hasBinaryPlistSignature(bytes);

/**
 * The text a member's bytes encode, or null when they cannot be read as text.
 * A member's kind says nothing about its encoding: wide text has no byte order
 * mark to explain its NULs, and a scan of it would match nothing and still count
 * as complete. A NUL inside UTF-8 text does not change how the rest of it reads.
 * A binary plist has its own object encoding, so its owner decodes it.
 */
const decodeMemberText = (bytes: Buffer): MemberText | null => {
  const encoding = byteOrderMarkEncoding(bytes);
  if (encoding === "utf-32") return null;
  if (encoding !== null)
    return { text: new TextDecoder(encoding).decode(bytes), complete: true };
  if (hasBinaryPlistSignature(bytes)) return decodeBinaryPlistMember(bytes);
  if (hasNonUtf8Nul(bytes)) return null;
  return { text: bytes.toString("utf8"), complete: true };
};

const scanText = (
  state: ScanState,
  member: MemberView,
  byteLength: number,
  text: MemberText | null,
): void => {
  if (
    byteLength > MAX_RELEASE_EXPOSURE_TEXT_MEMBER_BYTES ||
    state.textBytes + byteLength > MAX_RELEASE_EXPOSURE_TEXT_BYTES
  ) {
    state.skippedText += 1;
    return;
  }
  state.textBytes += byteLength;
  if (text === null) {
    state.skippedText += 1;
    return;
  }
  if (text.complete) state.scannedText += 1;
  else state.skippedText += 1;
  state.visitText(text.text, member.location);
};

/**
 * Probe a package member that is neither text nor a map. Only its header is
 * read unless the bytes declare a PE, so large binary members cost no budget
 * that a later source map or text member needs.
 */
const examinePackagedBinary = async (
  state: ScanState,
  member: MemberView,
  context: ScanContext,
): Promise<boolean> => {
  const probe = await member.read(MAX_RELEASE_EXPOSURE_MEMBER_PROBE_BYTES);
  if (probe.kind === "unread") {
    // `examineMember` counts this failed read.
    noteUnreadBinary(state, member, false);
    return false;
  }
  const header = probe.kind === "bytes" ? probe.bytes : probe.prefix;
  const native =
    asNativeFormat(member.format) ??
    (header === null
      ? null
      : sniffNativeFormat(
          header,
          probe.kind === "bytes" ? header.length : member.declaredSize,
        ));
  if (native === null && header?.toString("latin1", 0, 2) === "MZ") {
    const windows = observeMzWindowsHeader(header);
    if (
      windows.state === "signature-needed" ||
      (windows.state === "candidate" && windows.signature === "unobserved")
    ) {
      // The image may be native, so it stays unexamined by the on-disk readers,
      // and it may carry a package that nothing here can clear.
      state.packagedNative += 1;
      notePeNotExamined(state, member.location);
      noteUnexaminedPackage(state);
    }
  }
  if (
    native === null &&
    header !== null &&
    probeNestedAsar(state, member.location, header, probe.kind === "bytes")
  ) {
    noteNestedPackage(state, "asar", member.location);
    return true;
  }
  if (native !== null) {
    state.packagedNative += 1;
    await probePackagedImage(state, member, native, context);
  } else await examineProbedText(state, member, probe, context);
  if (native !== "pe") return true;
  if (state.packagedPeReads >= MAX_RELEASE_EXPOSURE_PACKAGED_PE_READS) {
    notePeNotExamined(state, member.location);
    return true;
  }
  state.packagedPeReads += 1;
  const image =
    probe.kind === "bytes"
      ? probe
      : await member.read(MAX_RELEASE_EXPOSURE_PACKAGED_PE_BYTES);
  if (image.kind === "bytes") readPdb(state, image.bytes, member.location);
  else notePeNotExamined(state, member.location);
  return image.kind !== "unread";
};

const readPdb = (state: ScanState, bytes: Buffer, imagePath: string): void => {
  const header = observeMzWindowsHeader(bytes);
  if (header.state !== "declared" || header.signature !== "PE") {
    state.pdbFailed += 1;
    return;
  }
  state.pdbExamined += 1;
  try {
    const parsed = inspectPeCodeViewFromBuffer(bytes, header.offset);
    if (!parsed.ok) {
      state.pdbFailed += 1;
      pushLimitation(state, `${imagePath}: ${parsed.error.message}`);
    } else if (parsed.value !== undefined && parsed.value.pdbPath.length > 0) {
      const record = parsed.value;
      pushSample(state.pdbPaths, record.pdbPath);
      pushSample(state.pdbImagePaths, imagePath);
    }
  } catch {
    state.pdbFailed += 1;
  }
};

const examinePdb = async (
  filePath: string,
  expectedSha256: string | undefined,
  state: ScanState,
  { signal, resources, maxFileBytes }: ScanContext,
): Promise<void> => {
  if (state.pdbAttempts >= PDB_READ_LIMIT) {
    state.pdbFailed += 1;
    return;
  }
  state.pdbAttempts += 1;
  try {
    const snapshot = await readStableArtifact(
      filePath,
      maxFileBytes,
      signal,
      undefined,
      resources,
    );
    if (expectedSha256 !== undefined && snapshot.sha256 !== expectedSha256)
      throw new ArtifactReaderFailure(
        "integrity",
        `Member changed during acquisition: ${filePath}`,
      );
    readPdb(state, snapshot.bytes, filePath);
  } catch (cause) {
    rethrowReadFailure(cause);
    state.pdbFailed += 1;
    pushLimitation(state, `Could not read PE debug records from ${filePath}.`);
  }
};

const readOccurrence = async (
  input: ConsumeInput,
  occurrence: InventoryOccurrence,
  ordinals: ReadonlyMap<string, number>,
  containers: Map<string, OpenContainer>,
  byId: Map<string, InventoryOccurrence>,
  formatOf: (occurrence: InventoryOccurrence) => string,
  nodeSha: Map<string, string>,
  state: ScanState,
  budget: number,
): Promise<MemberRead> => {
  const parent =
    occurrence.parent_occurrence_id === null
      ? undefined
      : byId.get(occurrence.parent_occurrence_id);
  const packaged = packageAncestor(occurrence, byId, formatOf);
  const container = packaged ?? parent;
  const containerFormat = container === undefined ? null : formatOf(container);
  const extractable =
    containerFormat !== null && EXTRACTABLE.has(containerFormat);
  const compressed =
    occurrence.compressed_size !== null && occurrence.compressed_size > 0;
  const located = occurrence.source_location;
  if (
    extractable &&
    container !== undefined &&
    containerFormat !== null &&
    (compressed || located === null)
  ) {
    const containerPath = diskPath(input, container, byId, formatOf);
    if (containerPath === null) return { kind: "unread" };
    return readContainerMember(
      input,
      container,
      containerPath,
      containerFormat,
      shaOf(container, nodeSha),
      shaOf(occurrence, nodeSha),
      occurrence,
      ordinals,
      containers,
      budget,
      state,
    );
  }
  if (located !== null && !compressed && parent !== undefined) {
    if (
      input.snapshot !== null &&
      parent.parent_occurrence_id === null &&
      located.offset >= 0 &&
      located.offset + located.length <= input.snapshot.length
    )
      return fitAllowance(
        input.snapshot.subarray(
          located.offset,
          located.offset + located.length,
        ),
        budget,
      );
    const parentPath = diskPath(input, parent, byId, formatOf);
    if (parentPath !== null) {
      const bytes = await readSpan(
        parentPath,
        located.offset,
        Math.min(located.length, budget),
        state,
        input,
      );
      if (bytes === null) return { kind: "unread" };
      return located.length > budget
        ? overAllowance(bytes)
        : { kind: "bytes", bytes };
    }
  }
  const filePath = diskPath(input, occurrence, byId, formatOf);
  if (filePath === null) return { kind: "unread" };
  if (input.snapshot !== null && filePath === input.path)
    return fitAllowance(input.snapshot, budget);
  return readDiskMember(
    filePath,
    budget,
    shaOf(occurrence, nodeSha),
    state,
    input,
  );
};

type EmbeddedPackageProbe =
  | { readonly kind: "package"; readonly format: PackageFormat }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable" };

/**
 * Own one member descriptor. A failed close stays retained by the resource
 * scope, and the primary failure survives it.
 */
const withMemberDescriptor = async <T>(
  filePath: string,
  { resources, signal }: ScanContext,
  use: (source: StableRegularFileDescriptor) => Promise<T>,
): Promise<T> => {
  const source = await openRootArtifact(filePath, resources, signal);
  let settled: Result<T, unknown>;
  try {
    settled = ok(await use(source));
  } catch (cause) {
    settled = err(asReadFailure(cause));
  }
  await releaseRootArtifact(
    filePath,
    source.owner,
    resources,
    settled.ok
      ? { kind: "completed", digest: null }
      : { kind: "failed", cause: settled.error },
    signal,
  );
  if (!settled.ok) throw settled.error;
  return settled.value;
};

const embeddedPackageFormat = async (
  filePath: string,
  nativeFormat: NativeFormat,
  state: ScanState,
  context: ScanContext,
  location = filePath,
): Promise<EmbeddedPackageProbe> => {
  try {
    return await withMemberDescriptor(filePath, context, async (source) => {
      if (source.initial.size > context.maxFileBytes) {
        pushLimitation(
          state,
          `Did not probe ${location} for an embedded package because it exceeds ${String(context.maxFileBytes)} bytes.`,
        );
        return { kind: "unreadable" };
      }
      const probes = new ArtifactEmbeddedFormatProbes(
        filePath,
        source,
        context.signal,
      );
      const classified = await classifyEmbeddedExecutablePackage(
        probes,
        nativeFormat,
        context.signal,
      );
      return classified === undefined
        ? { kind: "absent" }
        : { kind: "package", format: classified.format };
    });
  } catch (cause) {
    rethrowReadFailure(cause);
    pushLimitation(
      state,
      `Could not probe ${location} for an embedded package.`,
    );
    return { kind: "unreadable" };
  }
};

/**
 * The embedded-package probes read carrier offsets from a file, and a package
 * member has no file of its own, so its bytes stay on disk for the probe alone.
 */
const embeddedPackageFormatOfBytes = async (
  bytes: Buffer,
  member: MemberView,
  nativeFormat: NativeFormat,
  state: ScanState,
  context: ScanContext,
): Promise<EmbeddedPackageProbe> => {
  try {
    const root = await mkdtemp(join(tmpdir(), "rea-release-member-"));
    const owner: ArtifactResourceOwner = {
      kind: "lease",
      resource: root,
      lease: { release: () => rm(root, { force: true, recursive: true }) },
    };
    let settled: Result<EmbeddedPackageProbe, unknown>;
    try {
      const filePath = join(root, "member");
      await writeFile(filePath, bytes, { flag: "wx", mode: 0o600 });
      settled = ok(
        await embeddedPackageFormat(
          filePath,
          nativeFormat,
          state,
          context,
          member.location,
        ),
      );
    } catch (cause) {
      settled = err(cause);
    }
    // The directory holds the member's bytes, so a failed removal stays owned.
    const removal = await context.resources.release(owner);
    if (removal.kind === "failed")
      throw context.resources.cleanupFailure(
        settled.ok
          ? { kind: "completed" }
          : { kind: "failed", cause: settled.error },
        [removal],
      );
    if (!settled.ok) throw settled.error;
    return settled.value;
  } catch (cause) {
    rethrowReadFailure(cause);
    pushLimitation(
      state,
      `Could not probe ${member.location} for an embedded package.`,
    );
    return { kind: "unreadable" };
  }
};

/**
 * A packaged executable can carry its own package, whose members this scan does
 * not expand. Only an image the embedded-package owner cleared leaves member
 * coverage intact. All members share one file's byte allowance.
 */
const probePackagedImage = async (
  state: ScanState,
  member: MemberView,
  nativeFormat: NativeFormat,
  context: ScanContext,
): Promise<void> => {
  const allowance = context.maxFileBytes - state.packagedProbeBytes;
  const image = allowance > 0 ? await member.read(allowance) : null;
  if (image?.kind !== "bytes") {
    state.packagedProbeBytes = context.maxFileBytes;
    state.unprobedImages += 1;
    noteUnexaminedPackage(state);
    pushLimitation(
      state,
      `Did not probe ${member.location} for an embedded package.`,
    );
    return;
  }
  state.packagedProbeBytes += image.bytes.length;
  const probe = await embeddedPackageFormatOfBytes(
    image.bytes,
    member,
    nativeFormat,
    state,
    context,
  );
  if (probe.kind === "unreadable") noteUnexaminedPackage(state);
  else if (probe.kind === "package")
    noteNestedPackage(state, probe.format, member.location);
};

const scanEmbeddedPackage = async (
  input: ConsumeInput,
  occurrence: InventoryOccurrence,
  filePath: string,
  nativeFormat: NativeFormat,
  containers: Map<string, OpenContainer>,
  state: ScanState,
): Promise<void> => {
  if (state.embeddedProbes >= EMBEDDED_PROBE_LIMIT) {
    noteUnexaminedPackage(state);
    state.unprobedImages += 1;
    pushLimitation(
      state,
      `Stopped probing native images for embedded packages after ${String(EMBEDDED_PROBE_LIMIT)} files.`,
    );
    return;
  }
  state.embeddedProbes += 1;
  const probe = await embeddedPackageFormat(
    filePath,
    nativeFormat,
    state,
    input,
  );
  if (probe.kind === "unreadable") {
    noteUnexaminedPackage(state);
    return;
  }
  if (probe.kind === "absent") return;
  state.formats.add(probe.format);
  await scanUnexpandedContainer(
    input,
    occurrence,
    filePath,
    probe.format,
    containers,
    state,
  );
};

const scanUnexpandedContainer = async (
  input: ConsumeInput,
  occurrence: InventoryOccurrence,
  filePath: string,
  format: PackageFormat,
  containers: Map<string, OpenContainer>,
  state: ScanState,
): Promise<void> => {
  let entries: readonly ArtifactEntry[];
  try {
    const container = await openContainer(
      containers,
      occurrence.occurrence_id,
      filePath,
      format,
      input.inventory?.nodes.find(
        (node) => node.artifact_id === occurrence.artifact_id,
      )?.sha256,
      state,
      input.signal,
    );
    if (container === null) {
      noteUnexaminedPackage(state);
      return;
    }
    entries = await containerEntries(
      container,
      state,
      input.signal,
      (entry) => {
        noteUnlistedEntry(state, entry);
      },
    );
  } catch (cause) {
    rethrowReadFailure(cause);
    noteUnexaminedPackage(state);
    pushLimitation(state, `Could not list ${filePath}.`);
    return;
  }
  for (const entry of entries) {
    if (input.signal?.aborted)
      throw new AnalysisCancelledError(OPERATION, {
        cause: input.signal.reason,
      });
    const location = `${filePath}/${entry.path}`;
    if (hasCompanionName(entry.path)) state.companionPaths.add(location);
    noteUnfollowedMapLink(state, entry.kind, entry.path, location);
    if (entry.kind !== "file") continue;
    const stated = ownerStatedKind(entry.formatMetadata);
    await examineMember(state, input, {
      logical: entry.path,
      format: stated === "javascript" ? "javascript-bundle" : "file",
      kind: stated ?? "file",
      kindStated: stated !== null,
      encrypted: entry.encrypted,
      declaredSize: entry.declaredSize,
      location,
      packageFormat: format,
      read: (budget) =>
        readListedEntry(
          containers.get(occurrence.occurrence_id),
          entry,
          filePath,
          budget,
          state,
          input.signal,
        ),
    });
  }
};

/** An unlisted package leaves every member-based check undecided. */
const noteUnexaminedPackage = (state: ScanState): void => {
  state.unreadable += 1;
  state.coverageUnknown = true;
};

const noteNestedPackage = (
  state: ScanState,
  format: PackageFormat,
  location: string,
): void => {
  state.formats.add(format);
  noteUnexaminedPackage(state);
  pushLimitation(state, `Nested package ${location} was not expanded.`);
};

/**
 * The ASAR owner's signature test. A match does not establish a valid archive.
 * A probe that stops at the header admission, or runs out of a prefix read
 * before it decides, leaves the member undecided rather than not an ASAR: the
 * member may still carry a package nothing here reads, so coverage becomes
 * unknown while the member is examined as whatever else it may be.
 */
const probeNestedAsar = (
  state: ScanState,
  location: string,
  bytes: Buffer,
  complete: boolean,
): boolean => {
  const observed = createAsarHeaderSignatureProbe(
    state.asarHeaderAdmission,
  ).write(bytes);
  if (observed.state === "matched") return true;
  if (
    observed.state === "limit" ||
    (observed.state === "pending" &&
      !complete &&
      observed.extents !== undefined)
  ) {
    noteUnexaminedPackage(state);
    pushLimitation(
      state,
      `Could not decide whether ${location} holds an ASAR within the header admission.`,
    );
  }
  return false;
};

const readListedEntry = async (
  container: OpenContainer | undefined,
  entry: ArtifactEntry,
  filePath: string,
  budget: number,
  state: ScanState,
  signal: AbortSignal | undefined,
): Promise<MemberRead> => {
  if (container === undefined) return { kind: "unread" };
  try {
    return await readEntryBytes(container.reader, entry, budget, state, signal);
  } catch (cause) {
    rethrowReadFailure(cause);
    pushLimitation(state, `Could not read ${entry.path} from ${filePath}.`);
    return { kind: "unread" };
  }
};

const readContainerMember = async (
  input: ConsumeInput,
  parent: InventoryOccurrence,
  parentPath: string,
  parentFormat: string,
  expectedSha256: string | undefined,
  memberSha256: string | undefined,
  occurrence: InventoryOccurrence,
  ordinals: ReadonlyMap<string, number>,
  containers: Map<string, OpenContainer>,
  budget: number,
  state: ScanState,
): Promise<MemberRead> => {
  const format = asPackageFormat(parentFormat);
  if (format === null) return { kind: "unread" };
  try {
    const container = await openContainer(
      containers,
      parent.occurrence_id,
      parentPath,
      format,
      expectedSha256,
      state,
      input.signal,
    );
    if (container === null) return { kind: "unread" };
    await containerEntries(container, state, input.signal);
    const entry = container.byPath.get(entryPath(occurrence, parent))?.[
      ordinals.get(occurrence.occurrence_id) ?? 0
    ];
    if (entry === undefined || entry.kind !== "file") return { kind: "unread" };
    // The container digest binds packed members to the captured snapshot. An
    // unpacked member is read from its companion on disk, so it is bound to
    // the digest inventory recorded for that member instead.
    return await readEntryBytes(
      container.reader,
      entry,
      budget,
      state,
      input.signal,
      entry.unpacked === true && memberSha256 !== undefined
        ? {
            sha256: memberSha256,
            changed: `ASAR member changed before interpretation: ${occurrence.logical_path}`,
          }
        : undefined,
    );
  } catch (cause) {
    rethrowReadFailure(cause);
    pushLimitation(state, `Could not read ${occurrence.logical_path}.`);
    return { kind: "unread" };
  }
};

const openContainer = async (
  containers: Map<string, OpenContainer>,
  id: string,
  filePath: string,
  format: PackageFormat,
  expectedSha256: string | undefined,
  state: ScanState,
  signal: AbortSignal | undefined,
): Promise<OpenContainer | null> => {
  const cached = containers.get(id);
  if (cached !== undefined) return cached;
  if (containers.size >= OPEN_CONTAINER_LIMIT) {
    pushLimitation(
      state,
      `Stopped opening package readers after ${String(OPEN_CONTAINER_LIMIT)} containers.`,
    );
    return null;
  }
  if (signal?.aborted)
    throw new AnalysisCancelledError(OPERATION, { cause: signal.reason });
  const reader = createArtifactReader(filePath, format, {
    environment: process.env,
    unreadableDirectories: "omit",
    asarHeaderAdmission: state.asarHeaderAdmission,
  });
  if (reader === undefined) return null;
  const container: OpenContainer = {
    path: filePath,
    reader,
    entries: null,
    byPath: new Map(),
  };
  containers.set(id, container);
  if (expectedSha256 !== undefined)
    await reader.prepareContainer?.(expectedSha256, signal);
  return container;
};

const containerEntries = async (
  container: OpenContainer,
  state: ScanState,
  signal: AbortSignal | undefined,
  onPastCap?: (entry: ArtifactEntry) => void,
): Promise<readonly ArtifactEntry[]> => {
  if (container.entries !== null) return container.entries;
  const listed: ArtifactEntry[] = [];
  const traversal = new ArtifactTraversalObservation();
  let count = 0;
  let truncated = false;
  for await (const entry of container.reader.entries(signal, traversal)) {
    count += 1;
    if (count > CONTAINER_LIST_LIMIT) {
      if (!truncated) {
        truncated = true;
        state.coverageUnknown = true;
        pushLimitation(
          state,
          `Stopped listing a package after ${String(CONTAINER_LIST_LIMIT)} entries.`,
        );
      }
      onPastCap?.(entry);
      continue;
    }
    listed.push(entry);
    const key = logicalPathNfc(entry.path).replace(/\/+$/u, "");
    const sameName = container.byPath.get(key);
    if (sameName === undefined) container.byPath.set(key, [entry]);
    else sameName.push(entry);
  }
  const coverage = traversal.snapshot();
  if (coverage.status === "unknown") state.coverageUnknown = true;
  for (const limitation of coverage.limitations)
    pushLimitation(state, limitation);
  container.entries = listed;
  return listed;
};

const readEntryBytes = async (
  reader: ArtifactReader,
  entry: ArtifactEntry,
  budget: number,
  state: ScanState,
  signal: AbortSignal | undefined,
  expected?: ExpectedMemberDigest,
): Promise<MemberRead> => {
  const stream = await reader.open(entry, signal);
  return readStreamBounded(stream, budget, state, signal, expected);
};

/** An inventoried digest the member's complete bytes must still match. */
interface ExpectedMemberDigest {
  readonly sha256: string;
  readonly changed: string;
}

const readStreamBounded = async (
  stream: Readable,
  budget: number,
  state: ScanState,
  signal: AbortSignal | undefined,
  expected?: ExpectedMemberDigest,
): Promise<MemberRead> => {
  const chunks: Buffer[] = [];
  const hash = expected === undefined ? undefined : createHash("sha256");
  let total = 0;
  let overBudget = false;
  let failure: unknown;
  try {
    for await (const chunk of stream) {
      if (signal?.aborted)
        throw new AnalysisCancelledError(OPERATION, { cause: signal.reason });
      const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(piece);
      total += piece.length;
      state.memberBytesRead += piece.length;
      if (total > budget) {
        overBudget = true;
        break;
      }
      hash?.update(piece);
    }
    // The digest covers the whole member, so it is only checked when the
    // member ended within the allowance. A member past the allowance is never
    // read further to finish the hash: it stays over_allowance, unverified.
    if (
      !overBudget &&
      expected !== undefined &&
      hash !== undefined &&
      hash.digest("hex") !== expected.sha256
    )
      throw new ArtifactReaderFailure("integrity", expected.changed);
  } catch (cause) {
    failure = cause;
  }
  let closeFailure: unknown;
  try {
    stream.destroy();
  } catch (cause) {
    closeFailure = cause;
  }
  if (failure !== undefined && closeFailure !== undefined)
    throw new AggregateError(
      [failure, closeFailure],
      "Member read and stream close both failed.",
    );
  if (closeFailure !== undefined) throw closeFailure;
  if (failure !== undefined) throw failure;
  const bytes = Buffer.concat(chunks);
  return overBudget ? overAllowance(bytes) : { kind: "bytes", bytes };
};

const readSpan = async (
  filePath: string,
  offset: number,
  length: number,
  state: ScanState,
  context: ScanContext,
): Promise<Buffer | null> => {
  const { signal } = context;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    !Number.isSafeInteger(offset + length)
  )
    return null;
  try {
    return await withMemberDescriptor(
      filePath,
      context,
      async ({ handle, initial }) => {
        const observed = await handle.stat();
        if (!sameRegularFileState(initial, observed))
          throw new ArtifactReaderFailure(
            "integrity",
            `Artifact changed before read: ${filePath}`,
          );
        if (offset + length > observed.size) return null;
        const bytes = await readFileHandleRange(handle, offset, length, () => {
          if (signal?.aborted)
            throw new AnalysisCancelledError(OPERATION, {
              cause: signal.reason,
            });
        });
        const after = await handle.stat();
        if (!sameRegularFileState(initial, after))
          throw new ArtifactReaderFailure(
            "integrity",
            `Artifact changed during read: ${filePath}`,
          );
        state.memberBytesRead += bytes.length;
        return Buffer.from(bytes);
      },
    );
  } catch (cause) {
    rethrowReadFailure(cause);
    pushLimitation(state, `Could not read ${filePath}.`);
    return null;
  }
};

const readDiskMember = async (
  filePath: string,
  maxBytes: number,
  expectedSha256: string | undefined,
  state: ScanState,
  context: ScanContext,
): Promise<MemberRead> => {
  try {
    const snapshot = await readStableArtifact(
      filePath,
      maxBytes,
      context.signal,
      undefined,
      context.resources,
    );
    if (expectedSha256 !== undefined && snapshot.sha256 !== expectedSha256)
      throw new ArtifactReaderFailure(
        "integrity",
        `Member changed during acquisition: ${filePath}`,
      );
    return { kind: "bytes", bytes: snapshot.bytes };
  } catch (cause) {
    rethrowReadFailure(cause);
    if (cause instanceof ArtifactReaderFailure && cause.reason === "limit")
      return {
        kind: "over_allowance",
        prefix: await readSpan(
          filePath,
          0,
          Math.min(maxBytes, MAX_RELEASE_EXPOSURE_MEMBER_PROBE_BYTES),
          state,
          context,
        ),
      };
    pushLimitation(state, `Could not read ${filePath}.`);
    return { kind: "unread" };
  }
};

const asReadFailure = (cause: unknown): unknown =>
  cause instanceof RegularFileChangedError
    ? new ArtifactReaderFailure("integrity", cause.message, { cause })
    : cause;

/**
 * A read that left cleanup unfinished is never a skipped member, whatever its
 * reason: only the error tells the caller a descriptor is still retained.
 */
const rethrowReadFailure = (cause: unknown): void => {
  const failure = asReadFailure(cause);
  if (failure instanceof AnalysisError) throw failure;
  if (
    failure instanceof ArtifactReaderFailure &&
    (failure.reason === "cancelled" ||
      failure.reason === "integrity" ||
      failure.cleanup !== undefined)
  )
    throw failure;
};

/**
 * List the parent directory up to the sibling allowance. The stream stops at
 * the allowance, so a very large directory costs no more than the limit.
 */
const listSiblings = async (
  directory: string,
  state: ScanState,
  { signal, resources, siblingCleanup }: ScanContext,
): Promise<readonly Dirent[]> => {
  let owner: OwnedDirectoryHandle;
  try {
    owner = new OwnedDirectoryHandle(await opendir(directory));
  } catch {
    noteIncompleteSiblings(state);
    return [];
  }
  const entries: Dirent[] = [];
  let listed: Result<boolean, unknown>;
  try {
    let truncated = false;
    for (;;) {
      if (signal?.aborted)
        throw new AnalysisCancelledError(OPERATION, { cause: signal.reason });
      const entry = await owner.handle.read();
      if (entry === null) break;
      if (entries.length >= SIBLING_LIST_LIMIT) {
        truncated = true;
        break;
      }
      entries.push(entry);
    }
    listed = ok(truncated);
  } catch (cause) {
    listed = err(cause);
  }
  const attempt = await resources.release({
    kind: "directory-handle",
    resource: `directory beside the selected file: ${directory}`,
    handle: owner,
  });
  if (!listed.ok && listed.error instanceof AnalysisError) {
    if (attempt.kind === "failed")
      throw resources.cleanupFailure({ kind: "failed", cause: listed.error }, [
        attempt,
      ]);
    throw listed.error;
  }
  if (attempt.kind === "failed") siblingCleanup.push(attempt);
  if (!listed.ok || listed.value) noteIncompleteSiblings(state);
  return entries;
};

const noteIncompleteSiblings = (state: ScanState): void => {
  state.skippedCompanions += 1;
  pushLimitation(
    state,
    "The directory beside the selected file could not be listed completely.",
  );
};

const scanSiblings = async (
  input: ConsumeInput,
  state: ScanState,
): Promise<void> => {
  const directory = dirname(input.path);
  const own = basename(input.path);
  for (const entry of await listSiblings(directory, state, input)) {
    if (input.signal?.aborted)
      throw new AnalysisCancelledError(OPERATION, {
        cause: input.signal.reason,
      });
    if (entry.name === own) continue;
    const sibling = appendCallerPath(directory, entry.name);
    if (hasCompanionName(entry.name)) {
      state.companionPaths.add(sibling);
      continue;
    }
    if (!entry.name.toLowerCase().endsWith(".map")) continue;
    if (isJavaScriptSourceMapName(entry.name)) continue;
    // A declared map stays a source map and a loaded script stays a script,
    // and `noteUnreachedTargets` counts either one.
    const key = memberLocationKey(sibling);
    if (state.mapTargets.has(key) || state.scriptTargets.has(key)) continue;
    // A link is not followed, so a linker map it names stays unread, not absent.
    if (entry.isSymbolicLink()) {
      state.skippedCompanions += 1;
      continue;
    }
    if (!entry.isFile()) continue;
    await classifySiblingMap(sibling, state, input);
  }
};

/**
 * Siblings are in scope only for debug-companion discovery, so a sibling map
 * never reaches the selected artifact's source-map counts. Its read still
 * spends the same map count, or a directory of .map files would multiply the
 * byte allowance by the listing allowance.
 */
const classifySiblingMap = async (
  sibling: string,
  state: ScanState,
  input: ConsumeInput,
): Promise<void> => {
  const { hasSlot, bytes } = chargeMapRead(state);
  const loaded = await readDiskMember(sibling, bytes, undefined, state, input);
  if (loaded.kind === "unread") {
    state.skippedCompanions += 1;
    return;
  }
  const prefix = loaded.kind === "bytes" ? loaded.bytes : loaded.prefix;
  if (loaded.kind === "bytes" && hasSlot && parsesAsSourceMap(loaded.bytes))
    return;
  // A native header outranks the name, as it does for a member.
  if (
    prefix !== null &&
    sniffNativeFormat(
      prefix,
      loaded.kind === "bytes" ? prefix.length : null,
    ) !== null
  )
    return;
  if (prefix === null || mayHaveSourceMapPrefix(prefix))
    state.skippedCompanions += 1;
  else noteLinkerMapGuess(state, sibling);
};

const parsesAsSourceMap = (bytes: Buffer): boolean => {
  const text = mapText(bytes);
  if (text === null) return false;
  try {
    inspectSourceMap(text);
    return true;
  } catch {
    return false;
  }
};

const diskPath = (
  input: ConsumeInput,
  occurrence: InventoryOccurrence,
  byId: Map<string, InventoryOccurrence>,
  formatOf: (occurrence: InventoryOccurrence) => string,
): string | null => {
  if (hasExtractableAncestor(occurrence, byId, formatOf)) return null;
  if (
    occurrence.source_path !== undefined &&
    occurrence.source_path.length > 0 &&
    isAbsolute(occurrence.source_path)
  )
    return occurrence.source_path;
  if (!input.directory) {
    if (occurrence.parent_occurrence_id === null) return input.path;
    return null;
  }
  if (occurrence.logical_path.split("/").includes("..")) return null;
  if (occurrence.logical_path.length === 0 || occurrence.logical_path === ".")
    return input.path;
  const source = occurrence.source_path;
  return appendCallerPath(
    input.path,
    source !== undefined && logicalPathNfc(source) === occurrence.logical_path
      ? source
      : occurrence.logical_path,
  );
};

const packageAncestor = (
  occurrence: InventoryOccurrence,
  byId: Map<string, InventoryOccurrence>,
  formatOf: (occurrence: InventoryOccurrence) => string,
): InventoryOccurrence | undefined => {
  const seen = new Set<string>();
  let parentId = occurrence.parent_occurrence_id;
  while (parentId !== null) {
    if (seen.has(parentId)) return undefined;
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (parent === undefined) return undefined;
    if (EXTRACTABLE.has(formatOf(parent))) return parent;
    parentId = parent.parent_occurrence_id;
  }
  return undefined;
};

const hasExtractableAncestor = (
  occurrence: InventoryOccurrence,
  byId: Map<string, InventoryOccurrence>,
  formatOf: (occurrence: InventoryOccurrence) => string,
): boolean => packageAncestor(occurrence, byId, formatOf) !== undefined;

const entryPath = (
  occurrence: InventoryOccurrence,
  parent: InventoryOccurrence,
): string => {
  const logical = occurrence.logical_path;
  const parentLogical = parent.logical_path;
  if (parentLogical.length === 0 || parentLogical === ".") return logical;
  const prefix = `${parentLogical}/`;
  return logical.startsWith(prefix) ? logical.slice(prefix.length) : logical;
};

/**
 * Readers do not follow links, so a map one names, or a map a script or page
 * it names could hold, stays unread, not absent. The link is one omission
 * however many declarations reach it.
 */
const noteUnfollowedMapLink = (
  state: ScanState,
  kind: string,
  logical: string,
  location: string,
): void => {
  if (kind !== "symlink") return;
  if (
    !isSourceMap(logical, "file") &&
    !canDeclareMap({ kind: "file", logical })
  )
    return;
  const key = memberLocationKey(location);
  state.examinedMaps.add(key);
  state.examinedScripts.add(key);
  state.skippedMaps += 1;
  // A generic `.map` link may name a linker map, as an unread map may.
  if (isSourceMap(logical, "file") && !isJavaScriptSourceMapName(logical))
    state.skippedCompanions += 1;
};

const noteUnlistedEntry = (state: ScanState, entry: ArtifactEntry): void => {
  noteUnfollowedMapLink(state, entry.kind, entry.path, entry.path);
  if (entry.kind !== "file") return;
  if (entry.encrypted) state.unreadable += 1;
  if (isSourceMap(entry.path, "file")) {
    noteUnreadMap(state, { logical: entry.path, location: entry.path }, null);
    state.skippedText += 1;
  } else if (isText(entry.path, "file")) state.skippedText += 1;
};

const JAVASCRIPT_SOURCE_MAP = /\.(?:cjs|css|cts|js|jsx|mjs|mts|ts|tsx)\.map$/iu;

const isJavaScriptSourceMapName = (logical: string): boolean =>
  JAVASCRIPT_SOURCE_MAP.test(logical);

const isSourceMap = (logical: string, kind: string): boolean =>
  kind === "source-map" || logical.toLowerCase().endsWith(".map");

const isDeclaredText = (kind: string): boolean =>
  kind === "javascript" ||
  kind === "source-map" ||
  kind === "plist" ||
  kind === "entitlements";

const isText = (logical: string, kind: string): boolean =>
  isDeclaredText(kind) || TEXT_EXTENSION.test(logical);

const hasCompanionName = (logical: string): boolean => {
  const lower = logical.toLowerCase();
  return (
    lower.endsWith(".pdb") ||
    lower.endsWith(".debug") ||
    lower.endsWith(".dsym")
  );
};

/**
 * FAT identity from the container owner. A prefix can only rule a universal
 * image out against the member's real size: without one, or with slices past
 * the prefix, the image may be native and stays counted as one.
 */
const sniffFatFormat = (
  bytes: Buffer,
  size: number | null,
): "mach-o-universal" | null => {
  const known = size !== null && size >= bytes.length;
  const header = readFatContainerHeader(bytes, known ? size : bytes.length);
  if (header.state !== "parsed") return null;
  return known &&
    classifyFatContainerEvidence(header, bytes).state === "not-mach-o"
    ? null
    : "mach-o-universal";
};

/** Header facts from the executable owners. A JVM class is not a FAT Mach-O. */
const sniffNativeFormat = (
  bytes: Buffer,
  size: number | null = bytes.length,
): NativeFormat | null => {
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x7f &&
    bytes[1] === 0x45 &&
    bytes[2] === 0x4c &&
    bytes[3] === 0x46
  )
    return "elf";
  if (readMachoHeaderPrefixFacts(bytes).format !== null) return "mach-o";
  const universal = sniffFatFormat(bytes, size);
  if (universal !== null) return universal;
  const windows = observeMzWindowsHeader(bytes);
  if (windows.state === "declared" && windows.signature === "PE") return "pe";
  return null;
};

const targetKind = (
  path: string,
  format: string,
  directory: boolean,
): ReleaseExposureScan["target"]["kind"] => {
  if (directory && basename(path).toLowerCase().endsWith(".app")) return "app";
  if (directory || format === "directory") return "directory";
  if (format === "asar") return "asar";
  if (NATIVE.has(format) || EXTRACTABLE.has(format)) return "executable";
  return "file";
};

/**
 * Wide text is valid UTF-8 when its characters are ASCII, so validity alone
 * cannot separate it from UTF-8 holding a NUL. Density can: UTF-16 puts a NUL in
 * every other byte of each ASCII character, and a stray NUL is one byte of many.
 */
const hasNonUtf8Nul = (bytes: Buffer): boolean => {
  const header = bytes.subarray(0, MEMBER_ENCODING_HEADER_BYTES);
  const nuls = header.reduce((count, byte) => count + (byte === 0 ? 1 : 0), 0);
  return (
    nuls > 0 &&
    (nuls * WIDE_TEXT_NUL_DIVISOR >= header.length || !isUtf8(bytes))
  );
};

const pushSample = (samples: string[], value: string): void => {
  if (
    value.length === 0 ||
    samples.includes(value) ||
    samples.length >= MAX_RELEASE_EXPOSURE_SAMPLES
  )
    return;
  samples.push(value);
};

const pushLimitation = (state: ScanState, message: string): void => {
  if (
    state.limitations.length >= LIMITATION_CAP ||
    state.limitations.includes(message)
  )
    return;
  state.limitations.push(message);
};

const fileSizeRecovery = (maxFileBytes: number) =>
  maxFileBytes >= MAX_RELEASE_EXPOSURE_FILE_BYTES
    ? fixedAllowanceOptions(
        `The release exposure input allowance of ${String(MAX_RELEASE_EXPOSURE_FILE_BYTES)} bytes (this release has no runtime override)`,
        "input",
      )
    : {
        retryable: false as const,
        remediationAction: `Raise max_file_bytes above ${String(maxFileBytes)} bytes or select a smaller artifact. The ceiling is ${String(MAX_RELEASE_EXPOSURE_FILE_BYTES)} bytes.`,
      };

/**
 * The header admission is its own bound, not the selected-file ceiling, so
 * max_file_bytes cannot repair it. The recovery names the shared setting the
 * composition threaded into this reader.
 */
const asarHeaderAdmissionFailure = (
  cause: ArtifactReaderFailure,
  admission: ArtifactAdmissionLimit,
): AnalysisResourceConstraintError =>
  new AnalysisResourceConstraintError(
    OPERATION,
    "capacity",
    admission.requiredBytes === undefined
      ? `An ASAR header/index exceeds ${String(admission.maximumBytes)} bytes.`
      : `An ASAR header/index of ${String(admission.requiredBytes)} bytes exceeds ${String(admission.maximumBytes)} bytes.`,
    {
      asar_max_header_bytes: admission.maximumBytes,
      ...(admission.requiredBytes === undefined
        ? {}
        : { required_header_bytes: admission.requiredBytes }),
    },
    {
      cause,
      retryable: false,
      remediationAction: asarHeaderAdmissionRecovery(admission),
      limit: {
        ...analysisSettingLimit(
          "asar.max_header_bytes",
          admission.maximumBytes,
          admission.source,
        ),
        ...(admission.requiredBytes === undefined
          ? {}
          : { required_value: admission.requiredBytes }),
      },
    },
  );

const releaseExposureLimitFailure = (
  cause: ArtifactReaderFailure,
  maxFileBytes: number,
): AnalysisResourceConstraintError =>
  cause.admission === undefined
    ? new AnalysisResourceConstraintError(
        OPERATION,
        "file-size",
        cause.message,
        { max_file_bytes: maxFileBytes },
        { cause, ...fileSizeRecovery(maxFileBytes) },
      )
    : asarHeaderAdmissionFailure(cause, cause.admission);

const releaseExposureFailurePrimary = (
  facts: ArtifactFilePrimaryFacts,
  path: string,
  maxFileBytes: number,
): AnalysisError => {
  const { cause, origin } = facts;
  if (origin === "owned-or-classified" && cause instanceof AnalysisError)
    return cause;
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "integrity"
  )
    return new AnalysisArtifactChangedError(OPERATION, path, cause.message, {
      cause,
    });
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "cancelled"
  )
    return new AnalysisCancelledError(OPERATION, {
      cause: artifactFileCancellationCause(cause),
    });
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure
  ) {
    if (cause.reason === "limit")
      return releaseExposureLimitFailure(cause, maxFileBytes);
    if (cause.reason === "path" || cause.reason === "format")
      return new AnalysisInputError(OPERATION, { cause }, [
        { path: ["path"], reason: "invalid_format", message: cause.message },
      ]);
  }
  if (cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(OPERATION, path, cause.code, {
        cause,
      });
    if (isSelectedRegularFileError(cause))
      return new AnalysisInputError(OPERATION, { cause }, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Selected artifact could not be read (${String(cause.code)}): ${path}.`,
        },
      ]);
  }
  return new ProviderAdapterError(RELEASE_EXPOSURE_PROVIDER.id, OPERATION, {
    cause,
    diagnostics: {
      path,
      reason: cause instanceof Error ? cause.message : String(cause),
    },
  });
};

const releaseExposureFailure = (
  cause: unknown,
  path: string,
  maxFileBytes: number,
): AnalysisError =>
  projectStableArtifactFailure(
    cause,
    releaseExposureFailurePrimary(
      artifactFilePrimaryFacts(cause),
      path,
      maxFileBytes,
    ),
    path,
    RELEASE_EXPOSURE_PROVIDER.id,
    OPERATION,
  );
