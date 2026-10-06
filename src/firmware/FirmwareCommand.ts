import { randomUUID } from "node:crypto";
import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisCancelledError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import {
  spawnOwnedProviderProcess,
  ProviderProcessSupervisor,
  type OwnedProviderProcessSpawnOptions,
  type SpawnedOwnedProviderProcess,
} from "../process/ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "../process/ProcessOwnership.js";
import { FIRMWARE_LIMITS } from "./FirmwareRelease.js";
import { hashFirmwareFile, inventoryFirmwareOutput } from "./FirmwareFiles.js";

/** Injectable owned launcher for production protocol and lifecycle tests. */
export type FirmwareLauncher = (
  options: OwnedProviderProcessSpawnOptions,
) => Promise<SpawnedOwnedProviderProcess>;

/** Resolve explicitly supplied executable paths; never install or search for engines. */
export const resolveFirmwareCommand = async (
  environment: Readonly<Record<string, string | undefined>>,
  engine: "binwalk" | "unblob",
  operation: string,
) => {
  const variable =
    engine === "binwalk" ? "REA_BINWALK_COMMAND" : "REA_UNBLOB_COMMAND";
  const configured = environment[variable];
  if (
    process.platform !== "linux" ||
    configured === undefined ||
    !isAbsolute(configured)
  )
    throw new AnalysisCapabilityUnavailableError(
      engine,
      operation,
      `This integration requires Linux and an absolute ${variable} path to the caller-supplied tool`,
    );
  const command = await realpath(configured).catch((cause: unknown) => {
    throw new AnalysisCapabilityUnavailableError(
      engine,
      operation,
      `${variable} is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  });
  await access(command, constants.X_OK);
  const limiter =
    environment.REA_FIRMWARE_PRLIMIT_COMMAND ?? "/usr/bin/prlimit";
  if (!isAbsolute(limiter))
    throw new AnalysisCapabilityUnavailableError(
      engine,
      operation,
      "REA_FIRMWARE_PRLIMIT_COMMAND must be absolute",
    );
  await access(limiter, constants.X_OK).catch(() => {
    throw new AnalysisCapabilityUnavailableError(
      engine,
      operation,
      `Resource limiter unavailable: ${limiter}; provide util-linux prlimit`,
    );
  });
  return { command, limiter, sha256: await hashFirmwareFile(command) };
};

/** Execute one bounded provider command and verify its owned descendants have stopped. */
export const runFirmwareCommand = async (context: {
  engine: string;
  operation: string;
  command: string;
  limiter: string;
  args: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string | undefined>>;
  signal: AbortSignal;
  launcher?: FirmwareLauncher;
  outputBudget?: { root: string; bytes: number; entries: number };
  acceptReportedExtractionFailure?: boolean;
}) => {
  const { engine, operation, signal } = context;
  signal.throwIfAborted();
  const runId = `rea-firmware-${randomUUID()}`;
  const spawned = await (context.launcher ?? spawnOwnedProviderProcess)({
    command: context.limiter,
    arguments: [
      `--as=${FIRMWARE_LIMITS.addressSpaceBytes}`,
      `--fsize=${context.outputBudget?.bytes ?? FIRMWARE_LIMITS.reportBytes}`,
      "--core=0",
      "--cpu=120",
      "--",
      context.command,
      ...context.args,
    ],
    expectedCommand: null,
    runId,
    cwd: context.cwd,
    hostEnvironment: context.environment,
    env: {
      TMPDIR: context.cwd,
      OMP_NUM_THREADS: "1",
      OPENBLAS_NUM_THREADS: "1",
      RAYON_NUM_THREADS: "1",
      NO_COLOR: "1",
    },
  });
  const supervisor = new ProviderProcessSupervisor({
    ...spawned,
    ownsProcessLifetime: true,
    cleanup:
      spawned.cleanup ?? (() => cleanupOwnedProcessGroup(spawned.ownership)),
  });
  let failure: unknown;
  try {
    const deadline = Date.now() + FIRMWARE_LIMITS.timeoutMs;
    while (!(await supervisor.waitForExit(100))) {
      if (signal.aborted) throw new AnalysisCancelledError(operation);
      if (Date.now() >= deadline)
        throw new AnalysisTimeoutError(operation, FIRMWARE_LIMITS.timeoutMs);
      if (context.outputBudget !== undefined)
        await inventoryFirmwareOutput(
          context.outputBudget.root,
          context.outputBudget.bytes,
          context.outputBudget.entries,
          operation,
          signal,
        );
    }
    if (signal.aborted) throw new AnalysisCancelledError(operation);
  } catch (cause: unknown) {
    failure = cause;
  }
  const stopped = await supervisor.stop();
  const snapshot = supervisor.snapshot();
  supervisor.dispose();
  if (stopped.status === "incomplete")
    throw new ProviderCleanupError(engine, [runId, context.cwd], {
      reason: stopped.reason,
    });
  if (failure !== undefined) throw failure;
  if (
    snapshot.exitCode !== 0 &&
    !(
      context.acceptReportedExtractionFailure === true &&
      snapshot.exitCode === 1
    )
  )
    throw new ProviderAdapterError(engine, operation, {
      diagnostics: {
        reason:
          "Tool failed; inspect exit status and stderr for format, dependency, sandbox or resource-limit failures",
        exit_code: snapshot.exitCode ?? null,
        signal: snapshot.signal ?? null,
        stdout: snapshot.stdout.text,
        stderr: snapshot.stderr.text,
        stdout_bytes: snapshot.stdout.bytes,
        stderr_bytes: snapshot.stderr.bytes,
      },
    });
  return {
    stdout: snapshot.stdout,
    stderr: snapshot.stderr,
    exit_code: snapshot.exitCode,
    signal: snapshot.signal ?? null,
    command: context.command,
    args: [...context.args],
    resource_limiter: context.limiter,
  };
};
