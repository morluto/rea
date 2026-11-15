import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import {
  assertArtifactCommandPath,
  type ArtifactCommandPath,
} from "../process/ArtifactCommandPath.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { artifactFileCancellationCause } from "../artifacts/ArtifactFileOperation.js";
import { randomUUID } from "node:crypto";
import { fixedAllowanceOptions } from "../domain/fixedAllowanceRemediation.js";
import {
  AnalysisError,
  type AnalysisCapturedOutput,
  type AnalysisErrorOptions,
} from "../domain/analysisErrorBase.js";
import { createPcapDiagnosticProjection } from "./PcapDiagnosticOutput.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisProtocolError,
  AnalysisUnsupportedTargetError,
  cancelledBy,
  carriedReason,
} from "../domain/analysisErrorCore.js";
import {
  OwnedCommandFailure,
  ownedCommandResources,
  prepareOwnedCommand,
  runOwnedCommand,
} from "../process/OwnedCommand.js";
import type {
  ProviderProcessSupervisor,
  ProviderProcessSnapshot,
} from "../process/ProviderProcess.js";
import {
  isWindowsBatchFile,
  windowsBatchCommand,
  WindowsBatchCommandError,
} from "../process/WindowsBatchCommand.js";
import { providerOutcomeOf } from "../process/ProviderOutcome.js";
import { classifyProviderOutcome } from "../process/classifyProviderOutcome.js";
import { pcapToolUnavailable } from "./PcapConfiguration.js";
import {
  attributePcapLimitedExit,
  PCAP_LIMITER_REMEDIATION,
} from "./PcapNativeBound.js";

export type PcapCommandLauncher = NonNullable<
  Parameters<typeof runOwnedCommand>[2]
>["launcher"];

export interface PcapCommandCleanup {
  readonly reason: string;
  readonly resources: readonly string[];
  readonly capturedOutput: AnalysisCapturedOutput;
}

export interface PcapCommandOutput {
  /** Lazy safe diagnostics; raw stdout remains owned by the successful parser. */
  readonly capturedOutput: AnalysisCapturedOutput;
  readonly stdout: string;
  readonly stderr: string;
  readonly invalidUtf8Streams: readonly ("stdout" | "stderr")[];
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
  readonly redactHttpTransportCredentials?: boolean;
  readonly nativeBound?: {
    readonly limiter?: {
      command: ArtifactCommandPath;
      arguments: readonly string[];
    };
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
  const projectDiagnostic = createPcapDiagnosticProjection(
    options.redactHttpTransportCredentials === true,
  );
  const captureDiagnostic = (
    snapshot: ProviderProcessSnapshot,
  ): AnalysisCapturedOutput =>
    projectDiagnostic({
      stdout: snapshot.stdout.text,
      stderr: snapshot.stderr.text,
      stdout_bytes: snapshot.stdout.bytes,
      stderr_bytes: snapshot.stderr.bytes,
      exit_code: snapshot.exitCode ?? null,
      signal: snapshot.signal ?? null,
      truncated:
        snapshot.diagnosticTruncated === true ||
        snapshot.outputIncomplete === true,
    });
  /** A version probe that fails names the tool; a capture read names the file. */
  const pcapToolFailure = (
    diagnostic: string,
    details: AnalysisErrorOptions,
  ): AnalysisError => {
    if (options.inputPath === undefined)
      return pcapToolUnavailable(
        operation,
        `The selected tool ${command} cannot report its version: ${diagnostic}`,
        details,
      );
    if (
      /not a capture file|file.*isn't a capture file|file format.*not supported/iu.test(
        diagnostic,
      )
    )
      return new AnalysisUnsupportedTargetError(
        operation,
        options.inputPath,
        diagnostic,
        details,
      );
    return new AnalysisProtocolError(
      `Packet capture tool ${command} failed: ${diagnostic}`,
      details,
    );
  };
  if (signal?.aborted) throw cancelledBy(operation, signal);
  const hostEnvironment = {
    ...options.environment,
    LC_ALL: "C",
    LANG: "C",
  };
  let cleanup: PcapCommandCleanup | undefined;
  let commandAttempted = false;
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
            command: options.nativeBound.limiter.command.invocationPath,
            arguments: [
              ...options.nativeBound.limiter.arguments,
              invocation.command,
              ...invocation.arguments,
            ],
          };
    // Native ownership preparation has its own bounded compiler lifecycle;
    // do not spend the tool's execution deadline rebuilding a cold SDK cache.
    await prepareOwnedCommand(signal);
    const selectedLimiter = options.nativeBound?.limiter?.command;
    if (selectedLimiter !== undefined)
      await assertArtifactCommandPath(selectedLimiter, operation, { signal });
    commandAttempted = true;
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
          const capturedOutput = captureDiagnostic(snapshot);
          options.retain(owner, resources, stopped.reason, capturedOutput);
          cleanup = { reason: stopped.reason, resources, capturedOutput };
        },
      },
    );
    if (selectedLimiter !== undefined)
      await assertArtifactCommandPath(selectedLimiter, operation, {
        get capturedOutput() {
          return captureDiagnostic(output);
        },
      });
    return {
      get capturedOutput() {
        return captureDiagnostic(output);
      },
      stdout: output.stdout.text,
      stderr: output.stderr.text,
      invalidUtf8Streams: [
        ...(output.stdout.invalidUtf8 === true ? (["stdout"] as const) : []),
        ...(output.stderr.invalidUtf8 === true ? (["stderr"] as const) : []),
      ],
      ...(cleanup === undefined ? {} : { cleanup }),
    };
  } catch (cause) {
    if (cause instanceof AnalysisError) {
      if (cleanup !== undefined) {
        const pending = new ProviderCleanupError(
          "pcap",
          cleanup.resources,
          {
            reason: cleanup.reason,
          },
          {
            operation,
            capturedOutput: cleanup.capturedOutput,
            cleanup: { reason: cleanup.reason, resources: cleanup.resources },
          },
        );
        throw analysisErrorWithCleanupFailure(cause, pending, operation);
      }
      throw cause;
    }
    if (cause instanceof ArtifactReaderFailure && cause.reason === "cancelled")
      throw cancelledBy(
        operation,
        carriedReason(artifactFileCancellationCause(cause)),
      );
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
          : captureDiagnostic(cause.snapshot),
      );
    const cleanupDetails =
      cleanup !== undefined
        ? { cleanup }
        : cause instanceof OwnedCommandFailure && cause.cleanupFailure !== null
          ? {
              cleanup: {
                reason: cause.cleanupFailure,
                resources: cause.resources,
              },
            }
          : {};
    if (cause instanceof WindowsBatchCommandError)
      throw pcapToolUnavailable(
        operation,
        `Cannot run selected tool ${command}: ${cause.message}`,
        { cause, ...cleanupDetails },
      );
    const selectedLimiter =
      options.nativeBound?.limiter?.command.invocationPath;
    const launchedPath = selectedLimiter ?? command;
    const preparationFailure = (
      diagnostic: string,
      details: AnalysisErrorOptions,
    ): AnalysisProtocolError =>
      new AnalysisProtocolError(
        `Preparing the owned packet command failed: ${diagnostic}`,
        details,
      );
    const outcome = providerOutcomeOf(cause);
    if (outcome === undefined) {
      const diagnostic = cause instanceof Error ? cause.message : String(cause);
      const details = { cause, ...cleanupDetails };
      if (!commandAttempted) throw preparationFailure(diagnostic, details);
      // An errno the launcher raised without a spawn identity names no stage.
      if (cause instanceof Error && "code" in cause)
        throw new AnalysisProtocolError(
          `The packet command could not start; the failing stage is unknown: ${diagnostic}`,
          details,
        );
      throw pcapToolFailure(diagnostic, details);
    }
    throw classifyProviderOutcome(outcome, {
      operation,
      capturedOutput: captureDiagnostic,
      details: cleanupDetails,
      timeout: { ms: limits.timeoutMs },
      outputLimit: {
        limits: { max_output_bytes: limits.maxOutputBytes },
        recovery: fixedAllowanceOptions(
          "The packet-tool output capture allowance",
          "capture",
        ),
      },
      memoryLimitBytes: options.nativeBound?.memoryLimitBytes,
      dialect: (failure, details) => {
        if (
          failure.kind === "launch-refused" &&
          // Only a launcher naming the launched path identifies who refused.
          failure.refusal.executable === launchedPath
        ) {
          if (selectedLimiter !== undefined) {
            const reason = `Selected capture limiter ${selectedLimiter} could not be launched (${failure.refusal.code}).`;
            return new AnalysisCapabilityUnavailableError(
              "pcap",
              operation,
              reason,
              {
                ...details,
                userMessage: `${reason} ${PCAP_LIMITER_REMEDIATION}`,
                remediationAction: PCAP_LIMITER_REMEDIATION,
              },
            );
          }
          return pcapToolUnavailable(
            operation,
            failure.refusal.kind === "missing"
              ? `Selected tool ${command} was not found (${failure.refusal.code})`
              : `Selected tool ${command} exists but could not be executed (${failure.refusal.code})`,
            details,
          );
        }
        const diagnostic =
          failure.output?.snapshot.stderr.text.trim() || failure.message;
        if (!commandAttempted) return preparationFailure(diagnostic, details);
        if (failure.kind === "launch-refused")
          return new AnalysisProtocolError(
            `The packet command could not start; the failing stage is unknown: ${diagnostic}`,
            details,
          );
        if (selectedLimiter !== undefined) {
          if (failure.kind !== "exited" || failure.output === undefined)
            return new AnalysisProtocolError(
              `The bounded packet command failed before its exit was observed; whether the limiter or selected tool failed is unknown: ${diagnostic}`,
              details,
            );
          const attributed = attributePcapLimitedExit(selectedLimiter, {
            exitCode: failure.exitCode,
            signal: failure.signal,
            stderr: failure.output.snapshot.stderr.text,
          });
          if (attributed.stage === "limiter") {
            const reason = `Selected capture limiter ${selectedLimiter} failed before starting ${command}: ${diagnostic}`;
            return new AnalysisCapabilityUnavailableError(
              "pcap",
              operation,
              reason,
              {
                ...details,
                userMessage: `${reason} ${PCAP_LIMITER_REMEDIATION}`,
                remediationAction: PCAP_LIMITER_REMEDIATION,
              },
            );
          }
          if (attributed.stage === "tool-launch")
            return pcapToolUnavailable(
              operation,
              attributed.refusal === "missing"
                ? `Selected tool ${command} was not found: ${diagnostic}`
                : `Selected tool ${command} exists but could not be executed: ${diagnostic}`,
              details,
            );
          // Otherwise prlimit started the tool; its exit and output are the tool's.
        }
        return pcapToolFailure(diagnostic, details);
      },
    });
  }
};
