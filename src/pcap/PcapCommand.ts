import { randomUUID } from "node:crypto";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisProtocolError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../process/OwnedCommand.js";
import type { ProviderProcessSupervisor } from "../process/ProviderProcess.js";
import { prepareProcessOwnershipInspection } from "../process/ProcessOwnershipObservation.js";
import {
  isWindowsBatchFile,
  windowsBatchCommand,
  WindowsBatchCommandError,
} from "../process/WindowsBatchCommand.js";
import { pcapToolUnavailable } from "./PcapConfiguration.js";

export interface PcapCommandLimits {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

/** Owned process execution shared by version probes and capture reads. */
export const runPcapCommand = async (options: {
  readonly operation: string;
  readonly command: string;
  readonly arguments: readonly string[];
  readonly limits: PcapCommandLimits;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal | undefined;
  readonly inputPath?: string;
  readonly nativeBound?: {
    readonly limiter?: { command: string; arguments: readonly string[] };
    readonly memoryLimitBytes?: number;
  };
  readonly retain: (
    owner: ProviderProcessSupervisor,
    resources: readonly string[],
  ) => void;
}): Promise<{ stdout: string; stderr: string }> => {
  const { operation, command, limits, signal } = options;
  if (signal?.aborted)
    throw new AnalysisCancelledError(operation, { cause: signal.reason });
  const hostEnvironment = {
    ...process.env,
    ...options.environment,
    LC_ALL: "C",
    LANG: "C",
  };
  try {
    const batch = process.platform === "win32" && isWindowsBatchFile(command);
    const invocation = batch
      ? windowsBatchCommand({
          environment: hostEnvironment,
          batchPath: command,
          arguments: options.arguments,
        })
      : { command, arguments: options.arguments };
    const boundedInvocation =
      options.nativeBound?.limiter === undefined
        ? invocation
        : {
            command: options.nativeBound.limiter.command,
            arguments: [
              ...options.nativeBound.limiter.arguments,
              invocation.command,
              ...invocation.arguments,
            ],
          };
    // Native ownership preparation has its own bounded compiler lifecycle;
    // do not spend the tool's execution deadline rebuilding a cold SDK cache.
    await prepareProcessOwnershipInspection(signal);
    const output = await runOwnedCommand(
      {
        ...boundedInvocation,
        runId: randomUUID(),
        hostEnvironment,
        windowsVerbatimArguments: batch,
        expectedCommand: null,
        ...(options.nativeBound?.memoryLimitBytes === undefined
          ? {}
          : { memoryLimitBytes: options.nativeBound.memoryLimitBytes }),
      },
      { timeoutMs: limits.timeoutMs, diagnosticBytes: limits.maxOutputBytes },
      signal === undefined ? {} : { signal },
    );
    return { stdout: output.stdout.text, stderr: output.stderr.text };
  } catch (cause) {
    if (cause instanceof AnalysisError) throw cause;
    if (
      cause instanceof OwnedCommandFailure &&
      cause.cleanupOwner !== undefined
    )
      options.retain(cause.cleanupOwner, cause.resources);
    const details = {
      cause,
      ...(cause instanceof OwnedCommandFailure && cause.snapshot !== null
        ? {
            capturedOutput: {
              stdout: "",
              stderr: cause.snapshot.stderr.text,
              truncated:
                cause.snapshot.stdout.observedBytes > 0 ||
                (cause.snapshot.diagnosticTruncated ?? false),
              exit_code: cause.snapshot.exitCode ?? null,
              signal: cause.snapshot.signal ?? null,
            },
          }
        : {}),
      ...(cause instanceof OwnedCommandFailure && cause.cleanupFailure !== null
        ? {
            cleanup: {
              reason: cause.cleanupFailure,
              resources: cause.resources,
            },
          }
        : {}),
    };
    if (
      signal?.aborted ||
      (cause instanceof OwnedCommandFailure && cause.reason === "cancelled")
    )
      throw new AnalysisCancelledError(operation, details);
    if (
      cause instanceof OwnedCommandFailure &&
      cause.snapshot?.memoryLimitReached === true
    )
      throw new AnalysisResourceConstraintError(
        operation,
        "memory",
        "The owned Windows tool tree reached its enforced committed-memory limit.",
        {
          process_memory_limit_bytes:
            options.nativeBound?.memoryLimitBytes ?? null,
        },
        details,
      );
    if (
      cause instanceof OwnedCommandFailure &&
      (cause.snapshot?.signal === "SIGXCPU" ||
        cause.snapshot?.signal === "SIGXFSZ")
    )
      throw new AnalysisResourceConstraintError(
        operation,
        cause.snapshot.signal === "SIGXCPU" ? "cpu" : "file-size",
        `Producer terminated with ${cause.snapshot.signal}; its exact cause is not independently established.`,
        null,
        details,
      );
    if (cause instanceof OwnedCommandFailure && cause.reason === "timeout")
      throw new AnalysisTimeoutError(operation, limits.timeoutMs, details);
    if (cause instanceof OwnedCommandFailure && cause.reason === "output-limit")
      throw new AnalysisResourceConstraintError(
        operation,
        "memory",
        "Tool output exceeded its complete-output budget",
        { max_output_bytes: limits.maxOutputBytes },
        details,
      );
    if (
      cause instanceof WindowsBatchCommandError ||
      (cause instanceof Error &&
        "code" in cause &&
        (cause.code === "ENOENT" || cause.code === "EACCES"))
    )
      throw pcapToolUnavailable(
        operation,
        `Cannot run selected tool ${command}: ${cause.message}`,
        details,
      );
    const diagnostic =
      cause instanceof OwnedCommandFailure
        ? cause.snapshot?.stderr.text.trim() || cause.message
        : cause instanceof Error
          ? cause.message
          : String(cause);
    if (options.inputPath === undefined)
      throw pcapToolUnavailable(
        operation,
        `The selected tool ${command} cannot report its version: ${diagnostic}`,
        details,
      );
    if (
      options.inputPath !== undefined &&
      /not a capture file|file.*isn't a capture file|file format.*not supported/iu.test(
        diagnostic,
      )
    )
      throw new AnalysisUnsupportedTargetError(
        operation,
        options.inputPath,
        diagnostic,
        details,
      );
    throw new AnalysisProtocolError(
      `Packet capture tool ${command} failed: ${diagnostic}`,
      details,
    );
  }
};
