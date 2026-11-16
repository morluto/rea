import { unknownTarget } from "../../domain/targetIdentity.js";
import { HOST_PLATFORM } from "../../platform/HostPlatform.js";
import { nativeDeadlineRecovery } from "../../domain/native/nativeDeadlines.js";
import { Budget } from "../../domain/budget.js";
import {
  ArtifactResourceScope,
  bindArtifactFileCleanup,
} from "../../resources/index.js";
import {
  ProcessOwnershipInspectionCancelled,
  ProcessOwnershipIdentityBatchFailure,
} from "../../process/ProcessInspectionCancellation.js";
import {
  retainProcessInspectionCleanup,
  processInspectionFailure,
  processInspectionCancellationError,
} from "../../providers/OwnedCommandCleanup.js";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat as statPath } from "node:fs/promises";
import type { Stats } from "node:fs";

import {
  requireAnalysisViewRetention,
  summarizeRetainedAnalysis,
  type AnalysisViewRetention,
} from "../analysisView/AnalysisViewService.js";
import {
  AnalysisAccessDeniedError,
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
  AnalysisOutputError,
  cancelledBy,
  carriedReason,
  OwnerCancellation,
} from "../../domain/analysisErrorCore.js";
import {
  AnalysisError,
  type AnalysisCleanupObservation,
  type AnalysisErrorOptions,
} from "../../domain/analysisErrorBase.js";
import { AnalysisCleanupRelease } from "../../domain/analysisCleanupRelease.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { jsonValueSchema, type JsonValue } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  DEFAULT_REVERSE_COMMAND_TIMEOUT_MS,
  DEFAULT_REVERSE_COMMAND_OUTPUT_BYTES,
  reverseCommandOutputLimit,
  objdumpInputSchema,
  rizinInputSchema,
  type RizinInput,
} from "../../domain/reverseEngineering.js";
import type {
  ReverseEngineeringCommandPort,
  ReverseEngineeringCommandRepair,
  ReverseEngineeringCommandSelection,
  ReverseEngineeringCommandUnavailable,
  ReverseEngineeringProviderCommand,
} from "./ReverseEngineeringCommandPort.js";
import { execFileOutputFailure } from "../../process/ExecFileOutput.js";
import {
  describeLaunchFailure,
  launcherFailureOf,
} from "../../process/launchFailure.js";
import { classifyLaunchFailure } from "../../process/classifyProviderOutcome.js";
import {
  OwnedCommandFailure,
  preparationHostCapacityFailure,
  runOwnedCommand,
} from "../../process/OwnedCommand.js";
import { DarwinProcessOwnershipInspectionError } from "../../process/DarwinProcessRunTokenReader.js";
import {
  DARWIN_PROCESS_OWNERSHIP_REMEDIATION,
  LinuxOwnedProcessPrerequisiteError,
  processOwnershipAdmissionRecovery,
  systemProcessOwnershipHost,
} from "../../process/ProcessOwnershipObservation.js";
import { ProcessAdmissionError } from "../../process/ProcessAdmissionError.js";
import type { ProviderProcessSupervisor } from "../../process/ProviderProcess.js";
import { RuntimeControlUnavailableError } from "../../domain/runtimeControlUnavailableError.js";
import { WindowsNativeAuthorityUnavailableError } from "../../windows/WindowsNativeLoader.js";
import {
  WindowsNativeSpawnControlError,
  windowsNativeSpawnControlError,
} from "../../windows/WindowsOwnedProcess.js";
import { absoluteCallerPath } from "../../filesystem/callerPath.js";
import { parseAnalysisInput } from "../AnalysisInput.js";
import { analysisErrorWithCancellation } from "../../domain/analysisErrorCancellation.js";
import { errorMessage } from "../../kernel/errorMessage.js";

export type ReverseEngineeringOperation =
  | "inspect_with_objdump"
  | "execute_rizin_command";

export interface CommandProviderLaunchFailure {
  readonly reason: string;
  readonly remediation: string;
}

export type CommandProviderLaunchFailures = Readonly<
  Partial<Record<ReverseEngineeringOperation, CommandProviderLaunchFailure>>
>;

interface CommandLaunchOutcome {
  failure:
    | {
        readonly dispatch: number;
        readonly reason: string;
        readonly remediation: string;
      }
    | undefined;
  succeeded: number;
}

const reverseCommandOutputLimitation = (
  bytes: number,
  source: "default" | "request",
): string =>
  `REA stopped collecting output at max_output_bytes=${String(bytes)} bytes (source ${source}) and requested termination of the provider process; captured stdout and stderr are a prefix and command completion is unknown. Narrow or page the provider command, or raise the output_limit control for the next call; no restart is required. Confirm command effects and cleanup before deciding whether it is safe to repeat. Client receive limits are separate.`;
// Bound simultaneous provider process families independently of output admission.
const MAX_CONCURRENT_REVERSE_ENGINEERING_OPERATIONS = 8;
const MAX_ACTIVE_CAPTURE_BYTES =
  MAX_CONCURRENT_REVERSE_ENGINEERING_OPERATIONS *
  DEFAULT_REVERSE_COMMAND_OUTPUT_BYTES;

export interface ReverseEngineeringServiceOptions {
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly commands: ReverseEngineeringCommandPort;
  readonly runOwned?: typeof runOwnedCommand;
  readonly digest?: typeof digestFile;
  readonly stat?: (path: string) => Promise<Stats>;
}

interface ReverseEngineeringCommandRunner {
  (
    command: string,
    arguments_: readonly string[],
    options: {
      readonly env: NodeJS.ProcessEnv;
      readonly signal: AbortSignal | undefined;
      readonly timeout: number;
      readonly maxBuffer: number;
    },
  ): Promise<{
    readonly stdout: string;
    readonly stderr: string;
    readonly stdoutInvalidUtf8?: boolean;
    readonly stderrInvalidUtf8?: boolean;
    readonly stdoutBytes?: number;
    readonly stderrBytes?: number;
    readonly outputTruncated?: boolean;
  }>;
}

export type ReverseEngineeringServiceRuntimeOptions = Omit<
  ReverseEngineeringServiceOptions,
  "commands" | "environment"
>;

/** Resolve one command for shared execution and adapter admission decisions. */
export const resolveRizinCommandRequest = (
  input: unknown,
): Result<RizinInput, AnalysisInputError> => {
  const parsed = rizinInputSchema.safeParse(input);
  return parsed.success
    ? ok(parsed.data)
    : err(
        analysisInputErrorFromIssues(
          "execute_rizin_command",
          parsed.error.issues,
          input,
          { cause: parsed.error },
        ),
      );
};

/** One accepted command, including the controls retained through admission and cleanup. */
interface ReverseCommandObservation {
  readonly operation: ReverseEngineeringOperation;
  readonly profile: ReverseEngineeringProviderCommand;
  readonly path: string | undefined;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number;
  readonly outputBudgetBytes: number;
}

/** A configured command the host search did not find; nothing was launched. */
const reverseCommandUnavailable = (
  operation: ReverseEngineeringOperation,
  unavailable: ReverseEngineeringCommandUnavailable,
): AnalysisCapabilityUnavailableError => {
  const { command, reason, repair } = unavailable;
  const { provider, remediationAction } = repair;
  return new AnalysisCapabilityUnavailableError(
    unavailable.identity.id,
    operation,
    reason.kind === "not_found"
      ? "Configured command was not found on PATH"
      : `Configured command could not be searched on PATH (invalid PATHEXT entry ${JSON.stringify(reason.extension)})`,
    {
      userMessage:
        reason.kind === "not_found"
          ? `Could not find the selected ${provider} command ${JSON.stringify(command)} on PATH; REA did not search the current directory.`
          : `Could not search PATH for the selected ${provider} command ${JSON.stringify(command)}: PATHEXT entry ${JSON.stringify(reason.extension)} is not a filename extension.`,
      remediationAction:
        reason.kind === "not_found"
          ? remediationAction
          : `Remove ${JSON.stringify(reason.extension)} from PATHEXT, or ${remediationAction.charAt(0).toLowerCase()}${remediationAction.slice(1)}`,
      diagnostics: {
        boundary: "provider-lookup",
        command,
        lookup_failure: reason.kind,
        ...(reason.kind === "invalid_pathext"
          ? { pathext_entry: reason.extension }
          : {}),
      },
    },
  );
};

/** Shared application workflow for caller-selected local analysis commands. */
export class ReverseEngineeringService {
  readonly #environment: Readonly<NodeJS.ProcessEnv>;
  readonly #commands: ReverseEngineeringCommandPort;
  readonly #run: ReverseEngineeringCommandRunner;
  readonly #digest: typeof digestFile;
  readonly #stat: (path: string) => Promise<Stats>;
  readonly #inspectionResources = new ArtifactResourceScope();
  readonly #pendingCleanup = new Map<
    ProviderProcessSupervisor,
    {
      readonly observation: AnalysisCleanupObservation;
      /** Confirmed by a later verified stop; retry failures read it. */
      readonly release: AnalysisCleanupRelease;
      readonly retryFailure?: AnalysisError;
    }
  >();
  readonly #activeOperations = new Map<
    AbortController,
    Promise<Result<Evidence, AnalysisError>>
  >();
  /** Output capture admitted across active operations. */
  readonly #reservedOutput = new Budget(MAX_ACTIVE_CAPTURE_BYTES);
  #closing = false;
  #closePromise: Promise<void> | undefined;
  #dispatched = 0;
  readonly #outcomes = new Map<
    ReverseEngineeringOperation,
    CommandLaunchOutcome
  >();

  constructor(options: ReverseEngineeringServiceOptions) {
    this.#environment = { ...(options.environment ?? process.env) };
    this.#commands = options.commands;
    this.#run = runOwnedCommandOutput(
      options.runOwned ?? runOwnedCommand,
      (owner, cleanup) =>
        this.#pendingCleanup.set(owner, {
          observation: cleanup,
          release:
            this.#pendingCleanup.get(owner)?.release ??
            new AnalysisCleanupRelease(),
        }),
    );
    this.#digest = options.digest ?? digestFile;
    this.#stat = options.stat ?? statPath;
  }

  /** Ask retained process owners to settle cleanup before admitting more work. */
  async retryCleanup(
    operation = "reverse_engineering_cleanup",
  ): Promise<Result<null, AnalysisError>> {
    let failure: AnalysisError | undefined;
    try {
      await this.#inspectionResources.retryCleanup();
    } catch (cause: unknown) {
      failure = new AnalysisOutputError(
        operation,
        "Process inspection cleanup remains incomplete.",
        {
          cause,
          cleanup: {
            reason: "Process inspection cleanup remains incomplete.",
            resources: this.#inspectionResources.cleanupResources,
          },
        },
      );
      bindArtifactFileCleanup(cause, failure);
    }
    for (const [owner, retained] of this.#pendingCleanup) {
      let stopped: Awaited<ReturnType<ProviderProcessSupervisor["stop"]>>;
      try {
        stopped = await owner.stop();
      } catch (cause) {
        stopped = {
          status: "incomplete",
          reason: errorMessage(cause),
        };
      }
      if (stopped.status === "incomplete") {
        const observation = {
          reason: stopped.reason,
          resources: retained.observation.resources,
        };
        let retryFailure = retained.retryFailure;
        if (retryFailure === undefined) {
          retryFailure = retained.release.bind(
            new AnalysisOutputError(
              operation,
              "A previous provider process still requires cleanup.",
              { cleanup: observation },
            ),
          );
        }
        this.#pendingCleanup.set(owner, {
          observation,
          release: retained.release,
          retryFailure,
        });
        if (failure === undefined) failure = retryFailure;
      } else {
        retained.release.confirm();
        this.#pendingCleanup.delete(owner);
      }
    }
    return failure === undefined ? ok(null) : err(failure);
  }

  /** Retry cleanup for provider process groups retained after an incomplete stop. */
  #outcome(operation: ReverseEngineeringOperation): CommandLaunchOutcome {
    const existing = this.#outcomes.get(operation);
    if (existing !== undefined) return existing;
    const created: CommandLaunchOutcome = { failure: undefined, succeeded: 0 };
    this.#outcomes.set(operation, created);
    return created;
  }

  /**
   * Record that this dispatch could not run the configured command, unless a
   * later dispatch has already succeeded or failed.
   */
  #recordUnavailable(
    operation: ReverseEngineeringOperation,
    dispatch: number,
    failure: AnalysisCapabilityUnavailableError,
    repair: ReverseEngineeringCommandRepair,
  ): void {
    const outcome = this.#outcome(operation);
    if (
      (outcome.failure === undefined || dispatch > outcome.failure.dispatch) &&
      dispatch > outcome.succeeded
    )
      outcome.failure = {
        dispatch,
        reason: failure.userMessage ?? failure.message,
        remediation: failure.remediationAction ?? repair.remediationAction,
      };
  }

  /** Current launch failures observed for caller-configured standalone tools. */
  observedLaunchFailures(): CommandProviderLaunchFailures {
    const result: Partial<
      Record<ReverseEngineeringOperation, CommandProviderLaunchFailure>
    > = {};
    for (const [operation, outcome] of this.#outcomes) {
      if (
        outcome.failure !== undefined &&
        outcome.failure.dispatch > outcome.succeeded
      ) {
        result[operation] = {
          reason: outcome.failure.reason,
          remediation: outcome.failure.remediation,
        };
      }
    }
    return result;
  }

  /** Forget runtime launch outcomes observed for standalone tools. */
  clearObservedFailures(): void {
    this.#outcomes.clear();
  }

  close(): Promise<void> {
    this.#closing = true;
    this.#closePromise ??= this.#closeActiveOperationsAndCleanup().catch(
      (cause: unknown) => {
        this.#closePromise = undefined;
        throw cause;
      },
    );
    return this.#closePromise;
  }

  async #closeActiveOperationsAndCleanup(): Promise<void> {
    const active = [...this.#activeOperations.entries()];
    for (const [controller] of active)
      controller.abort(OwnerCancellation.ownerClosed);
    await Promise.allSettled(active.map(([, operation]) => operation));

    const cleanup = await this.retryCleanup();
    if (!cleanup.ok) throw cleanup.error;
  }

  async inspectWithObjdump(
    rawInput: unknown,
    options: { readonly signal?: AbortSignal } = {},
    retention: AnalysisViewRetention = {
      evidenceById: undefined,
      recordEvidence: undefined,
    },
  ): Promise<Result<Evidence, AnalysisError>> {
    const parsed = parseAnalysisInput(
      "inspect_with_objdump",
      rawInput,
      objdumpInputSchema,
    );
    if (!parsed.ok) return parsed;
    const {
      detail,
      command_timeout_ms: commandTimeoutMs,
      max_output_bytes: maxOutputBytes,
      ...input
    } = parsed.value;
    if (detail === "summary") {
      const ready = requireAnalysisViewRetention(
        "inspect_with_objdump",
        retention,
      );
      if (!ready.ok) return ready;
    }
    const selection = this.#commands.objdump(input);
    let parameters: Readonly<Record<string, JsonValue>>;
    if (input.operation === "disassemble") {
      const { symbol, ...base } = input;
      parameters = symbol === undefined ? base : { ...base, symbol };
    } else parameters = input;
    if (commandTimeoutMs !== undefined)
      parameters = { ...parameters, command_timeout_ms: commandTimeoutMs };
    if (maxOutputBytes !== undefined)
      parameters = { ...parameters, max_output_bytes: maxOutputBytes };
    const observed = await this.#observe({
      operation: "inspect_with_objdump",
      selection,
      path: input.operation === "architectures" ? undefined : input.path,
      parameters,
      signal: options.signal,
      timeoutMs: commandTimeoutMs ?? DEFAULT_REVERSE_COMMAND_TIMEOUT_MS,
      outputBudgetBytes: maxOutputBytes ?? DEFAULT_REVERSE_COMMAND_OUTPUT_BYTES,
    });
    return observed.ok && detail === "summary"
      ? summarizeRetainedAnalysis(observed.value, retention)
      : observed;
  }

  executeRizinCommand(
    rawInput: unknown,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Result<Evidence, AnalysisError>> {
    const parsed = resolveRizinCommandRequest(rawInput);
    return parsed.ok
      ? this.executeRizinCommandValidated(parsed.value, options)
      : Promise.resolve(parsed);
  }

  /** Execute owner-validated input after the adapter has admitted its target. */
  executeRizinCommandValidated(
    request: RizinInput,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Result<Evidence, AnalysisError>> {
    const {
      command_timeout_ms: commandTimeoutMs,
      max_output_bytes: maxOutputBytes,
      ...input
    } = request;
    return this.#observe({
      operation: "execute_rizin_command",
      selection: this.#commands.rizin(input),
      path: input.path,
      parameters: request,
      signal: options.signal,
      timeoutMs: commandTimeoutMs ?? DEFAULT_REVERSE_COMMAND_TIMEOUT_MS,
      outputBudgetBytes: maxOutputBytes ?? DEFAULT_REVERSE_COMMAND_OUTPUT_BYTES,
    });
  }

  #observe({
    selection,
    ...request
  }: Omit<ReverseCommandObservation, "profile"> & {
    readonly selection: ReverseEngineeringCommandSelection;
  }): Promise<Result<Evidence, AnalysisError>> {
    const { operation, signal, outputBudgetBytes } = request;
    if (signal?.aborted)
      return Promise.resolve(err(cancelledBy(operation, signal)));
    if (this.#closing)
      return Promise.resolve(
        err(
          new AnalysisOutputError(
            operation,
            "Reverse-engineering service is closed.",
          ),
        ),
      );
    // A command the host search did not find is this dispatch's outcome:
    // discovery reports it like a launch failure until a later success.
    if (!selection.ok) {
      const refusal = reverseCommandUnavailable(operation, selection.error);
      this.#recordUnavailable(
        operation,
        ++this.#dispatched,
        refusal,
        selection.error.repair,
      );
      return Promise.resolve(err(refusal));
    }
    if (
      this.#activeOperations.size >=
        MAX_CONCURRENT_REVERSE_ENGINEERING_OPERATIONS ||
      !this.#reservedOutput.tryCharge(outputBudgetBytes)
    )
      return Promise.resolve(
        err(
          new AnalysisResourceConstraintError(
            operation,
            "transport",
            `Reverse-engineering capture capacity reached (${String(MAX_CONCURRENT_REVERSE_ENGINEERING_OPERATIONS)} operations or ${String(MAX_ACTIVE_CAPTURE_BYTES)} reserved output bytes).`,
            {
              max_concurrent_operations:
                MAX_CONCURRENT_REVERSE_ENGINEERING_OPERATIONS,
              active_operations: this.#activeOperations.size,
              max_active_capture_bytes: MAX_ACTIVE_CAPTURE_BYTES,
              reserved_output_bytes: this.#reservedOutput.used,
              requested_output_bytes: outputBudgetBytes,
            },
            {
              retryable: true,
              remediationAction: `Wait for active objdump or rizin work to finish, then retry, or lower max_output_bytes to fit the ${String(MAX_ACTIVE_CAPTURE_BYTES)}-byte aggregate capture admission. This live capacity has no runtime override; command_timeout_ms does not raise it. No restart is required.`,
            },
          ),
        ),
      );
    const controller = new AbortController();
    const relayAbort = (): void => controller.abort(signal?.reason);
    if (signal instanceof AbortSignal) {
      if (signal.aborted) relayAbort();
      else signal.addEventListener("abort", relayAbort, { once: true });
    }
    const operationSignal =
      signal === undefined || signal instanceof AbortSignal
        ? controller.signal
        : signal;
    const running = this.#observeProvider({
      ...request,
      profile: selection.value,
      signal: operationSignal,
    });
    const tracked = running
      .then((result) =>
        !result.ok && operationSignal?.aborted
          ? err(
              analysisErrorWithCancellation(
                result.error,
                cancelledBy(operation, operationSignal),
              ),
            )
          : result,
      )
      .finally(() => {
        signal?.removeEventListener("abort", relayAbort);
        this.#activeOperations.delete(controller);
        this.#reservedOutput.refund(outputBudgetBytes);
      });
    this.#activeOperations.set(controller, tracked);
    return tracked;
  }

  async #observeProvider(
    request: ReverseCommandObservation,
  ): Promise<Result<Evidence, AnalysisError>> {
    const {
      operation,
      profile,
      path,
      parameters,
      signal,
      timeoutMs,
      outputBudgetBytes,
    } = request;
    const { executable: command, arguments: args } = profile;
    const { provider, setting } = profile.repair;
    if (signal?.aborted) return err(cancelledBy(operation, signal));
    const cleanup = await this.retryCleanup(operation);
    if (!cleanup.ok) return cleanup;
    const absolutePath =
      path === undefined ? undefined : absoluteCallerPath(path);
    let digest: string | undefined;
    try {
      if (absolutePath !== undefined)
        digest = await this.#digest(
          absolutePath,
          signal,
          this.#stat,
          timeoutMs,
        );
    } catch (cause) {
      const code = commandFailureCode(cause);
      if (preflightCancelled(signal, cause, code))
        return err(
          cancelledBy(
            operation,
            carriedReason(callerCancellationCause(signal, cause)),
          ),
        );
      if (code === "EACCES" || code === "EPERM") {
        const deniedPath = absolutePath === undefined ? command : absolutePath;
        return err(
          new AnalysisAccessDeniedError(operation, deniedPath, code, {
            cause,
          }),
        );
      }
      if (code === "ETIMEDOUT")
        return err(
          new AnalysisTimeoutError(operation, timeoutMs, {
            cause,
            ...reverseCommandTimeoutGuidance(provider, timeoutMs),
          }),
        );
      if (
        code !== "ENOENT" &&
        code !== "ENOTDIR" &&
        code !== "EINVAL" &&
        code !== "ELOOP" &&
        code !== "ENAMETOOLONG"
      ) {
        if (cause instanceof AnalysisError) return err(cause);
        return err(
          new ProviderAdapterError(profile.identity.id, operation, {
            cause,
            diagnostics: {
              phase: "target_preflight",
              ...(code === undefined ? {} : { system_code: code }),
            },
          }),
        );
      }
      const targetReason =
        code === "EINVAL"
          ? "The selected target is not a regular file."
          : code === "ELOOP"
            ? "The selected target path contains a symbolic-link loop."
            : code === "ENAMETOOLONG"
              ? "The selected target path is too long."
              : "The selected target was not found.";
      return err(
        new AnalysisInputError(
          operation,
          {
            cause,
            userMessage: `${targetReason} Selected path: ${absolutePath}. Check the path and choose a readable regular file before retrying.`,
          },
          [
            {
              path: ["path"],
              reason: "invalid_value",
              message: `${targetReason}${code === undefined ? "" : ` (host error ${code})`}`,
            },
          ],
        ),
      );
    }
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let exitCode: number | string | null = 0;
    let signalName: string | null = null;
    let outputTruncated = false;
    let stdoutInvalidUtf8 = false;
    let stderrInvalidUtf8 = false;
    let cleanupIncomplete = false;
    let cleanupOnlyFailure = false;
    let completionStatus: "complete" | "rejected" | "unknown" = "complete";
    let outputLimitReached = false;
    let failure: AnalysisError | undefined;
    let cleanupOwner: ProviderProcessSupervisor | undefined;
    let earlyFailure: AnalysisError | undefined;
    const dispatch = ++this.#dispatched;
    try {
      const output = await this.#run(command, args, {
        env: {
          ...this.#environment,
          ...profile.environmentOverrides,
        },
        signal,
        timeout: timeoutMs,
        maxBuffer: outputBudgetBytes,
      });
      stdout = output.stdout;
      stderr = output.stderr;
      stdoutBytes = output.stdoutBytes ?? Buffer.byteLength(stdout);
      stderrBytes = output.stderrBytes ?? Buffer.byteLength(stderr);
      stdoutInvalidUtf8 = output.stdoutInvalidUtf8 === true;
      stderrInvalidUtf8 = output.stderrInvalidUtf8 === true;
      outputTruncated = output.outputTruncated === true;
    } catch (cause) {
      const ownedCause =
        cause instanceof OwnedOutputFailure ? cause.cause : cause;
      const inspection = processInspectionFailure(ownedCause);
      if (
        inspection !== undefined &&
        !(inspection instanceof DarwinProcessOwnershipInspectionError)
      ) {
        const cancellation = processInspectionCancellationError(
          ownedCause,
          operation,
        );
        earlyFailure =
          ownedCause instanceof OwnedCommandFailure &&
          ownedCause.reason === "timeout"
            ? new AnalysisTimeoutError(operation, timeoutMs, {
                cause: ownedCause,
                ...reverseCommandTimeoutGuidance(provider, timeoutMs),
              })
            : inspection instanceof ProcessOwnershipInspectionCancelled ||
                (inspection instanceof ProcessOwnershipIdentityBatchFailure &&
                  inspection.origin === "cancelled")
              ? cancellation
              : new ProviderAdapterError("process-ownership", operation, {
                  cause: inspection,
                  diagnostics: { stage: "ownership_preparation" },
                });
      }
      cleanupOwner =
        cause instanceof OwnedOutputFailure ? cause.cleanupOwner : undefined;
      if (
        cause instanceof OwnedOutputFailure &&
        cause.capabilityError !== undefined
      )
        earlyFailure = new AnalysisCapabilityUnavailableError(
          cause.capabilityError.providerId,
          cause.capabilityError.operation,
          cause.capabilityError.reason,
          {
            cause: cause.capabilityError,
            ...(cause.capabilityError.diagnostics === undefined
              ? {}
              : { diagnostics: cause.capabilityError.diagnostics }),
            ...(cause.capabilityError.capturedOutput === undefined
              ? {}
              : { capturedOutput: cause.capabilityError.capturedOutput }),
            ...(cause.capabilityError.partialObservation === undefined
              ? {}
              : {
                  partialObservation: cause.capabilityError.partialObservation,
                }),
            ...(cause.capabilityError.userMessage === undefined
              ? {}
              : { userMessage: cause.capabilityError.userMessage }),
            retryable: cause.capabilityError.retryable,
            ...ownedCleanupOptions(cause),
          },
        );
      const capture = execFileOutputFailure(cause);
      const code =
        capture?.code ??
        commandFailureCode(cause) ??
        (cause instanceof LinuxOwnedProcessPrerequisiteError
          ? (execFileOutputFailure(cause.cause)?.code ??
            commandFailureCode(cause.cause))
          : undefined);
      if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
        outputLimitReached = true;
      // Host capacity and an oversized argument list are classified by the
      // shared launch owner; a refusal keeps this provider's repair below.
      const launch =
        preparationHostCapacityFailure(ownedCause) ??
        launcherFailureOf(
          cause instanceof LinuxOwnedProcessPrerequisiteError
            ? cause.cause
            : cause,
        );
      if (
        earlyFailure === undefined &&
        (launch?.kind === "host-exhausted" || launch?.kind === "argument-list")
      )
        earlyFailure = classifyLaunchFailure(launch, {
          providerId: profile.identity.id,
          operation,
          command,
          selection: setting,
          argumentBytes: args.reduce(
            (bytes, argument, index) =>
              bytes + Buffer.byteLength(argument) + (index === 0 ? 0 : 1),
            0,
          ),
          details: { cause, ...ownedCleanupOptions(cause) },
        });
      if (
        earlyFailure === undefined &&
        cause instanceof LinuxOwnedProcessPrerequisiteError
      ) {
        earlyFailure = cause;
      }
      const admissionFailure =
        cause instanceof ProcessAdmissionError
          ? cause
          : cause instanceof OwnedOutputFailure &&
              cause.cause instanceof ProcessAdmissionError
            ? cause.cause
            : undefined;
      if (earlyFailure === undefined && admissionFailure !== undefined) {
        const rawSystemCode =
          admissionFailure.detail?.system_code ??
          (typeof admissionFailure.cause === "object" &&
          admissionFailure.cause !== null
            ? (execFileOutputFailure(admissionFailure.cause)?.code ??
              commandFailureCode(admissionFailure.cause))
            : undefined);
        const admissionSystemCode =
          typeof rawSystemCode === "string" ? rawSystemCode : undefined;
        const recovery = processOwnershipAdmissionRecovery(
          admissionFailure.code,
          systemProcessOwnershipHost.platform ?? HOST_PLATFORM.platform,
          admissionSystemCode,
        );
        earlyFailure = new AnalysisCapabilityUnavailableError(
          "process-ownership",
          "prepare_owned_process",
          `Process ownership admission failed (${admissionFailure.code}${admissionSystemCode === undefined ? "" : `, ${admissionSystemCode}`}) before starting ${provider}: ${admissionFailure.message}`,
          {
            cause,
            userMessage: `Process ownership admission failed (${admissionFailure.code}${admissionSystemCode === undefined ? "" : `, ${admissionSystemCode}`}) before starting ${provider}.`,
            remediationAction: `${recovery} ${setting} does not need to change.`,
            diagnostics: {
              boundary: "process-ownership",
              admission_code: admissionFailure.code,
              ...(admissionSystemCode === undefined
                ? {}
                : { system_code: admissionSystemCode }),
            },
            ...ownedCleanupOptions(cause),
          },
        );
      }
      const darwinFailure =
        inspection instanceof DarwinProcessOwnershipInspectionError
          ? inspection
          : undefined;
      if (earlyFailure === undefined && darwinFailure !== undefined) {
        if (code === "ETIMEDOUT") {
          earlyFailure = new AnalysisTimeoutError(operation, timeoutMs, {
            cause,
            ...reverseCommandTimeoutGuidance(provider, timeoutMs),
          });
        } else if (darwinFailure.cancellation !== undefined) {
          earlyFailure = cancelledBy(
            operation,
            carriedReason(darwinFailure.cancellation?.reason),
          );
        } else {
          earlyFailure = new AnalysisCapabilityUnavailableError(
            "process-ownership",
            "prepare_owned_process",
            `Darwin process ownership inspection could not be prepared: ${darwinFailure.message}`,
            {
              cause,
              userMessage: darwinFailure.message,
              remediationAction: `${DARWIN_PROCESS_OWNERSHIP_REMEDIATION} ${setting} does not need to change.`,
              diagnostics: {
                boundary: "process-ownership",
                stage: "ownership_preparation",
                ...(darwinFailure.compilerOutcome === undefined
                  ? {}
                  : {
                      compiler_outcome: jsonValueSchema.parse(
                        darwinFailure.compilerOutcome,
                      ),
                    }),
              },
              ...(darwinFailure.capturedOutput === undefined
                ? {}
                : { capturedOutput: darwinFailure.capturedOutput }),
            },
          );
        }
      }
      if (inspection !== undefined && earlyFailure !== undefined)
        earlyFailure = retainProcessInspectionCleanup(
          inspection,
          earlyFailure,
          this.#inspectionResources,
          operation,
        );
      const controlFailure = runtimeControlPreparationError(cause);
      if (
        earlyFailure === undefined &&
        controlFailure !== undefined &&
        code !== "ETIMEDOUT" &&
        !commandCancelled(signal, cause, code)
      ) {
        const remediation =
          controlFailure.remediationAction === undefined
            ? `${setting} does not need to change.`
            : `${controlFailure.remediationAction} ${setting} does not need to change.`;
        earlyFailure = new AnalysisCapabilityUnavailableError(
          "process-ownership",
          "prepare_owned_process",
          controlFailure.message,
          {
            cause,
            retryable: controlFailure.retryable,
            userMessage: controlFailure.message,
            remediationAction: remediation,
            diagnostics: {
              boundary: "process-ownership",
              control_code: controlFailure.code,
              ...(controlFailure instanceof
              WindowsNativeAuthorityUnavailableError
                ? { failure_stage: controlFailure.failureStage }
                : {}),
              ...(controlFailure instanceof WindowsNativeSpawnControlError &&
              controlFailure.constraint !== undefined
                ? { constraint: controlFailure.constraint }
                : {}),
            },
            ...ownedCleanupOptions(cause),
          },
        );
      }
      if (
        earlyFailure === undefined &&
        (capture === undefined ||
          (cause instanceof OwnedOutputFailure && cause.launchFailure) ||
          code === "ENOENT" ||
          code === "EACCES" ||
          code === "EPERM" ||
          code === "ERR_PROVIDER_LAUNCH")
      ) {
        if (commandCancelled(signal, cause, code))
          earlyFailure = cancelledBy(
            operation,
            carriedReason(callerCancellationCause(signal, cause)),
            { ...ownedCleanupOptions(cause) },
          );
        else if (code === "ETIMEDOUT")
          earlyFailure = new AnalysisTimeoutError(operation, timeoutMs, {
            cause,
            ...ownedCleanupOptions(cause),
            ...reverseCommandTimeoutGuidance(provider, timeoutMs),
          });
        else {
          const { provider, remediationAction } = profile.repair;
          // This provider's repair names the configured executable; the
          // shared launch owner supplies the errno and syscall facts.
          const unavailable = (
            description: string,
            details: AnalysisErrorOptions,
          ): AnalysisError =>
            new AnalysisCapabilityUnavailableError(
              profile.identity.id,
              operation,
              `Unable to run configured command (${description})`,
              {
                ...details,
                userMessage: `Could not launch the selected ${provider} executable ${JSON.stringify(command)} (${description}).`,
                remediationAction,
              },
            );
          const details: AnalysisErrorOptions = {
            cause,
            ...ownedCleanupOptions(cause),
          };
          earlyFailure =
            launch === undefined
              ? unavailable(String(code ?? "unknown error"), {
                  ...details,
                  diagnostics: {
                    boundary: "provider-launch",
                    command,
                    system_code: code ?? null,
                  },
                })
              : classifyLaunchFailure(launch, {
                  providerId: profile.identity.id,
                  operation,
                  command,
                  selection: setting,
                  details,
                  unavailable: (failure, launchDetails) =>
                    unavailable(describeLaunchFailure(failure), launchDetails),
                });
        }
      }
      if (earlyFailure === undefined && capture !== undefined) {
        stdout = capture.stdout;
        stderr = capture.stderr;
        stdoutBytes = capture.stdoutBytes ?? Buffer.byteLength(stdout);
        stderrBytes = capture.stderrBytes ?? Buffer.byteLength(stderr);
        exitCode = capture.code;
        signalName = capture.signal;
        outputTruncated = capture.outputTruncated;
        if (capture.collectionFailure) {
          exitCode = null;
          completionStatus = "unknown";
        }
        const capturedOutput = {
          stdout,
          stderr,
          truncated: outputTruncated,
          stdout_bytes: stdoutBytes,
          stderr_bytes: stderrBytes,
          exit_code:
            !capture.collectionFailure && typeof capture.code === "number"
              ? capture.code
              : null,
          signal: capture.signal,
        };
        if (commandCancelled(signal, cause, code))
          failure = cancelledBy(
            operation,
            carriedReason(callerCancellationCause(signal, cause)),
            { capturedOutput, ...ownedCleanupOptions(cause) },
          );
        else if (code === "ETIMEDOUT")
          failure = new AnalysisTimeoutError(operation, timeoutMs, {
            cause,
            capturedOutput,
            ...ownedCleanupOptions(cause),
            ...reverseCommandTimeoutGuidance(provider, timeoutMs),
          });
        if (
          cause instanceof OwnedOutputFailure &&
          cause.cleanup !== undefined
        ) {
          cleanupIncomplete = true;
          if (failure === undefined) {
            cleanupOnlyFailure =
              !capture.collectionFailure &&
              !capture.outputTruncated &&
              !capture.killed &&
              capture.signal === null &&
              typeof capture.code === "number" &&
              !signal?.aborted;
            failure = new AnalysisOutputError(
              operation,
              "Provider process cleanup remains incomplete.",
              {
                cause,
                capturedOutput,
                cleanup: cause.cleanup,
                cleanupOnly: cleanupOnlyFailure,
              },
            );
          }
        }
        if (
          failure === undefined &&
          cause instanceof OwnedOutputFailure &&
          cause.collectionFailure
        )
          failure = new AnalysisOutputError(
            operation,
            "Provider output collection failed.",
            { cause, capturedOutput },
          );
        if (
          capture.killed ||
          capture.signal !== null ||
          typeof capture.code !== "number"
        ) {
          exitCode = null;
          completionStatus = "unknown";
        }
        if (cause instanceof OwnedOutputFailure) {
          stdoutInvalidUtf8 = cause.stdoutInvalidUtf8;
          stderrInvalidUtf8 = cause.stderrInvalidUtf8;
        }
      }
    }
    if (earlyFailure !== undefined) {
      if (
        earlyFailure instanceof AnalysisCapabilityUnavailableError &&
        earlyFailure.diagnostics?.boundary === "provider-launch" &&
        earlyFailure.providerId === profile.identity.id
      ) {
        this.#recordUnavailable(
          operation,
          dispatch,
          earlyFailure,
          profile.repair,
        );
      }
      return err(this.#registerCleanupFailure(earlyFailure, cleanupOwner));
    }
    if (failure !== undefined && cleanupOwner !== undefined)
      failure = this.#registerCleanupFailure(failure, cleanupOwner);
    let digestAfter: string | null = null;
    if (absolutePath === undefined) {
      digestAfter = null;
    } else if (cleanupIncomplete) {
      if (!cleanupOnlyFailure) completionStatus = "unknown";
    } else {
      try {
        digestAfter = await this.#digest(
          absolutePath,
          signal,
          this.#stat,
          timeoutMs,
        );
      } catch {
        // Preserve the provider's collected observations if the artifact vanished or became unreadable.
      }
    }
    if (signal?.aborted && failure === undefined) {
      failure = cancelledBy(operation, signal, {
        capturedOutput: {
          stdout,
          stderr,
          truncated: outputTruncated,
          stdout_bytes: stdoutBytes,
          stderr_bytes: stderrBytes,
          exit_code: typeof exitCode === "number" ? exitCode : null,
          signal: signalName,
        },
      });
      exitCode = null;
      completionStatus = "unknown";
    }
    const artifactChanged =
      absolutePath === undefined
        ? null
        : digestAfter === null || digest === undefined
          ? null
          : digestAfter !== digest;
    const outputBudgetSource =
      parameters.max_output_bytes === undefined ? "default" : "request";
    // Only a completed process's diagnostics can establish a refusal; partial
    // or failed captures keep their unknown completion.
    const rejection =
      completionStatus === "complete" &&
      (failure === undefined ||
        (failure instanceof AnalysisOutputError && failure.cleanupOnly))
        ? profile.rejection?.(stderr)
        : undefined;
    if (rejection !== undefined) completionStatus = "rejected";
    const result = {
      stdout,
      stderr,
      exit_code: exitCode,
      signal: signalName,
      output_budget_bytes: outputBudgetBytes,
      output_budget_source: outputBudgetSource,
      output_truncated: outputTruncated,
      ...(outputLimitReached
        ? { output_limit: reverseCommandOutputLimit(outputBudgetBytes) }
        : {}),
      completion_status: completionStatus,
      artifact_sha256_after: absolutePath === undefined ? null : digestAfter,
      artifact_changed: absolutePath === undefined ? null : artifactChanged,
      ...(rejection === undefined ? {} : { refusal: rejection.refusal }),
    };
    const limitations = [
      // A pathless command reports no artifact; its provider says what the
      // response does not establish.
      ...(absolutePath === undefined
        ? []
        : [
            "The executable implementation, version and supported formats are unknown because no reliable identity probe was performed.",
          ]),
      ...(profile.limitations ?? []),
      "A non-zero process exit is preserved as an observed command result.",
      ...(rejection === undefined ? [] : [rejection.limitation]),
      ...(stdoutInvalidUtf8 || stderrInvalidUtf8
        ? [
            `Captured ${[
              ...(stdoutInvalidUtf8 ? ["stdout"] : []),
              ...(stderrInvalidUtf8 ? ["stderr"] : []),
            ].join(
              " and ",
            )} bytes contain invalid or incomplete UTF-8; replacement characters in the text capture do not preserve the original bytes.`,
          ]
        : []),
      ...(outputLimitReached
        ? [
            reverseCommandOutputLimitation(
              outputBudgetBytes,
              outputBudgetSource,
            ),
          ]
        : outputTruncated
          ? [
              "Captured provider output is partial because bytes were omitted; process completion is reported separately.",
            ]
          : []),
      ...(signalName === null || outputLimitReached
        ? []
        : [
            `The provider process terminated by signal ${signalName}; captured output may be partial and command completion is unknown.`,
          ]),
      ...(failure === undefined ||
      (failure instanceof AnalysisOutputError && failure.cleanupOnly)
        ? []
        : [
            `Command completion is unknown because the operation failed with ${failure._tag}: ${failure.message}`,
          ]),
      ...(absolutePath === undefined
        ? []
        : [
            "When both are available, pre-run and post-run digests detect artifact changes across the provider call but cannot prove the exact bytes consumed during the call.",
          ]),
      ...(artifactChanged === true
        ? [
            "The provider command may have changed the artifact while analysis was running; pre-run and post-run digests are both reported.",
          ]
        : []),
      ...(absolutePath !== undefined && digestAfter === null
        ? [
            cleanupIncomplete
              ? "The post-run artifact digest was not captured because owned provider cleanup was incomplete at observation time; artifact changes during the command remain unquantified."
              : signal?.aborted
                ? "The post-run artifact digest is unknown because cancellation interrupted the digest."
                : "The post-run artifact digest is unknown because the artifact could not be read after the provider call.",
          ]
        : []),
    ];
    const evidence = createEvidence(
      absolutePath === undefined || digest === undefined
        ? unknownTarget("not-observed")
        : { path: absolutePath, sha256: digest, format: "unknown" },
      profile.identity,
      {
        predicateType: "rea.reverse-engineering.command-observation",
        operation,
        parameters: {
          ...(absolutePath === undefined
            ? {
                operation: "architectures",
                ...(typeof parameters.max_output_bytes === "number"
                  ? { max_output_bytes: parameters.max_output_bytes }
                  : {}),
                ...(typeof parameters.command_timeout_ms === "number"
                  ? { command_timeout_ms: parameters.command_timeout_ms }
                  : {}),
              }
            : parameters),
          provider_executable: command,
          command_arguments: [...args],
        },
        rawResult: result,
        result,
        limitations,
        ...(absolutePath === undefined
          ? {}
          : {
              locations: [
                { kind: "artifact-path" as const, path: absolutePath },
              ],
            }),
      },
    );
    if (
      failure?._tag !== "AnalysisCancelledError" &&
      failure?._tag !== "AnalysisTimeoutError"
    ) {
      const outcome = this.#outcome(operation);
      outcome.succeeded = Math.max(outcome.succeeded, dispatch);
    }
    return failure === undefined
      ? ok(evidence)
      : err(failure.retainPartialObservation(evidence));
  }

  #registerCleanupFailure(
    failure: AnalysisError,
    cleanupOwner: ProviderProcessSupervisor | undefined,
  ): AnalysisError {
    if (cleanupOwner !== undefined && failure.cleanupIncomplete)
      this.#pendingCleanup.get(cleanupOwner)?.release.bind(failure);
    return failure;
  }
}

interface OwnedOutputFailureOptions {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | string | null;
  readonly signal: string | null;
  readonly outputTruncated: boolean;
  readonly stdoutInvalidUtf8: boolean;
  readonly stderrInvalidUtf8: boolean;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly capabilityError?: AnalysisCapabilityUnavailableError;
  readonly collectionFailure?: boolean;
  readonly cleanup?: AnalysisCleanupObservation;
  readonly cleanupOwner?: ProviderProcessSupervisor;
  readonly cause?: unknown;
  readonly launchFailure?: boolean;
}

class OwnedOutputFailure extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | string | null;
  readonly signal: string | null;
  readonly outputTruncated: boolean;
  readonly stdoutInvalidUtf8: boolean;
  readonly stderrInvalidUtf8: boolean;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly capabilityError: AnalysisCapabilityUnavailableError | undefined;
  readonly collectionFailure: boolean;
  readonly cleanup: AnalysisCleanupObservation | undefined;
  readonly cleanupOwner: ProviderProcessSupervisor | undefined;
  readonly launchFailure: boolean;

  constructor(options: OwnedOutputFailureOptions) {
    super("Owned provider command did not produce a complete result.", {
      cause: options.cause,
    });
    this.stdout = options.stdout;
    this.stderr = options.stderr;
    this.code = options.code;
    this.signal = options.signal;
    this.outputTruncated = options.outputTruncated;
    this.stdoutInvalidUtf8 = options.stdoutInvalidUtf8;
    this.stderrInvalidUtf8 = options.stderrInvalidUtf8;
    this.stdoutBytes = options.stdoutBytes;
    this.stderrBytes = options.stderrBytes;
    this.capabilityError = options.capabilityError;
    this.collectionFailure = options.collectionFailure ?? false;
    this.cleanup = options.cleanup;
    this.cleanupOwner = options.cleanupOwner;
    this.launchFailure = options.launchFailure ?? false;
  }
}

const runOwnedCommandOutput =
  (
    runOwned: typeof runOwnedCommand,
    onCleanupOwner: (
      owner: ProviderProcessSupervisor,
      cleanup: AnalysisCleanupObservation,
    ) => void,
  ): ReverseEngineeringCommandRunner =>
  async (command, args, options) => {
    const spawnEnv = { ...options.env };
    try {
      const snapshot = await runOwned(
        {
          command,
          arguments: [...args],
          runId: randomUUID(),
          expectedCommand: null,
          env: spawnEnv,
          hostEnvironment: {},
          sweepTokenOwnedProcesses: true,
        },
        {
          timeoutMs: options.timeout,
          diagnosticBytes: options.maxBuffer,
          acceptNonZeroExit: true,
        },
        { signal: options.signal },
      );
      if (snapshot.signal !== null && snapshot.signal !== undefined)
        throw new OwnedOutputFailure({
          stdout: snapshot.stdout.text,
          stderr: snapshot.stderr.text,
          code: snapshot.exitCode ?? null,
          signal: snapshot.signal,
          outputTruncated: snapshot.diagnosticTruncated === true,
          stdoutInvalidUtf8: snapshot.stdout.invalidUtf8 === true,
          stderrInvalidUtf8: snapshot.stderr.invalidUtf8 === true,
          stdoutBytes: snapshot.stdout.bytes,
          stderrBytes: snapshot.stderr.bytes,
        });
      if (snapshot.exitCode !== 0)
        throw new OwnedOutputFailure({
          stdout: snapshot.stdout.text,
          stderr: snapshot.stderr.text,
          code: snapshot.exitCode ?? null,
          signal: null,
          outputTruncated: snapshot.diagnosticTruncated === true,
          stdoutInvalidUtf8: snapshot.stdout.invalidUtf8 === true,
          stderrInvalidUtf8: snapshot.stderr.invalidUtf8 === true,
          stdoutBytes: snapshot.stdout.bytes,
          stderrBytes: snapshot.stderr.bytes,
        });
      return {
        stdout: snapshot.stdout.text,
        stderr: snapshot.stderr.text,
        outputTruncated: snapshot.diagnosticTruncated === true,
        stdoutInvalidUtf8: snapshot.stdout.invalidUtf8 === true,
        stderrInvalidUtf8: snapshot.stderr.invalidUtf8 === true,
        stdoutBytes: snapshot.stdout.bytes,
        stderrBytes: snapshot.stderr.bytes,
      };
    } catch (cause) {
      if (!(cause instanceof OwnedCommandFailure)) throw cause;
      if (cause.cleanupOwner !== undefined && cause.cleanupFailure !== null)
        onCleanupOwner(cause.cleanupOwner, {
          reason: cause.cleanupFailure,
          resources: cause.resources,
        });
      const snapshot = cause.snapshot;
      const launchErrorCode =
        cause.cause instanceof Error
          ? Reflect.get(cause.cause, "code")
          : undefined;
      const code =
        cause.reason === "cancelled"
          ? "ABORT_ERR"
          : cause.reason === "timeout"
            ? "ETIMEDOUT"
            : cause.reason === "output-limit"
              ? "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
              : snapshot === null
                ? typeof launchErrorCode === "string"
                  ? launchErrorCode
                  : "ERR_PROVIDER_LAUNCH"
                : (snapshot.exitCode ?? null);
      throw new OwnedOutputFailure({
        stdout: snapshot?.stdout.text ?? "",
        stderr: snapshot?.stderr.text ?? "",
        code,
        launchFailure: cause.reason === "process" && snapshot === null,
        signal: snapshot?.signal ?? null,
        outputTruncated: snapshot?.diagnosticTruncated === true,
        stdoutInvalidUtf8: snapshot?.stdout.invalidUtf8 === true,
        stderrInvalidUtf8: snapshot?.stderr.invalidUtf8 === true,
        stdoutBytes: snapshot?.stdout.bytes ?? 0,
        stderrBytes: snapshot?.stderr.bytes ?? 0,
        ...(cause.cause instanceof AnalysisCapabilityUnavailableError
          ? { capabilityError: cause.cause }
          : {}),
        ...(cause.collectionFailure ? { collectionFailure: true } : {}),
        ...(cause.cleanupFailure === null
          ? {}
          : {
              cleanup: {
                reason: cause.cleanupFailure,
                resources: cause.resources,
              },
            }),
        ...(cause.cleanupOwner === undefined
          ? {}
          : { cleanupOwner: cause.cleanupOwner }),
        cause,
      });
    }
  };

const ownedCleanupOptions = (
  cause: unknown,
): { readonly cleanup?: AnalysisCleanupObservation } =>
  cause instanceof OwnedOutputFailure && cause.cleanup !== undefined
    ? { cleanup: cause.cleanup }
    : {};

const runtimeControlPreparationError = (
  cause: unknown,
): RuntimeControlUnavailableError | undefined => {
  if (cause instanceof RuntimeControlUnavailableError) return cause;
  if (cause instanceof OwnedOutputFailure)
    return runtimeControlPreparationError(cause.cause);
  if (cause instanceof OwnedCommandFailure && cause.reason === "process")
    return runtimeControlPreparationError(cause.cause);
  return windowsNativeSpawnControlError(cause);
};

/**
 * The deadline failure names `command_timeout_ms` and binds it as the
 * per-call control; each adapter names the option that sets it.
 */
const reverseCommandTimeoutGuidance = (provider: string, timeoutMs: number) =>
  nativeDeadlineRecovery({
    timeoutMs,
    parameter: "command_timeout_ms",
    defaultMs: DEFAULT_REVERSE_COMMAND_TIMEOUT_MS,
    phase: `${provider} command deadline`,
    unchanged: `No restart is required. The combined output allowance is separately selected by max_output_bytes (default ${String(DEFAULT_REVERSE_COMMAND_OUTPUT_BYTES)} bytes).`,
    detail:
      " It covers target preflight and the one-shot command (deadlineExpired); it is not a Ghidra or Hopper startup deadline or a debugger session deadline.",
  });

export const digestFile = async (
  path: string,
  signal?: AbortSignal,
  stat: (path: string) => Promise<Stats> = statPath,
  timeoutMs: number = DEFAULT_REVERSE_COMMAND_TIMEOUT_MS,
  open: (
    path: string,
  ) => ReturnType<typeof createReadStream> = createReadStream,
): Promise<string> => {
  const startedAt = performance.now();
  const info = await statWithDeadline(path, signal, stat, timeoutMs);
  if (!info.isFile())
    throw Object.assign(new Error("Artifact digest requires a regular file"), {
      code: "EINVAL",
    });
  const remainingMs = Math.max(
    0,
    Math.ceil(timeoutMs - (performance.now() - startedAt)),
  );
  if (remainingMs === 0)
    throw Object.assign(new Error("Artifact digest timed out"), {
      code: "ETIMEDOUT",
    });
  return new Promise<string>((resolveDigest, rejectDigest) => {
    const hash = createHash("sha256");
    const stream = open(path);
    const timer = setTimeout(
      () =>
        stream.destroy(
          Object.assign(new Error("Artifact digest timed out"), {
            code: "ETIMEDOUT",
          }),
        ),
      remainingMs,
    );
    const abort = (): void => {
      stream.destroy(
        cancelledBy("artifact_digest", carriedReason(signal?.reason)),
      );
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    if (signal?.aborted) {
      cleanup();
      stream.destroy();
      rejectDigest(cancelledBy("artifact_digest", signal));
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    stream.on("data", (chunk: Buffer | string) => hash.update(chunk));
    stream.once("error", (cause: Error) => {
      cleanup();
      rejectDigest(cause);
    });
    stream.once("end", () => {
      cleanup();
      resolveDigest(hash.digest("hex"));
    });
  });
};

const PHYSICAL_FAILURE_CODES = new Set([
  "EACCES",
  "EPERM",
  "ETIMEDOUT",
  "ENOENT",
  "ENOTDIR",
  "EINVAL",
  "ELOOP",
  "ENAMETOOLONG",
  "E2BIG",
  "EBUSY",
  "ERR_PROVIDER_LAUNCH",
]);

/**
 * A late abort does not replace a recognized physical failure. Other rejections
 * observed while the caller signal is aborted remain cancellation; a bare
 * `ABORT_ERR` without the caller's abort is not.
 */
const preflightCancelled = (
  signal: AbortSignal | undefined,
  cause: unknown,
  code: string | number | undefined,
): boolean => {
  if (cause instanceof AnalysisCancelledError) return true;
  if (signal?.aborted !== true) return false;
  if (cause === signal.reason) return true;
  return typeof code !== "string" || !PHYSICAL_FAILURE_CODES.has(code);
};

const commandCancelled = (
  signal: AbortSignal | undefined,
  cause: unknown,
  code: string | number | undefined,
): boolean => {
  if (
    cause instanceof OwnedOutputFailure &&
    cause.cause instanceof OwnedCommandFailure
  )
    return cause.cause.reason === "cancelled";
  return preflightCancelled(signal, cause, code);
};

const callerCancellationCause = (
  signal: AbortSignal | undefined,
  cause: unknown,
): unknown => (signal?.aborted === true ? signal.reason : cause);

const commandFailureCode = (cause: unknown): string | number | undefined => {
  if (typeof cause !== "object" || cause === null) return undefined;
  const code: unknown = Reflect.get(cause, "code");
  return typeof code === "string" || typeof code === "number"
    ? code
    : undefined;
};

const statWithDeadline = (
  path: string,
  signal: AbortSignal | undefined,
  stat: (path: string) => Promise<Stats>,
  timeoutMs: number,
): Promise<Stats> => {
  if (signal?.aborted)
    return Promise.reject(cancelledBy("artifact_digest", signal));
  return new Promise<Stats>((resolveStat, rejectStat) => {
    let settled = false;
    const finish = (outcome: Result<Stats, unknown>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (outcome.ok) resolveStat(outcome.value);
      else rejectStat(outcome.error);
    };
    const abort = (): void =>
      finish(
        err(cancelledBy("artifact_digest", carriedReason(signal?.reason))),
      );
    const timer = setTimeout(
      () =>
        finish(
          err(
            Object.assign(new Error("Artifact stat timed out"), {
              code: "ETIMEDOUT",
            }),
          ),
        ),
      timeoutMs,
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    // Promise handlers stay attached after timeout/cancellation so a delayed
    // stat rejection is observed and cannot become an unhandled rejection.
    try {
      void stat(path).then(
        (info) => finish(ok(info)),
        (cause: unknown) => finish(err(cause)),
      );
    } catch (cause) {
      finish(err(cause));
    }
  });
};
