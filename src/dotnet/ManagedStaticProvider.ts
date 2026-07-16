import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import {
  createAnalysisExecution,
  type AnalysisClient,
  type AnalysisOperation,
  type AnalysisProvider,
  type CapabilityDescriptor,
  type ExecutionOptions,
  type ProviderIdentity,
} from "../application/AnalysisProvider.js";
import { MANAGED_STATIC_PROVIDER } from "../application/InvestigationProviders.js";
import {
  MANAGED_TOOL_CONTRACTS,
  managedArtifactInputSchema,
  type ManagedToolName,
} from "../contracts/managedToolContracts.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  EvidenceIntegrityError,
  ProviderAdapterError,
} from "../domain/errors.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok } from "../domain/result.js";
import { inspectManagedArtifactBytes } from "./ManagedArtifactInspector.js";

const IDENTITY: ProviderIdentity = Object.freeze(MANAGED_STATIC_PROVIDER);

/** Execution-free managed PE/CLI auxiliary provider. */
export class ManagedStaticProvider implements AnalysisProvider {
  readonly #capabilities: readonly CapabilityDescriptor[] = Object.freeze(
    MANAGED_TOOL_CONTRACTS.map((contract) =>
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
          launchesProcess: false,
          mayShowUi: false,
          mayAccessNetwork: false,
          mayWriteFilesystem: false,
          changesPermissions: false,
          requiresRoot: false,
        }),
        limits: Object.freeze({
          maxResults: 500,
          maxPayloadBytes: 4 * 1024 * 1024,
          timeoutMs: null,
        }),
        limitations: Object.freeze([
          "This capability inventories PE/CLI identity only; method signatures and CIL are admitted by a later contract.",
          "It never loads the target assembly, resolves dependencies through a CLR, decompiles C#, or executes target code.",
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
    return new ManagedStaticClient(target);
  }
}

class ManagedStaticClient implements AnalysisClient {
  constructor(private readonly target: BinaryTarget) {}

  async execute(
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ) {
    if (operation === "health")
      return ok(createAnalysisExecution(null, IDENTITY));
    if (!isManagedOperation(operation))
      return err(
        new AnalysisCapabilityUnavailableError(
          IDENTITY.id,
          operation,
          "Operation is not implemented by the managed static provider.",
        ),
      );
    if (this.target.format !== "pe")
      return err(
        new AnalysisCapabilityUnavailableError(
          IDENTITY.id,
          operation,
          `Managed static triage requires a PE target; observed ${this.target.format}.`,
        ),
      );
    try {
      const input = managedArtifactInputSchema.parse(parameters);
      if (options?.signal?.aborted === true)
        return err(new AnalysisCancelledError(operation));
      const metadata = await stat(this.target.path);
      if (metadata.size > input.max_file_bytes)
        return err(
          new AnalysisCapabilityUnavailableError(
            IDENTITY.id,
            operation,
            `Artifact size ${String(metadata.size)} exceeds max_file_bytes ${String(input.max_file_bytes)}.`,
          ),
        );
      const bytes = await readFile(
        this.target.path,
        options?.signal === undefined ? undefined : { signal: options.signal },
      );
      if (bytes.length > input.max_file_bytes)
        return err(
          new AnalysisCapabilityUnavailableError(
            IDENTITY.id,
            operation,
            `Artifact grew beyond max_file_bytes ${String(input.max_file_bytes)} while it was read.`,
          ),
        );
      const observedDigest = createHash("sha256").update(bytes).digest("hex");
      if (observedDigest !== this.target.sha256)
        return err(
          new EvidenceIntegrityError(
            `Managed artifact digest changed after open: expected ${this.target.sha256}, observed ${observedDigest} at ${this.target.path}`,
          ),
        );
      const result = inspectManagedArtifactBytes(bytes, this.target, {
        referenceOffset: input.reference_offset,
        referenceLimit: input.reference_limit,
        resourceOffset: input.resource_offset,
        resourceLimit: input.resource_limit,
        attributeOffset: input.attribute_offset,
        attributeLimit: input.attribute_limit,
        maxMetadataBytes: input.max_metadata_bytes,
        maxTableRows: input.max_table_rows,
        maxHeapItemBytes: input.max_heap_item_bytes,
      });
      return ok(
        createAnalysisExecution(result, IDENTITY, {
          rawResult: null,
          limitations: result.limitations,
          subject: this.target,
          locations:
            result.pe.cli === null
              ? [{ kind: "file-offset" as const, offset: 0 }]
              : [
                  {
                    kind: "file-offset-range" as const,
                    start: result.pe.cli.header_offset,
                    end:
                      result.pe.cli.header_offset + result.pe.cli.header_size,
                  },
                  ...[result.module, result.assembly]
                    .filter((value) => value !== null)
                    .map((value) => ({
                      kind: "file-offset" as const,
                      offset: value.row_offset,
                    })),
                ],
        }),
      );
    } catch (cause: unknown) {
      if (options?.signal?.aborted === true)
        return err(new AnalysisCancelledError(operation));
      return err(new ProviderAdapterError(IDENTITY.id, operation, { cause }));
    }
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

const isManagedOperation = (
  operation: AnalysisOperation,
): operation is ManagedToolName =>
  MANAGED_TOOL_CONTRACTS.some(({ name }) => name === operation);
