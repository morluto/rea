import {
  createAnalysisExecution,
  type AnalysisClient,
  type AnalysisOperation,
  type AnalysisProvider,
  type CapabilityDescriptor,
  type ProviderIdentity,
  type ExecutionOptions,
} from "../application/AnalysisProvider.js";
import { inventoryArtifactFully } from "../application/ArtifactInventory.js";
import { extractArtifact } from "../application/ArtifactExtraction.js";
import { analyzeInterfaceBuilderBundle } from "../application/InterfaceBuilderAnalysis.js";
import {
  ARTIFACT_ANALYSIS_OPERATIONS,
  artifactInventoryInputSchema,
  artifactExtractionExecutionSchema,
  type ArtifactAnalysisOperation,
} from "../contracts/artifactToolContracts.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import {
  AnalysisCapabilityUnavailableError,
  ArtifactOperationError,
  type AnalysisError,
} from "../domain/errors.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { interfaceBuilderLimitsSchema } from "../domain/interfaceBuilderGraph.js";
import { err, ok } from "../domain/result.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import { ARTIFACT_GRAPH_PROVIDER } from "../application/InvestigationProviders.js";
import { createEvidence } from "../domain/evidence.js";
import { createArtifactInspection } from "../domain/artifactInspection.js";
import {
  resolveArtifactIntegrityPolicy,
  resolveNativeMountPolicy,
} from "../application/ArtifactInventory/policy.js";

const IDENTITY: ProviderIdentity = Object.freeze(ARTIFACT_GRAPH_PROVIDER);

/** Read-only inventory and exclusively owned extraction provider. */
export class ArtifactProvider implements AnalysisProvider {
  constructor(
    private readonly nativeMountEnabled = false,
    private readonly integrityContinueEnabled = false,
  ) {}

  readonly #capabilities: readonly CapabilityDescriptor[] = Object.freeze(
    ARTIFACT_ANALYSIS_OPERATIONS.map((operation) =>
      Object.freeze({
        provider: IDENTITY,
        operation,
        available: true as const,
        reason: null,
        effects: Object.freeze({
          mutatesArtifact: false,
          launchesProcess: operation !== "decode_interface_builder",
          mayShowUi: false,
          mayAccessNetwork: false,
          mayWriteFilesystem: operation === "extract_artifact",
          changesPermissions: false,
          requiresRoot: false,
        }),
        limitations: Object.freeze([
          "DMG child inventory is macOS-only and requires per-call approval plus operator policy; PKG remains root-hash-only.",
          "ASAR files discovered in filesystem-backed inventories are expanded without bulk extraction; other nested containers remain recorded only.",
        ]),
      }),
    ),
  );

  identity(): ProviderIdentity {
    return IDENTITY;
  }

  capabilities(): readonly CapabilityDescriptor[] {
    return this.#capabilities;
  }

  createClient(target: BinaryTarget): AnalysisClient {
    return new ArtifactClient(
      target,
      this.nativeMountEnabled,
      this.integrityContinueEnabled,
    );
  }
}

class ArtifactClient implements AnalysisClient {
  constructor(
    private readonly target: BinaryTarget,
    private readonly nativeMountEnabled: boolean,
    private readonly integrityContinueEnabled: boolean,
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
          throw new ArtifactReaderFailure(
            "unavailable",
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
      if (operation === "extract_artifact") {
        const parsed = artifactExtractionExecutionSchema.parse(parameters);
        const result = await extractArtifact(
          {
            inputPath: this.target.sourcePath ?? this.target.path,
            inputFormat: this.target.format,
            outputRoot: parsed.output_root,
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
      return err(translateFailure(operation, cause));
    }
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  private async inspectArtifact(
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ) {
    const parsed = artifactInventoryInputSchema.parse(parameters);
    const inventoryParameters = artifactInventoryInputSchema.parse({
      native_mount_approved: parsed.native_mount_approved,
      integrity_policy: parsed.integrity_policy,
      integrity_continue_approved: parsed.integrity_continue_approved,
    });
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
      readonly native_mount_approved: boolean;
      readonly integrity_policy: "fail" | "record-and-continue";
      readonly integrity_continue_approved: boolean;
    },
    options?: ExecutionOptions,
  ) {
    return inventoryArtifactFully(this.target.sourcePath ?? this.target.path, {
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
      nativeMount: resolveNativeMountPolicy(
        parsed.native_mount_approved === true,
        this.nativeMountEnabled,
      ),
      integrity: resolveArtifactIntegrityPolicy(
        parsed.integrity_policy === "fail"
          ? { mode: "fail" }
          : {
              mode: parsed.integrity_policy,
            },
        this.integrityContinueEnabled,
      ),
    });
  }
}

const isArtifactOperation = (
  operation: AnalysisOperation,
): operation is ArtifactAnalysisOperation =>
  ARTIFACT_ANALYSIS_OPERATIONS.includes(
    operation as (typeof ARTIFACT_ANALYSIS_OPERATIONS)[number],
  );

const translateFailure = (
  operation: ArtifactAnalysisOperation,
  cause: unknown,
): AnalysisError => {
  if (cause instanceof ArtifactReaderFailure)
    return new ArtifactOperationError(operation, cause.reason, cause.details);
  return new ArtifactOperationError(operation, "io");
};

const subjectFor = (
  path: string,
  manifest: {
    readonly root_sha256: string;
    readonly root_format: import("../domain/artifactGraph.js").ArtifactNode["format"];
  },
) => ({
  path,
  sha256: manifest.root_sha256,
  format: manifest.root_format,
});
