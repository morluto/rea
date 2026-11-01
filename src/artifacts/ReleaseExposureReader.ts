import type { Dirent } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import type {
  ReleaseExposurePort,
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
} from "./ArtifactResourceScope.js";
import {
  artifactFileCancellationCause,
  artifactFilePrimaryFacts,
  type ArtifactFilePrimaryFacts,
} from "./ArtifactFileOperation.js";
import { ArtifactEmbeddedFormatProbes } from "./ArtifactEmbeddedFormatProbes.js";
import { ArtifactTraversalObservation } from "./ArtifactTraversalObservation.js";
import { classifyEmbeddedExecutablePackage } from "./inventory/classify.js";
import { inventoryArtifact } from "./inventory/ArtifactInventory.js";
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
  readFatContainerHeader,
  readMachoHeaderPrefixFacts,
} from "../domain/apple/machoContainer.js";
import { inspectPeCodeViewFromBuffer } from "../domain/binaryTarget.js";
import { hasBinaryPlistSignature } from "../domain/apple/appleArchiveFormat.js";
import { logicalPathNfc } from "../domain/artifactIdentity.js";
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
const PE_MEMBER_NAME = /\.(?:dll|exe|sys)$/iu;
const JAVASCRIPT_MEMBER_NAME = /\.(?:[cm]?[jt]s|[jt]sx)$/iu;

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
  ): Promise<Result<ReleaseExposureScan, AnalysisError>> {
    const maxFileBytes =
      input.max_file_bytes ?? MAX_RELEASE_EXPOSURE_FILE_BYTES;
    const context: ScanContext = {
      signal: options?.signal,
      resources: this.#resources,
      maxFileBytes,
      visitText,
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
  const inventory = await inventoryArtifact(path, {
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
    inventory = await inventoryArtifact(path, {
      acquisitionLimits: {
        maximumEntries: MAX_RELEASE_EXPOSURE_INVENTORY_ENTRIES,
        maximumBytes: MAX_RELEASE_EXPOSURE_INVENTORY_BYTES,
      },
      integrity: "record-and-continue",
      resourceScope: context.resources,
      signal: context.signal,
      selectedPath: path,
      expectedRootSha256: sha256,
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
  readonly visitText: ReleaseExposureTextVisitor;
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
  let result: ReleaseExposureScan | undefined;
  let failure: unknown;
  let failed = false;
  try {
    result = await scanOccurrences(input, containers);
  } catch (cause) {
    failure = cause;
    failed = true;
  }
  const [firstCleanup, ...remainingCleanup] = [
    ...input.siblingCleanup,
    ...(await releaseContainers(containers, input.resources)),
  ];
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
  const state = createState(input.visitText);
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
      state.formats.add(packageKind);
      noteUnexaminedPackage(state);
      if (!occurrence.encrypted) {
        state.readable += 1;
        pushSample(state.memberSamples, location);
      }
      pushLimitation(state, `Nested package ${location} was not expanded.`);
      continue;
    }
    await examineMember(state, {
      logical,
      format: nativeFormat ?? format,
      kind: occurrence.artifact_kind,
      encrypted: occurrence.encrypted,
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
  noteUnreachedMapTargets(state);
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
    fuse_candidates:
      kind === "app"
        ? [{ path: input.path, role: "app-bundle" }]
        : nativeImages.map((image) => ({
            path: image.path,
            role: "native-image" as const,
          })),
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
      paths: [...state.companionPaths],
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
                "A source map exceeded the map count or byte allowance, could not be read, was past the package entry cap, or was declared but not found; inline CSS source-map directives are not inspected.",
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
              reason: `Only ${String(EMBEDDED_PROBE_LIMIT)} native images are probed for an embedded package.`,
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
  companionPaths: Set<string>;
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
  embeddedProbes: number;
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
  visitText: ReleaseExposureTextVisitor;
}

const createState = (visitText: ReleaseExposureTextVisitor): ScanState => ({
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
  embeddedProbes: 0,
  unprobedImages: 0,
  native: new Map(),
  nativeDigests: new Map(),
  limitations: [],
  mapsRead: 0,
  mapTargets: new Set(),
  examinedLocations: new Set(),
  examinedMaps: new Set(),
  visitText,
});

interface MemberView {
  readonly logical: string;
  readonly format: string;
  readonly kind: string;
  readonly encrypted: boolean;
  /** Reported path. A package member names its host file. */
  readonly location: string;
  readonly packageFormat: PackageFormat | null;
  readonly read: ReadMember;
}

const isJavaScriptMember = (member: MemberView): boolean =>
  member.kind === "javascript" || JAVASCRIPT_MEMBER_NAME.test(member.logical);

const isCssMember = (member: MemberView): boolean =>
  member.logical.toLowerCase().endsWith(".css");

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
  await examineMember(state, {
    logical: basename(input.path),
    format: rootFormat,
    kind: "file",
    encrypted: false,
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
  member: MemberView,
): Promise<void> => {
  const { packageFormat } = member;
  if (packageFormat !== null) state.formats.add(packageFormat);
  let readable = false;
  const map = isDeclaredMap(state, member);
  (map ? state.examinedMaps : state.examinedLocations).add(
    memberLocationKey(member.location),
  );
  if (member.encrypted) noteUnreadMember(state, member);
  else if (map) readable = await examineMapMember(state, member);
  else if (isText(member.logical, member.kind))
    readable = await examineTextMember(state, member);
  else if (packageFormat !== null)
    readable = await examinePackagedBinary(state, member);
  else if (asNativeFormat(member.format) === null)
    await examineProbedText(
      state,
      member,
      await member.read(MAX_RELEASE_EXPOSURE_MEMBER_PROBE_BYTES),
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
  if (isJavaScriptMember(member) || isCssMember(member)) state.skippedMaps += 1;
  if (isDeclaredMap(state, member)) {
    noteUnreadMap(state, member, null);
    state.skippedText += 1;
  } else if (isText(member.logical, member.kind)) state.skippedText += 1;
  else noteUnreadBinary(state, member);
};

const noteUnreadBinary = (state: ScanState, member: MemberView): void => {
  const native = asNativeFormat(member.format);
  if (native !== null) state.packagedNative += 1;
  else state.skippedText += 1;
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
): Promise<boolean> => {
  // A member a script names as its map is a JavaScript map whatever it is called.
  const declared = isSourceMap(member.logical, member.kind)
    ? member
    : { ...member, logical: `${member.logical}.js.map` };
  const loaded = await examineMap(state, declared);
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

/** Returns the read so a caller can also scan its text, or null when nothing was read. */
const examineMap = async (
  state: ScanState,
  map: Pick<MemberView, "logical" | "location" | "read">,
): Promise<MemberRead | null> => {
  const hasSlot = state.mapsRead < MAX_RELEASE_EXPOSURE_SOURCE_MAPS;
  if (!hasSlot && isJavaScriptSourceMapName(map.logical)) {
    state.skippedMaps += 1;
    return null;
  }
  const loaded = await map.read(
    hasSlot
      ? MAX_RELEASE_EXPOSURE_SOURCE_MAP_BYTES
      : MAX_RELEASE_EXPOSURE_MEMBER_PROBE_BYTES,
  );
  if (loaded.kind === "unread") noteUnreadMap(state, map, null);
  else if (loaded.kind === "over_allowance")
    noteUnreadMap(state, map, loaded.prefix);
  else if (hasSlot) readSourceMap(state, map, loaded.bytes);
  else noteUnreadMap(state, map, loaded.bytes);
  return loaded;
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
    state.companionPaths.add(map.location);
    return;
  }
  state.skippedMaps += 1;
  state.skippedCompanions += 1;
};

const mayHaveSourceMapPrefix = (prefix: Buffer): boolean => {
  const text = sourceMapJsonText(prefix.toString("utf8")).trimStart();
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
  state.mapsRead += 1;
  try {
    const inspected = inspectSourceMap(bytes.toString("utf8"));
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
        parsed = JSON.parse(sourceMapJsonText(bytes.toString("utf8")));
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
      !mayHaveSourceMapPrefix(bytes)
    ) {
      state.companionPaths.add(map.location);
      return;
    }
    pushSample(state.mapSamples, map.location);
    state.unparsedMaps += 1;
  }
};

const examineTextMember = async (
  state: ScanState,
  member: MemberView,
): Promise<boolean> => {
  // CSS can declare inline maps, but the directive parser only handles JavaScript.
  if (isCssMember(member)) state.skippedMaps += 1;
  const remaining = MAX_RELEASE_EXPOSURE_TEXT_BYTES - state.textBytes;
  if (remaining <= 0) {
    state.skippedText += 1;
    if (isJavaScriptMember(member)) state.skippedMaps += 1;
    return true;
  }
  const loaded = await member.read(
    Math.min(MAX_RELEASE_EXPOSURE_TEXT_MEMBER_BYTES, remaining),
  );
  if (loaded.kind === "bytes") {
    const text = decodeMemberText(loaded.bytes);
    scanText(state, member, loaded.bytes.length, text);
    if (isJavaScriptMember(member)) {
      if (text === null) state.skippedMaps += 1;
      else examineInlineMaps(state, member, text);
    }
  } else {
    state.skippedText += 1;
    if (isJavaScriptMember(member)) state.skippedMaps += 1;
  }
  return loaded.kind !== "unread";
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
): Promise<void> => {
  const prefix =
    probe.kind === "bytes"
      ? probe.bytes
      : probe.kind === "over_allowance"
        ? probe.prefix
        : null;
  if (prefix === null) state.skippedText += 1;
  else if (
    prefix.length > 0 &&
    (!prefix.includes(0) || byteOrderMarkEncoding(prefix) !== null)
  )
    await examineTextMember(state, member);
};

const examineInlineMaps = (
  state: ScanState,
  member: MemberView,
  source: string,
): void => {
  const parsed = parseJavaScriptSource(source, member.logical);
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
        ? Buffer.from(payload, "base64")
        : Buffer.from(decodeURIComponent(payload), "utf8");
      if (decoded.length > MAX_RELEASE_EXPOSURE_SOURCE_MAP_BYTES) {
        state.skippedMaps += 1;
        continue;
      }
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
 * A declaration names its map by location, not by file name. A map that is
 * recognized by name is examined as a member; any other local target is
 * recorded so it is examined as a map when it is reached. A target already
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
  if (path.length === 0 || isSourceMap(path, "file")) return;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    state.skippedMaps += 1;
    return;
  }
  noteMapTarget(state, resolve(dirname(member.location), decoded));
};

const noteMapTarget = (state: ScanState, location: string): void => {
  const target = memberLocationKey(location);
  if (state.examinedMaps.has(target)) return;
  if (state.examinedLocations.has(target)) state.skippedMaps += 1;
  else state.mapTargets.add(target);
};

/**
 * Lookup identity for a member location. Inventory reports logical paths in
 * NFC, so a declared target spelled in another normalization form still
 * names the same member. The declared URL itself is left as written.
 */
const memberLocationKey = (location: string): string =>
  logicalPathNfc(resolve(location));

const isDeclaredMap = (state: ScanState, member: MemberView): boolean =>
  isSourceMap(member.logical, member.kind) ||
  state.mapTargets.has(memberLocationKey(member.location));

/** A declared map target that was never reached was not assessed. */
const noteUnreachedMapTargets = (state: ScanState): void => {
  for (const target of state.mapTargets)
    if (!state.examinedMaps.has(target)) state.skippedMaps += 1;
};

/**
 * The text a member's bytes encode, or null when they cannot be read as text.
 * A member's kind says nothing about its encoding: NULs that no byte order mark
 * explains are not UTF-8, so a scan of them would match nothing and still count
 * as complete. A binary plist is the exception, because its ASCII strings are
 * stored in the raw bytes.
 */
const decodeMemberText = (bytes: Buffer): string | null => {
  const encoding = byteOrderMarkEncoding(bytes);
  if (encoding === "utf-32") return null;
  if (encoding !== null) return new TextDecoder(encoding).decode(bytes);
  if (hasBinaryNul(bytes) && !hasBinaryPlistSignature(bytes)) return null;
  return bytes.toString("utf8");
};

const scanText = (
  state: ScanState,
  member: MemberView,
  byteLength: number,
  text: string | null,
): void => {
  if (
    byteLength > MAX_RELEASE_EXPOSURE_TEXT_MEMBER_BYTES ||
    state.textBytes + byteLength > MAX_RELEASE_EXPOSURE_TEXT_BYTES ||
    text === null
  ) {
    state.skippedText += 1;
    return;
  }
  state.textBytes += byteLength;
  state.scannedText += 1;
  state.visitText(text, member.location);
};

/**
 * Probe a package member that is neither text nor a map. Only its header is
 * read unless the bytes declare a PE, so large binary members cost no budget
 * that a later source map or text member needs.
 */
const examinePackagedBinary = async (
  state: ScanState,
  member: MemberView,
): Promise<boolean> => {
  const probe = await member.read(MAX_RELEASE_EXPOSURE_MEMBER_PROBE_BYTES);
  if (probe.kind === "unread") {
    noteUnreadBinary(state, member);
    return false;
  }
  const header = probe.kind === "bytes" ? probe.bytes : probe.prefix;
  const native =
    asNativeFormat(member.format) ??
    (header === null ? null : sniffNativeFormat(header));
  if (native === null && header?.toString("latin1", 0, 2) === "MZ") {
    const windows = observeMzWindowsHeader(header);
    if (
      windows.state === "signature-needed" ||
      (windows.state === "candidate" && windows.signature === "unobserved")
    )
      notePeNotExamined(state, member.location);
  }
  if (native !== null) state.packagedNative += 1;
  else await examineProbedText(state, member, probe);
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
): Promise<EmbeddedPackageProbe> => {
  try {
    return await withMemberDescriptor(filePath, context, async (source) => {
      if (source.initial.size > context.maxFileBytes) {
        pushLimitation(
          state,
          `Did not probe ${filePath} for an embedded package because it exceeds ${String(context.maxFileBytes)} bytes.`,
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
      `Could not probe ${filePath} for an embedded package.`,
    );
    return { kind: "unreadable" };
  }
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
    if (entry.kind !== "file") continue;
    await examineMember(state, {
      logical: entry.path,
      format: "file",
      kind: "file",
      encrypted: entry.encrypted,
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
    return await readEntryBytes(container.reader, entry, budget, signal);
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
    return await readEntryBytes(container.reader, entry, budget, input.signal);
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
  signal: AbortSignal | undefined,
): Promise<MemberRead> => {
  const stream = await reader.open(entry, signal);
  return readStreamBounded(stream, budget, signal);
};

const readStreamBounded = async (
  stream: Readable,
  budget: number,
  signal: AbortSignal | undefined,
): Promise<MemberRead> => {
  const chunks: Buffer[] = [];
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
      if (total > budget) {
        overBudget = true;
        break;
      }
    }
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

const rethrowReadFailure = (cause: unknown): void => {
  const failure = asReadFailure(cause);
  if (failure instanceof AnalysisError) throw failure;
  if (
    failure instanceof ArtifactReaderFailure &&
    (failure.reason === "cancelled" || failure.reason === "integrity")
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
    if (entry.name === own || entry.isSymbolicLink()) continue;
    const sibling = appendCallerPath(directory, entry.name);
    if (hasCompanionName(entry.name)) {
      state.companionPaths.add(sibling);
      continue;
    }
    if (!entry.name.toLowerCase().endsWith(".map") || !entry.isFile()) continue;
    if (isJavaScriptSourceMapName(entry.name)) continue;
    // Siblings are in scope only for debug-companion discovery.
    const loaded = await readDiskMember(
      sibling,
      MAX_RELEASE_EXPOSURE_SOURCE_MAP_BYTES,
      undefined,
      state,
      input,
    );
    if (loaded.kind === "unread") state.skippedCompanions += 1;
    else if (loaded.kind === "over_allowance") {
      if (loaded.prefix === null || mayHaveSourceMapPrefix(loaded.prefix))
        state.skippedCompanions += 1;
      else state.companionPaths.add(sibling);
    } else {
      try {
        inspectSourceMap(loaded.bytes.toString("utf8"));
      } catch {
        if (mayHaveSourceMapPrefix(loaded.bytes)) state.skippedCompanions += 1;
        else state.companionPaths.add(sibling);
      }
    }
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

const noteUnlistedEntry = (state: ScanState, entry: ArtifactEntry): void => {
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

/** Header facts from the executable owners. A JVM class is not a FAT Mach-O. */
const sniffNativeFormat = (bytes: Buffer): NativeFormat | null => {
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x7f &&
    bytes[1] === 0x45 &&
    bytes[2] === 0x4c &&
    bytes[3] === 0x46
  )
    return "elf";
  if (readMachoHeaderPrefixFacts(bytes).format !== null) return "mach-o";
  if (readFatContainerHeader(bytes, bytes.length).state === "parsed")
    return "mach-o-universal";
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

const hasBinaryNul = (bytes: Buffer): boolean => {
  const prefix = Math.min(bytes.length, 512);
  for (let index = 0; index < prefix; index += 1)
    if (bytes[index] === 0) return true;
  return false;
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
      return new AnalysisResourceConstraintError(
        OPERATION,
        "file-size",
        cause.message,
        { max_file_bytes: maxFileBytes },
        { cause, ...fileSizeRecovery(maxFileBytes) },
      );
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
