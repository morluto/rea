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
  type AnalysisCleanupObservation,
} from "../../domain/analysisErrorBase.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  DEFAULT_REVERSE_COMMAND_TIMEOUT_MS,
  MAX_REVERSE_COMMAND_TIMEOUT_MS,
  objdumpInputSchema,
  rizinInputSchema,
  type RizinInput,
} from "../../domain/reverseEngineering.js";
import type {
  ProviderToolIdentification,
  ReverseEngineeringCommandPort,
  ReverseEngineeringProviderCommand,
} from "./ReverseEngineeringCommandPort.js";
import {
  capturedInvalidUtf8,
  execFileFailureCapturedOutput,
  execFileOutput,
  execFileOutputFailure,
} from "../../process/ExecFileOutput.js";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../../process/OwnedCommand.js";
import type { ProviderProcessSupervisor } from "../../process/ProviderProcess.js";
import { boundedUtf8Text } from "../../process/boundedUtf8Text.js";
import { lookupExecutable } from "../../process/ExecutableLookup.js";
import { absoluteCallerPath } from "../../filesystem/callerPath.js";
import { parseAnalysisInput } from "../AnalysisInput.js";

export type ReverseEngineeringOperation =
  | "inspect_with_objdump"
  | "execute_rizin_command";

const MAX_COMBINED_OUTPUT_BYTES = 16 * 1024 * 1024;
// Eight concurrent captures bound retained provider output to 128 MiB.
const MAX_CONCURRENT_REVERSE_ENGINEERING_OPERATIONS = 8;

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

/** Shared application workflow for caller-selected local analysis commands. */
export class ReverseEngineeringService {
  readonly #environment: Readonly<NodeJS.ProcessEnv>;
  readonly #commands: ReverseEngineeringCommandPort;
  readonly #lookup: typeof lookupExecutable;
  readonly #run: ReverseEngineeringCommandRunner;
  readonly #digest: typeof digestFile;
  readonly #stat: (path: string) => Promise<Stats>;
  readonly #pendingCleanup = new Map<
    ProviderProcessSupervisor,
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
  #closing = false;
  #closePromise: Promise<void> | undefined;

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
    const observed = await this.#observe(
      "inspect_with_objdump",
      command,
      input.operation === "architectures" ? undefined : input.path,
      parameters,
      options.signal,
      commandTimeoutMs ?? DEFAULT_REVERSE_COMMAND_TIMEOUT_MS,
    );
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
    const { command_timeout_ms: commandTimeoutMs, ...input } = request;
    const command = this.#commands.rizin(input);
    return this.#observe(
      "execute_rizin_command",
      command,
      input.path,
      commandTimeoutMs === undefined ? input : request,
      options.signal,
      commandTimeoutMs ?? DEFAULT_REVERSE_COMMAND_TIMEOUT_MS,
    );
  }

  #observe(
    operation: ReverseEngineeringOperation,
    profile: ReverseEngineeringProviderCommand,
    path: string | undefined,
    parameters: Readonly<Record<string, JsonValue>>,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<Result<Evidence, AnalysisError>> {
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
      MAX_CONCURRENT_REVERSE_ENGINEERING_OPERATIONS
    )
      return Promise.resolve(
        err(
          new AnalysisResourceConstraintError(
            operation,
            "transport",
            `Concurrent reverse-engineering operation capacity reached (${String(MAX_CONCURRENT_REVERSE_ENGINEERING_OPERATIONS)} operations). This release has no runtime override.`,
            {
              max_concurrent_operations:
                MAX_CONCURRENT_REVERSE_ENGINEERING_OPERATIONS,
              active_operations: this.#activeOperations.size,
            },
            {
              remediationAction: `Wait for an active objdump or rizin command to finish, then retry. This capacity of ${String(MAX_CONCURRENT_REVERSE_ENGINEERING_OPERATIONS)} operations has no runtime override, and command_timeout_ms does not raise it.`,
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
    const running = this.#observeProvider(
      operation,
      profile,
      path,
      parameters,
      operationSignal,
      timeoutMs,
    );
    const tracked = running.finally(() => {
      signal?.removeEventListener("abort", relayAbort);
      this.#activeOperations.delete(controller);
    });
    this.#activeOperations.set(controller, tracked);
    return tracked;
  }

  async #observeProvider(
    operation: ReverseEngineeringOperation,
    profile: ReverseEngineeringProviderCommand,
    path: string | undefined,
    parameters: Readonly<Record<string, JsonValue>>,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<Result<Evidence, AnalysisError>> {
    const { executable: command, arguments: args } = profile;
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
    );
    // An error before Evidence exists keeps the executable the caller selected.
    if (!identified.ok)
      return err(
        identified.error.retainDiagnostics({ provider_executable: command }),
      );
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
    let failure: AnalysisError | undefined;
    let cleanupOwner: ProviderProcessSupervisor | undefined;
    let earlyFailure: AnalysisError | undefined;
    try {
      const output = await this.#run(identification.executable, args, {
        env: environment,
        signal,
        timeout: timeoutMs,
        stopSignal: "SIGTERM",
        maxBuffer: MAX_COMBINED_OUTPUT_BYTES,
      });
      stdout = output.stdout;
      stderr = output.stderr;
      stdoutBytes = output.stdoutBytes ?? Buffer.byteLength(stdout);
      stderrBytes = output.stderrBytes ?? Buffer.byteLength(stderr);
      stdoutInvalidUtf8 = output.stdoutInvalidUtf8 === true;
      stderrInvalidUtf8 = output.stderrInvalidUtf8 === true;
      outputTruncated = output.outputTruncated === true;
    } catch (cause) {
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
      const code = capture?.code ?? commandFailureCode(cause);
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
            provider,
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
      // Without command output there is no Evidence to carry the selected
      // executable and what the lookup, hash and probe observed, so the
      // failure keeps them.
      earlyFailure.retainDiagnostics(
        identification.observed
          ? {
              provider: identification.identity,
              provider_executable: command,
              ...identification.parameters,
            }
          : { provider_executable: command },
      );
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
    const result = {
      stdout,
      stderr,
      exit_code: exitCode,
      signal: signalName,
      output_truncated: outputTruncated,
      completion_status: completionStatus,
      artifact_sha256_after: absolutePath === undefined ? null : digestAfter,
      artifact_changed: absolutePath === undefined ? null : artifactChanged,
    };
    const limitations = [
      ...(absolutePath === undefined
        ? [
            "The objdump version is not reported; the output lists BFD targets advertised by the installed tool and does not establish support for the selected artifact.",
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
      ...(outputTruncated
        ? [
            "Captured provider output is partial because bytes were omitted; process completion is reported separately.",
          ]
        : []),
      ...(signalName === null
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
        ? [
            "This output lists BFD targets advertised by the installed objdump and is independent of the selected artifact.",
          ]
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
        `The executable version and supported formats are reported as unknown because ${reason}.`,
        ...(observed?.provider_executable_sha256 === undefined
          ? []
          : [EXECUTABLE_DIGEST_TIMING]),
        ...(probe === undefined ? [] : [probe.assumedIdentity]),
      ],
      parameters:
        probe === undefined
          ? {}
          : { ...observed, provider_identity: "assumed" },
      observed: observed !== undefined,
    });
    if (probe === undefined)
      return ok(unidentified("no reliable version probe was performed"));
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
    // The command launch reports an executable that cannot be selected.
    if (lookup.status !== "found")
      return ok(
        unidentified(
          lookup.status === "no-working-directory"
            ? "the executable could not be located: its lookup needed the working directory, which could not be read"
            : "the executable could not be located",
        ),
      );
    let sha256: string;
    try {
      sha256 = await this.#digest(lookup.path, signal, this.#stat, timeoutMs);
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
    );
    // A probe that ends the call keeps the path and digest it ran from.
    if (!outcome.ok) return err(outcome.error.retainDiagnostics(parameters));
    const completed = outcome.value;
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
        EXECUTABLE_DIGEST_TIMING,
        ...identification.limitations,
      ],
      parameters: { ...bannerParameters, provider_identity: "banner" },
      observed: true,
    });
  }

  /**
   * Run one version probe under the call's deadline and cancellation. Its
   * output stays separate from the command's; a failed probe keeps bounded
   * diagnostics.
   */
  async #runVersionProbe(
    operation: ReverseEngineeringOperation,
    executable: string,
    probe: NonNullable<ReverseEngineeringProviderCommand["versionProbe"]>,
    environment: NodeJS.ProcessEnv,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<Result<VersionProbeOutcome, AnalysisError>> {
    try {
      const output = await this.#run(executable, probe.arguments, {
        env: environment,
        signal,
        timeout: timeoutMs,
        stopSignal: "SIGTERM",
        maxBuffer: MAX_COMBINED_OUTPUT_BYTES,
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
      // A cut banner identifies nothing: the cut could fall inside its version.
      const identification = banner.truncated
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
      if (cause instanceof OwnedOutputFailure && cause.cleanup !== undefined)
        return err(
          this.#registerCleanupFailure(
            new AnalysisOutputError(
              operation,
              "The provider version probe's process cleanup remains incomplete.",
              { cause, ...probeOutput },
            ),
            cleanupOwner,
          ),
        );
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
    cleanupOwner: ProviderProcessSupervisor | undefined,
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
    };

/** Why a probe that read no usable banner leaves the version unknown. */
/** A digest read before launch cannot bind the bytes that ran. */
export const EXECUTABLE_DIGEST_TIMING =
  "The executable's SHA-256 was read before the probe and the command launched, so it does not prove the bytes that ran.";

export const VERSION_PROBE_FAILURE_REASONS = {
  failed: "did not complete successfully",
  "timed-out": "reached the command deadline",
  undecodable: "printed output that is not valid UTF-8",
} as const satisfies Record<
  Exclude<VersionProbeOutcome["status"], "read" | "unrecognized">,
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
    // Invalid UTF-8 is decoded as replacement characters; these mark it.
    stdout_invalid_utf8: output?.stdoutInvalidUtf8 === true,
    stderr_invalid_utf8: output?.stderrInvalidUtf8 === true,
  };
};

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
          diagnosticBytes: MAX_COMBINED_OUTPUT_BYTES,
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

const reverseCommandTimeoutGuidance = (
  timeoutMs: number,
): { readonly userMessage: string; readonly remediationAction: string } => ({
  userMessage: `This objdump or rizin command reached its ${String(timeoutMs)} ms server/provider deadline (command_timeout_ms) during target preflight, executable identification or the one-shot command (deadlineExpired). This is not a Ghidra or Hopper startup deadline and not a debugger session deadline.`,
  remediationAction: `${
    timeoutMs < MAX_REVERSE_COMMAND_TIMEOUT_MS
      ? `Increase command_timeout_ms above ${String(timeoutMs)} (integer milliseconds from 1 to ${String(MAX_REVERSE_COMMAND_TIMEOUT_MS)}; omitted means ${String(DEFAULT_REVERSE_COMMAND_TIMEOUT_MS)}), or use --command-timeout-ms on the CLI.`
      : `command_timeout_ms is already at the maximum ${String(MAX_REVERSE_COMMAND_TIMEOUT_MS)} ms; no higher deadline is supported.`
  } The new value applies on the next call; no restart is required. The ${String(MAX_COMBINED_OUTPUT_BYTES)} byte (16 MiB) combined output cap has no runtime override. Allow execution, cleanup and delivery headroom in the outer MCP client deadline. Confirm outstanding work and cleanup before retrying.`,
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
        new AnalysisCancelledError("artifact_digest", {
          cause: signal?.reason,
        }),
      );
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    if (signal?.aborted) {
      cleanup();
      stream.destroy();
      rejectDigest(
        new AnalysisCancelledError("artifact_digest", {
          cause: signal.reason,
        }),
      );
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
): boolean => code === "ABORT_ERR" || preflightCancelled(signal, cause, code);

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
    return Promise.reject(
      new AnalysisCancelledError("artifact_digest", { cause: signal.reason }),
    );
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
        err(
          new AnalysisCancelledError("artifact_digest", {
            cause: signal?.reason,
          }),
        ),
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
