import type { AppConfig } from "../config/types.js";
import { z } from "zod";
import { AbortedWait, waitForAbortable } from "../process/AbortablePromise.js";
import {
  createAnalysisExecution,
  type AnalysisClient,
  type AnalysisOperation,
  type ExecutionOptions,
} from "../ports/AnalysisProvider.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisProtocolError,
  AnalysisOutputError,
  AnalysisInputError,
  AnalysisTimeoutError,
  AnalysisResourceConstraintError,
  cancelledBy,
  carriedReason,
  isAborted,
} from "../domain/analysisErrorCore.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import type { IdaConfiguration } from "./IdaConfiguration.js";
import { IdaToolRejection, type IdaMcpConnection } from "./IdaMcpConnection.js";
import {
  hexRaysCloseSchema,
  hexRaysListSchema,
  hexRaysOpenSchema,
  hexRaysTools,
  runHexRaysQuery,
  type HexRaysBackend,
  type HexRaysStatus,
} from "./IdaHexRaysProtocol.js";
import { idaCompatibilityProfile } from "./IdaConfiguration.js";
import { createIdaDiagnosticRedactor } from "./IdaDiagnosticRedactor.js";
import { nativeTools } from "./IdaNativeProtocol.js";
import { readSettledHealth } from "./IdaBusyHealth.js";
import { isX86OnlyTarget } from "./IdaCallGraph.js";
import {
  IdaOperationRunner,
  type IdaRawObservation,
} from "./IdaOperationRunner.js";
import {
  IDA_DATABASE_TARGET_LIMITATION,
  IDA_LIMITATIONS,
  idaOperationUnavailableReason,
  type IdaOperation,
} from "./IdaProviderCapabilities.js";
import {
  IDA_OPERATIONS,
  IDA_PROVIDER_IDENTITY,
} from "./IdaProviderMetadata.js";
import {
  absentDatabaseCloseSchema,
  attachedMetadataSchema,
  closeDatabaseSchema,
  databaseListSchema,
  modernHealthSchema,
  openDatabaseSchema,
  rejectedOpenDatabaseSchema,
} from "./IdaProtocolValues.js";
import {
  idaFileDigest,
  IdaWorkspace,
  sameIdaHostPath,
} from "./IdaWorkspace.js";
import { parseIdaInput } from "./IdaInput.js";
import { createEvidence } from "../domain/evidence.js";
import {
  ArtifactReaderFailure,
  bindArtifactFileCleanup,
} from "../resources/index.js";
import { classifyProviderFailure } from "../providers/classifyProviderFailure.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { analysisErrorWithCleanupDependencies } from "../domain/analysisErrorCleanup.js";
import {
  analysisClientFailureContext,
  analysisClientFailureForOperation,
} from "../providers/AnalysisClientFailure.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { isPathWithinRoot } from "../domain/localPath.js";
import { isQualifiedCallerPath } from "../filesystem/callerPath.js";

const modernTools = [
  "idb_open",
  "idb_list",
  "idb_close",
  "server_health",
  "list_funcs",
  "lookup_funcs",
  "find_regex",
  "decompile",
  "disasm",
  "callees",
  "xrefs_to",
];
const operationSet: ReadonlySet<string> = new Set(IDA_OPERATIONS);

const isIdaOperation = (operation: string): operation is IdaOperation =>
  operationSet.has(operation);
interface IdaOperationFailureContext {
  runner: IdaOperationRunner | undefined;
  metadataBefore: JsonValue | undefined;
  metadataAfter: JsonValue | undefined;
  postOperationIdentityCheck: "not_attempted" | "started" | "verified";
  parameters: Readonly<Record<string, JsonValue>>;
}

/** Upstream session ids of inventory entries, omitting unreported ones. */
interface UpstreamSession {
  readonly session_id: string;
  readonly backend: "worker" | "gui";
  /** Upstream ownership; null when no inventory has reported it. */
  readonly owned: boolean | null;
  /** Last inventoried input binding; null until upstream reports it. */
  readonly input_path: string | null;
  /** Last inventoried activity; null before upstream reports it. */
  readonly is_active: boolean | null;
  readonly hexrays_status?: HexRaysStatus;
  readonly hexrays_backend?: HexRaysBackend;
}

/** Inventory bindings and protocol-specific evidence used to decide cleanup. */
type InventoriedSession = UpstreamSession & {
  readonly owned: boolean;
  readonly input_path: string;
  readonly referencesWorkspace: boolean;
  readonly released: boolean;
};

/** A failed cleanup retains its private workspace and reports the remaining resource. */
class IdaCleanupError extends ProviderAdapterError {
  constructor(
    path: string,
    cause: unknown,
    sessions?: readonly UpstreamSession[],
  ) {
    super("ida", "close", {
      cause,
      cleanup: {
        reason:
          "IDA connection or private workspace cleanup remains unverified.",
        resources: [path],
      },
      capturedOutput:
        cause instanceof AnalysisError ? cause.capturedOutput : undefined,
      diagnostics: {
        ...(cause instanceof AnalysisError ? cause.diagnostics : undefined),
        reason:
          "IDA cleanup could not be verified; the remaining connection or private workspace is retained for retry.",
        failure_reason:
          cause instanceof AnalysisError
            ? (cause.diagnostics?.reason ?? cause.message)
            : errorMessage(cause),
        workspace: path,
        ...(sessions === undefined
          ? {}
          : {
              upstream_sessions: {
                state: "unverified",
                sessions: sessions.map(
                  ({
                    session_id,
                    backend,
                    owned,
                    input_path,
                    is_active,
                    hexrays_status,
                    hexrays_backend,
                  }) => ({
                    session_id,
                    backend,
                    owned,
                    input_path,
                    is_active,
                    ...(hexrays_status === undefined ? {} : { hexrays_status }),
                    ...(hexrays_backend === undefined
                      ? {}
                      : { hexrays_backend }),
                  }),
                ),
                reason:
                  "Release of upstream sessions matching the requested session ID or private workspace was not confirmed; input_path preserves the last observed path and is null when no inventory has reported it. is_active preserves registry activity and is null when unknown; it does not establish process liveness. A worker outlives its supervisor and may keep running until it finishes and reaches its idle timeout; exiting REA does not stop it. A gui session belongs to an IDA instance REA does not control. An empty session_id means upstream reported none; owned is null when no inventory has reported ownership; an empty list means the requested worker's close was confirmed but no inventory has identified any remaining session.",
              },
            }),
      },
    });
  }
}

/**
 * A worker that is still tearing down can remain in inventory with its identity
 * already cleared: an empty `session_id`, `owned: false` and `is_active: false`,
 * while `input_path` still names the private copy. Such a row establishes no
 * live session, so the private-input arm must not report it as a blocker. The
 * owning worker is matched by its own session ID separately, and a genuine peer
 * on the same input keeps a session ID, so neither case is weakened.
 *
 * Limited to `backend: "worker"`: a gui row belongs to an IDA instance REA does
 * not control, and the observed teardown shape covers workers only, so a gui
 * row keeps blocking release whatever its flags say.
 */
const isReleasedSupervisorWorker = (entry: {
  readonly session_id: string;
  readonly owned: boolean;
  readonly is_active: boolean;
  readonly backend: "worker" | "gui";
}): boolean =>
  entry.backend === "worker" &&
  entry.session_id === "" &&
  entry.owned === false &&
  entry.is_active === false;

/** Format-owner facts for a refused database/target binding, before any operation replies exist. */
class IdaIdentityRefusal extends AnalysisProtocolError {
  constructor(
    readonly reason: string,
    readonly recovery: string,
    check: string,
  ) {
    super(reason, { diagnostics: { identity_check: check, reason, recovery } });
  }
}

const IDA_RECOVERY =
  "Check the configured upstream MCP registration and selected target; see docs/providers/ida-provider.md.";

/**
 * Attribute a typed failure to the accepted operation and the redacted
 * endpoint it reached. A startup failure #start already attributed passes
 * through, as does every other typed failure.
 */
const idaAttribution = (
  cause: AnalysisError,
  operation: string,
  endpoint: Readonly<Record<string, string>>,
  options: ExecutionOptions | undefined,
): AnalysisError => {
  if (cause instanceof IdaIdentityRefusal)
    return new AnalysisOutputError(operation, cause.reason, {
      cause,
      userMessage: cause.reason,
      remediationAction: cause.recovery,
      diagnostics: cause.diagnostics,
    });
  if (cause instanceof AnalysisCancelledError)
    return cancelledBy(
      operation,
      carriedReason(
        cause.cause === undefined ? options?.signal?.reason : cause.cause,
      ),
      {
        capturedOutput: cause.capturedOutput,
        diagnostics: { ...cause.diagnostics, ...endpoint },
        partialObservation: cause.partialObservation,
        cleanup:
          cause.cleanup ??
          (cause.cleanupIncomplete
            ? { reason: cause.message, resources: cause.cleanupResources }
            : undefined),
      },
    )
      .bindCleanupDependencies([cause])
      .bindCleanupResourceOwner(cause);
  if (
    cause instanceof AnalysisTimeoutError ||
    cause instanceof AnalysisResourceConstraintError
  )
    // #start has already attributed a startup failure and its endpoint;
    // wrapping it again would replace the producer cause with an intermediate.
    return cause.operation === operation &&
      cause.diagnostics?.startup_operation !== undefined
      ? cause
      : analysisClientFailureForOperation(
          cause,
          "ida",
          operation,
          endpoint,
        ).bindCleanupResourceOwner(cause);
  if (cause instanceof ProviderAdapterError && cause.operation === "transport")
    return analysisClientFailureForOperation(cause, "ida", operation, {
      ...endpoint,
      recovery: IDA_RECOVERY,
    }).bindCleanupResourceOwner(cause);
  if (cause instanceof AnalysisProtocolError && "endpoint" in endpoint)
    return new AnalysisProtocolError(cause.message, {
      ...analysisClientFailureContext(cause, "ida", operation),
      diagnostics: { ...cause.diagnostics, ...endpoint },
    }).bindCleanupResourceOwner(cause);
  return cause;
};

/** Serial read-only session whose lifecycle authority excludes an attached GUI. */
export class IdaSessionClient implements AnalysisClient {
  #tail: Promise<void> = Promise.resolve();
  #startup: Promise<void> | undefined;
  #closed = false;
  #closing = false;
  #closePromise: Promise<Result<null, AnalysisError>> | undefined;
  #workspace: IdaWorkspace | undefined;
  #database: string | undefined;
  /** The upstream session id this client requested or was assigned; unknown before then. */
  #expectedSession: string | undefined;
  #databaseCloseCompleted = false;
  #openAttempted = false;
  #openCompleted = false;
  #ready = false;
  #blockingSessions: readonly UpstreamSession[] | undefined;
  #openRejected = false;
  #callGraphAdvertised = false;
  #surveyAdvertised = false;
  #initialIdentity: string | undefined;
  #metadata: JsonValue = null;
  #lifecycle: JsonValue[] = [];
  /** Hex-Rays health reads of the current operation, kept whole beside the parsed metadata. */
  #healthObservations: IdaRawObservation[] = [];

  constructor(
    private readonly config: IdaConfiguration,
    private readonly target: BinaryTarget,
    private readonly connection: IdaMcpConnection,
    private readonly profile?: AnalysisProfileCommitment,
    private readonly regexSettings?: Pick<
      AppConfig,
      "regexMatchingDeadline" | "regexWorkerHeapRequest"
    >,
  ) {}

  execute(
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ) {
    const call = this.#tail.then(() =>
      this.#execute(operation, parameters, options),
    );
    this.#tail = call.then(
      () => undefined,
      () => undefined,
    );
    return call;
  }

  async executeIfReady(
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ) {
    if (!this.#ready || this.#closed || this.#closing)
      return Promise.resolve(undefined);
    const call = this.#tail.then(() => {
      if (!this.#ready || this.#closed || this.#closing) return undefined;
      if (isAborted(options?.signal))
        return err(cancelledBy(operation, options?.signal));
      return this.#execute(operation, parameters, options, true);
    });
    this.#tail = call.then(
      () => undefined,
      () => undefined,
    );
    const result = await waitForAbortable(call, options?.signal);
    return result instanceof AbortedWait
      ? err(cancelledBy(operation, result))
      : result;
  }

  async #execute(
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
    readyOnly = false,
  ) {
    if (this.#closed || this.#closing)
      return err(
        new AnalysisProtocolError(
          "IDA session is closing or closed; reopen the target.",
        ),
      );
    if (isAborted(options?.signal))
      return err(cancelledBy(operation, options?.signal));
    if (operation !== "health" && !isIdaOperation(operation))
      return err(
        new AnalysisCapabilityUnavailableError(
          "ida",
          operation,
          "This integration admits read-only analysis operations only.",
        ),
      );
    const unavailableReason =
      operation === "health"
        ? undefined
        : idaOperationUnavailableReason(
            operation,
            idaCompatibilityProfile(this.config),
          );
    if (unavailableReason !== undefined)
      return err(
        new AnalysisCapabilityUnavailableError(
          "ida",
          operation,
          unavailableReason,
        ),
      );
    if (operation !== "health") {
      const parsed = parseIdaInput(operation, parameters);
      if (!parsed.ok) return parsed;
      parameters = parsed.value;
    }
    const document = parameters.document;
    if (
      document !== undefined &&
      (typeof document !== "string" ||
        (!sameIdaHostPath(document, this.target.path) &&
          (this.target.sourcePath === undefined ||
            !sameIdaHostPath(document, this.target.sourcePath))))
    )
      return err(
        new AnalysisInputError(operation, undefined, [
          {
            path: ["document"],
            reason: "invalid_value",
            expected: this.target.path,
            message:
              "IDA document must be the REA-bound target; omit document or use its admitted path.",
          },
        ]),
      );
    this.#healthObservations = [];
    const failureContext: IdaOperationFailureContext = {
      runner: undefined,
      metadataBefore: undefined,
      metadataAfter: undefined,
      postOperationIdentityCheck: "not_attempted",
      parameters,
    };
    try {
      if (!readyOnly) await this.#start(operation);
      const before = await this.#observe(options);
      failureContext.metadataBefore = before;
      if (isAborted(options?.signal))
        throw cancelledBy(operation, options?.signal);
      if (operation === "health") return this.#health(before);
      if (!isIdaOperation(operation))
        throw new AnalysisProtocolError(
          "IDA operation changed after validation.",
        );
      const runner = this.#runner(options);
      failureContext.runner = runner;
      const result = await runner.run(operation, parameters);
      if (isAborted(options?.signal))
        throw cancelledBy(operation, options?.signal);
      failureContext.postOperationIdentityCheck = "started";
      const after = await this.#observe(
        options,
        (observed) => (failureContext.metadataAfter = observed),
      );
      failureContext.postOperationIdentityCheck = "verified";
      if (isAborted(options?.signal))
        throw cancelledBy(operation, options?.signal);
      return ok(
        createAnalysisExecution(result, IDA_PROVIDER_IDENTITY, {
          rawResult: {
            upstream: this.connection.serverInfo(),
            metadata_before: before,
            metadata_after: after,
            observations: jsonValueSchema.parse(runner.raw),
            ...this.#healthEvidence(),
          },
          limitations: [...this.#limitations(), ...runner.limitations],
          ...(runner.relationshipCoverage === undefined
            ? {}
            : { relationshipCoverage: runner.relationshipCoverage }),
          ...(runner.referencesTruncated !== undefined
            ? { referencesTruncated: runner.referencesTruncated }
            : {}),
          locations: [
            { kind: "artifact-path", path: this.target.path },
            ...runner.locations,
          ],
          ...(this.profile === undefined
            ? {}
            : { analysisProfile: this.profile }),
        }),
      );
    } catch (cause: unknown) {
      return this.#failure(operation, cause, options, failureContext);
    }
  }

  #runner(options: ExecutionOptions | undefined): IdaOperationRunner {
    const protocol = idaCompatibilityProfile(this.config).protocol;
    const database = this.#database;
    return new IdaOperationRunner(
      this.connection,
      // Hex-Rays answers database-supervisor reads through its query bridge.
      protocol === "hexrays" ? "modern" : protocol,
      database,
      {
        ...(protocol === "hexrays" && database !== undefined
          ? {
              invoke: (tool, args) =>
                runHexRaysQuery(
                  this.connection,
                  database,
                  tool,
                  args,
                  this.config.timeoutMs,
                  options?.signal,
                ),
            }
          : {}),
        regexMatchingDeadline: this.regexSettings?.regexMatchingDeadline,
        regexWorkerHeapRequest: this.regexSettings?.regexWorkerHeapRequest,
        signal: options?.signal,
        selectorOrigin: options?.selectorOrigin,
        x86Only: isX86OnlyTarget(this.target),
        callGraphAvailable: this.#callGraphAdvertised,
        surveyAvailable: this.#surveyAdvertised,
        admittedDocument: this.target.path,
      },
    );
  }

  #limitations(): readonly string[] {
    return this.target.kind === "database"
      ? [...IDA_LIMITATIONS, IDA_DATABASE_TARGET_LIMITATION]
      : IDA_LIMITATIONS;
  }

  #health(metadata: JsonValue) {
    return ok(
      createAnalysisExecution(
        {
          ready: true,
          mode: this.config.mode,
          database: this.#database ?? null,
          upstream: this.connection.serverInfo(),
          metadata,
          lifecycle: this.#lifecycle,
        },
        IDA_PROVIDER_IDENTITY,
        {
          limitations: this.#limitations(),
          ...(this.profile === undefined
            ? {}
            : { analysisProfile: this.profile }),
        },
      ),
    );
  }

  #failure(
    operation: string,
    cause: unknown,
    options: ExecutionOptions | undefined,
    context: IdaOperationFailureContext,
  ): Result<never, AnalysisError> {
    // The validated registration owns the exact endpoint spelling. Apply the
    // same credential exclusions used for upstream transport diagnostics.
    const endpoint =
      !(cause instanceof ArtifactReaderFailure) && "url" in this.config
        ? {
            endpoint: createIdaDiagnosticRedactor(this.config).url(
              this.config.url,
            ),
          }
        : {};
    // What IDA reports for an upstream failure nothing typed recognised.
    const adapterFailure = (raw: unknown) =>
      new ProviderAdapterError("ida", operation, {
        cause: raw,
        diagnostics: {
          ...endpoint,
          reason:
            raw instanceof Error ? raw.message : "Unknown upstream failure",
          recovery: IDA_RECOVERY,
        },
      });
    const failure = classifyProviderFailure(cause, {
      providerId: "ida",
      operation,
      attribute: (typed) => idaAttribution(typed, operation, endpoint, options),
      recognise: (raw) =>
        raw instanceof z.ZodError
          ? new AnalysisOutputError(
              operation,
              `IDA MCP returned malformed or unsupported producer data: ${raw.issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`).join("; ")}`,
              { cause: raw },
            )
          : undefined,
      // The attributed primary is composed with the read's unresolved cleanup.
      readCleanup: (read, primary) => {
        const cleanup = new ProviderCleanupError(
          "ida",
          read.cleanup.resources,
          { reason: read.cleanup.reason },
          { operation, cause: read },
        );
        bindArtifactFileCleanup(read, cleanup);
        return analysisErrorWithCleanupDependencies(
          primary ?? adapterFailure(read),
          cleanup,
          operation,
        );
      },
      unclassified: adapterFailure,
    });
    // Only operation calls made after target identity/readiness validation can
    // become partial Evidence. The failing call itself is absent from `raw`
    // when its transport or MCP envelope could not be decoded.
    const { runner, metadataBefore, metadataAfter } = context;
    if (
      runner !== undefined &&
      runner.raw.length > 0 &&
      metadataBefore !== undefined
    ) {
      const observations = jsonValueSchema.parse(runner.raw);
      const upstream = this.connection.serverInfo();
      const binding =
        context.postOperationIdentityCheck !== "verified"
          ? {
              status: "not_verified",
              reason:
                cause instanceof Error
                  ? cause.message
                  : "Post-operation target identity was not observed.",
            }
          : { status: "verified" };
      failure.retainPartialObservation(
        createEvidence(this.target, IDA_PROVIDER_IDENTITY, {
          predicateType: "analysis-observation",
          operation,
          parameters: context.parameters,
          result: {
            status: "partial",
            failed_operation: operation,
            observations,
            metadata_before: metadataBefore,
            target_binding: binding,
            ...(metadataAfter === undefined
              ? {}
              : { metadata_after: metadataAfter }),
          },
          rawResult: {
            upstream,
            observations,
            metadata_before: metadataBefore,
            ...(metadataAfter === undefined
              ? {}
              : { metadata_after: metadataAfter }),
            ...this.#healthEvidence(),
            post_operation_identity_check: context.postOperationIdentityCheck,
          },
          confidence: "observed",
          authority: "external-service",
          limitations: [
            ...this.#limitations(),
            ...runner.limitations,
            "The requested IDA operation failed after these completed upstream replies; the partial Evidence does not establish a complete result.",
            "Replies are bound to the selected target only by the pre-operation identity check unless post_operation_identity_check is verified.",
          ],
          locations: [
            { kind: "artifact-path", path: this.target.path },
            ...runner.locations,
          ],
          ...(this.profile === undefined
            ? {}
            : { analysisProfile: this.profile }),
        }),
      );
    }
    return err(failure);
  }

  async #start(operation: string): Promise<void> {
    this.#startup ??= this.#initialize();
    try {
      await this.#startup;
    } catch (cause: unknown) {
      if (
        !(cause instanceof AnalysisTimeoutError) &&
        !(cause instanceof AnalysisResourceConstraintError) &&
        !(cause instanceof ProviderAdapterError)
      )
        throw cause;
      // Transport adapters already receive caller attribution in #failure.
      if (
        cause instanceof ProviderAdapterError &&
        cause.operation === "transport"
      )
        throw cause;
      // Startup is shared, but each accepted operation owns its attribution.
      // The shared boundary preserves typed outcome and cleanup facts without
      // mutating the cached startup failure.
      throw analysisClientFailureForOperation(cause, "ida", operation, {
        startup_operation: cause.operation,
        ...("url" in this.config
          ? {
              endpoint: createIdaDiagnosticRedactor(this.config).url(
                this.config.url,
              ),
            }
          : {}),
      }).bindCleanupResourceOwner(cause);
    }
  }

  async #initialize(): Promise<void> {
    const profile = idaCompatibilityProfile(this.config);
    const tools = new Set(await this.connection.connect());
    const protocol = profile.protocol;
    // REA's query bridge implements both reads for the Hex-Rays profile.
    this.#callGraphAdvertised =
      protocol === "hexrays" || tools.has("callgraph");
    this.#surveyAdvertised =
      protocol === "hexrays" || tools.has("survey_binary");
    const expected = {
      native: nativeTools,
      modern: modernTools,
      hexrays: hexRaysTools,
    }[protocol];
    const missing = expected.filter((name) => !tools.has(name));
    if (missing.length > 0) {
      // A registration for another profile can still point at the official
      // server; name the registration that fits instead of a reinstall.
      const servesHexRays =
        protocol !== "hexrays" && hexRaysTools.every((name) => tools.has(name));
      const hexRaysHint = servesHexRays
        ? ' This server serves the Hex-Rays IDA MCP catalog; register it with "mode": "headless" and "protocol": "hexrays".'
        : "";
      const summary =
        protocol === "hexrays"
          ? `IDA MCP Hex-Rays compatibility profile is missing tools: ${missing.join(", ")}. The Hex-Rays profile requires the official Hex-Rays IDA MCP tool catalog. See docs/providers/ida-provider.md.`
          : `IDA MCP ${profile.diagnosticLabel} compatibility profile is missing tools: ${missing.join(", ")}. Attached mode requires the native IDA MCP tool catalog; headless mode requires the database supervisor profile.${hexRaysHint} See docs/providers/ida-provider.md.`;
      // The caller cannot act on a profile mismatch it never sees, so the
      // missing names travel as adapter diagnostics rather than a bare message.
      throw new ProviderAdapterError("ida", "initialize", {
        userMessage: summary,
        diagnostics: {
          reason: summary,
          mode: this.config.mode,
          expected_profile: profile.diagnosticIdentity,
          missing_tools: [...missing],
          advertised_tools: [...tools].sort(),
          recovery: servesHexRays
            ? 'Set "mode": "headless" and "protocol": "hexrays" in the registration; see docs/providers/ida-provider.md.'
            : "Install an IDA MCP build that serves the selected profile; see docs/providers/ida-provider.md.",
        },
      });
    }
    if (this.config.mode === "headless") {
      this.#workspace = await IdaWorkspace.allocate(
        this.target,
        this.config.workspaceRoot,
      );
      await this.#workspace.copyInput();
      const workspace = this.#workspace;
      this.#openAttempted = true;
      const session =
        protocol === "hexrays"
          ? await this.#openHexRays(workspace)
          : await this.#openSupervisor(workspace);
      const inventory = await this.#inventory(workspace);
      this.#lifecycle.push(inventory.raw);
      this.#recordBlockingSessions(
        inventory.sessions.filter(
          (entry) => entry.session_id === session || entry.referencesWorkspace,
        ),
      );
      const entry = inventory.sessions.find(
        ({ session_id }) => session_id === session,
      );
      if (
        entry?.owned !== true ||
        entry.backend !== "worker" ||
        (protocol === "hexrays" && entry.hexrays_backend !== "idalib") ||
        entry.is_active !== true ||
        !sameIdaHostPath(entry.input_path, workspace.inputPath)
      )
        throw new IdaIdentityRefusal(
          "IDA did not return an active owned headless worker for the private input copy.",
          "Configure the supervisor to return an active owned worker for the private input. Confirm retained cleanup before reopening the target.",
          "owned_worker_binding",
        );
      this.#database = session;
    }
    this.#ready = true;
  }

  /** Request the private worker from a database supervisor; returns its session id. */
  async #openSupervisor(workspace: IdaWorkspace): Promise<string> {
    this.#expectedSession = workspace.sessionId;
    const raw = await this.connection.call("idb_open", {
      input_path: workspace.inputPath,
      mode: "force_headless",
      run_auto_analysis: true,
      build_caches: true,
      init_hexrays: true,
      preferred_session_id: workspace.sessionId,
    });
    this.#openCompleted = true;
    // A completed but malformed/positive open may still own a live Worker.
    // Only an explicit producer rejection keeps the old no-worker branch.
    this.#openRejected = rejectedOpenDatabaseSchema.safeParse(raw).success;
    this.#lifecycle.push(raw);
    const opened = openDatabaseSchema.parse(raw);
    if (!sameIdaHostPath(opened.session.input_path, workspace.inputPath))
      throw new IdaIdentityRefusal(
        "IDA opened a different input than the private admitted target copy.",
        "Check the selected input and upstream worker binding. Retry only after retained private-worker cleanup is confirmed.",
        "opened_input",
      );
    if (opened.session.session_id !== workspace.sessionId)
      throw new IdaIdentityRefusal(
        "IDA returned an adopted or unexpected session instead of the requested private worker.",
        "Use an IDA supervisor that honors the requested private worker session ID. Confirm retained cleanup before reopening the target.",
        "worker_session",
      );
    return opened.session.session_id;
  }

  /**
   * Lease an idalib worker for the private input copy. Hex-Rays assigns the
   * instance id, so the binding is the returned id plus its inventory row.
   */
  async #openHexRays(workspace: IdaWorkspace): Promise<string> {
    let raw: JsonValue;
    try {
      raw = await this.connection.call("open_database", {
        path: workspace.inputPath,
        set_current: false,
      });
    } catch (cause: unknown) {
      // A tool error is a completed, explicit rejection; anything else leaves
      // the open's outcome unknown and the workspace retained.
      if (cause instanceof IdaToolRejection) {
        this.#openCompleted = true;
        this.#openRejected = true;
      }
      throw cause;
    }
    this.#openCompleted = true;
    this.#lifecycle.push(raw);
    const opened = hexRaysOpenSchema.parse(raw);
    this.#expectedSession = opened.instance_id;
    if (opened.backend === "idat")
      throw new IdaIdentityRefusal(
        "The Hex-Rays server opened an idat worker. This profile requires idalib.",
        'Set "env": { "IDA_NEXUS_IDALIB_ONLY": "1" } in the Hex-Rays stdio registration, then reopen the target after cleanup.',
        "headless_backend",
      );
    if (opened.backend === "gui")
      throw new AnalysisProtocolError(
        "IDA attached a GUI database instead of a private idalib worker for the private input copy.",
      );
    return opened.instance_id;
  }

  /** Normalize upstream inventory and derive the path scope for release checks. */
  async #inventory(workspace: IdaWorkspace): Promise<{
    readonly raw: JsonValue;
    readonly sessions: readonly InventoriedSession[];
  }> {
    if (idaCompatibilityProfile(this.config).protocol !== "hexrays") {
      const raw = await this.connection.call("idb_list", {});
      return {
        raw,
        sessions: databaseListSchema.parse(raw).sessions.map((entry) => ({
          ...entry,
          referencesWorkspace: sameIdaHostPath(
            entry.input_path,
            workspace.inputPath,
          ),
          released: isReleasedSupervisorWorker(entry),
        })),
      };
    }
    const raw = await this.connection.call("list_databases", {});
    return {
      raw,
      sessions: hexRaysListSchema.parse(raw).instances.map((entry) => ({
        session_id: entry.instance_id ?? "",
        backend: entry.backend === "gui" ? "gui" : "worker",
        owned: entry.instance_id !== null,
        input_path: entry.path,
        is_active:
          entry.status === "unavailable"
            ? null
            : entry.status === "current" || entry.status === "attached",
        hexrays_status: entry.status,
        hexrays_backend: entry.backend,
        // Nexus may list the private database path in place of the input.
        referencesWorkspace:
          isQualifiedCallerPath(entry.path) &&
          isPathWithinRoot(workspace.directory, entry.path),
        // Every listed workspace path blocks release, including unleased rows.
        released: false,
      })),
    };
  }

  async #readHexRaysHealth(
    database: string,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    const observation = await runHexRaysQuery(
      this.connection,
      database,
      "server_health",
      {},
      this.config.timeoutMs,
      signal,
    );
    this.#healthObservations.push(observation);
    return observation.result;
  }

  /** The bridge digest and engine output behind this operation's identity checks. */
  #healthEvidence() {
    return this.#healthObservations.length === 0
      ? {}
      : {
          health_observations: jsonValueSchema.parse(this.#healthObservations),
        };
  }

  async #nativeMetadata(signal?: AbortSignal): Promise<JsonValue> {
    if (this.connection.readResource === undefined)
      throw new AnalysisProtocolError(
        "Native IDA MCP requires resources/read for recorded input metadata.",
      );
    return this.connection.readResource("ida://idb/metadata", { signal });
  }

  async #observe(
    options?: ExecutionOptions,
    onObserved?: (metadata: JsonValue) => void,
  ): Promise<JsonValue> {
    let identity: string;
    if (this.config.mode === "attached") {
      const raw = await this.#nativeMetadata(options?.signal);
      const metadata = attachedMetadataSchema.parse(raw);
      this.#metadata = raw;
      onObserved?.(raw);
      if (metadata.sha256.toLowerCase() !== this.target.sha256.toLowerCase())
        throw new IdaIdentityRefusal(
          `The attached IDA input SHA-256 does not match the selected target ${this.target.path}; open that target in IDA or use headless mode.`,
          "Open the selected original input in IDA, or configure headless mode and reopen the target through REA.",
          "attached_sha256",
        );
      identity = JSON.stringify([
        metadata.path,
        metadata.sha256.toLowerCase(),
        metadata.base,
      ]);
    } else {
      if (this.#database === undefined || this.#workspace === undefined)
        throw new IdaIdentityRefusal(
          "IDA headless session has no database binding.",
          "Close the REA analysis session and reopen the selected target using the configured headless supervisor.",
          "database_binding",
        );
      // Hex-Rays execute_python waits for initial auto-analysis before running.
      const raw =
        idaCompatibilityProfile(this.config).protocol === "hexrays"
          ? await this.#readHexRaysHealth(this.#database, options?.signal)
          : await readSettledHealth(this.connection, {
              database: this.#database,
              timeoutMs: this.config.timeoutMs,
              signal: options?.signal,
            });
      const metadata = modernHealthSchema.parse(raw);
      this.#metadata = raw;
      onObserved?.(raw);
      // A database records the input it was created from and is rewritten by
      // its worker, so the private copy is bound by the opened database path;
      // copyInput already verified the bytes it admitted.
      if (
        this.target.kind === "database"
          ? metadata.idb_path === null ||
            !sameIdaHostPath(metadata.idb_path, this.#workspace.inputPath)
          : !sameIdaHostPath(metadata.input_path, this.#workspace.inputPath) ||
            (metadata.input_sha256 != null &&
              metadata.input_sha256.toLowerCase() !==
                this.#workspace.inputSha256) ||
            (await idaFileDigest(this.#workspace.inputPath)) !==
              this.#workspace.inputSha256
      )
        throw new IdaIdentityRefusal(
          "IDA headless input identity changed after target admission.",
          "Close the REA analysis session, confirm private-worker cleanup, then reopen the selected original target.",
          "headless_input",
        );
      if (metadata.auto_analysis_ready !== true)
        throw new AnalysisCapabilityUnavailableError(
          "ida",
          "server_health",
          metadata.auto_analysis_ready === false
            ? "IDA auto-analysis is incomplete."
            : "IDA auto-analysis readiness is unknown.",
          {
            retryable: metadata.auto_analysis_ready === false,
            remediationAction:
              metadata.auto_analysis_ready === false
                ? "Wait for IDA auto-analysis to complete, then retry the request."
                : "Inspect the upstream IDA worker's analysis readiness before retrying; unknown readiness does not establish active analysis.",
            diagnostics: { auto_analysis_ready: metadata.auto_analysis_ready },
          },
        );
      identity = JSON.stringify([
        this.#database,
        metadata.input_path,
        metadata.idb_path,
        metadata.imagebase,
      ]);
    }
    if (
      this.#initialIdentity !== undefined &&
      identity !== this.#initialIdentity
    )
      throw new IdaIdentityRefusal(
        "The IDA target or image base changed during the REA session; reopen the target.",
        "Close the REA analysis session and reopen the selected target after confirming the intended input and image base in IDA.",
        "session_identity",
      );
    this.#initialIdentity = identity;
    return this.#metadata;
  }

  async close(): Promise<Result<null, AnalysisError>> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    const closing = this.#closeOnce();
    const shared = closing.finally(() => {
      if (this.#closePromise === shared) this.#closePromise = undefined;
    });
    this.#closePromise = shared;
    return shared;
  }

  /**
   * Upstream sessions whose release cleanup has not confirmed: the entries
   * the latest successful inventory found blocking release; else the
   * requested private worker until its close is confirmed, and then none
   * known.
   */
  #unreleasedSessions(): readonly UpstreamSession[] | undefined {
    if (this.#blockingSessions !== undefined) return this.#blockingSessions;
    if (
      !this.#openAttempted ||
      this.#workspace === undefined ||
      this.#openRejected
    )
      return undefined;
    return this.#databaseCloseCompleted
      ? []
      : [
          {
            session_id: this.#expectedSession ?? "",
            backend: "worker",
            owned: null,
            input_path: null,
            is_active: null,
          },
        ];
  }

  /** Drop a session whose release upstream confirmed, keeping other blockers. */
  #forgetReleasedSession(sessionId: string): void {
    const remaining = this.#blockingSessions?.filter(
      ({ session_id }) => session_id !== sessionId,
    );
    this.#blockingSessions =
      remaining !== undefined && remaining.length > 0 ? remaining : undefined;
  }

  /** Replace blocker evidence from a successful inventory; true when blocked. */
  #recordBlockingSessions(
    entries: readonly (UpstreamSession & { readonly owned: boolean })[],
  ): boolean {
    this.#blockingSessions = entries.length > 0 ? entries : undefined;
    return entries.length > 0;
  }

  /** Release the session; false when upstream rejected the release and only inventory can settle it. */
  async #closeDatabase(database: string): Promise<boolean> {
    if (idaCompatibilityProfile(this.config).protocol === "hexrays") {
      try {
        hexRaysCloseSchema.parse(
          await this.connection.call("close_database", {
            instance_id: database,
          }),
        );
        return true;
      } catch (cause: unknown) {
        // A rejected release, such as an already reaped or busy lease, is
        // settled by the inventory read that follows and retried otherwise.
        if (!(cause instanceof IdaToolRejection)) throw cause;
        return false;
      }
    }
    const response = await this.connection.call("idb_close", {
      database,
      save: false,
    });
    const closed = closeDatabaseSchema.safeParse(response);
    if (!closed.success) {
      if (!absentDatabaseCloseSchema(database).safeParse(response).success)
        throw closed.error;
      return true;
    }
    if (
      closed.data.session_id !== database ||
      closed.data.saved === true ||
      closed.data.owned !== true ||
      closed.data.backend !== "worker"
    )
      throw new AnalysisProtocolError(
        "IDA database close did not confirm the requested owned, unsaved session release.",
      );
    return true;
  }

  async #closeOnce(): Promise<Result<null, AnalysisError>> {
    this.#closing = true;
    await this.#tail;
    if (this.#closed) return ok(null);
    try {
      const workspace = this.#workspace;
      if (workspace !== undefined && this.#openAttempted) {
        if (this.#database === undefined) {
          const inventory = await this.#inventory(workspace);
          const expected = this.#expectedSession;
          // REA's own Hex-Rays stdio server leases only what REA opened, so a
          // late lease on the private input is REA's even without a reply id.
          const adoptByPath =
            expected === undefined &&
            idaCompatibilityProfile(this.config).protocol === "hexrays";
          this.#database = inventory.sessions.find(
            (entry) =>
              entry.owned &&
              entry.backend === "worker" &&
              (entry.session_id === expected || adoptByPath) &&
              sameIdaHostPath(entry.input_path, workspace.inputPath),
          )?.session_id;
          // Every same-input session and any entry under the requested ID,
          // whatever its input, stays reported until a later successful
          // inventory confirms release.
          const blocked = this.#recordBlockingSessions(
            inventory.sessions.filter(
              (entry) =>
                entry.session_id === expected || entry.referencesWorkspace,
            ),
          );
          if (this.#database === undefined && blocked)
            throw new AnalysisProtocolError(
              "A registered session still matches the requested ID or private input without a verified private worker binding; the workspace was retained.",
            );
          if (
            this.#database === undefined &&
            this.#openCompleted &&
            !this.#openRejected
          )
            throw new AnalysisProtocolError(
              "IDA open returned without a verified private worker binding. An empty session inventory does not prove that its Worker exited; the private workspace was retained.",
            );
        }
        if (this.#database !== undefined) {
          if (
            !this.#databaseCloseCompleted &&
            (await this.#closeDatabase(this.#database))
          ) {
            this.#databaseCloseCompleted = true;
            this.#forgetReleasedSession(this.#database);
          }
          const inventory = await this.#inventory(workspace);
          const remaining = inventory.sessions.filter(
            (entry) =>
              !entry.released &&
              (entry.session_id === this.#database ||
                entry.referencesWorkspace),
          );
          if (this.#recordBlockingSessions(remaining))
            throw new AnalysisProtocolError(
              "IDA worker remains registered after close.",
            );
          // An unconfirmed close is settled once inventory shows the release.
          this.#databaseCloseCompleted = true;
          this.#database = undefined;
        }
        if (!this.#openCompleted)
          throw new AnalysisProtocolError(
            "IDA database open did not return a completed response. Worker inventory cannot prove that the request has stopped; the private workspace was retained.",
          );
        this.#openAttempted = false;
      }
      await this.connection.close();
      await this.#workspace?.remove();
      this.#closed = true;
      return ok(null);
    } catch (cause: unknown) {
      this.connection.detach();
      const path = this.#workspace?.directory ?? "IDA MCP connection";
      const failure = new IdaCleanupError(
        path,
        cause,
        this.#unreleasedSessions(),
      );
      const client = this;
      // The failure reads this client's later successful close.
      const owner = {
        get cleanupResources() {
          return client.#closed ? [] : [path];
        },
        get cleanupReleased() {
          return client.#closed;
        },
      };
      return err(
        failure.bindCleanupResourceOwner(owner).bindCleanupReleaseClaim(owner),
      );
    }
  }
}
