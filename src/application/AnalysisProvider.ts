import type { BinaryTarget } from "../domain/binaryTarget.js";
import type { OfficialToolName } from "../contracts/toolContracts.js";
import type { EnhancedToolName } from "../contracts/enhancedInputs.js";
import type { NativeToolName } from "../contracts/nativeToolContracts.js";
import type { ArtifactToolName } from "../contracts/artifactToolContracts.js";
import type { AnalysisError } from "../domain/errors.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { Result } from "../domain/result.js";
import type { EvidenceLocation } from "../domain/evidence.js";
import type { EvidenceSubjectTarget } from "../domain/evidence.js";
import { jsonValueSchema } from "../domain/jsonValue.js";

interface ExecutionOptions {
  readonly signal?: AbortSignal;
}

/** Closed operations accepted by provider-backed analysis sessions. */
export type AnalysisOperation =
  | OfficialToolName
  | EnhancedToolName
  | NativeToolName
  | ArtifactToolName
  | "health";

/** Atomic successful provider observation with exact producing provenance. */
export interface AnalysisExecution {
  readonly result: JsonValue;
  readonly rawResult: JsonValue | null;
  readonly provider: ProviderIdentity;
  readonly limitations: readonly string[];
  readonly locations: readonly EvidenceLocation[];
  readonly subject: EvidenceSubjectTarget | null;
}

/** Build a validated atomic provider observation at an adapter boundary. */
export const createAnalysisExecution = (
  result: unknown,
  provider: ProviderIdentity,
  options: {
    readonly rawResult?: unknown;
    readonly limitations?: readonly string[];
    readonly locations?: readonly EvidenceLocation[];
    readonly subject?: EvidenceSubjectTarget;
  } = {},
): AnalysisExecution => ({
  result: jsonValueSchema.parse(result),
  rawResult:
    options.rawResult === undefined
      ? jsonValueSchema.parse(result)
      : jsonValueSchema.parse(options.rawResult),
  provider,
  limitations: [...(options.limitations ?? [])],
  locations: [...(options.locations ?? [])],
  subject: options.subject ?? null,
});

/** Provider-neutral application capability for one analysis operation. */
export interface AnalysisOperationPort {
  execute(
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>>;
}

/** Provider session bound to exactly one parsed artifact. */
export interface AnalysisClient extends AnalysisOperationPort {
  close(): Promise<void>;
}

export type AnalysisClientFactory = (target: BinaryTarget) => AnalysisClient;

export interface ProviderIdentity {
  readonly id: string;
  readonly name: string;
  readonly version: string | null;
}

interface CapabilityEffects {
  readonly mutatesArtifact: boolean;
  readonly launchesProcess: boolean;
  readonly mayShowUi: boolean;
  readonly mayAccessNetwork: boolean;
  readonly mayWriteFilesystem: boolean;
  readonly changesPermissions: boolean;
  readonly requiresRoot: boolean;
}

type CapabilityAvailability =
  | { readonly available: true; readonly reason: null }
  | { readonly available: false; readonly reason: string };

interface CapabilityLimits {
  readonly maxResults: number | null;
  readonly maxPayloadBytes: number | null;
  readonly timeoutMs: number | null;
}

export type CapabilityDescriptor = CapabilityAvailability & {
  readonly provider: ProviderIdentity;
  readonly operation: Exclude<AnalysisOperation, "health">;
  readonly inputContractVersion: number;
  readonly outputContractVersion: number;
  readonly pagination: "none" | "offset" | "cursor";
  readonly exhaustive: boolean;
  readonly effects: CapabilityEffects;
  readonly limits: CapabilityLimits;
  readonly limitations: readonly string[];
};

/** Factory and capability declaration for an analysis implementation. */
export interface AnalysisProvider {
  identity(): ProviderIdentity;
  capabilities(): readonly CapabilityDescriptor[];
  createClient(target: BinaryTarget): AnalysisClient;
}
