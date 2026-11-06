import { randomUUID } from "node:crypto";
import { fixedAllowanceOptions } from "../domain/fixedAllowanceRemediation.js";
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
  ownedCommandResources,
  prepareOwnedCommand,
  runOwnedCommand,
} from "../process/OwnedCommand.js";
import type { ProviderProcessSupervisor } from "../process/ProviderProcess.js";
import {
  isWindowsBatchFile,
  windowsBatchCommand,
  WindowsBatchCommandError,
} from "../process/WindowsBatchCommand.js";
import { pcapToolUnavailable } from "./PcapConfiguration.js";
import { resolveWindowsOwnedCommand } from "../process/resolveWindowsOwnedCommand.js";

export type PcapCommandLauncher = NonNullable<
  Parameters<typeof runOwnedCommand>[2]
>["launcher"];

export interface PcapCommandCleanup {
  readonly reason: string;
  readonly resources: readonly string[];
  readonly capturedOutput: {
    readonly stdout: string;
    readonly stderr: string;
    readonly truncated: boolean;
  };
}

export interface PcapCommandOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly cleanup?: PcapCommandCleanup;
}

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
  readonly launcher?: PcapCommandLauncher;
  readonly retain: (
    owner: ProviderProcessSupervisor,
    resources: readonly string[],
    reason: string,
    capturedOutput: PcapCommandCleanup["capturedOutput"],
  ) => void;
}): Promise<PcapCommandOutput> => {
  const { operation, command, limits, signal } = options;
  if (signal?.aborted)
    throw new AnalysisCancelledError(operation, { cause: signal.reason });
  const hostEnvironment = {
    ...process.env,
    ...options.environment,
    LC_ALL: "C",
    LANG: "C",
  };
  let cleanup: PcapCommandCleanup | undefined;
  try {
    const batch = process.platform === "win32" && isWindowsBatchFile(command);
    const invocation = batch
      ? windowsBatchCommand({
          environment: hostEnvironment,
          batchPath: command,
          arguments: options.arguments,
        })
      : { command, arguments: options.arguments };
    const ownedInvocation =
      process.platform === "win32"
        ? resolveWindowsOwnedCommand(
            invocation.command,
            invocation.arguments,
            hostEnvironment,
          )
        : {
            command: invocation.command,
            arguments: invocation.arguments,
            windowsVerbatimArguments: false,
          };
    const boundedInvocation =
      options.nativeBound?.limiter === undefined
        ? ownedInvocation
        : {
            command: options.nativeBound.limiter.command,
            arguments: [
              ...options.nativeBound.limiter.arguments,
              ownedInvocation.command,
              ...ownedInvocation.arguments,
            ],
            windowsVerbatimArguments: false,
          };
    // Native ownership preparation has its own bounded compiler lifecycle;
    // do not spend the tool's execution deadline rebuilding a cold SDK cache.
    await prepareOwnedCommand(signal);
    const output = await runOwnedCommand(
      {
        ...boundedInvocation,
        runId: randomUUID(),
        hostEnvironment,
        windowsVerbatimArguments:
          boundedInvocation.windowsVerbatimArguments || batch,
        expectedCommand: null,
        ...(options.nativeBound?.memoryLimitBytes === undefined
          ? {}
          : { memoryLimitBytes: options.nativeBound.memoryLimitBytes }),
      },
      { timeoutMs: limits.timeoutMs, diagnosticBytes: limits.maxOutputBytes },
      {
        ...(signal === undefined ? {} : { signal }),
        ...(options.launcher === undefined
          ? {}
          : { launcher: options.launcher }),
        retainCleanup: (owner, stopped) => {
          const resources =
            owner.launch.ownership === undefined
              ? ["owned-process"]
              : ownedCommandResources(owner.launch.ownership);
          const snapshot = owner.snapshot();
          const capturedOutput = {
            stdout: snapshot.stdout.text,
            stderr: snapshot.stderr.text,
            truncated:
              snapshot.diagnosticTruncated === true ||
              snapshot.outputIncomplete === true,
          };
          options.retain(owner, resources, stopped.reason, capturedOutput);
          cleanup = { reason: stopped.reason, resources, capturedOutput };
        },
      },
    );
    return {
      stdout: output.stdout.text,
      stderr: output.stderr.text,
      ...(cleanup === undefined ? {} : { cleanup }),
    };
  } catch (cause) {
    if (cause instanceof AnalysisError) throw cause;
    if (
      cause instanceof OwnedCommandFailure &&
      cause.cleanupOwner !== undefined
    )
      options.retain(
        cause.cleanupOwner,
        cause.resources,
        cause.cleanupFailure ?? cause.message,
        cause.snapshot === null
          ? { stdout: "", stderr: "", truncated: true }
          : {
              stdout: cause.snapshot.stdout.text,
              stderr: cause.snapshot.stderr.text,
              truncated:
                cause.snapshot.diagnosticTruncated === true ||
                cause.snapshot.outputIncomplete === true,
            },
      );
    const details = {
      cause,
      ...(cause instanceof OwnedCommandFailure && cause.snapshot !== null
        ? {
            capturedOutput: {
              stdout: cause.snapshot.stdout.text,
              stderr: cause.snapshot.stderr.text,
              truncated:
                cause.snapshot.diagnosticTruncated === true ||
                cause.snapshot.outputIncomplete === true,
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
    if (cause instanceof OwnedCommandFailure && cause.reason === "cancelled")
      throw new AnalysisCancelledError(operation, {
        ...details,
        cause: cause.cancellation?.reason,
      });
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
        {
          ...details,
          ...fixedAllowanceOptions(
            "The packet-tool output capture allowance",
            "capture",
          ),
        },
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
