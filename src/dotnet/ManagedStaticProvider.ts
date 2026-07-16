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
  managedMemberInputSchema,
  type ManagedToolName,
} from "../contracts/managedToolContracts.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  EvidenceIntegrityError,
  ProviderAdapterError,
} from "../domain/errors.js";
import type { EvidenceLocation } from "../domain/evidence.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type {
  ManagedArtifactInspection,
  ManagedMemberInspection,
} from "../domain/managedArtifact.js";
import { err, ok } from "../domain/result.js";
import { inspectManagedArtifactBytes } from "./ManagedArtifactInspector.js";
import { inspectManagedMembersBytes } from "./ManagedMemberInspector.js";

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
        limitations: limitationsFor(contract.name),
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
      if (options?.signal?.aborted === true)
        return err(new AnalysisCancelledError(operation));
      const maxFileBytes = maxRequestedFileBytes(operation, parameters);
      const metadata = await stat(this.target.path);
      if (metadata.size > maxFileBytes)
        return err(
          new AnalysisCapabilityUnavailableError(
            IDENTITY.id,
            operation,
            `Artifact size ${String(metadata.size)} exceeds max_file_bytes ${String(maxFileBytes)}.`,
          ),
        );
      const bytes = await readFile(
        this.target.path,
        options?.signal === undefined ? undefined : { signal: options.signal },
      );
      if (bytes.length > maxFileBytes)
        return err(
          new AnalysisCapabilityUnavailableError(
            IDENTITY.id,
            operation,
            `Artifact grew beyond max_file_bytes ${String(maxFileBytes)} while it was read.`,
          ),
        );
      const observedDigest = createHash("sha256").update(bytes).digest("hex");
      if (observedDigest !== this.target.sha256)
        return err(
          new EvidenceIntegrityError(
            `Managed artifact digest changed after open: expected ${this.target.sha256}, observed ${observedDigest} at ${this.target.path}`,
          ),
        );
      const result = inspectManagedOperation(
        operation,
        parameters,
        bytes,
        this.target,
      );
      return ok(
        createAnalysisExecution(result, IDENTITY, {
          rawResult: null,
          limitations: result.limitations,
          subject: this.target,
          locations: managedLocations(result),
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

const limitationsFor = (operation: ManagedToolName): readonly string[] =>
  Object.freeze(
    operation === "inspect_managed_artifact"
      ? [
          "This capability inventories PE/CLI identity only; inspect_managed_members admits bounded metadata members, signatures, and CIL anchors.",
          "It never loads the target assembly, resolves dependencies through a CLR, decompiles C#, or executes target code.",
        ]
      : [
          "This capability decodes bounded PE/CLI metadata members, signatures, and file-backed method bodies; decompiled C# and cross-build matching are separate future contracts.",
          "It never loads the target assembly, resolves dependencies through a CLR, decompiles C#, or executes target code.",
        ],
  );

const maxRequestedFileBytes = (
  operation: ManagedToolName,
  parameters: Readonly<Record<string, JsonValue>>,
): number => {
  if (operation === "inspect_managed_artifact")
    return managedArtifactInputSchema.parse(parameters).max_file_bytes;
  return managedMemberInputSchema.parse(parameters).max_file_bytes;
};

const inspectManagedOperation = (
  operation: ManagedToolName,
  parameters: Readonly<Record<string, JsonValue>>,
  bytes: Buffer,
  target: BinaryTarget,
): ManagedArtifactInspection | ManagedMemberInspection => {
  if (operation === "inspect_managed_artifact") {
    const input = managedArtifactInputSchema.parse(parameters);
    return inspectManagedArtifactBytes(bytes, target, {
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
  }
  const input = managedMemberInputSchema.parse(parameters);
  return inspectManagedMembersBytes(bytes, target, {
    typeOffset: input.type_offset,
    typeLimit: input.type_limit,
    methodOffset: input.method_offset,
    methodLimit: input.method_limit,
    fieldOffset: input.field_offset,
    fieldLimit: input.field_limit,
    memberRefOffset: input.member_ref_offset,
    memberRefLimit: input.member_ref_limit,
    edgeOffset: input.edge_offset,
    edgeLimit: input.edge_limit,
    instructionAnchorLimit: input.instruction_anchor_limit,
    maxMetadataBytes: input.max_metadata_bytes,
    maxTableRows: input.max_table_rows,
    maxHeapItemBytes: input.max_heap_item_bytes,
    maxMethodBodyBytes: input.max_method_body_bytes,
    maxMethodInstructions: input.max_method_instructions,
  });
};

const managedLocations = (
  result: ManagedArtifactInspection | ManagedMemberInspection,
): readonly EvidenceLocation[] => {
  if ("pe" in result) {
    if (result.pe.cli === null) return [{ kind: "file-offset", offset: 0 }];
    return [
      {
        kind: "file-offset-range",
        start: result.pe.cli.header_offset,
        end: result.pe.cli.header_offset + result.pe.cli.header_size,
      },
      ...[result.module, result.assembly]
        .filter((value) => value !== null)
        .map((value) => ({
          kind: "file-offset" as const,
          offset: value.row_offset,
        })),
    ];
  }
  return [
    ...(result.module === null
      ? [{ kind: "file-offset" as const, offset: 0 }]
      : [{ kind: "file-offset" as const, offset: result.module.row_offset }]),
    ...result.methods.items
      .filter((method) => method.body.file_offset !== null)
      .slice(0, 8)
      .map((method) => ({
        kind: "file-offset" as const,
        offset: method.body.file_offset ?? 0,
      })),
  ];
};
