import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import type { EspFlashSelection } from "../domain/firmware/espFlashLocation.js";
import {
  ARTIFACT_MEMBER_COUNT_PARAMETERS,
  ARTIFACT_MEMBER_COUNT_SETTING,
  artifactMemberCountSelected,
  artifactReaderLimitsInputSchema,
  resolveArtifactReaderLimits,
  type ArtifactMemberCount,
  type ArtifactReaderLimitsInput,
} from "../domain/artifactReaderLimits.js";
import type { AnalysisSettingsReader } from "../domain/analysisSettings.js";
import { analysisSettingLimit } from "../domain/analysisSettingDefinitions.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import { runtimeAsarHeaderAdmission } from "../config/runtimeAnalysisSettings.js";
import { runtimeArtifactMemberCount } from "../config/artifactMemberCount.js";
import { artifactTargetRefusal } from "../domain/apple/artifactTargetApplicability.js";
import {
  bindArtifactFileCleanup,
  ArtifactReaderFailure,
  ArtifactResourceScope,
  withArtifactTargetIdentity,
  translateArtifactFailure,
} from "../resources/index.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import {
  createAnalysisExecution,
  type AnalysisClient,
  type AnalysisExecution,
  type AnalysisOperation,
  type AnalysisProvider,
  type CapabilityDescriptor,
  type ProviderIdentity,
  type ExecutionOptions,
  type RetainedResourceScope,
} from "../ports/AnalysisProvider.js";
import {
  inspectBundleKeyedArchive,
  inspectStandaloneKeyedArchive,
} from "./apple/KeyedArchiveReader.js";
import { traceDylibResolution } from "./apple/DylibResolutionReader.js";
import { dirname } from "node:path";
import { inventoryArtifact } from "./inventory/ArtifactInventory.js";
import { extractArtifact } from "./extraction/ArtifactExtraction.js";
import { analyzeInterfaceBuilderBundle } from "./apple/InterfaceBuilderAnalysis.js";
import { analyzeAppleAssetCatalogs } from "./apple/AppleAssetCatalogAnalysis.js";
import {
  ARTIFACT_ANALYSIS_OPERATIONS,
  artifactInventoryInputSchema,
  artifactExtractionExecutionSchema,
  type ArtifactAnalysisOperation,
} from "../contracts/artifactToolContracts.js";
import {
  artifactTargetSelectedPath,
  type BinaryTarget,
} from "../domain/binaryTargetTypes.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisTargetFailureError,
  unsupportedTarget,
} from "../domain/analysisErrorCore.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { interfaceBuilderLimitsSchema } from "../domain/apple/interfaceBuilderGraph.js";
import { err, ok, type Result } from "../domain/result.js";
import { artifactCapabilities } from "./ArtifactProviderMetadata.js";
import { ARTIFACT_GRAPH_PROVIDER } from "../domain/investigationProviders.js";
import {
  createEvidence,
  type EvidenceSubjectTarget,
} from "../domain/evidence.js";
import { binaryTargetSelection } from "../domain/targetIdentity.js";
import type { ArtifactInventoryResult } from "../domain/artifactGraph.js";
import {
  artifactInventorySubject,
  type ArtifactInventorySubject as InventorySubject,
} from "../domain/artifactInventoryEvidence.js";
import { freezeJsonSnapshot } from "../domain/immutableJson.js";
import {
  artifactInspectionSources,
  createArtifactInspection,
  type ArtifactInspectionRootImage,
} from "../domain/artifactInspection.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import type {
  ResolvedAppBundleResourceRoot,
  BundleResourceRoot,
} from "../domain/apple/bundleResourceRoot.js";
import { BUNDLE_ARTIFACT_RESOURCE_OPERATIONS } from "../ports/BundleResourceOperations.js";
import { errorMessage } from "../kernel/errorMessage.js";

/** Read-only inventory and exclusively owned extraction provider. */
export class ArtifactProvider implements AnalysisProvider {
  readonly #capabilities: readonly CapabilityDescriptor[];
  readonly #platform: NodeJS.Platform;
  private readonly environment: Readonly<NodeJS.ProcessEnv>;

  constructor(
    environment: Readonly<NodeJS.ProcessEnv>,
    /** The host whose readers run; tests select another host's rules. */
    platform: NodeJS.Platform = HOST_PLATFORM.platform,
    private readonly settings?: AnalysisSettingsReader,
  ) {
    this.environment = snapshotEnvironment(environment, platform);
    this.#capabilities = artifactCapabilities(platform);
    this.#platform = platform;
  }

  identity(): ProviderIdentity {
    return ARTIFACT_GRAPH_PROVIDER;
  }

  capabilities(): readonly CapabilityDescriptor[] {
    return this.#capabilities;
  }

  createClient(target: BinaryTarget): AnalysisClient {
    return new ArtifactClient(
      target,
      this.environment,
      this.#platform,
      this.settings,
    );
  }

  /**
   * Inspect a caller-selected directory without a session target. The
   * directory's subject is its complete tree digest, or an explicit unknown
   * when the walk was partial.
   */
  async inspectDirectory(
    path: string,
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
    /** The caller's lifetime, which keeps a failed cleanup retryable. */
    retained?: RetainedResourceScope,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const resources = new ArtifactResourceScope();
    const policy = new ArtifactReaderPolicy(this.environment, this.settings);
    let inspected: Result<AnalysisExecution, AnalysisError>;
    try {
      inspected = await inspectInventory(
        artifactInventoryInputSchema.parse(parameters),
        (inventoryParameters) =>
          inventoryArtifact(path, {
            selectedPath: path,
            resourceScope: resources,
            ...inventoryRuntimeOptions(
              this.environment,
              this.settings,
              inventoryParameters,
              options,
              policy,
            ),
          }),
        (inventory) => ({
          subject: artifactInventorySubject(path, inventory),
          rootImage: undefined,
        }),
        options,
      );
    } catch (cause: unknown) {
      inspected = err(
        translateArtifactFailure("inspect_artifact", path, cause),
      );
    }
    if (!inspected.ok) policy.bind(inspected.error, parameters);
    // A completed inspection still fails when its readers could not be
    // released. The caller's lifetime keeps this scope, so a later close of
    // that lifetime retries exactly the owners that are still pending.
    const closed = await closeArtifactResources(resources, path);
    if (!closed.ok)
      retained?.retain(
        {
          close: () => resources.close(),
          cleanupResources: resources.cleanupResources,
        },
        `artifact directory inspection of ${path}`,
      );
    return closed.ok || !inspected.ok ? inspected : closed;
  }

  createBundleResourceClient(
    root: ResolvedAppBundleResourceRoot,
  ): AnalysisClient {
    return new BundleResourceArtifactClient(
      root,
      this.environment,
      this.#platform,
    );
  }
}

/** Project both artifact clients' shutdown through the exact retained cleanup owner. */
const closeArtifactResources = (
  resources: ArtifactResourceScope,
  fallbackResource: string,
): Promise<Result<null, AnalysisError>> =>
  resources.close().then(
    () => ok(null),
    (cause: unknown) => {
      const failure =
        cause instanceof ArtifactReaderFailure ? cause : undefined;
      const error = new ProviderCleanupError(
        ARTIFACT_GRAPH_PROVIDER.id,
        failure?.cleanup?.resources ?? [fallbackResource],
        {
          reason: failure?.cleanup?.reason ?? errorMessage(cause),
        },
        { cause, operation: "close_binary" },
      );
      bindArtifactFileCleanup(cause, error);
      return err(error);
    },
  );

const serializedResourceRoot = (
  root: ResolvedAppBundleResourceRoot,
): BundleResourceRoot => ({
  caller_path: root.callerPath,
  canonical_path: root.canonicalPath,
  info_plist_path: root.infoPlistPath,
  layout: root.layout,
  executable_sha256: root.executableSha256,
});

class BundleResourceArtifactClient implements AnalysisClient {
  readonly #resourceScope = new ArtifactResourceScope();

  constructor(
    private readonly root: ResolvedAppBundleResourceRoot,
    private readonly environment: Readonly<NodeJS.ProcessEnv>,
    private readonly platform: NodeJS.Platform,
  ) {}

  async execute(
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ) {
    if (operation === "health")
      return ok(createAnalysisExecution(null, ARTIFACT_GRAPH_PROVIDER));
    if (!BUNDLE_ARTIFACT_RESOURCE_OPERATIONS.has(operation))
      return err(
        new AnalysisCapabilityUnavailableError(
          ARTIFACT_GRAPH_PROVIDER.id,
          operation,
          "The app resource reader supports only plist, Interface Builder, asset catalog, and keyed archive inspection.",
        ),
      );
    try {
      const resourceRoot = serializedResourceRoot(this.root);
      const result =
        operation === "decode_interface_builder"
          ? await analyzeInterfaceBuilderBundle({
              bundlePath: this.root.canonicalPath,
              targetSha256: null,
              resourceRoot,
              resources: this.#resourceScope,
              limits: interfaceBuilderLimitsSchema.parse(parameters),
              ...(options?.signal === undefined
                ? {}
                : { signal: options.signal }),
            })
          : operation === "inspect_keyed_archive"
            ? await inspectBundleKeyedArchive({
                bundlePath: this.root.canonicalPath,
                targetSha256: null,
                resourceRoot,
                parameters,
                platform: this.platform,
                resources: this.#resourceScope,
                ...(options?.signal === undefined
                  ? {}
                  : { signal: options.signal }),
              })
            : operation === "inspect_asset_catalog"
              ? await analyzeAppleAssetCatalogs({
                  bundlePath: this.root.canonicalPath,
                  targetSha256: null,
                  resourceRoot,
                  environment: this.environment,
                  resources: this.#resourceScope,
                  page: parameters,
                  ...(options?.signal === undefined
                    ? {}
                    : { signal: options.signal }),
                })
              : (() => {
                  throw new AnalysisCapabilityUnavailableError(
                    ARTIFACT_GRAPH_PROVIDER.id,
                    operation,
                    "Property list inspection requires a platform-native reader.",
                  );
                })();
      return ok(
        createAnalysisExecution(result, ARTIFACT_GRAPH_PROVIDER, {
          limitations: "limitations" in result ? result.limitations : [],
        }),
      );
    } catch (cause: unknown) {
      return err(
        translateArtifactFailure(
          operation as ArtifactAnalysisOperation,
          this.root.callerPath,
          cause,
        ),
      );
    }
  }

  close(): Promise<Result<null, AnalysisError>> {
    return closeArtifactResources(
      this.#resourceScope,
      "app bundle resource reader",
    );
  }
}

class ArtifactClient implements AnalysisClient {
  readonly #resourceScope = new ArtifactResourceScope();

  constructor(
    private readonly target: BinaryTarget,
    private readonly environment: Readonly<NodeJS.ProcessEnv>,
    private readonly platform: NodeJS.Platform,
    private readonly settings?: AnalysisSettingsReader,
  ) {}

  async execute(
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ) {
    const policy = new ArtifactReaderPolicy(this.environment, this.settings);
    const executed = await this.#execute(
      operation,
      parameters,
      policy,
      options,
    );
    if (!executed.ok) policy.bind(executed.error, parameters);
    return executed;
  }

  async #execute(
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    policy: ArtifactReaderPolicy,
    options?: ExecutionOptions,
  ) {
    if (operation === "health")
      return ok(createAnalysisExecution(null, ARTIFACT_GRAPH_PROVIDER));
    if (!isArtifactOperation(operation))
      return err(
        new AnalysisCapabilityUnavailableError(
          ARTIFACT_GRAPH_PROVIDER.id,
          operation,
          "Operation is not implemented by artifact graph provider.",
        ),
      );
    try {
      const targetRefusal = artifactTargetRefusal(operation, this.target);
      if (targetRefusal !== undefined)
        throw this.unsupportedTarget(operation, targetRefusal.reason);
      if (operation === "inspect_artifact") {
        const inspected = await this.inspectArtifact(
          parameters,
          policy,
          options,
        );
        return inspected;
      }
      if (operation === "decode_interface_builder") {
        const limits = interfaceBuilderLimitsSchema.parse(parameters);
        const result = await withArtifactTargetIdentity(
          this.target,
          this.#resourceScope,
          () =>
            analyzeInterfaceBuilderBundle({
              bundlePath: this.target.sourcePath ?? this.target.path,
              targetSha256: this.target.sha256,
              limits,
              resources: this.#resourceScope,
              ...(options?.signal === undefined
                ? {}
                : { signal: options.signal }),
            }),
          options?.signal,
        );
        return ok(
          createAnalysisExecution(result, ARTIFACT_GRAPH_PROVIDER, {
            limitations: result.limitations,
            locations: result.documents.map(({ relative_path: path }) => ({
              kind: "artifact-path" as const,
              path,
            })),
          }),
        );
      }
      if (operation === "inspect_keyed_archive") {
        // A bundle target reads bundle-relative archives whatever its
        // executable admitted as; only a plist opened on its own is standalone.
        const standalone =
          this.target.bundleInfoPlist === undefined &&
          this.target.kind === "artifact" &&
          this.target.format === "plist";
        const selectedPath = artifactTargetSelectedPath(this.target);
        const result = standalone
          ? await inspectStandaloneKeyedArchive({
              path: this.target.path,
              selectedPath,
              targetSha256: this.target.sha256,
              parameters,
              platform: this.platform,
              resources: this.#resourceScope,
              ...(options?.signal === undefined
                ? {}
                : { signal: options.signal }),
            })
          : await withArtifactTargetIdentity(
              this.target,
              this.#resourceScope,
              () =>
                inspectBundleKeyedArchive({
                  bundlePath: this.target.sourcePath ?? this.target.path,
                  targetSha256: this.target.sha256,
                  parameters,
                  platform: this.platform,
                  resources: this.#resourceScope,
                  ...(options?.signal === undefined
                    ? {}
                    : { signal: options.signal }),
                }),
              options?.signal,
            );
        return ok(
          createAnalysisExecution(result, ARTIFACT_GRAPH_PROVIDER, {
            limitations: result.limitations,
            locations: [{ kind: "artifact-path", path: result.archive_path }],
            ...(standalone
              ? {
                  subject: {
                    path: selectedPath,
                    sha256: result.archive_sha256,
                    format: "plist" as const,
                  },
                }
              : {}),
          }),
        );
      }
      if (operation === "inspect_asset_catalog") {
        return await this.inspectAssetCatalog(parameters, options);
      }
      if (operation === "trace_dylib_resolution")
        return await this.traceDylibResolution(parameters, options);
      if (operation === "extract_artifact") {
        const parsed = artifactExtractionExecutionSchema.parse(parameters);
        const result = await extractArtifact(
          {
            inputPath: this.target.sourcePath ?? this.target.path,
            expectedRootSha256:
              this.target.bundleInfoPlist === undefined
                ? this.target.sha256
                : undefined,
            selectedPath: this.target.artifactSelectedPath,
            inputFormat: this.target.format,
            espFlashSelection: espFlashSelection(this.target),
            outputRoot: parsed.output_root,
            ...(parsed.occurrence_ids === undefined
              ? {}
              : { occurrenceIds: parsed.occurrence_ids }),
            environment: this.environment,
            asarHeaderAdmission: runtimeAsarHeaderAdmission(
              this.environment,
              this.settings,
            ),
            integrityPolicy: parsed.integrity_policy,
            ...policy.readerLimits(parsed.artifact_limits),
            resourceScope: this.#resourceScope,
          },
          options?.signal,
        );
        return ok(
          createAnalysisExecution(result, ARTIFACT_GRAPH_PROVIDER, {
            rawResult: null,
            limitations: result.limitations,
            subject: executionSubject(
              subjectFor(this.target, { manifest: result.manifest }),
            ),
            // Each extracted file's path is already in artifacts.
            locations: [],
          }),
        );
      }
      const parsed = artifactInventoryInputSchema.parse(parameters);
      const result = await this.inventory(parsed, policy, options);
      return ok(
        createAnalysisExecution(result, ARTIFACT_GRAPH_PROVIDER, {
          rawResult: null,
          limitations: result.limitations,
          subject: executionSubject(subjectFor(this.target, result)),
          // Each occurrence's logical path is already in the result.
          locations: [],
        }),
      );
    } catch (cause: unknown) {
      return err(
        translateArtifactFailure(
          operation as ArtifactAnalysisOperation,
          // The caller's spelling, not the resolved file the reader opened.
          this.target.callerInputPath ??
            artifactTargetSelectedPath(this.target),
          cause,
        ),
      );
    }
  }

  close(): Promise<Result<null, AnalysisError>> {
    return closeArtifactResources(this.#resourceScope, "artifact resources");
  }

  /** The active target's kind is outside this operation's supported targets. */
  private unsupportedTarget(
    operation: string,
    reason: string,
  ): AnalysisTargetFailureError {
    return unsupportedTarget(
      operation,
      this.target.sourcePath ?? this.target.path,
      this.target.format,
      reason,
    );
  }

  private async inspectAssetCatalog(
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ) {
    const bundlePath = this.target.sourcePath ?? this.target.path;
    const result = await withArtifactTargetIdentity(
      this.target,
      this.#resourceScope,
      () =>
        analyzeAppleAssetCatalogs({
          environment: this.environment,
          bundlePath,
          resources: this.#resourceScope,
          targetSha256: this.target.sha256,
          page: parameters,
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
        }),
      options?.signal,
    );
    return ok(
      createAnalysisExecution(result, ARTIFACT_GRAPH_PROVIDER, {
        limitations: result.limitations,
        locations: result.catalogs.map(({ path }) => ({
          kind: "artifact-path" as const,
          path,
        })),
      }),
    );
  }

  private async traceDylibResolution(
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ) {
    // Only a target opened from an app bundle directory carries its Info.plist;
    // a regular file whose name ends in .app is a standalone image.
    const bundle =
      this.target.bundleInfoPlist === undefined
        ? undefined
        : this.target.sourcePath;
    const result = await traceDylibResolution({
      rootPath: bundle ?? dirname(this.target.path),
      targetPath: this.target.path,
      targetSha256: this.target.sha256,
      enumerateRoots: bundle !== undefined,
      parameters,
      resourceScope: this.#resourceScope,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
    return ok(
      createAnalysisExecution(result, ARTIFACT_GRAPH_PROVIDER, {
        limitations: result.limitations,
        locations: result.images.map(({ path }) => ({
          kind: "artifact-path" as const,
          path,
        })),
        // A universal trace selects its own slices. Thin files retain their
        // architecture and use the default subject for the open target.
        ...(this.target.format === "mach-o-universal"
          ? {
              subject: {
                path: this.target.path,
                sha256: this.target.sha256,
                format: this.target.format,
                selection: null,
              },
            }
          : {}),
      }),
    );
  }

  private inspectArtifact(
    parameters: Readonly<Record<string, JsonValue>>,
    policy: ArtifactReaderPolicy,
    options?: ExecutionOptions,
  ) {
    return inspectInventory(
      artifactInventoryInputSchema.parse(parameters),
      (inventoryParameters) =>
        this.inventory(inventoryParameters, policy, options),
      (inventory) => ({
        subject: subjectFor(this.target, inventory),
        rootImage: rootImage(this.target, inventory.manifest),
      }),
      options,
    );
  }

  private inventory(
    parsed: InventoryParameters,
    policy: ArtifactReaderPolicy,
    options?: ExecutionOptions,
  ) {
    return inventoryArtifact(this.target.sourcePath ?? this.target.path, {
      expectedRootSha256:
        this.target.bundleInfoPlist === undefined
          ? this.target.sha256
          : undefined,
      selectedPath: this.target.artifactSelectedPath,
      resourceScope: this.#resourceScope,
      espFlashSelection: espFlashSelection(this.target),
      ...inventoryRuntimeOptions(
        this.environment,
        this.settings,
        parsed,
        options,
        policy,
      ),
    });
  }
}

/** The inventory request facts an inspection records and its nested inventory runs with. */
interface InventoryParameters {
  readonly integrity_policy: "fail" | "record-and-continue";
  readonly artifact_limits?: ArtifactReaderLimitsInput | undefined;
}

/** Runtime inventory options shared by session-target and path inspections. */
const inventoryRuntimeOptions = (
  environment: Readonly<NodeJS.ProcessEnv>,
  settings: AnalysisSettingsReader | undefined,
  parsed: InventoryParameters,
  options: ExecutionOptions | undefined,
  policy: ArtifactReaderPolicy,
) => ({
  environment,
  asarHeaderAdmission: runtimeAsarHeaderAdmission(environment, settings),
  ...(options?.signal === undefined ? {} : { signal: options.signal }),
  integrity: parsed.integrity_policy,
  ...policy.readerLimits(parsed.artifact_limits),
});

/**
 * One call's reader admission policy. The session member count is resolved at
 * most once, so the limits a reader enforced and the setting a refusal names
 * agree. Without a caller selection or a non-default session value, readers
 * keep their own defaults and Evidence reports no effective limits.
 */
class ArtifactReaderPolicy {
  #memberCount: ArtifactMemberCount | undefined;

  constructor(
    private readonly environment: Readonly<NodeJS.ProcessEnv>,
    private readonly settings: AnalysisSettingsReader | undefined,
  ) {}

  #resolved(): ArtifactMemberCount {
    this.#memberCount ??= runtimeArtifactMemberCount(
      this.environment,
      this.settings,
    );
    return this.#memberCount;
  }

  readerLimits(selected: ArtifactReaderLimitsInput | undefined) {
    // The caller's fields come first: when every backed field is selected,
    // the session value (and an invalid launch seed) is never consulted.
    if (
      selected !== undefined &&
      ARTIFACT_MEMBER_COUNT_PARAMETERS.every((parameter) =>
        artifactMemberCountSelected(selected, parameter),
      )
    )
      return { readerLimits: resolveArtifactReaderLimits(selected) };
    const memberCount = this.#resolved();
    return selected === undefined && memberCount.source === "default"
      ? {}
      : {
          readerLimits: resolveArtifactReaderLimits(
            selected,
            memberCount.value,
          ),
        };
  }

  /**
   * Report a member-count refusal as the setting that backs its field, with
   * that field as the per-call route and the value's source.
   */
  bind(
    error: AnalysisError,
    parameters: Readonly<Record<string, JsonValue>>,
  ): void {
    if (!(error instanceof ArtifactOperationError)) return;
    const fact = error.readerLimit;
    const parameter = ARTIFACT_MEMBER_COUNT_PARAMETERS.find(
      (candidate) => candidate === fact?.parameter,
    );
    if (fact === undefined || parameter === undefined) return;
    const selected = artifactReaderLimitsInputSchema.safeParse(
      parameters.artifact_limits,
    );
    const requested =
      selected.success && artifactMemberCountSelected(selected.data, parameter);
    // An unselected field took the session value this call resolved.
    const source = requested ? "request" : this.#memberCount?.source;
    if (source === undefined) return;
    error.bindLimit({
      ...analysisSettingLimit(
        ARTIFACT_MEMBER_COUNT_SETTING,
        fact.effective_value,
        source,
      ),
      parameter,
      ...(typeof fact.required_value === "number"
        ? { required_value: fact.required_value }
        : {}),
    });
  }
}

/**
 * Inventory once, commit the inventory as nested Evidence, and derive the
 * inspection from it. The subject and root image come from the caller, which
 * owns what the inventoried root is.
 */
const inspectInventory = async (
  parsed: InventoryParameters,
  inventory: (
    parameters: InventoryParameters,
  ) => Promise<ArtifactInventoryResult>,
  describe: (inventory: ArtifactInventoryResult) => {
    readonly subject: InventorySubject;
    readonly rootImage: ArtifactInspectionRootImage | undefined;
  },
  options: ExecutionOptions | undefined,
): Promise<Result<AnalysisExecution, AnalysisError>> => {
  const inventoryParameters = {
    integrity_policy: parsed.integrity_policy,
    ...(parsed.artifact_limits === undefined
      ? {}
      : { artifact_limits: parsed.artifact_limits }),
  };
  await options?.progress?.report({
    phase: "inspect_artifact.inventory",
    completed: 0,
    total: 1,
    message: "inventory substep started",
  });
  // The freshly parsed inventory is exclusively owned here. Sealing it lets
  // the nested Evidence share it instead of cloning and re-digesting it.
  const inventoryResult = freezeJsonSnapshot(
    await inventory(inventoryParameters),
  );
  const { subject, rootImage: image } = describe(inventoryResult);
  // Sealed at creation, the nested Evidence is borrowed when the session
  // records it as a source, rather than parsed and digested again.
  const inventoryEvidence = createEvidence(
    subject,
    ARTIFACT_GRAPH_PROVIDER,
    {
      operation: "inventory_artifact",
      parameters: inventoryParameters,
      result: inventoryResult,
      rawResult: null,
      limitations: inventoryResult.limitations,
      // The nested inventory already names every occurrence's logical path.
      locations: [],
    },
    { immutable: true },
  );
  // The returned execution and its Evidence then reuse this owned report.
  const result = freezeJsonSnapshot(
    createArtifactInspection(inventoryEvidence, image),
  );
  await options?.progress?.report({
    phase: "inspect_artifact.inventory",
    completed: 1,
    total: 1,
    message: "inventory substep completed",
  });
  return ok(
    createAnalysisExecution(result, ARTIFACT_GRAPH_PROVIDER, {
      rawResult: null,
      limitations: result.limitations,
      sourceEvidence: artifactInspectionSources(result),
      subject: executionSubject(subject),
      locations: [],
    }),
  );
};

/** An execution names a local subject, or null for an explicit unknown. */
const executionSubject = (
  subject: InventorySubject,
): EvidenceSubjectTarget | null => ("path" in subject ? subject : null);

/** Caller inputs of an explicitly selected ESP flash image, for its readers. */
const espFlashSelection = (
  target: BinaryTarget,
): EspFlashSelection | undefined =>
  target.format === "esp-flash-image" && target.espFlash.selected
    ? {
        flashOffset: target.espFlash.flashOffset ?? undefined,
        partitionTableOffset: target.espFlash.partitionTableOffset ?? undefined,
      }
    : undefined;

const isArtifactOperation = (
  operation: AnalysisOperation,
): operation is ArtifactAnalysisOperation =>
  ARTIFACT_ANALYSIS_OPERATIONS.includes(
    operation as (typeof ARTIFACT_ANALYSIS_OPERATIONS)[number],
  );

/** The native image target admission parsed from the inventory root's bytes. */
const rootImage = (
  target: BinaryTarget,
  manifest: { readonly root_sha256: string },
): ArtifactInspectionRootImage | undefined => {
  if (manifest.root_sha256 !== target.sha256) return undefined;
  if (target.format === "pe") return { format: "pe", managed: target.managed };
  return target.format === "elf" ||
    target.format === "mach-o" ||
    target.format === "mach-o-universal"
    ? { format: target.format }
    : undefined;
};

/**
 * The inventory root as an Evidence subject. When the root is the open
 * target's own bytes, it carries the target's selection (ESP flash offsets)
 * and the architecture target admission parsed from its header, so
 * observations of different selections name different subjects.
 */
const subjectFor = (
  target: BinaryTarget,
  inventory: Pick<ArtifactInventoryResult, "manifest" | "root_digest">,
): InventorySubject => {
  const { manifest } = inventory;
  if (inventory.root_digest !== undefined)
    return artifactInventorySubject(
      artifactTargetSelectedPath(target),
      inventory,
    );
  const sameTarget =
    manifest.root_sha256 === target.sha256 &&
    manifest.root_format === target.format;
  const selection = sameTarget ? binaryTargetSelection(target) : null;
  return {
    path: artifactTargetSelectedPath(target),
    sha256: manifest.root_sha256,
    format: manifest.root_format,
    ...(sameTarget && target.architecture !== undefined
      ? { architecture: target.architecture }
      : {}),
    ...(selection === null ? {} : { selection }),
  };
};
