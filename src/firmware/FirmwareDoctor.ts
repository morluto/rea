import { randomUUID } from "node:crypto";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import type {
  DoctorProviderCheck,
  DoctorProviderInspection,
} from "../application/Doctor.js";
import { err, ok, type Result } from "../domain/result.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { analysisErrorWithCancellation } from "../domain/analysisErrorCancellation.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import {
  runOwnedCommand,
  OwnedCommandFailure,
} from "../process/OwnedCommand.js";
import type { ProviderProcessSupervisor } from "../process/ProviderProcess.js";
import {
  createSystemProcessOwnershipHost,
  LinuxOwnedProcessPrerequisiteError,
} from "../process/ProcessOwnershipObservation.js";
import { artifactCommandOutput } from "../process/ArtifactAnalysisResources.js";
import { prlimitArgumentVector } from "../process/LinuxResourceLimits.js";
import {
  firmwareLimiterPath,
  inspectFirmwareExecutable,
} from "./FirmwareConfiguration.js";
import { FIRMWARE_LIMITS } from "./FirmwareRelease.js";
import { admitFirmwareVersion } from "./FirmwareVersion.js";
import {
  FIRMWARE_TOOL_REQUIREMENTS,
  type FirmwareEngineName,
} from "../contracts/firmware/firmwareToolRequirements.js";

const PROBE_LIMITS = {
  timeoutMs: 5_000,
  diagnosticBytes: 64 * 1024,
  acceptNonZeroExit: true,
} as const;
const DEPENDENCY_HEADER =
  "The following executables found installed, which are needed by unblob:";

interface ProbeOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

interface InspectionProgress {
  primaryFailure?: AnalysisError;
  readonly inspections: DoctorProviderInspection[];
}

/** Host process seams; production uses the shared owned-command supervisor. */
export interface FirmwareDoctorHost {
  readonly prepareOwnership?: (
    environment: Readonly<NodeJS.ProcessEnv>,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly runCommand?: typeof runOwnedCommand;
}

/** Read-only tool diagnostics, with unresolved child cleanup retained until close. */
export class FirmwareDoctor {
  readonly #pendingCleanup = new Set<ProviderProcessSupervisor>();

  constructor(
    readonly environment: Readonly<NodeJS.ProcessEnv>,
    readonly platform: NodeJS.Platform = process.platform,
    readonly host: FirmwareDoctorHost = {},
    readonly signal?: AbortSignal,
  ) {}

  /** Inspect each optional tool independently and share host prerequisite probes. */
  async inspect(): Promise<readonly DoctorProviderInspection[]> {
    const progress: InspectionProgress = { inspections: [] };
    try {
      return await this.#inspectProviders(progress);
    } catch (cause: unknown) {
      const failure =
        cause instanceof ArtifactReaderFailure && cause.reason === "cancelled"
          ? new AnalysisCancelledError("doctor", { cause: cause.cause })
          : cause;
      const retained =
        failure instanceof AnalysisCancelledError
          ? analysisErrorWithCancellation(progress.primaryFailure, failure)
          : failure;
      if (retained instanceof AnalysisError) {
        const secondary = retained.secondaryFailures.filter(
          (failure) => !(failure instanceof AnalysisCancelledError),
        );
        retained.retainDiagnostics({
          firmware_inspections: jsonValueSchema.parse(progress.inspections),
          firmware_inspection_count: {
            completed: progress.inspections.length,
            total: 2,
          },
          ...(secondary.length === 0
            ? {}
            : {
                firmware_secondary_probe_failures: jsonValueSchema.parse(
                  secondary.map(projectAnalysisError),
                ),
              }),
        });
      }
      throw retained;
    }
  }

  async #inspectProviders(
    progress: InspectionProgress,
  ): Promise<readonly DoctorProviderInspection[]> {
    this.#throwIfCancelled();
    const platform = diagnostic(
      "platform",
      this.platform === "linux",
      `Firmware integrations require Linux; observed ${this.platform}.`,
      "unsupported_host",
      "Run firmware integrations on Linux; no tools are installed by doctor.",
    );
    const checks: DoctorProviderCheck[] = [platform];
    let limiter: string | undefined;
    const hasConfiguredEngine = Object.values(FIRMWARE_TOOL_REQUIREMENTS).some(
      ({ commandEnvironment }) =>
        this.environment[commandEnvironment] !== undefined,
    );
    if (platform.ok && hasConfiguredEngine) {
      const ps = await this.#inspectPs();
      this.#throwIfCancelled();
      checks.push(ps);
      const path = await inspectFirmwareExecutable(
        firmwareLimiterPath(this.environment),
        "REA_FIRMWARE_PRLIMIT_COMMAND (util-linux prlimit)",
        false,
        this.signal,
      );
      if (!path.ok) {
        checks.push(
          diagnostic(
            "prlimit",
            false,
            path.error,
            "missing_dependency",
            "Provide util-linux prlimit at /usr/bin/prlimit or set REA_FIRMWARE_PRLIMIT_COMMAND to its absolute executable path.",
          ),
        );
      } else if (ps.ok) {
        const result = await this.#probe(
          path.value.invocationPath,
          ["--version"],
          progress,
        );
        const valid =
          result.ok &&
          result.value.exitCode === 0 &&
          /^.+ from util-linux \d/u.test(result.value.stdout.trim());
        checks.push(
          diagnostic(
            "prlimit",
            valid,
            result.ok
              ? result.value.stdout.trim() || result.value.stderr
              : result.error,
            "missing_dependency",
            "Provide a working util-linux prlimit executable and rerun doctor.",
          ),
        );
        if (valid) limiter = path.value.invocationPath;
      } else {
        checks.push(
          diagnostic(
            "prlimit",
            false,
            "Executable path validated; util-linux version probe was not run because process ownership inspection is unavailable.",
            "unknown",
            "Resolve the ps diagnostic and rerun doctor.",
          ),
        );
      }
    }
    const { inspections } = progress;
    for (const engine of ["binwalk", "unblob"] as const) {
      this.#throwIfCancelled();
      inspections.push(
        await this.#inspectEngine(engine, checks, limiter, progress),
      );
    }
    this.#throwIfCancelled();
    return inspections;
  }

  get hasPendingCleanup(): boolean {
    return this.#pendingCleanup.size > 0;
  }

  /** Retry retained cleanup; never silently discard ownership after a failed probe. */
  async close(): Promise<string | undefined> {
    const failures: string[] = [];
    for (const owner of this.#pendingCleanup) {
      const result = await owner.stop();
      if (result.status === "incomplete") failures.push(result.reason);
      else this.#pendingCleanup.delete(owner);
    }
    return failures.length === 0
      ? undefined
      : `Firmware doctor cleanup incomplete: ${failures.join("; ")}`;
  }

  #throwIfCancelled(): void {
    if (this.signal?.aborted)
      throw new AnalysisCancelledError("doctor", { cause: this.signal.reason });
  }

  async #inspectPs(): Promise<DoctorProviderCheck> {
    try {
      const timeout = AbortSignal.timeout(PROBE_LIMITS.timeoutMs);
      const signal =
        this.signal === undefined
          ? timeout
          : AbortSignal.any([this.signal, timeout]);
      if (this.host.prepareOwnership !== undefined)
        await this.host.prepareOwnership(this.environment, signal);
      else
        await createSystemProcessOwnershipHost(
          "linux",
          this.environment,
        ).prepare?.(signal);
      return diagnostic(
        "ps",
        true,
        "procps-compatible ps can inspect REA's current process.",
        "missing_dependency",
        "",
      );
    } catch (cause: unknown) {
      this.#throwIfCancelled();
      if (
        cause instanceof LinuxOwnedProcessPrerequisiteError &&
        cause.outputLimitBytes !== undefined
      )
        return {
          ...diagnostic(
            "ps",
            false,
            cause.reason,
            "unknown",
            "Process inspection exceeded its fixed output allowance; reduce the process-table output before retrying doctor. No firmware probe was launched.",
          ),
          details: {
            reason: "output_limit",
            max_output_bytes_per_stream: cause.outputLimitBytes,
          },
        };
      return diagnostic(
        "ps",
        false,
        failureMessage(cause),
        "missing_dependency",
        "Install procps/procps-ng or provide a procps-compatible ps on REA's PATH, then rerun doctor.",
      );
    }
  }

  async #inspectEngine(
    engine: FirmwareEngineName,
    prerequisites: readonly DoctorProviderCheck[],
    limiter: string | undefined,
    progress: InspectionProgress,
  ): Promise<DoctorProviderInspection> {
    const variable = FIRMWARE_TOOL_REQUIREMENTS[engine].commandEnvironment;
    const configured = this.environment[variable] !== undefined;
    const checks = [...prerequisites];
    const command = await inspectFirmwareExecutable(
      this.environment[variable],
      variable,
      true,
      this.signal,
    );
    checks.push(
      diagnostic(
        "configuration",
        command.ok,
        command.ok
          ? `${variable} resolves to ${command.value.resolvedPath}.`
          : command.error,
        configured ? "config_drift" : "missing_analysis_engine",
        `Set ${variable} to an absolute readable executable path to the caller-supplied ${engine} tool.`,
      ),
    );
    let version: string | null = null;
    if (command.ok && limiter !== undefined) {
      const probe = await this.#probe(
        limiter,
        limitedArguments(command.value.invocationPath, ["--version"]),
        progress,
      );
      if (!probe.ok || probe.value.exitCode !== 0) {
        checks.push(
          diagnostic(
            "version",
            false,
            probe.ok
              ? `Version probe exited ${String(probe.value.exitCode)}: ${probe.value.stderr || probe.value.stdout}`
              : probe.error,
            "runtime_failure",
            `Check ${variable} and its runtime dependencies, then rerun doctor.`,
          ),
        );
      } else {
        const admitted = admitFirmwareVersion(
          engine,
          probe.value.stdout.trim(),
        );
        const accepted =
          admitted.status === "verified" || admitted.status === "compatible";
        if (accepted) version = admitted.version;
        checks.push(
          diagnostic(
            "version",
            accepted,
            admitted.status === "verified"
              ? `Verified release ${admitted.version}.`
              : admitted.status === "compatible"
                ? admitted.limitation
                : admitted.message,
            admitted.status === "unresolved" ? "unknown" : "config_drift",
            `Select a supported ${engine} release; see docs/firmware-analysis.md.`,
          ),
        );
        if (engine === "unblob" && accepted)
          checks.push(
            await this.#inspectDependencies(
              limiter,
              command.value.invocationPath,
              progress,
            ),
          );
      }
    }
    return {
      id: engine,
      configured,
      available: checks.every(({ ok }) => ok),
      providerVersion: version,
      // Readiness does not opt firmware tools into setup's registration writes.
      registrationEnvironment: {},
      checks,
    };
  }

  async #inspectDependencies(
    limiter: string,
    command: string,
    progress: InspectionProgress,
  ): Promise<DoctorProviderCheck> {
    const result = await this.#probe(
      limiter,
      limitedArguments(command, ["--show-external-dependencies"]),
      progress,
    );
    if (!result.ok)
      return diagnostic(
        "external-dependencies",
        false,
        result.error,
        "runtime_failure",
        "Check unblob --show-external-dependencies and its runtime dependencies.",
      );
    const { stdout, stderr, exitCode } = result.value;
    const parsed = parseDependencies(stdout);
    if (
      !parsed.ok ||
      (exitCode !== 0 && exitCode !== 1) ||
      (exitCode === 1 && parsed.value.missing.length === 0) ||
      (exitCode === 0 && parsed.value.missing.length > 0)
    )
      return diagnostic(
        "external-dependencies",
        false,
        `Unrecognized or inconsistent Unblob dependency report (exit ${String(exitCode)}): ${stdout}${stderr}`,
        "unknown",
        "Inspect unblob --show-external-dependencies; doctor could not establish extractor readiness.",
      );
    const missing = parsed.value.missing;
    return {
      ...diagnostic(
        "external-dependencies",
        missing.length === 0,
        missing.length === 0
          ? "All external extractors reported by Unblob are installed; extraction behavior remains target-dependent."
          : `Unblob reports missing external extractors: ${missing.join(", ")}. Selected formats may still work with partial coverage.`,
        "missing_dependency",
        `Provide the extractors reported missing by unblob --show-external-dependencies: ${missing.join(", ")}.`,
      ),
      details: { installed: parsed.value.installed, missing },
    };
  }

  async #probe(
    command: string,
    arguments_: readonly string[],
    progress: InspectionProgress,
  ): Promise<Result<ProbeOutput, string>> {
    // A failed cleanup blocks subsequent launches while keeping successful peer facts.
    if (this.#pendingCleanup.size > 0)
      return err(
        "An earlier firmware diagnostic still owns unresolved process cleanup; no further tool was launched.",
      );
    try {
      const result = await (this.host.runCommand ?? runOwnedCommand)(
        {
          command,
          arguments: arguments_,
          expectedCommand: null,
          cwd: process.cwd(),
          hostEnvironment: this.environment,
          env: {
            NO_COLOR: "1",
            PYTHONDONTWRITEBYTECODE: "1",
            RAYON_NUM_THREADS: "1",
          },
          runId: `rea-firmware-doctor-${randomUUID()}`,
        },
        PROBE_LIMITS,
        {
          signal: this.signal,
          retainCleanup: (owner) => {
            this.#pendingCleanup.add(owner);
          },
        },
      );
      return ok({
        stdout: result.stdout.text,
        stderr: result.stderr.text,
        exitCode: result.exitCode ?? null,
      });
    } catch (cause: unknown) {
      const failure = probeFailure(cause);
      if (failure instanceof AnalysisCancelledError) throw failure;
      // Keep the first command failure through later admission/finalization
      // cancellation, while ordinary failures still allow peer diagnostics.
      if (progress.primaryFailure === undefined)
        progress.primaryFailure = failure;
      else if (progress.primaryFailure !== failure)
        progress.primaryFailure.retainSecondaryFailure(failure);
      if (
        cause instanceof OwnedCommandFailure &&
        cause.cancellation !== undefined
      )
        throw analysisErrorWithCancellation(
          progress.primaryFailure,
          new AnalysisCancelledError("doctor", {
            cause: cause.cancellation.reason,
          }),
        );
      const output =
        cause instanceof OwnedCommandFailure ? cause.snapshot : null;
      return err(
        `${failureMessage(cause)}${output === null ? "" : `; stdout: ${output.stdout.text}; stderr: ${output.stderr.text}`}`,
      );
    }
  }
}

const diagnostic = (
  name: string,
  ok: boolean,
  detail: string,
  classification: DoctorProviderCheck["classification"],
  remediation: string,
): DoctorProviderCheck => ({
  name,
  ok,
  detail,
  classification,
  code: ok ? null : "provider_unavailable",
  remediation: ok ? null : remediation,
});

const limitedArguments = (
  command: string,
  args: readonly string[],
): readonly string[] => [
  ...prlimitArgumentVector(
    {
      address_space_bytes: FIRMWARE_LIMITS.addressSpaceBytes,
      file_bytes: 0,
      cpu_seconds: 5,
    },
    command,
  ),
  ...args,
];

const failureMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Translate the command owner's recorded outcome before considering later cancellation. */
const probeFailure = (cause: unknown): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  const owned = cause instanceof OwnedCommandFailure ? cause : undefined;
  const options = {
    cause,
    ...(owned?.snapshot == null
      ? {}
      : { capturedOutput: artifactCommandOutput(owned.snapshot) }),
    diagnostics: {
      firmware_probe: {
        reason: owned?.reason ?? "process",
        message: failureMessage(cause),
      },
    },
  };
  if (owned?.reason === "cancelled")
    return new AnalysisCancelledError("doctor", {
      ...options,
      cause:
        owned.cancellation === undefined ? cause : owned.cancellation.reason,
    });
  if (owned?.reason === "timeout")
    return new AnalysisTimeoutError("doctor", PROBE_LIMITS.timeoutMs, options);
  if (owned?.reason === "output-limit")
    return new AnalysisResourceConstraintError(
      "doctor",
      "memory",
      owned.message,
      { diagnostic_bytes: PROBE_LIMITS.diagnosticBytes },
      {
        ...options,
        retryable: false,
        remediationAction:
          "The firmware diagnostic output allowance is fixed at 65536 bytes. Reduce the tool's diagnostic output before retrying; changing its timeout does not raise this limit.",
      },
    );
  return new ProviderAdapterError("firmware", "doctor", {
    ...options,
    userMessage: failureMessage(cause),
  });
};

/** Parse only the upstream 26.6 dependency format; unfamiliar output remains unknown. */
const parseDependencies = (
  stdout: string,
): Result<{ installed: string[]; missing: string[] }, string> => {
  const [header, ...lines] = stdout.trim().split(/\r?\n/u);
  if (header !== DEPENDENCY_HEADER || lines.length === 0)
    return err("Unrecognized dependency report.");
  const installed: string[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const match = /^\s+(\S+)\s+([✓✗])\s*$/u.exec(line);
    const command = match?.[1];
    if (command === undefined || seen.has(command))
      return err("Malformed or duplicate dependency row.");
    seen.add(command);
    (match?.[2] === "✓" ? installed : missing).push(command);
  }
  return ok({ installed, missing });
};
