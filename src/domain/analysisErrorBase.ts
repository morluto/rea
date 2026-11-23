import type { ElfDebugLink } from "./native/elfDebugLink.js";
import type { ElfDependencies } from "./native/elfDependencies.js";
import type { ElfNotes } from "./native/elfNotes.js";
import type { ElfUnwindRanges } from "./native/elfUnwindRanges.js";
import type { KernelBuildConfig } from "./native/kernelBuildConfig.js";
import type { KernelModule } from "./native/kernelModule.js";
import type { InterfaceBuilderAnalysis } from "./apple/interfaceBuilderGraph.js";
import type { PartialTaskMeasurement } from "./desktop/taskDifficulty.js";
import type { AppleIpsPartialObservation } from "./native/appleIps.js";
import type { PlaywrightTrace } from "./playwrightTrace/playwrightTrace.js";
import type { ApiContract } from "./apiContract/apiContract.js";
import type { GraphqlContract } from "./apiContract/graphqlContract.js";
import type { SavedAnalysisSnapshotPartialObservation } from "./savedAnalysisSnapshot.js";
import type { AnalysisLimit } from "./analysisSettings.js";
import type { JsonValue } from "./jsonValue.js";
import type { AnalysisCleanupRetry } from "./analysisErrorRecovery.js";
import type { EnvironmentBundlePublication } from "./environmentBundleExport.js";
import type { HistoricalSourceGraph } from "./referenceSourceGraph.js";

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
  "ConfigurationError",
  "NoBinaryOpenError",
  "BinaryTargetError",
] as const;

/** Stable tag for an expected analysis failure the domain defines. */
export type AnalysisErrorTag = (typeof ANALYSIS_ERROR_TAGS)[number];

const DOMAIN_ERROR_TAGS: ReadonlySet<string> = new Set(ANALYSIS_ERROR_TAGS);

/** Whether a tag names an error the domain defines and presents. */
export const isAnalysisErrorTag = (tag: string): tag is AnalysisErrorTag =>
  DOMAIN_ERROR_TAGS.has(tag);

/** The error's domain tag; undefined for a provider-owned failure. */
export const domainErrorTag = (error: {
  readonly _tag: string;
}): AnalysisErrorTag | undefined =>
  isAnalysisErrorTag(error._tag) ? error._tag : undefined;

declare const providerErrorTagBrand: unique symbol;

/**
 * Tag of a failure a provider module defines and presents itself. It is
 * outside the domain tag set; the error's `ownPresentation()` supplies what
 * the domain tables would.
 */
export type ProviderErrorTag = string & {
  readonly [providerErrorTagBrand]: true;
};

/** Brand the tag of a `ProviderOwnedAnalysisError` subclass. */
export const providerErrorTag = <const Tag extends string>(
  tag: Tag,
): Tag & ProviderErrorTag => tag as Tag & ProviderErrorTag;

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

/** Publication stopped after a workflow produced its Evidence. Counts describe
 * question occurrences, not distinct Unknown identities. */
export interface WorkflowUnknownPublication {
  readonly evidence_id: string;
  readonly evidence_retention: "retained" | "unverified";
  readonly total_questions: number;
  readonly created_questions: number;
  readonly existing_questions: number;
  readonly next_question_index: number;
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

/**
 * Inputs a failure's recovery names: fields of the failing operation's
 * contract (`path`, or `field.member`) the caller may set instead, and other
 * operations, by contract name, the caller may call. Each adapter renders its
 * own spelling (a CLI flag or command, an MCP field or tool), so the
 * message and remediation name contract fields and operations only.
 */
export interface AnalysisRelatedInputs {
  readonly parameters?: readonly string[];
  readonly operations?: readonly string[];
}

/** Optional provider-neutral context that must survive typed error projection. */
export interface AnalysisErrorOptions extends ErrorOptions {
  /** Typed primary retained when a later lifecycle failure composes this error. */
  readonly cleanupPrimary?: AnalysisError | undefined;
  /** Producer-owned, caller-safe facts retained through every typed projection. */
  readonly diagnostics?: Readonly<Record<string, JsonValue>> | undefined;
  readonly limit?: AnalysisLimit | undefined;
  /** Inputs the recovery names, rendered by each adapter. */
  readonly related?: AnalysisRelatedInputs | undefined;
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

/**
 * A completed observation for one argument of a composite request, kept
 * beside the failing operation's own partial observation.
 */
export interface AnalysisArgumentObservation {
  /** The composite contract's input field this observation completes. */
  readonly argument: string;
  readonly observation: AnalysisPartialObservation;
}

/** Exact cleanup owner that can attribute its currently unresolved resources. */
export interface AnalysisCleanupResourceOwner {
  readonly cleanupResources: readonly string[] | undefined;
}

/** A lease-backed claim whose owner records the confirmed release. */
export interface AnalysisCleanupReleaseClaim {
  readonly cleanupReleased: boolean;
}

/** Result completed before its source Evidence could be published. */
export type SourcePublicationCompletion =
  | {
      readonly kind: "unretained-evidence";
      readonly source_closure: "not-established";
      readonly evidence: Evidence;
    }
  | {
      readonly kind: "retained-evidence";
      readonly source_closure: "not-established";
      readonly evidence_id: string;
    }
  | {
      readonly kind: "unretained-observation";
      readonly source_closure: "not-established";
      readonly observation: Readonly<Record<string, JsonValue>>;
    }
  | {
      readonly kind: "inline-evidence";
      readonly retention: "one-shot-session" | "unknown";
      readonly source_closure: "not-established";
      readonly evidence: Evidence;
    }
  | {
      readonly kind: "omitted";
      readonly source_closure: "not-established";
      readonly reason:
        | "primary-authentication-failed"
        | "insufficient-authentication-headroom"
        | "recovery-input-invalid";
    };

export interface SourcePublicationRecovery {
  readonly source: AnalysisPartialObservation | undefined;
  readonly completed: SourcePublicationCompletion;
}

/**
 * Presentation an error's own module supplies. The shared presenter reads it
 * before its tables, so it never needs the error's type: a provider error
 * says what it means for callers where it is defined.
 */
export interface AnalysisErrorOwnPresentation {
  /** The stable code before any cleanup composition. */
  readonly code: AnalysisErrorProjection["code"];
  readonly category: AnalysisErrorProjection["category"];
  /** The outcome every caller receives; absent keeps the code's standard text. */
  readonly message?: string;
  /** Guidance only a caller that keeps REA's runtime and session receives. */
  readonly continuing?: AnalysisContinuingCallerGuidance;
  /** The next step; absent keeps the shared fallback. */
  readonly remediation?: string;
  /** False when the failure cannot clear on retry whatever its code. */
  readonly retryable?: false;
  readonly details?: Readonly<Record<string, JsonValue>>;
}

/**
 * The provider request a provider-owned failure answered. A shared workflow
 * that attributes the failure to its caller's operation copies `facts` under
 * `provider_request` and rebuilds the failure with `reattribute`.
 */
export interface ProviderRequestFailure {
  readonly facts: Readonly<Record<string, JsonValue>>;
  readonly reattribute: (
    operation: string,
    options: AnalysisErrorOptions,
  ) => AnalysisError;
}

/** Base class for expected analysis, provider, and session failures. */
export abstract class AnalysisError extends Error {
  limit: Readonly<AnalysisLimit> | undefined;
  /** Bind the accepted setting at its producing boundary. */
  bindLimit(limit: AnalysisLimit): this {
    this.limit = Object.freeze({ ...limit });
    return this;
  }
  readonly #cleanupPrimary: AnalysisError | undefined;
  // Undefined means unbound; a bound empty set records confirmed completion.
  #cleanupDependencies: Set<AnalysisError> | undefined;
  #cleanupResourceProjection:
    | { readonly cleanupResources: readonly string[] }
    | undefined;
  readonly diagnostics: Readonly<Record<string, JsonValue>> | undefined;
  /** Inputs the recovery names, rendered by each adapter. */
  readonly related: Readonly<AnalysisRelatedInputs> | undefined;
  readonly continuingCallerGuidance:
    | Readonly<AnalysisContinuingCallerGuidance>
    | undefined;
  readonly invocationDiagnostics:
    | Readonly<Record<string, JsonValue>>
    | undefined;
  #capturedOutput: AnalysisCapturedOutput | undefined;
  get capturedOutput(): AnalysisCapturedOutput | undefined {
    return this.#capturedOutput;
  }
  readonly cleanup: AnalysisCleanupObservation | undefined;
  /**
   * Whether cleanup is still unsettled. Once settled it stays settled; until
   * then completion is read from the owners when asked, never pushed here.
   */
  #cleanupIncomplete: boolean;
  /** Whether this error ever owned cleanup, apart from whether it finished. */
  #carriesCleanup: boolean;
  #ownedCleanupResources: readonly string[];
  #cleanupResourceOwner: AnalysisCleanupResourceOwner | undefined;
  #cleanupCompletionOwner: AnalysisCleanupResourceOwner | undefined;
  readonly #cleanupReleaseClaims = new Set<AnalysisCleanupReleaseClaim>();
  #cleanupRetry: AnalysisCleanupRetry | undefined;
  #secondaryFailures: AnalysisError[] = [];
  constructor(message: string, options?: AnalysisErrorOptions) {
    super(message, options);
    this.#cleanupPrimary = options?.cleanupPrimary;
    if (options?.limit !== undefined) this.bindLimit(options.limit);
    this.related =
      options?.related === undefined
        ? undefined
        : Object.freeze({
            ...(options.related.parameters === undefined
              ? {}
              : { parameters: Object.freeze([...options.related.parameters]) }),
            ...(options.related.operations === undefined
              ? {}
              : { operations: Object.freeze([...options.related.operations]) }),
          });
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
    this.#capturedOutput =
      options?.capturedOutput === undefined
        ? undefined
        : { ...options.capturedOutput };
    this.cleanup = options?.cleanup;
    this.#cleanupIncomplete = options?.cleanup !== undefined;
    this.#carriesCleanup = this.#cleanupIncomplete;
    this.#ownedCleanupResources = [...(options?.cleanup?.resources ?? [])];
    this.partialObservation = options?.partialObservation;
  }
  abstract readonly _tag: AnalysisErrorTag | ProviderErrorTag;
  /** What this error's own module says it means; undefined uses the shared tables. */
  ownPresentation(): AnalysisErrorOwnPresentation | undefined {
    return undefined;
  }
  /**
   * Whether the provider adapter or its process failed, rather than one
   * request. Session availability treats every operation of that provider as
   * affected until a later success.
   */
  get providerWide(): boolean {
    return false;
  }
  /** The provider request this failure answered; undefined when none. */
  providerRequest(): ProviderRequestFailure | undefined {
    return undefined;
  }
  readonly userMessage: string | undefined = undefined;
  readonly userCategory: "cancelled" | undefined = undefined;
  readonly executionFailure: string | undefined = undefined;
  partialObservation: AnalysisPartialObservation | undefined;
  #argumentObservations: AnalysisArgumentObservation[] = [];
  /** Completed argument observations of a composite request, in retention order. */
  get argumentObservations(): readonly AnalysisArgumentObservation[] {
    return this.#argumentObservations;
  }
  sourcePublicationRecovery: SourcePublicationRecovery | undefined;
  workflowUnknownPublication: WorkflowUnknownPublication | undefined;

  /** Keep the failed source and completed result with their error owner. */
  retainSourcePublication(completed: SourcePublicationCompletion): this {
    this.sourcePublicationRecovery = {
      source: this.partialObservation,
      completed,
    };
    this.partialObservation = undefined;
    return this;
  }

  get cleanupPrimary(): AnalysisError | undefined {
    return this.#cleanupPrimary;
  }

  /**
   * Whether owned resources remain unreleased: this error's own record AND
   * every bound dependency's record, each read from its owner when asked.
   * Completion is monotonic, so a later binding cannot reopen it.
   */
  get cleanupIncomplete(): boolean {
    if (!this.#cleanupIncomplete) return false;
    if (this.#ownCleanupPending()) return true;
    for (const dependency of this.#cleanupDependencies ?? [])
      if (dependency.cleanupIncomplete) return true;
    this.#cleanupIncomplete = false;
    this.#cleanupDependencies?.clear();
    this.#cleanupReleaseClaims.clear();
    return false;
  }

  /**
   * This error's own completion record. A bound release claim is its owner's
   * record; without one, an error composed only of dependencies has no
   * resources of its own, and any other error waits for its owner.
   */
  #ownCleanupPending(): boolean {
    if (this.#cleanupReleaseClaims.size === 0)
      return this.#cleanupDependencies === undefined;
    for (const claim of this.#cleanupReleaseClaims)
      if (claim.cleanupReleased) return false;
    return true;
  }

  /**
   * Read completion from a lease owner instead of having it pushed here.
   * Binding the same claim again is a no-op, so retries do not grow it.
   */
  bindCleanupReleaseClaim(claim: AnalysisCleanupReleaseClaim): this {
    this.#carriesCleanup = true;
    this.#cleanupReleaseClaims.add(claim);
    return this;
  }

  /** A subclass whose own resources are unreleased when it is constructed. */
  protected markCleanupIncomplete(incomplete: boolean): void {
    this.#cleanupIncomplete = incomplete;
    if (incomplete) this.#carriesCleanup = true;
  }
  /** Later typed failures retained without changing the primary error cause. */
  get secondaryFailures(): readonly AnalysisError[] {
    return [...this.#secondaryFailures];
  }
  readonly cleanupReport: ProcessCaptureCleanupReport | undefined = undefined;

  /**
   * Live owners own current resource attribution; cleanup keeps history. A
   * composed error's own resources usually summarize its dependencies, so
   * pending dependencies attribute; once only the owner's record is pending,
   * its own resources do.
   */
  get cleanupResources(): readonly string[] {
    const own =
      this.#cleanupResourceOwner?.cleanupResources ??
      this.#ownedCleanupResources;
    if (this.#cleanupDependencies === undefined) return own;
    const pending = [...this.#cleanupDependencies].filter(
      (dependency) => dependency.cleanupIncomplete,
    );
    if (pending.length > 0)
      return (
        this.#cleanupResourceProjection?.cleanupResources ?? [
          ...new Set(
            pending.flatMap((dependency) => dependency.cleanupResources),
          ),
        ]
      );
    return this.#cleanupIncomplete && this.#ownCleanupPending() ? own : [];
  }

  /** Whether cleanup follows an explicit owner or dependent errors. */
  get hasCleanupOwner(): boolean {
    return (
      this.#cleanupResourceOwner !== undefined ||
      this.#cleanupCompletionOwner !== undefined ||
      this.#cleanupDependencies !== undefined
    );
  }

  /**
   * Whether this error owns cleanup at all: its own resources, a release
   * claim, or an owner it follows. Unlike `cleanupIncomplete`, this stays
   * true after that cleanup finished, so a consumer can tell a released
   * owner from a failure (such as a cancellation) that never had one.
   */
  get carriesCleanup(): boolean {
    return this.#carriesCleanup || this.hasCleanupOwner;
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

  /** Retain facts on every primary that cleanup settlement can reveal. */
  retainPrimaryDiagnostics(
    diagnostics: Readonly<Record<string, JsonValue>>,
  ): this {
    for (
      let error: AnalysisError | undefined = this;
      error !== undefined;
      error = error.cleanupPrimary
    )
      error.retainDiagnostics(diagnostics);
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
    return this;
  }

  /** Keep a composed error incomplete until all explicitly owned source errors resolve. */
  bindCleanupDependencies(
    dependencies: readonly AnalysisError[],
    resourceProjection?: { readonly cleanupResources: readonly string[] },
  ): this {
    // Settle the dependencies already bound before adding more: completion is
    // monotonic, so a dependency bound after they released cannot reopen it.
    if (!this.cleanupIncomplete) this.#cleanupDependencies?.clear();
    const pending = (this.#cleanupDependencies ??= new Set<AnalysisError>());
    if (resourceProjection !== undefined)
      this.#cleanupResourceProjection = resourceProjection;
    for (const dependency of dependencies)
      if (dependency.cleanupIncomplete) pending.add(dependency);
    return this;
  }

  /** Retain a completed observation when a later step fails. */
  retainPartialObservation(observation: AnalysisPartialObservation): this {
    this.partialObservation ??= observation;
    return this;
  }

  /**
   * Retain a composite argument's completed observation without replacing
   * this failure's own partial observation; the first per argument wins.
   */
  retainArgumentObservation(
    argument: string,
    observation: AnalysisPartialObservation,
  ): this {
    if (!this.#argumentObservations.some((kept) => kept.argument === argument))
      this.#argumentObservations.push(Object.freeze({ argument, observation }));
    return this;
  }

  /** Keep command output observed before this error without replacing the owner. */
  retainCapturedOutput(output: AnalysisCapturedOutput): this {
    this.#capturedOutput ??= { ...output };
    return this;
  }

  /** Preserve the exact committed prefix when automatic question publication stops. */
  retainWorkflowUnknownPublication(
    publication: WorkflowUnknownPublication,
  ): this {
    this.workflowUnknownPublication ??= Object.freeze({ ...publication });
    return this;
  }
}

/**
 * A failure its provider module defines: its tag is outside the domain tag
 * set, so it must say what it means through `ownPresentation()`.
 */
export abstract class ProviderOwnedAnalysisError extends AnalysisError {
  abstract override readonly _tag: ProviderErrorTag;
  abstract override ownPresentation(): AnalysisErrorOwnPresentation;
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

/** Find the completed publication outcome owned anywhere in a cleanup chain. */
export const sourcePublicationRecoveryOf = (
  error: AnalysisError,
): SourcePublicationRecovery | undefined => {
  for (
    let owner: AnalysisError | undefined = error;
    owner !== undefined;
    owner = owner.cleanupPrimary
  )
    if (owner.sourcePublicationRecovery !== undefined)
      return owner.sourcePublicationRecovery;
  return undefined;
};
import type {
  PartialProcessCaptureObservation,
  ProcessCaptureCleanupReport,
} from "./process/processCapture.js";
import type { FileOffsetPartialObservation } from "./native/fileOffsetPartialObservation.js";
import type { NativeCallPartialObservation } from "./native/nativeCallPartialObservation.js";
import type { HopperCallerReconciliationPartial } from "./native/hopperCallerReconciliation.js";
import type { AnalysisErrorProjection } from "./analysisErrorProjection.js";
import type {
  ElectronActiveObservationResult,
  ElectronActivePartialObservation,
} from "./javascript/electronActiveObservation.js";
import type { JavaScriptRuntimeObservation } from "./javascript/javascriptRuntimeObservation.js";
import type {
  ArtifactInventoryPartialObservation,
  ArtifactExtractionPartialObservation,
} from "./artifactPartialObservation.js";
import type { WebScriptExportPartialObservation } from "./webScriptExport.js";
import type { JavaScriptRecoveryPartialObservation } from "./javascript/javascriptRecovery.js";
import type { BrowserScenarioPartialObservation } from "./browserScenarioCapture.js";
import type { Evidence } from "./evidence.js";
import type {
  ElectronPageInspection,
  ElectronPagePartialObservation,
} from "./javascript/electronObservation.js";
import type { AndroidPartialObservation } from "./android/androidPartialObservation.js";
import type { UefiPartialObservation } from "./uefi/uefiFirmwareAnalysis.js";
import type { FirmwarePartialObservation } from "./firmware/firmwareAnalysis.js";
import type {
  AdbActivityStartPartialObservation,
  AdbAcquiredFilePartialObservation,
  AdbPackagePullPartialObservation,
  AdbDisplayPartialObservation,
} from "./adb/adbDeviceAnalysis.js";
import type {
  InspectMacho,
  InspectPlist,
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
  | ElfDebugLink
  | ElfDependencies
  | ElfNotes
  | ElfUnwindRanges
  | KernelBuildConfig
  | KernelModule
  | InterfaceBuilderAnalysis
  | PartialTaskMeasurement
  | {
      readonly kind: "omitted-observation";
      readonly reason:
        | "insufficient-authentication-headroom"
        | "recovery-input-invalid";
    }
  | { readonly kind: "unretained-evidence"; readonly evidence: Evidence }
  | { readonly kind: "retained-evidence"; readonly evidence_id: string }
  | ApiContract
  | GraphqlContract
  | PlaywrightTrace
  | SavedAnalysisSnapshotPartialObservation
  | WebArtifactAcquisition
  | WebTraceObservation
  | CutterBridgeDiscovery
  | FridaDeviceList
  | FridaProcessList
  | WebModuleResolutionObservation
  | HistoricalSourceGraph
  | WebNetworkCapture
  | NativeLoadImagePartialObservation
  | NativeAotSnapshotObservation
  | FileSnapshotPartialObservation
  | PartialProcessCaptureObservation
  | NativeCallPartialObservation
  | HopperCallerReconciliationPartial
  | FileOffsetPartialObservation
  | ElectronActivePartialObservation
  | ElectronActiveObservationResult
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
  | EnvironmentBundlePublication
  | JavaScriptRecoveryPartialObservation
  | Evidence
  | BinaryLayout
  | RecordedCrash
  | AppleIpsPartialObservation
  | RecordedCrashPartialObservation
  | AndroidPartialObservation
  | FirmwarePartialObservation
  | UefiPartialObservation
  | NativeUiObservationResult
  | InspectSignature
  | InspectMacho
  | InspectPlist
  | ElectronPagePartialObservation
  | ElectronPageInspection
  | AdbActivityStartPartialObservation
  | AdbAcquiredFilePartialObservation
  | AdbPackagePullPartialObservation
  | AdbDisplayPartialObservation;
