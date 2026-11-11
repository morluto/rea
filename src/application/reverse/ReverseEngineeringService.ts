import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { bindArtifactFileCleanup } from "../../artifacts/ArtifactFileOperation.js";
import {
  ProcessOwnershipInspectionCancelled,
  ProcessOwnershipIdentityBatchFailure,
} from "../../process/ProcessInspectionCancellation.js";
import type { ProcessInspectionFailure } from "../../process/ProcessInspectionCleanup.js";
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
} from "../../domain/analysisErrorCore.js";
import {
  AnalysisError,
  type AnalysisCapturedOutput,
  type AnalysisCleanupObservation,
} from "../../domain/analysisErrorBase.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { jsonValueSchema, type JsonValue } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  DEFAULT_REVERSE_COMMAND_TIMEOUT_MS,
  DEFAULT_REVERSE_COMMAND_OUTPUT_BYTES,
  MAX_REVERSE_COMMAND_OUTPUT_BYTES,
  MAX_REVERSE_COMMAND_TIMEOUT_MS,
  objdumpInputSchema,
  type ProviderToolIdentification,
  rizinInputSchema,
  type RizinInput,
} from "../../domain/reverseEngineering.js";
import type {
  ReverseEngineeringCommandPort,
  ReverseEngineeringProviderCommand,
} from "./ReverseEngineeringCommandPort.js";
import {
  capturedInvalidUtf8,
  execFileFailureCapturedOutput,
  execFileOutput,
  execFileOutputFailure,
  HOST_SPAWN_CAPACITY_CODES,
} from "../../process/ExecFileOutput.js";
import {
  OwnedCommandFailure,
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
import { boundedUtf8Text } from "../../process/boundedUtf8Text.js";
import {
  lookupExecutable,
  searchesDiffer,
  searchMovesPast,
} from "../../process/ExecutableLookup.js";
import {
  fileDeadline,
  type FileStepOutcome,
} from "../../process/FileDeadline.js";
import { RuntimeControlUnavailableError } from "../../process/RuntimeControlUnavailableError.js";
import { WindowsNativeAuthorityUnavailableError } from "../../windows/WindowsNativeLoader.js";
import {
  WindowsNativeSpawnControlError,
  windowsNativeSpawnControlError,
} from "../../windows/WindowsOwnedProcess.js";
import { absoluteCallerPath } from "../../filesystem/callerPath.js";
import { parseAnalysisInput } from "../AnalysisInput.js";
import { analysisErrorWithCancellation } from "../../domain/analysisErrorCancellation.js";

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
  `REA stopped collecting output at max_output_bytes=${String(bytes)} bytes (source ${source}, default ${String(DEFAULT_REVERSE_COMMAND_OUTPUT_BYTES)}, range 1..${String(MAX_REVERSE_COMMAND_OUTPUT_BYTES)}) and requested termination of the provider process; captured stdout and stderr are a prefix and command completion is unknown. Narrow or page the provider command, or increase max_output_bytes (--max-output-bytes on the CLI) for the next call; no restart is required. Confirm command effects and cleanup before deciding whether it is safe to repeat. Client receive limits are separate.`;
// Bound simultaneous provider process families independently of output admission.
const MAX_CONCURRENT_REVERSE_ENGINEERING_OPERATIONS = 8;
const MAX_ACTIVE_CAPTURE_BYTES =
  MAX_CONCURRENT_REVERSE_ENGINEERING_OPERATIONS *
  DEFAULT_REVERSE_COMMAND_OUTPUT_BYTES;

export interface ReverseEngineeringServiceOptions {
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly commands: ReverseEngineeringCommandPort;
  /** Defaults to the host's PATH lookup and owned process execution. */
  readonly processes?: ReverseEngineeringProcesses;
  readonly digest?: typeof digestFile;
  readonly stat?: (path: string) => Promise<Stats>;
}

/**
 * The process boundary: where a provider command resolves and how it runs.
 * Lookup and execution are replaced together, so a fake runner never consults
 * the host PATH.
 */
export type ReverseEngineeringProcesses =
  | {
      readonly lookup: typeof lookupExecutable;
      /** Replaces execution and output capture. */
      readonly run: ReverseEngineeringCommandRunner;
      readonly runOwned?: undefined;
    }
  | {
      readonly lookup: typeof lookupExecutable;
      /** Replaces the owned process primitive under the service's capture. */
      readonly runOwned: typeof runOwnedCommand;
      readonly run?: undefined;
    };

const HOST_PROCESSES: ReverseEngineeringProcesses = {
  lookup: lookupExecutable,
  runOwned: runOwnedCommand,
};

interface ReverseEngineeringCommandRunner {
  (
    command: string,
    arguments_: readonly string[],
    options?: Parameters<typeof execFileOutput>[2],
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

/** Shared application workflow for caller-selected local analysis commands. */
export class ReverseEngineeringService {
  readonly #environment: Readonly<NodeJS.ProcessEnv>;
  readonly #commands: ReverseEngineeringCommandPort;
  readonly #lookup: typeof lookupExecutable;
  readonly #run: ReverseEngineeringCommandRunner;
  readonly #digest: typeof digestFile;
  readonly #stat: (path: string) => Promise<Stats>;
  readonly #inspectionResources = new ArtifactResourceScope();
  readonly #pendingCleanup = new Map<
    RetainedCleanupOwner,
    {
      readonly observation: AnalysisCleanupObservation;
      readonly failures: Set<AnalysisError>;
      readonly retryFailure?: AnalysisError;
    }
  >();
  readonly #activeOperations = new Map<
    AbortController,
    Promise<Result<Evidence, AnalysisError>>
  >();
  #reservedOutputBytes = 0;
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
    const processes = options.processes ?? HOST_PROCESSES;
    this.#lookup = processes.lookup;
    this.#run =
      processes.run === undefined
        ? runOwnedCommandOutput(processes.runOwned, (owner, cleanup) =>
            this.#pendingCleanup.set(owner, {
              observation: cleanup,
              failures: this.#pendingCleanup.get(owner)?.failures ?? new Set(),
            }),
          )
        : processes.run;
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
          reason: cause instanceof Error ? cause.message : String(cause),
        };
      }
      if (stopped.status === "incomplete") {
        const observation = {
          reason: stopped.reason,
          resources: retained.observation.resources,
        };
        let retryFailure = retained.retryFailure;
        if (retryFailure === undefined) {
          retryFailure = new AnalysisOutputError(
            operation,
            "A previous provider process still requires cleanup.",
            { cleanup: observation },
          );
          retained.failures.add(retryFailure);
        }
        this.#pendingCleanup.set(owner, {
          observation,
          failures: retained.failures,
          retryFailure,
        });
        if (failure === undefined) failure = retryFailure;
      } else {
        for (const previous of retained.failures) previous.resolveCleanup();
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
    for (const [controller] of active) controller.abort();
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
    const command = this.#commands.objdump(input);
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
      profile: command,
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
    const command = this.#commands.rizin(input);
    return this.#observe({
      operation: "execute_rizin_command",
      profile: command,
      path: input.path,
      parameters: request,
      signal: options.signal,
      timeoutMs: commandTimeoutMs ?? DEFAULT_REVERSE_COMMAND_TIMEOUT_MS,
      outputBudgetBytes: maxOutputBytes ?? DEFAULT_REVERSE_COMMAND_OUTPUT_BYTES,
    });
  }

  #observe(
    request: ReverseCommandObservation,
  ): Promise<Result<Evidence, AnalysisError>> {
    const { operation, signal, outputBudgetBytes } = request;
    if (signal?.aborted)
      return Promise.resolve(
        err(new AnalysisCancelledError(operation, { cause: signal.reason })),
      );
    if (this.#closing)
      return Promise.resolve(
        err(
          new AnalysisOutputError(
            operation,
            "Reverse-engineering service is closed.",
          ),
        ),
      );
    if (
      this.#activeOperations.size >=
        MAX_CONCURRENT_REVERSE_ENGINEERING_OPERATIONS ||
      this.#reservedOutputBytes + outputBudgetBytes > MAX_ACTIVE_CAPTURE_BYTES
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
              reserved_output_bytes: this.#reservedOutputBytes,
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
    this.#reservedOutputBytes += outputBudgetBytes;
    const running = this.#observeProvider({
      ...request,
      signal: operationSignal,
    });
    const tracked = running
      .then((result) =>
        !result.ok && operationSignal?.aborted
          ? err(
              analysisErrorWithCancellation(
                result.error,
                new AnalysisCancelledError(operation, {
                  cause: operationSignal.reason,
                }),
              ),
            )
          : result,
      )
      .finally(() => {
        signal?.removeEventListener("abort", relayAbort);
        this.#activeOperations.delete(controller);
        this.#reservedOutputBytes -= outputBudgetBytes;
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
    const hash = (file: string): Promise<string> =>
      this.#digest(file, { signal, timeoutMs, stat: this.#stat });
    if (signal?.aborted)
      return err(
        new AnalysisCancelledError(operation, { cause: signal.reason }),
      );
    const cleanup = await this.retryCleanup(operation);
    if (!cleanup.ok) return cleanup;
    const absolutePath =
      path === undefined ? undefined : absoluteCallerPath(path);
    let digest: string | undefined;
    try {
      if (absolutePath !== undefined) digest = await hash(absolutePath);
    } catch (cause) {
      const code = commandFailureCode(cause);
      if (preflightCancelled(signal, cause, code))
        return err(
          new AnalysisCancelledError(operation, {
            cause: callerCancellationCause(signal, cause),
          }),
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
            ...reverseCommandTimeoutGuidance(timeoutMs),
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
    const environment = {
      ...this.#environment,
      ...profile.environmentOverrides,
    };
    const identified = await this.#identifyProvider(
      operation,
      profile,
      environment,
      signal,
      timeoutMs,
      outputBudgetBytes,
      hash,
    );
    // An error before Evidence exists keeps the executable the caller
    // selected and the target it already resolved and hashed.
    const selection = {
      provider_executable: command,
      ...(absolutePath === undefined || digest === undefined
        ? {}
        : { artifact_path: absolutePath, artifact_sha256: digest }),
    };
    if (!identified.ok)
      return err(identified.error.retainDiagnostics(selection));
    const identification = identified.value;
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
    let completionStatus: "complete" | "unknown" = "complete";
    let outputLimitReached = false;
    let failure: AnalysisError | undefined;
    let cleanupOwner: RetainedCleanupOwner | undefined;
    let earlyFailure: AnalysisError | undefined;
    const dispatch = ++this.#dispatched;
    try {
      const output = await this.#run(identification.executable, args, {
        env: environment,
        signal,
        timeout: timeoutMs,
        stopSignal: "SIGTERM",
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
      )
        earlyFailure = ownershipPreparationError(
          inspection,
          cause,
          undefined,
          operation,
          timeoutMs,
        );
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
      if (earlyFailure === undefined && code === "E2BIG")
        earlyFailure = new AnalysisResourceConstraintError(
          operation,
          "transport",
          "The host rejected the provider command because its argument list exceeds the process launch limit.",
          {
            argument_bytes: args.reduce(
              (bytes, argument, index) =>
                bytes + Buffer.byteLength(argument) + (index === 0 ? 0 : 1),
              0,
            ),
          },
          { cause, ...ownedCleanupOptions(cause) },
        );
      if (
        earlyFailure === undefined &&
        typeof code === "string" &&
        HOST_SPAWN_CAPACITY_CODES.has(code)
      ) {
        const provider =
          operation === "inspect_with_objdump" ? "objdump" : "rizin";
        const setting =
          operation === "inspect_with_objdump"
            ? "REA_OBJDUMP_COMMAND"
            : "REA_RIZIN_COMMAND";
        earlyFailure = new AnalysisResourceConstraintError(
          operation,
          "capacity",
          `The host ran out of process, memory or file-descriptor capacity (${code}) to start ${provider}.`,
          { spawn_error: code, command },
          {
            cause,
            retryable: true,
            remediationAction: `The host ran out of process, memory or file-descriptor capacity (${code}). Close unused processes or files, or raise the process or open-file limit of the REA process, then retry; ${setting} does not need to change.`,
            diagnostics: {
              boundary: "host-capacity",
              command,
              system_code: code,
            },
            ...ownedCleanupOptions(cause),
          },
        );
      }
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
        const provider =
          operation === "inspect_with_objdump" ? "objdump" : "rizin";
        const setting =
          operation === "inspect_with_objdump"
            ? "REA_OBJDUMP_COMMAND"
            : "REA_RIZIN_COMMAND";
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
          systemProcessOwnershipHost.platform ?? process.platform,
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
      if (
        earlyFailure === undefined &&
        inspection instanceof DarwinProcessOwnershipInspectionError
      )
        earlyFailure = ownershipPreparationError(
          inspection,
          cause,
          code,
          operation,
          timeoutMs,
        );
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
        const setting =
          operation === "inspect_with_objdump"
            ? "REA_OBJDUMP_COMMAND"
            : "REA_RIZIN_COMMAND";
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
          earlyFailure = new AnalysisCancelledError(operation, {
            cause: callerCancellationCause(signal, cause),
            ...ownedCleanupOptions(cause),
          });
        else if (code === "ETIMEDOUT")
          earlyFailure = new AnalysisTimeoutError(operation, timeoutMs, {
            cause,
            ...ownedCleanupOptions(cause),
            ...reverseCommandTimeoutGuidance(timeoutMs),
          });
        else {
          const provider =
            operation === "inspect_with_objdump" ? "objdump" : "rizin";
          const setting =
            provider === "objdump"
              ? "REA_OBJDUMP_COMMAND"
              : "REA_RIZIN_COMMAND";
          earlyFailure = new AnalysisCapabilityUnavailableError(
            profile.identity.id,
            operation,
            `Unable to run configured command (${String(code ?? "unknown error")})`,
            {
              cause,
              userMessage: `Could not launch the selected ${provider} executable ${JSON.stringify(command)} (${String(code ?? "unknown error")}).`,
              remediationAction: `Set ${setting} to an installed executable ${provider === "objdump" ? "GNU objdump" : "Rizin"} command, or make that command available on PATH. Check execute permission on the command and search permission on its parent directories before retrying.`,
              diagnostics: {
                boundary: "provider-launch",
                command,
                system_code: code ?? null,
              },
              ...ownedCleanupOptions(cause),
            },
          );
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
          ...capturedInvalidUtf8(capture),
        };
        if (commandCancelled(signal, cause, code))
          failure = new AnalysisCancelledError(operation, {
            cause: callerCancellationCause(signal, cause),
            capturedOutput,
            ...ownedCleanupOptions(cause),
          });
        else if (code === "ETIMEDOUT")
          failure = new AnalysisTimeoutError(operation, timeoutMs, {
            cause,
            capturedOutput,
            ...ownedCleanupOptions(cause),
            ...reverseCommandTimeoutGuidance(timeoutMs),
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
        stdoutInvalidUtf8 = capture.stdoutInvalidUtf8 === true;
        stderrInvalidUtf8 = capture.stderrInvalidUtf8 === true;
      }
    }
    if (earlyFailure !== undefined) {
      // Without command output there is no Evidence to carry the selection
      // and what the lookup, hash and probe observed, so the failure keeps
      // them.
      earlyFailure.retainDiagnostics(
        identification.observed
          ? {
              provider: identification.identity,
              ...selection,
              ...identification.parameters,
            }
          : selection,
      );
      if (
        earlyFailure instanceof AnalysisCapabilityUnavailableError &&
        earlyFailure.diagnostics?.boundary === "provider-launch" &&
        earlyFailure.providerId === profile.identity.id
      ) {
        const outcome = this.#outcome(operation);
        if (
          (outcome.failure === undefined ||
            dispatch > outcome.failure.dispatch) &&
          dispatch > outcome.succeeded
        ) {
          outcome.failure = {
            dispatch,
            reason: earlyFailure.userMessage ?? earlyFailure.message,
            remediation:
              earlyFailure.remediationAction ??
              `Set ${operation === "inspect_with_objdump" ? "REA_OBJDUMP_COMMAND" : "REA_RIZIN_COMMAND"} to an installed executable command.`,
          };
        }
      }
      return err(this.#registerCleanupFailure(earlyFailure, cleanupOwner));
    }
    if (failure !== undefined && cleanupOwner !== undefined)
      failure = this.#registerCleanupFailure(failure, cleanupOwner);
    let digestAfter: string | null = null;
    let digestAfterTimedOut = false;
    if (absolutePath === undefined) {
      digestAfter = null;
    } else if (cleanupIncomplete) {
      if (!cleanupOnlyFailure) completionStatus = "unknown";
    } else {
      try {
        digestAfter = await hash(absolutePath);
      } catch (cause) {
        // Preserve the provider's collected observations if the artifact vanished,
        // became unreadable or its hash reached the deadline.
        digestAfterTimedOut = commandFailureCode(cause) === "ETIMEDOUT";
      }
    }
    if (signal?.aborted && failure === undefined) {
      failure = new AnalysisCancelledError(operation, {
        cause: signal.reason,
        capturedOutput: {
          stdout,
          stderr,
          truncated: outputTruncated,
          stdout_bytes: stdoutBytes,
          stderr_bytes: stderrBytes,
          exit_code: typeof exitCode === "number" ? exitCode : null,
          signal: signalName,
          ...capturedInvalidUtf8({ stdoutInvalidUtf8, stderrInvalidUtf8 }),
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
    const result = {
      stdout,
      stderr,
      exit_code: exitCode,
      signal: signalName,
      output_budget_bytes: outputBudgetBytes,
      output_budget_source: outputBudgetSource,
      output_truncated: outputTruncated,
      completion_status: completionStatus,
      artifact_sha256_after: absolutePath === undefined ? null : digestAfter,
      artifact_changed: absolutePath === undefined ? null : artifactChanged,
    };
    const limitations = [
      ...(absolutePath === undefined
        ? [
            "The objdump implementation and version are unknown. The captured output is the selected command's response and does not establish support for an artifact.",
          ]
        : identification.limitations),
      "A non-zero process exit is preserved as an observed command result.",
      ...(operation === "inspect_with_objdump" &&
      typeof parameters.symbol === "string"
        ? [
            "Disassembly is scoped to the caller-selected symbol using the provider's matching and symbol-boundary semantics; an empty match does not establish artifact-wide absence.",
          ]
        : []),
      ...(operation === "inspect_with_objdump" &&
      parameters.operation === "dwarf" &&
      parameters.follow_debug_links === true
        ? [
            "DWARF output may include local debug-link files whose identities are not bound to Evidence.",
          ]
        : []),
      ...(operation === "execute_rizin_command"
        ? [
            "Rizin commands and retained plugins may read files or access network resources outside the selected artifact; those external inputs are not bound to Evidence.",
          ]
        : []),
      ...(profile.limitations ?? []),
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
                : digestAfterTimedOut
                  ? postRunArtifactDigestDeadline(timeoutMs)
                  : POST_RUN_ARTIFACT_UNREADABLE,
          ]
        : []),
    ];
    const evidence = createEvidence(
      absolutePath === undefined || digest === undefined
        ? undefined
        : { path: absolutePath, sha256: digest, format: "unknown" },
      identification.identity,
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
          ...identification.parameters,
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

  /**
   * Resolve, hash and identify the selected executable, then run that same
   * path. Every call probes, in its environment and under its deadline: a
   * launcher keeps its path and digest while the tool it runs can change. A
   * tool that cannot be identified still runs; only cancellation, the call's
   * deadline and a probe whose process cleanup remains incomplete stop the
   * command.
   */
  async #identifyProvider(
    operation: ReverseEngineeringOperation,
    profile: ReverseEngineeringProviderCommand,
    environment: NodeJS.ProcessEnv,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    outputBudgetBytes: number,
    hash: (file: string) => Promise<string>,
  ): Promise<Result<ProviderIdentification, AnalysisError>> {
    const probe = profile.versionProbe;
    // Without an identifying banner, a probed provider's name is assumed.
    const unidentified = (
      reason: string,
      executable = profile.executable,
      // What the lookup, hash and probe observed; absent when the lookup
      // found no executable.
      observed?: Readonly<Record<string, JsonValue>>,
    ): ProviderIdentification => ({
      executable,
      identity: profile.identity,
      limitations: [
        `The executable implementation, version and supported formats are unknown because ${reason}.`,
        ...(observed?.provider_executable_sha256 === undefined
          ? []
          : [EXECUTABLE_OBSERVATION_TIMING]),
        ...(probe === undefined ? [] : [probe.assumedIdentity]),
      ],
      parameters:
        probe === undefined
          ? {}
          : { ...observed, provider_identity: "assumed" },
      observed: observed !== undefined,
    });
    if (probe === undefined)
      return ok(unidentified("no reliable identity probe was performed"));
    const lookup = await this.#lookup(
      profile.executable,
      () => process.cwd(),
      environment.PATH,
      { signal, timeoutMs },
    );
    if (lookup.status === "interrupted") {
      // The path being checked names the PATH location that stalled.
      const diagnostics = {
        phase: "executable_lookup",
        executable_lookup_candidate: lookup.candidate,
      };
      return err(
        lookup.by === "cancellation"
          ? new AnalysisCancelledError(operation, {
              cause: signal?.reason,
              diagnostics,
            })
          : new AnalysisTimeoutError(operation, timeoutMs, {
              diagnostics,
              ...reverseCommandTimeoutGuidance(timeoutMs),
            }),
      );
    }
    // The command runs the path the host refused to inspect, so a launch
    // failure keeps where access must be granted.
    if (lookup.status === "denied")
      return ok(
        unidentified(
          `the executable could not be inspected (${lookup.code})`,
          lookup.path,
          { provider_executable_path: lookup.path },
        ),
      );
    // The command launch reports an executable that cannot be selected. It
    // runs as the caller spelled it, which can launch where the absolute
    // spelling of an explicit selection is too long to inspect, and Evidence
    // or a launch failure keeps where the lookup looked and where it stopped.
    if (lookup.status !== "found") {
      const missing = lookup.status === "missing" ? lookup : undefined;
      const stopped = missing?.stoppedAt;
      const denied = missing?.deniedAt;
      const cwdCode =
        lookup.status === "no-working-directory"
          ? commandFailureCode(lookup.cause)
          : undefined;
      const observed = {
        ...(lookup.status === "no-working-directory"
          ? {
              executable_lookup_outcome: lookup.status,
              ...(cwdCode === undefined
                ? {}
                : { executable_lookup_code: String(cwdCode) }),
            }
          : {}),
        ...(missing?.selectedPath === undefined
          ? {}
          : { provider_executable_path: missing.selectedPath }),
        // Where a launch by name fails with EACCES and access must be granted.
        ...(denied === undefined
          ? {}
          : {
              executable_lookup_denied_candidate: denied.candidate,
              executable_lookup_denied_reason: denied.reason,
            }),
        ...(stopped === undefined
          ? {}
          : {
              executable_lookup_candidate: stopped.candidate,
              ...(stopped.code === undefined
                ? {}
                : { executable_lookup_code: stopped.code }),
            }),
      };
      return ok(
        unidentified(
          lookup.status === "no-working-directory"
            ? "the executable could not be located: its lookup needed the working directory, which could not be read"
            : stopped === undefined
              ? denied === undefined
                ? "the executable could not be located"
                : `the executable could not be located; a launch by name is denied (EACCES) at ${denied.candidate}, ${denied.reason === "permission" ? "which lacks execute permission or is under a directory that cannot be searched" : "which is not a regular file"}`
              : `the executable lookup stopped at ${stopped.candidate}${stopped.code === undefined ? "" : ` (${stopped.code})`}, where at least one native search stops, so the host's own search decides what runs`,
          profile.executable,
          Object.keys(observed).length === 0 ? undefined : observed,
        ),
      );
    }
    let sha256: string;
    try {
      sha256 = await hash(lookup.path);
    } catch (cause) {
      const code = commandFailureCode(cause);
      // A hash that ends the call keeps the path the lookup found.
      const diagnostics = {
        phase: "executable_digest",
        provider_executable_path: lookup.path,
      };
      if (preflightCancelled(signal, cause, code))
        return err(
          new AnalysisCancelledError(operation, {
            cause: callerCancellationCause(signal, cause),
            diagnostics,
          }),
        );
      // Hashing past the deadline ends the call, as the lookup's deadline does.
      if (code === "ETIMEDOUT")
        return err(
          new AnalysisTimeoutError(operation, timeoutMs, {
            cause,
            diagnostics,
            ...reverseCommandTimeoutGuidance(timeoutMs),
          }),
        );
      // The command still runs the path found, rather than searching PATH
      // again, where another executable could answer.
      return ok(
        unidentified(
          `the executable could not be read${code === undefined ? "" : ` (${String(code)})`}`,
          lookup.path,
          { provider_executable_path: lookup.path },
        ),
      );
    }
    const parameters = {
      provider_executable_path: lookup.path,
      provider_executable_sha256: sha256,
    };
    const outcome = await this.#runVersionProbe(
      operation,
      lookup.path,
      probe,
      environment,
      signal,
      timeoutMs,
      outputBudgetBytes,
    );
    // A probe that ends the call keeps the path and digest it ran from.
    if (!outcome.ok) return err(outcome.error.retainDiagnostics(parameters));
    const completed = outcome.value;
    // A spawned PATH search moves past a file that fails to start this way,
    // so the command runs as selected and the host decides what runs, keeping
    // that file as a candidate rather than as what ran. An explicitly selected
    // path has no later candidate, so the command runs that path and keeps what
    // the lookup and hash observed.
    if (completed.status === "not-started")
      return ok(
        lookup.selectedPath === undefined
          ? unidentified(
              `${lookup.path}, which the lookup found, did not start (${completed.code}), as when a script's interpreter is missing or not executable; the command runs \`${profile.executable}\` as selected, so the host decides what runs`,
              profile.executable,
              {
                executable_lookup_candidate: lookup.path,
                executable_lookup_code: completed.code,
                executable_lookup_candidate_sha256: sha256,
              },
            )
          : unidentified(
              `${lookup.path} did not start (${completed.code}), as when a script's interpreter is missing or not executable`,
              lookup.path,
              parameters,
            ),
      );
    if (completed.status !== "read" && completed.status !== "unrecognized")
      return ok(
        unidentified(
          `its version probe (${probe.arguments.join(" ")}) ${VERSION_PROBE_FAILURE_REASONS[completed.status]}`,
          lookup.path,
          { ...parameters, provider_version_probe: completed.diagnostics },
        ),
      );
    const banner = `its ${probe.arguments.join(" ")} banner`;
    const bannerParameters = {
      ...parameters,
      provider_version_banner: completed.banner,
      provider_version_banner_truncated: completed.bannerTruncated,
    };
    if (completed.status === "unrecognized")
      return ok(
        unidentified(`${banner} did not identify the tool`, lookup.path, {
          ...bannerParameters,
          provider_version_probe: completed.diagnostics,
        }),
      );
    const { identification } = completed;
    return ok({
      executable: lookup.path,
      identity: identification.identity,
      limitations: [
        `The executable version comes from ${banner}; supported formats remain unknown.`,
        EXECUTABLE_OBSERVATION_TIMING,
        ...identification.limitations,
      ],
      parameters: { ...bannerParameters, provider_identity: "banner" },
      observed: true,
    });
  }

  /**
   * Run one version probe under the call's deadline and cancellation. Its
   * output stays separate from the command's but runs, before the command,
   * within the output bytes the call reserved; a failed probe keeps bounded
   * diagnostics.
   */
  async #runVersionProbe(
    operation: ReverseEngineeringOperation,
    executable: string,
    probe: NonNullable<ReverseEngineeringProviderCommand["versionProbe"]>,
    environment: NodeJS.ProcessEnv,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    outputBudgetBytes: number,
  ): Promise<Result<VersionProbeOutcome, AnalysisError>> {
    try {
      const output = await this.#run(executable, probe.arguments, {
        env: environment,
        signal,
        timeout: timeoutMs,
        stopSignal: "SIGTERM",
        maxBuffer: outputBudgetBytes,
      });
      // Replacement characters could read as a version, and a banner accepted
      // beside undecodable stderr would drop the probe's diagnostics, so output
      // that is not valid UTF-8 on either stream identifies nothing.
      if (
        output.stdoutInvalidUtf8 === true ||
        output.stderrInvalidUtf8 === true
      )
        return ok({
          status: "undecodable",
          diagnostics: versionProbeDiagnostics(0, output),
        });
      // The budget and the record cover the first line as printed; only
      // identification reads it without surrounding whitespace.
      const banner = boundedUtf8Text(
        output.stdout.split(/\r?\n/u, 1)[0] ?? "",
        VERSION_PROBE_TEXT_BYTES,
      );
      // A cut banner identifies nothing: the cut could fall inside its
      // version, whether the record's budget or the call's output allowance
      // cut it.
      const identification =
        banner.truncated || output.outputTruncated === true
          ? undefined
          : probe.identify(banner.text.trim());
      return ok(
        identification === undefined
          ? {
              status: "unrecognized",
              banner: banner.text,
              bannerTruncated: banner.truncated,
              diagnostics: versionProbeDiagnostics(0, output),
            }
          : {
              status: "read",
              identification,
              banner: banner.text,
              bannerTruncated: banner.truncated,
            },
      );
    } catch (cause) {
      const capture = execFileOutputFailure(cause);
      const code = capture?.code ?? commandFailureCode(cause);
      const cleanupOwner =
        cause instanceof OwnedOutputFailure ? cause.cleanupOwner : undefined;
      // Ownership preparation that failed or stopped ends the call as it would
      // for the command, and its cleanup joins the same retained scope.
      const inspection = processInspectionFailure(
        cause instanceof OwnedOutputFailure ? cause.cause : cause,
      );
      const preparationFailure =
        inspection === undefined
          ? undefined
          : ownershipPreparationError(
              inspection,
              cause,
              code,
              operation,
              timeoutMs,
            );
      if (inspection !== undefined && preparationFailure !== undefined)
        return err(
          this.#registerCleanupFailure(
            retainProcessInspectionCleanup(
              inspection,
              preparationFailure,
              this.#inspectionResources,
              operation,
            ),
            cleanupOwner,
          ),
        );
      const probeOutput = {
        diagnostics: {
          phase: "version_probe",
          arguments: [...probe.arguments],
        },
        ...(capture === undefined
          ? {}
          : { capturedOutput: execFileFailureCapturedOutput(capture) }),
        ...ownedCleanupOptions(cause),
      };
      if (commandCancelled(signal, cause, code ?? undefined))
        return err(
          this.#registerCleanupFailure(
            new AnalysisCancelledError(operation, {
              cause: callerCancellationCause(signal, cause),
              ...probeOutput,
            }),
            cleanupOwner,
          ),
        );
      // Incomplete cleanup ends the call; a deadline that also ended the
      // probe stays the failure, with the cleanup attached, as for the command.
      if (cause instanceof OwnedOutputFailure && cause.cleanup !== undefined)
        return err(
          this.#registerCleanupFailure(
            code === "ETIMEDOUT"
              ? new AnalysisTimeoutError(operation, timeoutMs, {
                  cause,
                  ...probeOutput,
                  ...reverseCommandTimeoutGuidance(timeoutMs),
                })
              : new AnalysisOutputError(
                  operation,
                  "The provider version probe's process cleanup remains incomplete.",
                  { cause, ...probeOutput },
                ),
            cleanupOwner,
          ),
        );
      // The file did not start, with an error a native PATH search moves
      // past, as when a script's interpreter is missing or not executable,
      // or one at which native searches differ. ETIMEDOUT stays the probe's
      // deadline, which both runners report with that code.
      if (
        typeof code === "string" &&
        (searchMovesPast(code) || searchesDiffer(code))
      )
        return ok({ status: "not-started", code });
      // Both runners report the call's deadline as ETIMEDOUT, even when the
      // stop signal also ended the process.
      return ok({
        status: code === "ETIMEDOUT" ? "timed-out" : "failed",
        diagnostics: versionProbeDiagnostics(code, capture),
      });
    }
  }

  #registerCleanupFailure(
    failure: AnalysisError,
    cleanupOwner: RetainedCleanupOwner | undefined,
  ): AnalysisError {
    if (cleanupOwner !== undefined && failure.cleanupIncomplete)
      this.#pendingCleanup.get(cleanupOwner)?.failures.add(failure);
    return failure;
  }
}

/** The executable to run and the identity, limitations and provenance it records. */
interface ProviderIdentification {
  readonly executable: string;
  readonly identity: Evidence["provider"];
  readonly limitations: readonly string[];
  readonly parameters: Readonly<Record<string, JsonValue>>;
  /** The lookup found the executable; the parameters hold what it, the hash and any probe observed. */
  readonly observed: boolean;
}

/** One version probe's outcome. */
type VersionProbeOutcome =
  | {
      readonly status: "read";
      readonly identification: ProviderToolIdentification;
      /** The first stdout line, trimmed and bounded. */
      readonly banner: string;
      readonly bannerTruncated: boolean;
    }
  | {
      /** A banner that identified no tool, kept with the probe's diagnostics. */
      readonly status: "unrecognized";
      readonly banner: string;
      readonly bannerTruncated: boolean;
      readonly diagnostics: Readonly<Record<string, JsonValue>>;
    }
  | {
      readonly status: "failed" | "timed-out" | "undecodable";
      readonly diagnostics: Readonly<Record<string, JsonValue>>;
    }
  /** The host did not start the file, with an error its PATH search moves past. */
  | { readonly status: "not-started"; readonly code: string };

/** Why a probe that read no usable banner leaves the version unknown. */
/** Observations read before the command cannot bind the tool that ran. */
export const EXECUTABLE_OBSERVATION_TIMING =
  "The executable's SHA-256, and any -v banner, were read before the command launched, so they do not prove the bytes or the version that ran.";

export const VERSION_PROBE_FAILURE_REASONS = {
  failed: "did not complete successfully",
  "timed-out": "reached the command deadline",
  undecodable: "printed output that is not valid UTF-8",
} as const satisfies Record<
  Exclude<
    VersionProbeOutcome["status"],
    "read" | "unrecognized" | "not-started"
  >,
  string
>;

// A banner is one line. This UTF-8 byte budget bounds the recorded banner and
// each stream of a failed probe's diagnostics, cutting only between code points.
const VERSION_PROBE_TEXT_BYTES = 2_048;

/** Bounded exit facts and output of a probe that printed no usable banner. */
const versionProbeDiagnostics = (
  code: string | number | null | undefined,
  output:
    | {
        readonly stdout: string;
        readonly stderr: string;
        readonly signal?: string | null;
        readonly killed?: boolean;
        readonly outputTruncated?: boolean;
        readonly collectionFailure?: boolean;
        readonly stdoutInvalidUtf8?: boolean;
        readonly stderrInvalidUtf8?: boolean;
      }
    | undefined,
): Readonly<Record<string, JsonValue>> => {
  const stdout = boundedUtf8Text(
    output?.stdout ?? "",
    VERSION_PROBE_TEXT_BYTES,
  );
  const stderr = boundedUtf8Text(
    output?.stderr ?? "",
    VERSION_PROBE_TEXT_BYTES,
  );
  return {
    // An exit status of output that was not fully collected is not reported.
    exit_code:
      output?.collectionFailure !== true && typeof code === "number"
        ? code
        : null,
    signal: output?.signal ?? null,
    error_code: typeof code === "string" ? code : null,
    stdout: stdout.text,
    stderr: stderr.text,
    output_truncated:
      output?.outputTruncated === true || stdout.truncated || stderr.truncated,
    // As for the command: output that was not fully collected, or a probe that
    // was killed, signalled or left no exit code, did not observably complete.
    completion_status:
      output?.collectionFailure !== true &&
      output?.killed !== true &&
      (output?.signal ?? null) === null &&
      typeof code === "number"
        ? "complete"
        : "unknown",
    // Invalid UTF-8 is decoded as replacement characters; these mark it.
    stdout_invalid_utf8: output?.stdoutInvalidUtf8 === true,
    stderr_invalid_utf8: output?.stderrInvalidUtf8 === true,
  };
};

/** What retries an incomplete cleanup: a command's process or a preparation's helper. */
type RetainedCleanupOwner = Pick<ProviderProcessSupervisor, "stop">;

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
  readonly cleanupOwner?: RetainedCleanupOwner;
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
  readonly cleanupOwner: RetainedCleanupOwner | undefined;
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
      owner: RetainedCleanupOwner,
      cleanup: AnalysisCleanupObservation,
    ) => void,
  ): ReverseEngineeringCommandRunner =>
  async (command, args, options = {}) => {
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
          timeoutMs: options.timeout ?? DEFAULT_REVERSE_COMMAND_TIMEOUT_MS,
          diagnosticBytes:
            options.maxBuffer ?? DEFAULT_REVERSE_COMMAND_OUTPUT_BYTES,
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
              : launchErrorCode === "E2BIG"
                ? "E2BIG"
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
 * The failure an ownership preparation leaves when it fails or stops. The
 * command and its version probe share it, so a preparation failure ends the
 * call the same way at either. `code` is the failure code the runner reported;
 * Darwin preparation that a deadline interrupted stays a timeout.
 */
const ownershipPreparationError = (
  inspection: ProcessInspectionFailure,
  cause: unknown,
  code: string | number | null | undefined,
  operation: ReverseEngineeringOperation,
  timeoutMs: number,
): AnalysisError | undefined => {
  const ownedCause = cause instanceof OwnedOutputFailure ? cause.cause : cause;
  if (!(inspection instanceof DarwinProcessOwnershipInspectionError)) {
    const cancellation = processInspectionCancellationError(
      ownedCause,
      operation,
    );
    return ownedCause instanceof OwnedCommandFailure &&
      ownedCause.reason === "timeout"
      ? new AnalysisTimeoutError(operation, timeoutMs, {
          cause: ownedCause,
          ...reverseCommandTimeoutGuidance(timeoutMs),
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
  // A deadline that interrupted preparation keeps what the helper's compiler
  // printed, as a failed preparation does.
  if (code === "ETIMEDOUT")
    return new AnalysisTimeoutError(operation, timeoutMs, {
      cause,
      ...reverseCommandTimeoutGuidance(timeoutMs),
      ...(inspection.capturedOutput === undefined
        ? {}
        : { capturedOutput: inspection.capturedOutput }),
    });
  if (inspection.cancellation !== undefined)
    return new AnalysisCancelledError(operation, {
      cause: inspection.cancellation?.reason,
    });
  const setting =
    operation === "inspect_with_objdump"
      ? "REA_OBJDUMP_COMMAND"
      : "REA_RIZIN_COMMAND";
  return new AnalysisCapabilityUnavailableError(
    "process-ownership",
    "prepare_owned_process",
    `Darwin process ownership inspection could not be prepared: ${inspection.message}`,
    {
      cause,
      userMessage: inspection.message,
      remediationAction: `${DARWIN_PROCESS_OWNERSHIP_REMEDIATION} ${setting} does not need to change.`,
      diagnostics: {
        boundary: "process-ownership",
        stage: "ownership_preparation",
        ...(inspection.compilerOutcome === undefined
          ? {}
          : {
              compiler_outcome: jsonValueSchema.parse(
                inspection.compilerOutcome,
              ),
            }),
      },
      ...(inspection.capturedOutput === undefined
        ? {}
        : { capturedOutput: inspection.capturedOutput }),
    },
  );
};

/** How a caller raises the deadline that `timeoutMs` reached, if it can. */
const raiseCommandTimeout = (timeoutMs: number): string =>
  timeoutMs < MAX_REVERSE_COMMAND_TIMEOUT_MS
    ? `Increase command_timeout_ms above ${String(timeoutMs)} (integer milliseconds from 1 to ${String(MAX_REVERSE_COMMAND_TIMEOUT_MS)}; omitted means ${String(DEFAULT_REVERSE_COMMAND_TIMEOUT_MS)}), or use --command-timeout-ms on the CLI.`
    : `command_timeout_ms is already at the maximum ${String(MAX_REVERSE_COMMAND_TIMEOUT_MS)} ms; no higher deadline is supported.`;

const reverseCommandTimeoutGuidance = (
  timeoutMs: number,
): { readonly userMessage: string; readonly remediationAction: string } => ({
  userMessage: `This objdump or rizin command reached its ${String(timeoutMs)} ms server/provider deadline (command_timeout_ms) during target preflight, executable identification or the one-shot command (deadlineExpired). This is not a Ghidra or Hopper startup deadline and not a debugger session deadline.`,
  remediationAction: `${raiseCommandTimeout(timeoutMs)} The new value applies on the next call; no restart is required. The combined output allowance is separately selected by max_output_bytes (default ${String(DEFAULT_REVERSE_COMMAND_OUTPUT_BYTES)} bytes). Allow execution, cleanup and delivery headroom in the outer MCP client deadline. Confirm outstanding work and cleanup before retrying.`,
});

/**
 * The limitation for a post-run hash that reached the call's deadline, for
 * example at a read or close that a stalled mount holds. The command's output
 * is unaffected; only the artifact comparison is missing.
 */
export const postRunArtifactDigestDeadline = (timeoutMs: number): string =>
  `The post-run artifact digest is unknown because hashing the artifact after the provider call reached the ${String(timeoutMs)} ms command_timeout_ms deadline (ETIMEDOUT), for example at a read or close that a stalled mount holds; artifact changes during the command remain unquantified. ${raiseCommandTimeout(timeoutMs)}`;

/** The limitation for a post-run hash that read the artifact and failed. */
export const POST_RUN_ARTIFACT_UNREADABLE =
  "The post-run artifact digest is unknown because the artifact could not be read after the provider call.";

/** Optional bounds and file access for one hash. */
export interface FileDigestBounds {
  readonly signal?: AbortSignal | undefined;
  /** Milliseconds for the whole hash. */
  readonly timeoutMs?: number | undefined;
  readonly stat?: (path: string) => Promise<Stats>;
  readonly open?: (path: string) => ReturnType<typeof createReadStream>;
}

/**
 * Hash a regular file within one deadline. The hash completes once its stream
 * has closed, so a close that a stalled mount holds reaches the deadline as a
 * stalled open or read does. Destroying a stream cancels none of these, so a
 * hash that stops waiting destroys its stream, whose close keeps running until
 * the mount answers.
 */
export const digestFile = async (
  path: string,
  bounds: FileDigestBounds = {},
): Promise<string> => {
  const {
    signal,
    timeoutMs = DEFAULT_REVERSE_COMMAND_TIMEOUT_MS,
    stat = statPath,
    open = createReadStream,
  } = bounds;
  const deadline = fileDeadline(signal, timeoutMs);
  try {
    const info = digestStep(await deadline.run(() => stat(path)), signal);
    if (!info.isFile())
      throw Object.assign(
        new Error("Artifact digest requires a regular file"),
        { code: "EINVAL" },
      );
    let stream: ReturnType<typeof open> | undefined;
    const read = await deadline.run(() => readDigest((stream = open(path))));
    if (read.status === "interrupted") stream?.destroy();
    return digestStep(read, signal);
  } finally {
    deadline.release();
  }
};

/** The SHA-256 of a stream, once it has closed after its end. */
const readDigest = (
  stream: ReturnType<typeof createReadStream>,
): Promise<string> =>
  new Promise<string>((resolveDigest, rejectDigest) => {
    const hash = createHash("sha256");
    let digest: string | undefined;
    stream.on("data", (chunk: Buffer | string) => hash.update(chunk));
    stream.once("end", () => {
      digest = hash.digest("hex");
    });
    stream.once("error", rejectDigest);
    stream.once("close", () => {
      if (digest !== undefined) resolveDigest(digest);
      else
        rejectDigest(
          Object.assign(new Error("Artifact stream closed before its end"), {
            code: "ERR_STREAM_PREMATURE_CLOSE",
          }),
        );
    });
  });

/** The value of one hash step, or the error its failure or interruption reports. */
const digestStep = <Value>(
  outcome: FileStepOutcome<Value>,
  signal: AbortSignal | undefined,
): Value => {
  if (outcome.status === "fulfilled") return outcome.value;
  if (outcome.status === "rejected") throw outcome.cause;
  if (outcome.by === "cancellation")
    throw new AnalysisCancelledError("artifact_digest", {
      cause: signal?.reason,
    });
  throw Object.assign(new Error("Artifact digest timed out"), {
    code: "ETIMEDOUT",
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
 * observed while the caller signal is aborted remain cancellation. A bare
 * `ABORT_ERR` is not cancellation until the command boundary, which already
 * used that code for an aborted provider process.
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
  return code === "ABORT_ERR" || preflightCancelled(signal, cause, code);
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
