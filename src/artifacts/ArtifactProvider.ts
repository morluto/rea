import {
  createAnalysisExecution,
  type AnalysisClient,
  type AnalysisOperation,
  type AnalysisProvider,
  type CapabilityDescriptor,
  type ProviderIdentity,
} from "../application/AnalysisProvider.js";
import { inventoryArtifact } from "../application/ArtifactInventory.js";
import { extractArtifact } from "../application/ArtifactExtraction.js";
import {
  ARTIFACT_TOOL_CONTRACTS,
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

const IDENTITY: ProviderIdentity = Object.freeze(ARTIFACT_GRAPH_PROVIDER);

/** Read-only inventory and exclusively owned extraction provider. */
export class ArtifactProvider implements AnalysisProvider {
  readonly #capabilities: readonly CapabilityDescriptor[] = Object.freeze(
    ARTIFACT_TOOL_CONTRACTS.map((contract) =>
      Object.freeze({
        provider: IDENTITY,
        operation: contract.name,
        inputContractVersion: 1,
        outputContractVersion: 1,
        available: true as const,
        reason: null,
        pagination: "offset" as const,
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
          "DMG and PKG child inventory requires a future native read-only adapter.",
          "Nested containers are recorded but not recursively expanded implicitly.",
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
    return new ArtifactClient(target);
  }
}

class ArtifactClient implements AnalysisClient {
  constructor(private readonly target: BinaryTarget) {}

  async execute(
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options?: { readonly signal?: AbortSignal },
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
      const result = await inventoryArtifact(
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
