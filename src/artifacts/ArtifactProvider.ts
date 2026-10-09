import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import {
  createAnalysisExecution,
  type AnalysisClient,
  type AnalysisOperation,
  type AnalysisProvider,
  type CapabilityDescriptor,
  type ProviderIdentity,
  type ExecutionOptions,
} from "../application/AnalysisProvider.js";
import { inspectBundleKeyedArchive } from "./apple/KeyedArchiveReader.js";
import { traceDylibResolution } from "./apple/DylibResolutionReader.js";
import { basename, dirname } from "node:path";
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
import type { BinaryTarget } from "../domain/binaryTarget.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import { type AnalysisError } from "../domain/analysisErrorBase.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { interfaceBuilderLimitsSchema } from "../domain/apple/interfaceBuilderGraph.js";
import { err, ok, type Result } from "../domain/result.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import {
  ARTIFACT_PROVIDER_IDENTITY as IDENTITY,
  artifactCapabilities,
} from "./ArtifactProviderMetadata.js";
import { createEvidence } from "../domain/evidence.js";
import { createArtifactInspection } from "../domain/artifactInspection.js";
import { resolveArtifactIntegrityPolicy } from "./inventory/policy.js";

/** Read-only inventory and exclusively owned extraction provider. */
export class ArtifactProvider implements AnalysisProvider {
  readonly #capabilities: readonly CapabilityDescriptor[];
  readonly #platform: NodeJS.Platform;
  private readonly environment: Readonly<NodeJS.ProcessEnv>;

  constructor(
    environment: Readonly<NodeJS.ProcessEnv>,
    platform: NodeJS.Platform = process.platform,
  ) {
    this.environment = snapshotEnvironment(environment, platform);
    this.#capabilities = artifactCapabilities(platform);
    this.#platform = platform;
  }

  identity(): ProviderIdentity {
    return IDENTITY;
  }

  capabilities(): readonly CapabilityDescriptor[] {
    return this.#capabilities;
  }

  createClient(target: BinaryTarget): AnalysisClient {
    return new ArtifactClient(target, this.environment, this.#platform);
  }
}

class ArtifactClient implements AnalysisClient {
  constructor(
    private readonly target: BinaryTarget,
    private readonly environment: Readonly<NodeJS.ProcessEnv>,
    private readonly platform: NodeJS.Platform,
  ) {}

  async execute(
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ) {
    if (operation === "health")
      return ok(createAnalysisExecution(null, IDENTITY));
    if (!isArtifactOperation(operation))
      return err(
        new AnalysisCapabilityUnavailableError(
          IDENTITY.id,
          operation,
          "Operation is not implemented by artifact graph provider.",
        ),
      );
    try {
      if (operation === "inspect_artifact") {
        const inspected = await this.inspectArtifact(parameters, options);
        return inspected;
      }
      if (operation === "decode_interface_builder") {
        if (
          this.target.kind !== "executable" ||
          this.target.sourcePath === undefined ||
          !this.target.sourcePath.toLowerCase().endsWith(".app")
        )
          throw this.unsupportedTarget(
            operation,
            "decode_interface_builder requires an active .app bundle target",
          );
        const limits = interfaceBuilderLimitsSchema.parse(parameters);
        const result = await analyzeInterfaceBuilderBundle({
          bundlePath: this.target.sourcePath,
          targetSha256: this.target.sha256,
          limits,
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
        });
        return ok(
          createAnalysisExecution(result, IDENTITY, {
            limitations: result.limitations,
            locations: result.documents.map(({ relative_path: path }) => ({
              kind: "artifact-path" as const,
              path,
            })),
          }),
        );
      }
      if (operation === "inspect_keyed_archive") {
        const standalone =
          this.target.kind === "artifact" && this.target.format === "plist";
        if (
          standalone &&
          parameters.path !== undefined &&
          parameters.path !== "." &&
          parameters.path !== basename(this.target.path)
        )
          throw new AnalysisInputError(operation, undefined, [
            {
              path: ["path"],
              reason: "invalid_value",
              message:
                "For an active plist, path must select that archive (omit path or use its basename).",
              expected: basename(this.target.path),
            },
          ]);
        const bundlePath = standalone
          ? dirname(this.target.path)
          : this.target.sourcePath;
        if (
          bundlePath === undefined ||
          (!standalone && !bundlePath.toLowerCase().endsWith(".app"))
        )
          throw this.unsupportedTarget(
            operation,
            "inspect_keyed_archive requires an active plist or .app bundle",
          );
        const result = await inspectBundleKeyedArchive({
          bundlePath,
          targetSha256: this.target.sha256,
          parameters: standalone
            ? { ...parameters, path: basename(this.target.path) }
            : parameters,
          platform: this.platform,
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
        });
        if (standalone && result.archive_sha256 !== this.target.sha256)
          throw new ArtifactReaderFailure(
            "integrity",
            `Active archive digest changed: expected ${this.target.sha256}, observed ${result.archive_sha256}`,
          );
        return ok(
          createAnalysisExecution(result, IDENTITY, {
            limitations: result.limitations,
            locations: [{ kind: "artifact-path", path: result.archive_path }],
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
            inputFormat: this.target.format,
            outputRoot: parsed.output_root,
            environment: this.environment,
          },
          options?.signal,
        );
        return ok(
          createAnalysisExecution(result, IDENTITY, {
            rawResult: null,
            limitations: result.limitations,
            subject: subjectFor(
              this.target.sourcePath ?? this.target.path,
              result.manifest,
            ),
            locations: result.artifacts.map(({ relative_path: path }) => ({
              kind: "artifact-path" as const,
              path,
            })),
          }),
        );
      }
      const parsed = artifactInventoryInputSchema.parse(parameters);
      const result = await this.inventory(parsed, options);
      return ok(
        createAnalysisExecution(result, IDENTITY, {
          rawResult: null,
          limitations: result.limitations,
          subject: subjectFor(
            this.target.sourcePath ?? this.target.path,
            result.manifest,
          ),
          locations: result.occurrences.map(({ logical_path: path }) => ({
            kind: "artifact-path" as const,
            path,
          })),
        }),
      );
    } catch (cause: unknown) {
      return err(translateArtifactFailure(operation, cause));
    }
  }

  close(): Promise<Result<null, AnalysisError>> {
    return Promise.resolve(ok(null));
  }

  /** The active target's kind is outside this operation's supported targets. */
  private unsupportedTarget(
    operation: string,
    reason: string,
  ): AnalysisUnsupportedTargetError {
    return new AnalysisUnsupportedTargetError(
      operation,
      this.target.sourcePath ?? this.target.path,
      reason,
    );
  }

  private async inspectAssetCatalog(
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ) {
    const bundlePath = this.target.sourcePath;
    if (
      this.target.kind !== "executable" ||
      bundlePath === undefined ||
      !bundlePath.toLowerCase().endsWith(".app")
    )
      throw this.unsupportedTarget(
        "inspect_asset_catalog",
        "inspect_asset_catalog requires an active .app bundle target",
      );
    const result = await analyzeAppleAssetCatalogs({
      environment: this.environment,
      bundlePath,
      targetSha256: this.target.sha256,
      page: parameters,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
    return ok(
      createAnalysisExecution(result, IDENTITY, {
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
    if (this.target.kind !== "executable" || this.target.format !== "mach-o")
      throw this.unsupportedTarget(
        "trace_dylib_resolution",
        "trace_dylib_resolution requires an active Mach-O or .app bundle target",
      );
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
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
    return ok(
      createAnalysisExecution(result, IDENTITY, {
        limitations: result.limitations,
        locations: result.images.map(({ path }) => ({
          kind: "artifact-path" as const,
          path,
        })),
      }),
    );
  }

  private async inspectArtifact(
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ) {
    const parsed = artifactInventoryInputSchema.parse(parameters);
    const inventoryParameters = {
      integrity_policy: parsed.integrity_policy,
    };
    await options?.progress?.report({
      phase: "inspect_artifact.inventory",
      completed: 0,
      total: 1,
      message: "inventory substep started",
    });
    const inventory = await this.inventory(inventoryParameters, options);
    const subject = subjectFor(
      this.target.sourcePath ?? this.target.path,
      inventory.manifest,
    );
    const locations = inventory.occurrences.map(({ logical_path: path }) => ({
      kind: "artifact-path" as const,
      path,
    }));
    const inventoryEvidence = createEvidence(subject, IDENTITY, {
      operation: "inventory_artifact",
      parameters: inventoryParameters,
      result: inventory,
      rawResult: null,
      limitations: inventory.limitations,
      locations,
    });
    const result = createArtifactInspection(inventoryEvidence);
    await options?.progress?.report({
      phase: "inspect_artifact.inventory",
      completed: 1,
      total: 1,
      message: "inventory substep completed",
    });
    return ok(
      createAnalysisExecution(result, IDENTITY, {
        rawResult: null,
        limitations: result.limitations,
        subject,
        locations,
      }),
    );
  }

  private inventory(
    parsed: {
      readonly integrity_policy: "fail" | "record-and-continue";
    },
    options?: ExecutionOptions,
  ) {
    return inventoryArtifact(this.target.sourcePath ?? this.target.path, {
      environment: this.environment,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
      integrity: resolveArtifactIntegrityPolicy({
        mode: parsed.integrity_policy,
      }),
    });
  }
}

const isArtifactOperation = (
  operation: AnalysisOperation,
): operation is ArtifactAnalysisOperation =>
  ARTIFACT_ANALYSIS_OPERATIONS.includes(
    operation as (typeof ARTIFACT_ANALYSIS_OPERATIONS)[number],
  );

/** Translate one artifact boundary failure while retaining cleanup evidence. */
export const translateArtifactFailure = (
  operation: ArtifactAnalysisOperation,
  cause: unknown,
): AnalysisError => {
  if (cause instanceof ArtifactReaderFailure)
    return new ArtifactOperationError(
      operation,
      cause.reason,
      cause.details,
      cause.message,
      {
        ...(cause.cleanup === undefined ? {} : { cleanup: cause.cleanup }),
        ...(cause.partialObservation === undefined
          ? {}
          : { partialObservation: cause.partialObservation }),
      },
    );
  // Caller-selection and unsupported-target failures are already typed; keep
  // their correction details instead of reducing them to an I/O failure.
  if (
    cause instanceof AnalysisInputError ||
    cause instanceof AnalysisUnsupportedTargetError
  )
    return cause;
  return new ArtifactOperationError(operation, "io");
};

const subjectFor = (
  path: string,
  manifest: {
    readonly root_sha256: string;
    readonly root_format: import("../domain/artifactGraph.js").ArtifactInventoryResult["manifest"]["root_format"];
  },
) => ({
  path,
  sha256: manifest.root_sha256,
  format: manifest.root_format,
});
