import { HOST_PLATFORM } from "../../platform/HostPlatform.js";
import {
  AnalysisError,
  type AnalysisCapturedOutput,
} from "../../domain/analysisErrorBase.js";
import {
  AnalysisOutputError,
  AnalysisCapabilityUnavailableError,
  OwnerCancellation,
} from "../../domain/analysisErrorCore.js";
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import { createHash, randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import {
  streamChunkToBuffer,
  ArtifactResourceScope,
  ArtifactReaderFailure,
  sameArtifactSourceIdentity,
  type ArtifactEntry,
  type ArtifactReaderTraversal,
  DirectoryArtifactReader,
  translateArtifactFailure,
} from "../../resources/index.js";
import { InternalInvariantError } from "../../domain/internalInvariant.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { ARTIFACT_GRAPH_PROVIDER } from "../../domain/investigationProviders.js";
import { analysisErrorWithCleanupDependencies } from "../../domain/analysisErrorCleanup.js";
import {
  ArtifactTraversalObservation,
  declaredArtifactEntries,
} from "../ArtifactTraversalObservation.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import { analyzeInterfaceBuilderBundle } from "./InterfaceBuilderAnalysis.js";
import { parseJsonWithDuplicatePolicy } from "../../domain/jsonDuplicateMember.js";
import {
  appleAssetCatalogInputSchema,
  appleResourceKeyFields,
  parseAppleAssetCatalogRecords,
  projectAppleAssetCatalogPage,
  type AppleAssetAnalysisCoverage,
} from "../../domain/apple/appleAssetCatalog.js";
import {
  prepareOwnedCommand,
  runOwnedCommand,
} from "../../process/OwnedCommand.js";
import type {
  OwnedProviderProcessSpawnOptions,
  SpawnedOwnedProviderProcess,
} from "../../process/ProviderProcess.js";
import { providerOutcomeOf } from "../../process/ProviderOutcome.js";
import { describeLaunchFailure } from "../../process/launchFailure.js";
import {
  classifyProviderOutcome,
  type ProviderOutcomeContext,
} from "../../process/classifyProviderOutcome.js";
import { capturedProviderOutput } from "../../process/capturedProviderOutput.js";
import {
  processInspectionCancellationError,
  processInspectionFailure,
  retainArtifactCommandCleanup,
  retainProcessInspectionCleanup,
} from "../../providers/OwnedCommandCleanup.js";

const ASSETUTIL = "/usr/bin/assetutil";
const ASSETUTIL_TIMEOUT_MS = 60_000;
const OPERATION = "inspect_asset_catalog";
const MAX_CATALOG_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_METADATA_BYTES = 64 * 1024 * 1024;

/** Launches assetutil under owned supervision; tests substitute a stand-in process. */
export type AssetUtilLauncher = (
  options: OwnedProviderProcessSpawnOptions,
) => Promise<SpawnedOwnedProviderProcess>;

/** Inspect compiled asset catalog metadata without extracting rendition bytes. */
export const analyzeAppleAssetCatalogs = async (input: {
  readonly bundlePath: string;
  readonly targetSha256: string | null;
  readonly resourceRoot?: import("../../domain/apple/bundleResourceRoot.js").BundleResourceRoot;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly page?: unknown;
  readonly signal?: AbortSignal;
  readonly resources?: ArtifactResourceScope;
  /** Produce one catalog's metadata without a process; tests of parsing only. */
  readonly runAssetUtil?: (
    path: string,
    signal?: AbortSignal,
  ) => Promise<string>;
  readonly assetUtilLauncher?: AssetUtilLauncher;
  readonly analyzeInterfaceBuilder?: typeof analyzeInterfaceBuilderBundle;
  /** The host whose assetutil runs; tests select macOS on another host. */
  readonly platform?: NodeJS.Platform;
}) => {
  if (
    (input.platform ?? HOST_PLATFORM.platform) !== "darwin" &&
    input.runAssetUtil === undefined
  )
    throw new ArtifactReaderFailure(
      "unavailable",
      "Apple asset catalog inspection requires macOS assetutil",
    );
  const page = appleAssetCatalogInputSchema.parse(input.page ?? {});
  const resources = input.resources ?? new ArtifactResourceScope();
  // The Interface Builder graph only supplies resource keys for the join. Its
  // bundle walk is independent of the catalog walk, so both run together; a
  // catalog failure cancels it and is reported as the sequential order would.
  const interfaceBuilderCancel = new AbortController();
  const interfaceBuilderAnalysis = (
    input.analyzeInterfaceBuilder ?? analyzeInterfaceBuilderBundle
  )({
    bundlePath: input.bundlePath,
    targetSha256: input.targetSha256,
    resources,
    ...(input.resourceRoot === undefined
      ? {}
      : { resourceRoot: input.resourceRoot }),
    signal:
      input.signal === undefined
        ? interfaceBuilderCancel.signal
        : AbortSignal.any([input.signal, interfaceBuilderCancel.signal]),
  }).then(
    (value) => ({ ok: true, value }) as const,
    (error: unknown) => ({ ok: false, error }) as const,
  );
  let catalogs: Awaited<ReturnType<typeof collectAssetCatalogs>>["catalogs"];
  let uninspected: readonly string[];
  let traversal: ArtifactReaderTraversal;
  let catalogCoverage: AppleAssetAnalysisCoverage;
  try {
    ({
      catalogs,
      uninspected,
      traversal,
      coverage: catalogCoverage,
    } = await resources.run(() =>
      collectAssetCatalogs({ ...input, resources }),
    ));
  } catch (cause: unknown) {
    interfaceBuilderCancel.abort(OwnerCancellation.noLongerNeeded);
    const joined = await interfaceBuilderAnalysis;
    if (
      !joined.ok &&
      ((joined.error instanceof ArtifactReaderFailure &&
        joined.error.cleanup !== undefined) ||
        (joined.error instanceof AnalysisError &&
          joined.error.cleanupIncomplete))
    ) {
      // A defect still owns the outcome; it becomes the adapter failure the
      // provider boundary would report, so the reader's cleanup can join it.
      const primary =
        cause instanceof InternalInvariantError
          ? new ProviderAdapterError(
              ARTIFACT_GRAPH_PROVIDER.id,
              "inspect_asset_catalog",
              { cause },
            )
          : translateArtifactFailure("inspect_asset_catalog", cause);
      const cleanup = translateArtifactFailure(
        "inspect_asset_catalog",
        joined.error,
      );
      throw analysisErrorWithCleanupDependencies(
        primary,
        cleanup,
        "inspect_asset_catalog",
      );
    }
    throw cause;
  }
  const analyzed = await interfaceBuilderAnalysis;
  if (!analyzed.ok) throw analyzed.error;
  const interfaceBuilder = analyzed.value;
  const resourceReferences = collectInterfaceBuilderResourceKeys(
    interfaceBuilder.graph.nodes,
  );
  const resourceObjectsIncomplete = interfaceBuilder.graph.coverage.some(
    ({ facet, status }) =>
      (facet === "archive_object_decode" ||
        facet === "documents" ||
        facet.startsWith("objects:")) &&
      status !== "complete",
  );
  const result = projectAppleAssetCatalogPage({
    targetSha256: input.targetSha256,
    ...(input.resourceRoot === undefined
      ? {}
      : { resourceRoot: input.resourceRoot }),
    catalogs,
    inventoryCoverage: { scope: "container-entries", status: traversal.status },
    catalogCoverage,
    resourceKeyCoverage:
      catalogCoverage.status !== "complete"
        ? catalogCoverage
        : resourceObjectsIncomplete
          ? { status: "partial", reason: "interface_builder_graph_incomplete" }
          : { status: "complete", reason: null },
    offset: page.offset,
    limit: page.limit,
    resourceReferences,
  });
  return {
    ...result,
    limitations: [
      ...result.limitations,
      ...traversal.limitations,
      // An app without a compiled catalog is an observed empty inventory, not
      // a missing host tool.
      ...(catalogs.length === 0
        ? [
            "No compiled Assets.car catalog was found among the app bundle's regular files (symlinks are not followed); any resource keys are reported as unmatched.",
          ]
        : []),
      ...(uninspected.length === 0
        ? []
        : [
            `Asset catalog entries that are not regular files were not inspected, so resource keys reported as unmatched may resolve there: ${uninspected.join(", ")}`,
          ]),
      "Exact resource-key joins use only recognized image or asset key fields on decoded Interface Builder resource objects; other archive resource references are not inferred.",
      ...(resourceObjectsIncomplete
        ? [
            "Interface Builder resource-key joins may be incomplete because the decoded object inventory is incomplete.",
          ]
        : []),
    ],
  };
};

/** Inspect every regular Assets.car in the bundle; non-file entries are listed. */
const collectAssetCatalogs = async (input: {
  readonly bundlePath: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly signal?: AbortSignal;
  readonly resources: ArtifactResourceScope;
  readonly runAssetUtil?: (
    path: string,
    signal?: AbortSignal,
  ) => Promise<string>;
  readonly assetUtilLauncher?: AssetUtilLauncher;
}) => {
  const reader = new DirectoryArtifactReader(input.bundlePath);
  const catalogs: {
    path: string;
    sha256: string;
    records: ReturnType<typeof parseAppleAssetCatalogRecords>;
  }[] = [];
  const uninspected: string[] = [];
  const traversal = new ArtifactTraversalObservation();
  let symlinks = 0;
  let firstSymlink: string | undefined;
  let totalMetadataBytes = 0;
  let outcome: { kind: "completed" } | { kind: "failed"; cause: unknown } = {
    kind: "completed",
  };
  try {
    for await (const entry of declaredArtifactEntries(reader, input.signal, {
      onCoverage: traversal.record,
      onOmission: (omission) => {
        traversal.omit(omission);
        const { path, kind } = omission;
        if (path.split("/").at(-1) === "Assets.car")
          uninspected.push(`${path} (${kind})`);
      },
    })) {
      if (
        entry.kind === "symlink" &&
        entry.path.split("/").at(-1) !== "Assets.car"
      ) {
        symlinks += 1;
        firstSymlink ??= entry.path;
      }
      // Reader paths are `/`-separated; only an entry named exactly
      // Assets.car is a compiled catalog, not e.g. NotAssets.car.
      if (entry.path.split("/").at(-1) !== "Assets.car") continue;
      if (entry.kind !== "file") {
        uninspected.push(`${entry.path} (${entry.kind})`);
        continue;
      }
      const inspected = await inspectAssetCatalogEntry({
        reader,
        entry,
        runAssetUtil:
          input.runAssetUtil ??
          ((path, signal) =>
            runAssetUtil(
              path,
              input.environment,
              signal,
              input.assetUtilLauncher,
            )),
        resources: input.resources,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      totalMetadataBytes += inspected.metadataBytes;
      if (totalMetadataBytes > MAX_TOTAL_METADATA_BYTES)
        throw new ArtifactReaderFailure(
          "limit",
          `Combined asset catalog metadata exceeds ${MAX_TOTAL_METADATA_BYTES} bytes`,
        );
      catalogs.push(inspected.catalog);
    }
  } catch (cause: unknown) {
    outcome = { kind: "failed", cause };
  }
  const released = await input.resources.release({
    kind: "reader",
    reader,
    resource: input.bundlePath,
  });
  if (released.kind === "failed") {
    if (outcome.kind === "failed" && outcome.cause instanceof AnalysisError) {
      const cleanup = translateArtifactFailure(
        "inspect_asset_catalog",
        input.resources.cleanupFailure({ kind: "completed" }, [released]),
      );
      throw analysisErrorWithCleanupDependencies(
        outcome.cause,
        cleanup,
        "inspect_asset_catalog",
      );
    }
    throw input.resources.cleanupFailure(outcome, [released]);
  }
  if (outcome.kind === "failed") throw outcome.cause;
  if (symlinks > 0)
    traversal.record({
      // Source entries are represented even when their link targets were not
      // inspected. Keep that inventory scope separate from catalog discovery.
      status: "complete",
      limitations: [
        `Asset catalog discovery did not follow ${symlinks} symlink(s); catalogs beneath them may remain uninspected. First path: ${JSON.stringify(firstSymlink)}.`,
      ],
    });
  // Without any readable catalog, unmatched resource keys would overstate an
  // absence that a skipped catalog entry may contradict.
  if (catalogs.length === 0 && uninspected.length > 0)
    throw new ArtifactReaderFailure(
      "path",
      `Asset catalog entries are not regular files and were not inspected: ${uninspected.join(", ")}`,
    );
  const coverage: AppleAssetAnalysisCoverage =
    traversal.snapshot().status === "unknown" || symlinks > 0
      ? {
          status: "unknown",
          reason: "source_names_or_symlink_targets_unexamined",
        }
      : uninspected.length > 0
        ? { status: "partial", reason: "catalog_entries_uninspected" }
        : { status: "complete", reason: null };
  return { catalogs, uninspected, traversal: traversal.snapshot(), coverage };
};

const inspectAssetCatalogEntry = async (input: {
  readonly reader: DirectoryArtifactReader;
  readonly entry: ArtifactEntry;
  readonly runAssetUtil: (
    path: string,
    signal?: AbortSignal,
  ) => Promise<string>;
  readonly resources: ArtifactResourceScope;
  readonly signal?: AbortSignal;
}) => {
  const { entry, reader, signal } = input;
  const sha256 = await digestBounded(reader, entry, signal);
  const before = await lstat(entry.adapterKey, { bigint: true });
  if (
    !before.isFile() ||
    !sameArtifactSourceIdentity(entry.sourceIdentity, before)
  )
    throw new ArtifactReaderFailure(
      "integrity",
      `Asset catalog changed before inspection: ${entry.path}`,
      { integrityCheck: "member-identity" },
    );
  let output: string;
  try {
    output = await input.runAssetUtil(entry.adapterKey, signal);
  } catch (cause) {
    throw assetUtilFailure(cause, entry, input.resources);
  }
  const after = await lstat(entry.adapterKey, { bigint: true });
  if (
    !after.isFile() ||
    !sameArtifactSourceIdentity(entry.sourceIdentity, after) ||
    (await digestBounded(reader, entry, signal)) !== sha256
  )
    throw new ArtifactReaderFailure(
      "integrity",
      `Asset catalog changed during inspection: ${entry.path}`,
      { integrityCheck: "member-identity" },
    );
  const capturedOutput: AnalysisCapturedOutput = {
    stdout: output,
    stderr: "",
    truncated: false,
    stdout_bytes: Buffer.byteLength(output),
    exit_code: 0,
    signal: null,
  };
  const diagnostics = { catalog_path: entry.path };
  const decoded = parseJsonWithDuplicatePolicy(output, "reject");
  if (!decoded.ok) {
    if (decoded.duplicate !== undefined)
      throw new AnalysisOutputError(
        "inspect_asset_catalog",
        `assetutil returned duplicate JSON member ${JSON.stringify(decoded.duplicate.name)} for ${entry.path}`,
        { capturedOutput, diagnostics },
      );
    throw new AnalysisOutputError(
      "inspect_asset_catalog",
      `assetutil returned invalid JSON for ${entry.path}`,
      { cause: decoded.cause, capturedOutput, diagnostics },
    );
  }
  const parsed = decoded.value;
  try {
    return {
      catalog: {
        path: entry.path,
        sha256,
        records: parseAppleAssetCatalogRecords(parsed),
      },
      metadataBytes: Buffer.byteLength(output, "utf8"),
    };
  } catch (cause: unknown) {
    if (!(cause instanceof AnalysisOutputError)) throw cause;
    throw new AnalysisOutputError(
      "inspect_asset_catalog",
      `${cause.reason} for ${entry.path}`,
      { cause, capturedOutput, diagnostics },
    );
  }
};

/** Return only explicit image or asset fields from decoded resource objects. */
export const collectInterfaceBuilderResourceKeys = (
  nodes: readonly {
    readonly id: string;
    readonly kind: string;
    readonly name?: string;
    readonly attributes: Readonly<Record<string, unknown>>;
    readonly evidence: readonly {
      readonly artifact_path: string | null;
      readonly artifact_sha256: string | null;
    }[];
  }[],
) =>
  nodes.flatMap((node) => {
    if (node.kind !== "resource") return [];
    const source = node.evidence.find(
      (item) => item.artifact_path !== null && item.artifact_sha256 !== null,
    );
    const sourcePath = source?.artifact_path;
    const sourceArchiveSha256 = source?.artifact_sha256;
    if (sourcePath == null || sourceArchiveSha256 == null) return [];
    return appleResourceKeyFields(node.attributes).flatMap(([field, value]) => [
      {
        sourceNodeId: node.id,
        sourcePath,
        sourceArchiveSha256,
        field,
        key: value,
      },
    ]);
  });

/**
 * Run assetutil under owned supervision and return its complete output. The
 * macOS ownership helper is prepared first, under its own compile allowance,
 * so a cold helper build does not spend assetutil's deadline. Each stream
 * keeps its own 64 MiB allowance.
 */
const runAssetUtil = async (
  path: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  signal?: AbortSignal,
  launcher?: AssetUtilLauncher,
): Promise<string> => {
  await prepareOwnedCommand(signal);
  const snapshot = await runOwnedCommand(
    {
      command: ASSETUTIL,
      arguments: ["--info", path],
      runId: `rea-assetutil-${randomUUID()}`,
      hostEnvironment: { ...environment },
    },
    {
      timeoutMs: ASSETUTIL_TIMEOUT_MS,
      diagnosticBytes: { stdout: MAX_CATALOG_BYTES, stderr: MAX_CATALOG_BYTES },
    },
    {
      ...(signal === undefined ? {} : { signal }),
      ...(launcher === undefined ? {} : { launcher }),
    },
  );
  return snapshot.stdout.text;
};

/**
 * Classify one assetutil run through the shared command outcome owner, and
 * transfer any unresolved process or helper cleanup to the caller's scope,
 * which retries it before the next inspection and on close.
 */
const assetUtilFailure = (
  cause: unknown,
  entry: ArtifactEntry,
  resources: ArtifactResourceScope,
): unknown => {
  if (cause instanceof AnalysisError) return cause;
  const outcome = providerOutcomeOf(cause);
  // A command that exited 0 failed only because its cleanup is unproven.
  if (
    outcome?.kind === "exited" &&
    outcome.exitCode === 0 &&
    outcome.signal === null
  ) {
    // The completed run's output stays with the cleanup report that replaces it.
    const [cleanup, ...more] = retainArtifactCommandCleanup(
      cause,
      resources,
      OPERATION,
      outcome.output === undefined
        ? undefined
        : { capturedOutput: capturedProviderOutput(outcome.output.snapshot) },
    );
    if (cleanup !== undefined)
      return more.reduce(
        (primary, failure) =>
          analysisErrorWithCleanupDependencies(primary, failure, OPERATION),
        cleanup,
      );
  }
  const primary =
    processInspectionCancellationError(cause, OPERATION) ??
    (outcome !== undefined
      ? classifyProviderOutcome(outcome, assetUtilOutcomeContext(entry))
      : processInspectionFailure(cause) !== undefined
        ? new ProviderAdapterError(ARTIFACT_GRAPH_PROVIDER.id, OPERATION, {
            cause,
            diagnostics: { catalog_path: entry.path },
          })
        : undefined);
  if (primary === undefined) return cause;
  return retainProcessInspectionCleanup(cause, primary, resources, OPERATION);
};

/** What an assetutil outcome means; owner-observed facts are shared. */
const assetUtilOutcomeContext = (
  entry: ArtifactEntry,
): ProviderOutcomeContext => ({
  providerId: ARTIFACT_GRAPH_PROVIDER.id,
  operation: OPERATION,
  capturedOutput: capturedProviderOutput,
  details: { diagnostics: { catalog_path: entry.path } },
  timeout: { ms: ASSETUTIL_TIMEOUT_MS },
  outputLimit: {
    reason: "assetutil output exceeds the 64 MiB capture allowance",
    limits: { maximum_output_bytes: MAX_CATALOG_BYTES },
    recovery: fixedAllowanceOptions(
      "The assetutil capture allowance",
      "capture",
      {
        limit: MAX_CATALOG_BYTES,
        unit: "bytes",
      },
    ),
  },
  launchUnavailable: (failure, details) =>
    new AnalysisCapabilityUnavailableError(
      "artifact",
      OPERATION,
      failure.kind === "missing"
        ? "macOS assetutil is unavailable"
        : `macOS assetutil could not be launched (${describeLaunchFailure(failure)})`,
      details,
    ),
  dialect: (outcome, details) => {
    // assetutil's explicit input rejection is distinct from unusable tool
    // output. Match its complete diagnostic for this exact selected path;
    // other text, interrupted runs and incomplete captures establish no cause.
    const stderr = outcome.output?.snapshot.stderr.text ?? "";
    const rejectsCatalog = [
      `carutil: error:\n    ${entry.adapterKey} is not a valid AssetCatalog`,
      `carutil: error:\n\t${entry.adapterKey} is not a valid AssetCatalog`,
      `assetutil: file error error exiting: 'can't read from: '${entry.adapterKey}' Undefined error: 0' invalid file`,
    ].some((rejection) => {
      const offset = stderr.indexOf(rejection);
      const end = offset + rejection.length;
      return (
        offset >= 0 &&
        (offset === 0 || stderr[offset - 1] === "\n") &&
        (end === stderr.length || stderr[end] === "\n")
      );
    });
    if (
      outcome.kind === "exited" &&
      outcome.exitCode === 1 &&
      outcome.signal === null &&
      !outcome.stopRequested &&
      outcome.output?.truncated === false &&
      rejectsCatalog
    )
      return new ArtifactOperationError(
        OPERATION,
        "format",
        undefined,
        `assetutil rejected ${entry.path} as an invalid asset catalog`,
        details,
      );
    return new AnalysisOutputError(
      OPERATION,
      `assetutil did not produce usable catalog metadata for ${entry.path}`,
      details,
    );
  },
});

const digestBounded = async (
  reader: DirectoryArtifactReader,
  entry: import("../../resources/index.js").ArtifactEntry,
  signal?: AbortSignal,
): Promise<string> => {
  if (entry.declaredSize === null || entry.declaredSize > MAX_CATALOG_BYTES)
    throw new ArtifactReaderFailure(
      "limit",
      `Asset catalog exceeds ${MAX_CATALOG_BYTES} bytes: ${entry.path}`,
    );
  const stream = await reader.open(entry, signal);
  const hash = createHash("sha256");
  let length = 0;
  for await (const chunk of stream) {
    if (signal?.aborted === true)
      throw new ArtifactReaderFailure(
        "cancelled",
        "Asset catalog inspection cancelled",
        { cause: signal.reason },
      );
    const bytes = streamChunkToBuffer(chunk);
    length += bytes.length;
    if (length > MAX_CATALOG_BYTES)
      throw new ArtifactReaderFailure(
        "limit",
        `Asset catalog exceeds byte limit: ${entry.path}`,
      );
    hash.update(bytes);
  }
  return hash.digest("hex");
};
