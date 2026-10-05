import type { BinaryTarget } from "../domain/binaryTarget.js";
import type { OfficialToolName } from "../contracts/officialToolContracts.js";
import type { EnhancedToolName } from "../contracts/enhancedInputs.js";
import type { NativeToolName } from "../contracts/nativeToolContracts.js";
import type { ArtifactAnalysisOperation } from "../contracts/artifactToolContracts.js";
import type { ManagedToolName } from "../contracts/managedToolContracts.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { Result } from "../domain/result.js";
import type { EvidenceLocation } from "../domain/evidence.js";
import type { EvidenceSubjectTarget } from "../domain/evidence.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import type { ProgressReporter } from "./ProgressReporter.js";
import type { ProviderRejectionCode } from "../contracts/providerSelection.js";
import type { ProcessLineageObservation } from "../process/ProcessOwnership.js";

export interface ExecutionOptions {
  readonly signal?: AbortSignal;
  readonly progress?: ProgressReporter;
}

/** Closed operations accepted by provider-backed analysis sessions. */
export type AnalysisOperation =
  | OfficialToolName
  | EnhancedToolName
  | NativeToolName
  | ArtifactAnalysisOperation
  | ManagedToolName
  | "health";

/** Atomic successful provider observation with exact producing provenance. */
export interface AnalysisExecution {
  readonly result: JsonValue;
  readonly rawResult: JsonValue | null;
  readonly provider: ProviderIdentity;
  readonly analysisProfile?: AnalysisProfileCommitment;
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
    readonly analysisProfile?: AnalysisProfileCommitment;
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
  ...(options.analysisProfile === undefined
    ? {}
    : { analysisProfile: structuredClone(options.analysisProfile) }),
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

/** Retained provider-process observation attributed to its producing provider. */
export interface ProviderRuntimeLineageSnapshot {
  readonly provider: ProviderIdentity;
  readonly observation: ProcessLineageObservation;
}

/** One provider's current serial-request activity, including detached callers. */
export interface ProviderRequestActivitySnapshot {
  readonly provider: ProviderIdentity;
  readonly active: {
    readonly requestId: number;
    readonly operation: string;
    readonly elapsedMs: number;
    readonly callerState: "waiting" | "cancelled";
  } | null;
  readonly queuedRequests: number;
}

/** Provider session bound to exactly one parsed artifact. */
export interface AnalysisClient extends AnalysisOperationPort {
  /** Retained token-verified process snapshots for dynamic providers this client started. */
  runtimeLineageSnapshots?(): readonly ProviderRuntimeLineageSnapshot[];
  /** Current provider work that may outlive a timed-out or cancelled caller. */
  requestActivitySnapshots?(): readonly ProviderRequestActivitySnapshot[];
  /** Close with a typed result when the provider can verify cleanup. */
  closeWithOutcome?(
    options?: Pick<ExecutionOptions, "progress"> & {
      readonly retainDocument?: boolean;
    },
  ): Promise<Result<null, AnalysisError>>;
  close(): Promise<void>;
}

/** Per-client identity allocated before any provider side effect starts. */
export interface AnalysisClientContext {
  readonly runId: string;
}

export type AnalysisClientFactory = (
  target: BinaryTarget,
  profile?: AnalysisProfileCommitment,
  context?: AnalysisClientContext,
) => AnalysisClient;

export interface ProviderIdentity {
  readonly id: string;
  readonly name: string;
  readonly version: string | null;
}

/** Profile plus opaque compatibility output resolved before provider startup. */
export interface AnalysisProfileResolution {
  readonly profile: AnalysisProfileCommitment | null;
  readonly compatibility: Readonly<Record<string, JsonValue>>;
}

/** Cancellation context for side-effect-free provider profile resolution. */
export interface AnalysisProfileResolutionOptions {
  readonly signal?: AbortSignal;
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
  | {
      readonly available: true;
      readonly reason: null;
      readonly availabilityCode?: null;
    }
  | {
      readonly available: false;
      readonly reason: string;
      readonly availabilityCode?: ProviderRejectionCode;
    };

export type CapabilityDescriptor = CapabilityAvailability & {
  readonly provider: ProviderIdentity;
  readonly operation: Exclude<AnalysisOperation, "health">;
  readonly effects: CapabilityEffects;
  readonly limitations: readonly string[];
};

/** Factory and capability declaration for an analysis implementation. */
export interface AnalysisProvider {
  identity(): ProviderIdentity;
  capabilities(): readonly CapabilityDescriptor[];
  resolveAnalysisProfile?(
    target: BinaryTarget,
    options?: AnalysisProfileResolutionOptions,
  ): Promise<Result<AnalysisProfileResolution, AnalysisError>>;
  createClient(
    target: BinaryTarget,
    profile?: AnalysisProfileCommitment,
    context?: AnalysisClientContext,
  ): AnalysisClient;
}

/** Bounded host observation made without starting an analysis process. */
export type ProviderAvailability =
  | {
      readonly status: "available";
      readonly code: null;
      readonly reason: null;
      readonly diagnostics: Readonly<Record<string, JsonValue>>;
    }
  | {
      readonly status: "unavailable";
      readonly code: ProviderRejectionCode;
      readonly reason: string;
      readonly diagnostics: Readonly<Record<string, JsonValue>>;
    };

/** Provider-owned target support observation before profile resolution. */
export type ProviderTargetSupport =
  | {
      readonly status: "supported";
      readonly code: null;
      readonly reason: null;
      readonly diagnostics: Readonly<Record<string, JsonValue>>;
    }
  | {
      readonly status: "unsupported";
      readonly code:
        | "target_kind_unsupported"
        | "target_format_unsupported"
        | "architecture_unsupported"
        | "target_role_unsupported"
        | "managed_target_unsupported";
      readonly reason: string;
      readonly diagnostics: Readonly<Record<string, JsonValue>>;
    };

/** Deep provider candidate discoverable before one target-bound route is chosen. */
export interface AnalysisProviderCandidate extends AnalysisProvider {
  resolveAnalysisProfile(
    target: BinaryTarget,
    options?: AnalysisProfileResolutionOptions,
  ): Promise<Result<AnalysisProfileResolution, AnalysisError>>;
  inspectAvailability(): ProviderAvailability;
  inspectTargetSupport(target: BinaryTarget): ProviderTargetSupport;
}
