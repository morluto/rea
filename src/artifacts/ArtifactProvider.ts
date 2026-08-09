import {
  createAnalysisExecution,
  type AnalysisClient,
  type AnalysisOperation,
  type AnalysisProvider,
  type CapabilityDescriptor,
  type ProviderIdentity,
  type ExecutionOptions,
} from "../application/AnalysisProvider.js";
import { inventoryArtifact } from "../application/ArtifactInventory.js";
import { extractArtifact } from "../application/ArtifactExtraction.js";
import {
  ARTIFACT_TOOL_CONTRACTS,
  artifactInspectionInputSchema,
  artifactInventoryInputSchema,
  artifactExtractionInputSchema,
  type ArtifactToolName,
} from "../contracts/artifactToolContracts.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import {
  AnalysisCapabilityUnavailableError,
  ArtifactOperationError,
  type AnalysisError,
} from "../domain/errors.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok } from "../domain/result.js";
import {
  ArtifactReaderFailure,
  type ArtifactLimits,
} from "./ArtifactReader.js";
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
    ARTIFACT_TOOL_CONTRACTS.map((contract) =>
      Object.freeze({
        provider: IDENTITY,
        operation: contract.name,
        inputContractVersion: 1,
        outputContractVersion: 1,
        available: true as const,
        reason: null,
        pagination:
          contract.name === "inspect_artifact"
            ? ("none" as const)
            : ("offset" as const),
        exhaustive: false,
        effects: Object.freeze({
          mutatesArtifact: false,
          launchesProcess: true,
          mayShowUi: false,
          mayAccessNetwork: false,
          mayWriteFilesystem: contract.name === "extract_artifact",
          changesPermissions: false,
          requiresRoot: false,
        }),
        limits: Object.freeze({
          maxResults: 500,
          maxPayloadBytes: 4 * 1024 * 1024,
          timeoutMs: 120_000,
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
      if (operation === "extract_artifact") {
        const parsed = artifactExtractionInputSchema.parse(parameters);
        const result = await extractArtifact(
          {
            inputPath: this.target.sourcePath ?? this.target.path,
            inputFormat: this.target.format,
            outputRoot: parsed.output_root,
            occurrenceIds: parsed.occurrence_ids,
            offset: parsed.offset,
            limit: parsed.limit,
            limits: limitsFrom(parsed),
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
            locations: result.artifacts.items.map(
              ({ relative_path: path }) => ({
                kind: "artifact-path" as const,
                path,
              }),
            ),
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
          locations: result.occurrences.items.map(({ logical_path: path }) => ({
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
    const parsed = artifactInspectionInputSchema.parse(parameters);
    const inventoryParameters = artifactInventoryInputSchema.parse({
      node_offset: 0,
      node_limit: parsed.max_observations,
      occurrence_offset: 0,
      occurrence_limit: parsed.max_observations,
      edge_offset: 0,
      edge_limit: parsed.max_relationships,
      native_mount_approved: parsed.native_mount_approved,
      integrity_policy: parsed.integrity_policy,
      integrity_continue_approved: parsed.integrity_continue_approved,
      max_integrity_mismatches: parsed.max_integrity_mismatches,
      max_entries: parsed.max_entries,
      max_total_bytes: parsed.max_total_bytes,
      max_entry_bytes: parsed.max_entry_bytes,
      max_compression_ratio: parsed.max_compression_ratio,
      max_depth: parsed.max_depth,
      max_path_bytes: parsed.max_path_bytes,
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
    const locations = inventory.occurrences.items.map(
      ({ logical_path: path }) => ({
        kind: "artifact-path" as const,
        path,
      }),
    );
    const inventoryEvidence = createEvidence(subject, IDENTITY, {
      operation: "inventory_artifact",
      parameters: inventoryParameters,
      result: inventory,
      rawResult: null,
      limitations: inventory.limitations,
      locations,
    });
    const result = createArtifactInspection(inventoryEvidence, parsed);
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
      readonly node_offset: number;
      readonly node_limit: number;
      readonly occurrence_offset: number;
      readonly occurrence_limit: number;
      readonly edge_offset: number;
      readonly edge_limit: number;
      readonly native_mount_approved: boolean;
      readonly integrity_policy: "fail" | "record-and-continue";
      readonly integrity_continue_approved: boolean;
      readonly max_integrity_mismatches: number;
      readonly max_entries: number;
      readonly max_total_bytes: number;
      readonly max_entry_bytes: number;
      readonly max_compression_ratio: number;
      readonly max_depth: number;
      readonly max_path_bytes: number;
    },
    options?: ExecutionOptions,
  ) {
    return inventoryArtifact(
      this.target.sourcePath ?? this.target.path,
      limitsFrom(parsed),
      {
        nodeOffset: parsed.node_offset,
        nodeLimit: parsed.node_limit,
        occurrenceOffset: parsed.occurrence_offset,
        occurrenceLimit: parsed.occurrence_limit,
        edgeOffset: parsed.edge_offset,
        edgeLimit: parsed.edge_limit,
      },
      {
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
                maxMismatches: parsed.max_integrity_mismatches,
              },
          this.integrityContinueEnabled,
        ),
      },
    );
  }
}

const limitsFrom = (input: {
  readonly max_entries: number;
  readonly max_total_bytes: number;
  readonly max_entry_bytes: number;
  readonly max_compression_ratio: number;
  readonly max_depth: number;
  readonly max_path_bytes: number;
}): ArtifactLimits => ({
  maxEntries: input.max_entries,
  maxTotalBytes: input.max_total_bytes,
  maxEntryBytes: input.max_entry_bytes,
  maxCompressionRatio: input.max_compression_ratio,
  maxDepth: input.max_depth,
  maxPathBytes: input.max_path_bytes,
});

const isArtifactOperation = (
  operation: AnalysisOperation,
): operation is ArtifactToolName =>
  ARTIFACT_TOOL_CONTRACTS.some(({ name }) => name === operation);

const translateFailure = (
  operation: ArtifactToolName,
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
