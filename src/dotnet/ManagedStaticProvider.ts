import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";

import {
  createAnalysisExecution,
  type AnalysisClient,
  type AnalysisOperation,
  type AnalysisProvider,
  type CapabilityDescriptor,
  type ExecutionOptions,
  type ProviderIdentity,
} from "../application/AnalysisProvider.js";
import { managedStaticCapabilities } from "./ManagedStaticProviderMetadata.js";
import { MANAGED_STATIC_PROVIDER } from "../application/InvestigationProviders.js";
import {
  MANAGED_TOOL_CONTRACTS,
  managedTargetInputSchema,
  type ManagedToolName,
} from "../contracts/managed/managedToolContracts.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
} from "../domain/analysisErrorCore.js";
import { EvidenceIntegrityError } from "../domain/evidenceErrors.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import type { EvidenceLocation } from "../domain/evidence.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type {
  ManagedArtifactInspection,
  ManagedMemberInspection,
  ManagedNativeBoundaryInspection,
} from "../domain/managed/managedArtifact.js";
import { err, ok, type Result } from "../domain/result.js";
import { inspectManagedArtifactBytes } from "./ManagedArtifactInspector.js";
import { inspectManagedMembersBytes } from "./ManagedMemberInspector.js";
import { inspectManagedNativeBoundariesBytes } from "./ManagedNativeBoundaryInspector.js";

/** Execution-free managed PE/CLI auxiliary provider. */
export class ManagedStaticProvider implements AnalysisProvider {
  readonly #capabilities: readonly CapabilityDescriptor[] =
    managedStaticCapabilities();

  identity(): ProviderIdentity {
    return MANAGED_STATIC_PROVIDER;
  }

  capabilities(): readonly CapabilityDescriptor[] {
    return this.#capabilities;
  }

  createClient(target: BinaryTarget): AnalysisClient {
    return new ManagedStaticClient(target);
  }
}

class ManagedStaticClient implements AnalysisClient {
  #snapshotBytes: Buffer | undefined;

  constructor(private readonly target: BinaryTarget) {}

  async execute(
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ) {
    if (operation === "health")
      return ok(createAnalysisExecution(null, MANAGED_STATIC_PROVIDER));
    if (!isManagedOperation(operation))
      return err(
        new AnalysisCapabilityUnavailableError(
          MANAGED_STATIC_PROVIDER.id,
          operation,
          "Operation is not implemented by the managed static provider.",
        ),
      );
    if (this.target.format !== "pe")
      return err(
        new AnalysisCapabilityUnavailableError(
          MANAGED_STATIC_PROVIDER.id,
          operation,
          `Managed static triage requires a PE target; observed ${this.target.format}.`,
        ),
      );
    try {
      if (options?.signal?.aborted === true)
        return err(new AnalysisCancelledError(operation));
      const snapshot = this.#snapshotBytes;
      const observed =
        snapshot === undefined
          ? await readManagedSnapshot(this.target.path, options?.signal)
          : await hashManagedSource(this.target.path, options?.signal);
      if (observed.sha256 !== this.target.sha256)
        return err(
          new EvidenceIntegrityError(
            `Managed artifact digest changed after open: expected ${this.target.sha256}, observed ${observed.sha256} at ${this.target.path}`,
          ),
        );
      const bytes = snapshot ?? observed.bytes;
      if (bytes === undefined)
        throw new TypeError("Managed snapshot bytes are unavailable");
      this.#snapshotBytes = bytes;
      const result = inspectManagedOperation(
        operation,
        parameters,
        bytes,
        this.target,
      );
      return ok(
        createAnalysisExecution(result, MANAGED_STATIC_PROVIDER, {
          rawResult: null,
          limitations: result.limitations,
          subject: this.target,
          locations: managedLocations(result),
        }),
      );
    } catch (cause: unknown) {
      if (options?.signal?.aborted === true)
        return err(new AnalysisCancelledError(operation));
      return err(
        new ProviderAdapterError(MANAGED_STATIC_PROVIDER.id, operation, {
          cause,
        }),
      );
    }
  }

  close(): Promise<Result<null, AnalysisError>> {
    this.#snapshotBytes = undefined;
    return Promise.resolve(ok(null));
  }
}

interface ManagedSourceObservation {
  readonly byteLength: number;
  readonly sha256: string;
  readonly bytes?: Buffer;
}

const readManagedSnapshot = async (
  path: string,
  signal?: AbortSignal,
): Promise<ManagedSourceObservation> => {
  const bytes = await readFile(
    path,
    signal === undefined ? undefined : { signal },
  );
  return {
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes,
  };
};

const hashManagedSource = async (
  path: string,
  signal?: AbortSignal,
): Promise<ManagedSourceObservation> => {
  const digest = createHash("sha256");
  let byteLength = 0;
  const stream = createReadStream(
    path,
    signal === undefined ? undefined : { signal },
  );
  for await (const chunk of stream) {
    if (!Buffer.isBuffer(chunk))
      throw new TypeError("Managed source stream returned non-buffer data");
    if (chunk.length > Number.MAX_SAFE_INTEGER - byteLength)
      throw new RangeError("Managed source byte length overflowed");
    byteLength += chunk.length;
    digest.update(chunk);
  }
  return { byteLength, sha256: digest.digest("hex") };
};

const isManagedOperation = (
  operation: AnalysisOperation,
): operation is ManagedToolName =>
  MANAGED_TOOL_CONTRACTS.some(({ name }) => name === operation);

const inspectManagedOperation = (
  operation: ManagedToolName,
  parameters: Readonly<Record<string, JsonValue>>,
  bytes: Buffer,
  target: BinaryTarget,
):
  | ManagedArtifactInspection
  | ManagedMemberInspection
  | ManagedNativeBoundaryInspection => {
  managedTargetInputSchema.parse(parameters);
  if (operation === "inspect_managed_artifact") {
    return inspectManagedArtifactBytes(bytes, target);
  }
  if (operation === "inspect_managed_native_boundaries") {
    return inspectManagedNativeBoundariesBytes(bytes, target);
  }
  return inspectManagedMembersBytes(bytes, target);
};

const managedLocations = (
  result:
    | ManagedArtifactInspection
    | ManagedMemberInspection
    | ManagedNativeBoundaryInspection,
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
  if ("methods" in result)
    return [
      ...(result.module === null
        ? [{ kind: "file-offset" as const, offset: 0 }]
        : [{ kind: "file-offset" as const, offset: result.module.row_offset }]),
      ...result.methods
        .filter((method) => method.body.file_offset !== null)
        .map((method) => ({
          kind: "file-offset" as const,
          offset: method.body.file_offset ?? 0,
        })),
    ];
  return [
    ...(result.module === null
      ? [{ kind: "file-offset" as const, offset: 0 }]
      : [{ kind: "file-offset" as const, offset: result.module.row_offset }]),
    ...result.pinvoke_imports.map((mapping) => ({
      kind: "file-offset" as const,
      offset: mapping.row_offset,
    })),
  ];
};
