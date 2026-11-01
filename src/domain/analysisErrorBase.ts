import type { SavedAnalysisSnapshotPartialObservation } from "./savedAnalysisSnapshot.js";
import type { AnalysisSettingLimit } from "./analysisSettings.js";
import type { JsonValue } from "./jsonValue.js";
import type { AnalysisCleanupRetry } from "./analysisErrorRecovery.js";

/** Stable tags exposed by safe analysis-error projections. */
const ANALYSIS_ERROR_TAGS = [
  "AnalysisProtocolError",
  "AnalysisInputError",
  "AnalysisAccessDeniedError",
  "AnalysisArtifactChangedError",
  "AnalysisOutputError",
  "AnalysisCapabilityUnavailableError",
  "AnalysisUnsupportedTargetError",
  "AnalysisCancelledError",
  "AnalysisTimeoutError",
  "AnalysisResourceConstraintError",
  "ProviderSelectionError",
  "ProviderAdapterError",
  "BrowserObservationError",
  "ArtifactOperationError",
  "ProcessCaptureError",
  "EvidenceIntegrityError",
  "EvidenceFileError",
  "UnknownRegistryError",
  "HopperTimeoutError",
  "HopperCancelledError",
  "HopperProtocolError",
  "HopperRemoteError",
  "HopperProcessError",
  "HopperStartError",
  "ConfigurationError",
  "NoBinaryOpenError",
  "BinaryTargetError",
] as const;

/** Stable tag for an expected analysis failure. */
export type AnalysisErrorTag = (typeof ANALYSIS_ERROR_TAGS)[number];

/** Retained command output associated with a typed failure; truncation stays explicit. */
export interface AnalysisCapturedOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly stdout_bytes?: number;
  readonly stderr_bytes?: number;
  readonly exit_code?: number | null;
  readonly signal?: string | null;
}

/** Cleanup uncertainty attached to the original typed analysis failure. */
export interface AnalysisCleanupObservation {
  readonly reason: string;
  readonly resources: readonly string[];
}

/**
 * How long the adapter delivering a failure keeps REA's runtime and provider
 * session for its caller. An MCP connection continues: later calls reuse the
 * session and can update runtime settings. A one-shot invocation, such as a
 * CLI command, releases its provider session and exits before its caller can
 * act; only a new invocation's launch settings or arguments apply.
 */
export type AnalysisCallerLifetime = "continuing" | "invocation";

/**
 * Producer guidance that holds only for a continuing caller, kept apart from
 * the request's outcome. The error's own message and remediation must remain
 * true after an invocation has released the provider session.
 */
export interface AnalysisContinuingCallerGuidance {
  /** Appended to the outcome, such as that the provider session remains usable. */
  readonly userMessage?: string;
  /** Replaces the remediation, such as a same-session runtime setting update. */
  readonly remediationAction?: string;
}

/** Optional provider-neutral context that must survive typed error projection. */
export interface AnalysisErrorOptions extends ErrorOptions {
  /** Typed primary retained when a later lifecycle failure composes this error. */
  readonly cleanupPrimary?: AnalysisError | undefined;
  /** Producer-owned, caller-safe facts retained through every typed projection. */
  readonly diagnostics?: Readonly<Record<string, JsonValue>> | undefined;
  readonly limit?: AnalysisSettingLimit | undefined;
  readonly continuingCallerGuidance?:
    | AnalysisContinuingCallerGuidance
    | undefined;
  /**
   * The same diagnostics recorded for an invocation caller, present only when
   * an embedded child failure projects differently for that lifetime.
   */
  readonly invocationDiagnostics?:
    | Readonly<Record<string, JsonValue>>
    | undefined;
  readonly capturedOutput?: AnalysisCapturedOutput | undefined;
  readonly cleanup?: AnalysisCleanupObservation | undefined;
  readonly partialObservation?: AnalysisPartialObservation | undefined;
}

/** Exact cleanup owner that can attribute its currently unresolved resources. */
export interface AnalysisCleanupResourceOwner {
  readonly cleanupResources: readonly string[] | undefined;
}

/** Base class for expected analysis, provider, and session failures. */
export abstract class AnalysisError extends Error {
  limit: Readonly<AnalysisSettingLimit> | undefined;
  /** Bind the accepted setting at its producing boundary. */
  bindLimit(limit: AnalysisSettingLimit): this {
    this.limit = Object.freeze({ ...limit });
    return this;
  }
  readonly #cleanupPrimary: AnalysisError | undefined;
  // Undefined means unbound; a bound empty set records confirmed completion.
  #cleanupDependencies: Set<AnalysisError> | undefined;
  #retainedOwnCleanupIncomplete: boolean | undefined;
  #cleanupResourceProjection:
    | { readonly cleanupResources: readonly string[] }
    | undefined;
  #cleanupDependents: WeakRef<AnalysisError>[] = [];
  readonly diagnostics: Readonly<Record<string, JsonValue>> | undefined;
  readonly continuingCallerGuidance:
    | Readonly<AnalysisContinuingCallerGuidance>
    | undefined;
  readonly invocationDiagnostics:
    | Readonly<Record<string, JsonValue>>
    | undefined;
  readonly capturedOutput: AnalysisCapturedOutput | undefined;
  readonly cleanup: AnalysisCleanupObservation | undefined;
  cleanupIncomplete: boolean;
  #ownedCleanupResources: readonly string[];
  #cleanupResourceOwner: AnalysisCleanupResourceOwner | undefined;
  #cleanupCompletionOwner: AnalysisCleanupResourceOwner | undefined;
  #cleanupRetry: AnalysisCleanupRetry | undefined;
  #secondaryFailures: AnalysisError[] = [];
  constructor(message: string, options?: AnalysisErrorOptions) {
    super(message, options);
    this.#cleanupPrimary = options?.cleanupPrimary;
    if (options?.limit !== undefined) this.bindLimit(options.limit);
    this.diagnostics =
      options?.diagnostics === undefined
        ? undefined
        : structuredClone(options.diagnostics);
    this.continuingCallerGuidance =
      options?.continuingCallerGuidance === undefined
        ? undefined
        : Object.freeze({ ...options.continuingCallerGuidance });
    this.invocationDiagnostics =
      options?.invocationDiagnostics === undefined
        ? undefined
        : structuredClone(options.invocationDiagnostics);
    this.capturedOutput =
      options?.capturedOutput === undefined
        ? undefined
        : { ...options.capturedOutput };
    this.cleanup = options?.cleanup;
    this.cleanupIncomplete = options?.cleanup !== undefined;
    this.#ownedCleanupResources = [...(options?.cleanup?.resources ?? [])];
    this.partialObservation = options?.partialObservation;
  }
  abstract readonly _tag: AnalysisErrorTag;
  readonly userMessage: string | undefined = undefined;
  readonly userCategory: "cancelled" | undefined = undefined;
  readonly executionFailure: string | undefined = undefined;
  partialObservation: AnalysisPartialObservation | undefined;

  get cleanupPrimary(): AnalysisError | undefined {
    return this.#cleanupPrimary;
  }
  /** Later typed failures retained without changing the primary error cause. */
  get secondaryFailures(): readonly AnalysisError[] {
    return [...this.#secondaryFailures];
  }
  readonly cleanupReport: ProcessCaptureCleanupReport | undefined = undefined;

  /** Live dependencies own current resource attribution; cleanup keeps history. */
  get cleanupResources(): readonly string[] {
    if (this.#cleanupDependencies === undefined)
      return (
        this.#cleanupResourceOwner?.cleanupResources ??
        this.#ownedCleanupResources
      );
    const pending = [...this.#cleanupDependencies].filter(
      (dependency) => dependency.cleanupIncomplete,
    );
    if (pending.length === 0)
      return this.#retainedOwnCleanupIncomplete === true
        ? (this.#cleanupResourceOwner?.cleanupResources ??
            this.#ownedCleanupResources)
        : [];
    if (this.#cleanupResourceProjection !== undefined)
      return this.#cleanupResourceProjection.cleanupResources;
    return [
      ...new Set([
        ...(this.#retainedOwnCleanupIncomplete === true
          ? (this.#cleanupResourceOwner?.cleanupResources ??
            this.#ownedCleanupResources)
          : []),
        ...pending.flatMap((dependency) => dependency.cleanupResources),
      ]),
    ];
  }

  /** Whether cleanup follows an explicit owner or dependent errors. */
  get hasCleanupOwner(): boolean {
    return (
      this.#cleanupResourceOwner !== undefined ||
      this.#cleanupCompletionOwner !== undefined ||
      this.#cleanupDependencies !== undefined
    );
  }

  /** Bind attribution only to the producer that owns the complete cleanup set. */
  bindCleanupResourceOwner(owner: AnalysisCleanupResourceOwner): this {
    this.#cleanupResourceOwner = owner;
    return this;
  }

  /** Observe exact completion without replacing the producer's resource facts. */
  bindCleanupCompletionOwner(owner: AnalysisCleanupResourceOwner): this {
    this.#cleanupCompletionOwner = owner;
    return this;
  }

  /** Caller retry for the live cleanup; undefined once cleanup completes. */
  get cleanupRetry(): AnalysisCleanupRetry | undefined {
    return this.cleanupIncomplete ? this.#cleanupRetry : undefined;
  }

  /** Bind only from the owner retaining every reported resource for this retry. */
  bindCleanupRetry(retry: AnalysisCleanupRetry): this {
    this.#cleanupRetry = Object.freeze({ ...retry });
    return this;
  }

  /** Initialize resource facts supplied by a more specific error producer. */
  protected setCleanupResources(resources: readonly string[]): void {
    this.#ownedCleanupResources = [...resources];
  }

  /** Retain diagnostic facts without replacing the original typed error. */
  retainDiagnostics(diagnostics: Readonly<Record<string, JsonValue>>): this {
    Object.assign(this, {
      diagnostics: structuredClone({ ...this.diagnostics, ...diagnostics }),
      ...(this.invocationDiagnostics === undefined
        ? {}
        : {
            invocationDiagnostics: structuredClone({
              ...this.invocationDiagnostics,
              ...diagnostics,
            }),
          }),
    });
    return this;
  }

  /** Diagnostics recorded for a caller with this lifetime. */
  diagnosticsFor(
    callerLifetime: AnalysisCallerLifetime,
  ): Readonly<Record<string, JsonValue>> | undefined {
    return callerLifetime === "invocation"
      ? (this.invocationDiagnostics ?? this.diagnostics)
      : this.diagnostics;
  }

  retainSecondaryFailure(
    failure: AnalysisError,
    diagnostics?: Readonly<Record<string, JsonValue>>,
  ): this {
    // Secondary resources remain owned by their cleanup lifecycle; preserve
    // the primary error's live cleanup status and original output.
    if (diagnostics !== undefined) this.retainDiagnostics(diagnostics);
    this.#secondaryFailures.push(failure);
    this.#retainedOwnCleanupIncomplete ??= this.cleanupIncomplete;
    if (failure.cleanupIncomplete) this.cleanupIncomplete = true;
    this.#addCleanupDependencies([failure]);
    return this;
  }

  #addCleanupDependencies(dependencies: readonly AnalysisError[]): void {
    const pending = (this.#cleanupDependencies ??= new Set<AnalysisError>());
    for (const dependency of dependencies) {
      if (!dependency.cleanupIncomplete || pending.has(dependency)) continue;
      pending.add(dependency);
      dependency.#cleanupDependents = [
        ...dependency.#cleanupDependents.filter(
          (reference) => reference.deref() !== undefined,
        ),
        new WeakRef(this),
      ];
    }
  }

  /** Keep a composed error incomplete until all explicitly owned source errors resolve. */
  bindCleanupDependencies(
    dependencies: readonly AnalysisError[],
    resourceProjection?: { readonly cleanupResources: readonly string[] },
  ): this {
    const pending = (this.#cleanupDependencies ??= new Set<AnalysisError>());
    if (resourceProjection !== undefined)
      this.#cleanupResourceProjection = resourceProjection;
    this.#addCleanupDependencies(dependencies);
    if (pending.size === 0) this.resolveCleanup();
    else this.cleanupIncomplete = true;
    return this;
  }

  /** Clear live cleanup status only after its owning resource confirms retry success. */
  resolveCleanup(): this {
    if (this.#retainedOwnCleanupIncomplete !== undefined)
      this.#retainedOwnCleanupIncomplete = false;
    if (
      [...(this.#cleanupDependencies ?? [])].some(
        (dependency) => dependency.cleanupIncomplete,
      )
    ) {
      if (this.#retainedOwnCleanupIncomplete === false)
        this.cleanupIncomplete = true;
      return this;
    }
    this.#cleanupDependencies?.clear();
    this.cleanupIncomplete = false;
    for (const reference of this.#cleanupDependents) {
      const dependent = reference.deref();
      if (dependent !== undefined) dependent.#resolveCleanupFromDependency();
    }
    this.#cleanupDependents = [];
    return this;
  }

  #resolveCleanupFromDependency(): void {
    const dependenciesPending = [...(this.#cleanupDependencies ?? [])].some(
      (dependency) => dependency.cleanupIncomplete,
    );
    if (this.#retainedOwnCleanupIncomplete !== undefined) {
      this.cleanupIncomplete =
        this.#retainedOwnCleanupIncomplete || dependenciesPending;
      if (this.cleanupIncomplete) return;
    } else if (dependenciesPending) {
      return;
    }
    this.#cleanupDependencies?.clear();
    this.cleanupIncomplete = false;
    for (const reference of this.#cleanupDependents) {
      const dependent = reference.deref();
      if (dependent !== undefined) dependent.#resolveCleanupFromDependency();
    }
    this.#cleanupDependents = [];
  }

  /** Retain a completed observation when a later step fails. */
  retainPartialObservation(observation: AnalysisPartialObservation): this {
    this.partialObservation ??= observation;
    return this;
  }
}

/** Confirmed cleanup reveals the typed primary; unresolved ownership stays visible. */
export const resolvedAnalysisError = (error: AnalysisError): AnalysisError => {
  while (!error.cleanupIncomplete && error.cleanupPrimary !== undefined)
    error = error.cleanupPrimary;
  return error;
};

/** Original operation semantics remain distinct from the live cleanup envelope. */
export const primaryAnalysisError = (error: AnalysisError): AnalysisError => {
  while (error.cleanupPrimary !== undefined) error = error.cleanupPrimary;
  return error;
};
import type {
  PartialProcessCaptureObservation,
  ProcessCaptureCleanupReport,
} from "./process/processCapture.js";
import type { FileOffsetPartialObservation } from "./native/fileOffsetPartialObservation.js";
import type { NativeCallPartialObservation } from "./native/nativeCallPartialObservation.js";
import type { HopperCallerReconciliationPartial } from "./native/hopperCallerReconciliation.js";
import type { ElectronActivePartialObservation } from "./javascript/electronActiveObservation.js";
import type { JavaScriptRuntimeObservation } from "./javascript/javascriptRuntimeObservation.js";
import type {
  ArtifactInventoryPartialObservation,
  ArtifactExtractionPartialObservation,
} from "./artifactPartialObservation.js";
import type { WebScriptExportPartialObservation } from "./webScriptExport.js";
import type { JavaScriptRecoveryPartialObservation } from "./javascript/javascriptRecovery.js";
import type { BrowserScenarioPartialObservation } from "./browserScenarioCapture.js";
import type { Evidence } from "./evidence.js";
import type { ElectronPagePartialObservation } from "./javascript/electronObservation.js";
import type { AndroidPartialObservation } from "./android/androidPartialObservation.js";
import type { FirmwarePartialObservation } from "./firmware/firmwareAnalysis.js";
import type {
  AdbActivityStartPartialObservation,
  AdbAcquiredFilePartialObservation,
  AdbPackagePullPartialObservation,
  AdbDisplayPartialObservation,
} from "./adb/adbDeviceAnalysis.js";
import type {
  InspectMacho,
  InspectSignature,
} from "./native/nativeInspection.js";
import type { NativeUiObservationResult } from "./native/nativeUiObservation.js";
import type { BinaryLayout } from "./native/binaryLayout.js";
import type {
  RecordedCrash,
  RecordedCrashPartialObservation,
} from "./native/recordedCrash.js";
import type { WebPageInspection } from "./browserObservationSchemas.js";
import type {
  WebBundleAcquisitionPartialObservation,
  WebBundleAnalysis,
  WebSourceMapFetchPartialObservation,
} from "./webBundleAnalysis.js";
import type { WebExecutionObservation } from "./webExecution.js";
import type { WebSourceMapReport } from "./webSourceLocation.js";
import type { WebEventListenersObservation } from "./webEventListeners.js";

import type { NativeLoadImagePartialObservation } from "./native/nativeLoadImage.js";
import type { NativeAotSnapshotObservation } from "./native/nativeAotSnapshotObservation.js";
import type { FileSnapshotPartialObservation } from "./fileSnapshotObservation.js";

import type { WebModuleResolutionObservation } from "./webModuleTrace.js";
import type { WebNetworkCapture } from "./webNetworkCapture.js";
import type { FridaDeviceList, FridaProcessList } from "./fridaDiscovery.js";
import type { CutterBridgeDiscovery } from "./cutterDiscovery.js";

import type { WebTraceObservation } from "./webTraceObservation.js";
import type { WebArtifactAcquisition } from "./webArtifactAcquisition.js";

/** Provider-neutral evidence collected before a typed analysis failure. */
export type AnalysisPartialObservation =
  | SavedAnalysisSnapshotPartialObservation
  | WebArtifactAcquisition
  | WebTraceObservation
  | CutterBridgeDiscovery
  | FridaDeviceList
  | FridaProcessList
  | WebModuleResolutionObservation
  | WebNetworkCapture
  | NativeLoadImagePartialObservation
  | NativeAotSnapshotObservation
  | FileSnapshotPartialObservation
  | PartialProcessCaptureObservation
  | NativeCallPartialObservation
  | HopperCallerReconciliationPartial
  | FileOffsetPartialObservation
  | ElectronActivePartialObservation
  | BrowserScenarioPartialObservation
  | WebPageInspection
  | WebBundleAnalysis
  | WebBundleAcquisitionPartialObservation
  | WebSourceMapFetchPartialObservation
  | WebSourceMapReport
  | WebExecutionObservation
  | WebEventListenersObservation
  | JavaScriptRuntimeObservation
  | ArtifactInventoryPartialObservation
  | ArtifactExtractionPartialObservation
  | WebScriptExportPartialObservation
  | JavaScriptRecoveryPartialObservation
  | Evidence
  | BinaryLayout
  | RecordedCrash
  | RecordedCrashPartialObservation
  | AndroidPartialObservation
  | FirmwarePartialObservation
  | NativeUiObservationResult
  | InspectSignature
  | InspectMacho
  | ElectronPagePartialObservation
  | AdbActivityStartPartialObservation
  | AdbAcquiredFilePartialObservation
  | AdbPackagePullPartialObservation
  | AdbDisplayPartialObservation;
