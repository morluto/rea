import { randomUUID } from "node:crypto";

import {
  hopperStartupExitCode,
  type HopperPrivateDisplayStrategy,
  type HopperStartupDiagnostic,
  type HopperStartupFailureCode,
} from "../domain/hopperStartupFailure.js";
import { cleanupOwnedProcessGroup } from "../process/ProcessOwnership.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../process/ProviderProcess.js";
import { parseLinuxPrivateDisplayDiagnostic } from "./LinuxPrivateDisplayDiagnostic.js";

const PYTHON_PATH = "/usr/bin/python3";
const UNSHARE_PATH = "/usr/bin/unshare";
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const PROBE_OUTPUT_LIMIT_BYTES = 64 * 1024;

export type LinuxPrivateDisplayRunnableStrategy = Exclude<
  HopperPrivateDisplayStrategy,
  "unavailable"
>;

export interface LinuxPrivateDisplayProbeProcessResult {
  readonly exitCode: number | null | undefined;
  readonly stderr: string;
  readonly stderrBytes: number;
  readonly stderrTruncated: boolean;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly cleanupIncomplete: boolean;
}

export type LinuxPrivateDisplayProbeRunner = (
  strategy: LinuxPrivateDisplayRunnableStrategy,
  options: {
    readonly helperPath: string;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  },
) => Promise<LinuxPrivateDisplayProbeProcessResult>;

export type LinuxPrivateDisplaySelection =
  | {
      readonly ok: true;
      readonly strategy: LinuxPrivateDisplayRunnableStrategy;
      readonly diagnostic: HopperStartupDiagnostic;
    }
  | {
      readonly ok: false;
      readonly strategy: "unavailable";
      readonly exitCode: number;
      readonly diagnostic: HopperStartupDiagnostic;
    };

/** Probe the exact Xvfb boundary and select the least-privileged viable strategy. */
export const selectLinuxPrivateDisplayStrategy = async (options: {
  readonly helperPath: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly runProbe?: LinuxPrivateDisplayProbeRunner;
}): Promise<LinuxPrivateDisplaySelection> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const runner = options.runProbe ?? runLinuxPrivateDisplayProbe;
  const direct = await evaluatedProbe("direct", options, timeoutMs, runner);
  if (direct.ok) return direct;
  if (direct.diagnostic.failure_code !== "x11_socket_directory_unusable")
    return unavailable(direct.diagnostic);

  const isolated = await evaluatedProbe(
    "user-mount-namespace",
    options,
    timeoutMs,
    runner,
  );
  if (!isolated.ok)
    return unavailable({
      ...direct.diagnostic,
      strategy: "unavailable",
      reason: "namespace_unavailable",
      fallback_reason: isolated.diagnostic.reason,
      effective_socket_directory_mode:
        isolated.diagnostic.effective_socket_directory_mode,
      effective_mount_read_only: isolated.diagnostic.effective_mount_read_only,
      xvfb_stderr_bytes: isolated.diagnostic.xvfb_stderr_bytes,
      xvfb_stderr_truncated: isolated.diagnostic.xvfb_stderr_truncated,
    });
  return {
    ok: true,
    strategy: "user-mount-namespace",
    diagnostic: {
      ...isolated.diagnostic,
      socket_directory_mode: direct.diagnostic.socket_directory_mode,
      mount_read_only: direct.diagnostic.mount_read_only,
      fallback_reason: null,
    },
  };
};

/** Run one helper probe in an owned process group with a hard output bound. */
export const runLinuxPrivateDisplayProbe: LinuxPrivateDisplayProbeRunner =
  async (strategy, options) => {
    if (options.signal?.aborted === true)
      return emptyProcessResult({ cancelled: true });
    const command = privateDisplayProbeCommand(options.helperPath, strategy);
    let started: Awaited<ReturnType<typeof spawnOwnedProviderProcess>>;
    try {
      started = await spawnOwnedProviderProcess({
        command: command.command,
        arguments: command.arguments,
        runId: randomUUID(),
        expectedCommand: null,
      });
    } catch {
      return emptyProcessResult();
    }
    const launch = {
      process: started.process,
      ownsProcessLifetime: true,
      cleanup: () => cleanupOwnedProcessGroup(started.ownership),
    };
    const supervisor = new ProviderProcessSupervisor(launch, {
      maxOutputBytesPerStream: PROBE_OUTPUT_LIMIT_BYTES,
    });
    const outcome = await waitForProbeExit(
      supervisor,
      options.timeoutMs,
      options.signal,
    );
    let cleanupIncomplete = false;
    if (outcome !== "exit") {
      const stopped = await supervisor.stop();
      cleanupIncomplete = stopped.status === "incomplete";
    } else supervisor.dispose();
    const snapshot = supervisor.snapshot();
    return {
      exitCode: snapshot.exitCode,
      stderr: snapshot.stderr.text,
      stderrBytes: snapshot.stderr.bytes,
      stderrTruncated: snapshot.stderr.truncated,
      timedOut: outcome === "timeout",
      cancelled: outcome === "cancelled",
      cleanupIncomplete,
    };
  };

const privateDisplayProbeCommand = (
  helperPath: string,
  strategy: LinuxPrivateDisplayRunnableStrategy,
): { readonly command: string; readonly arguments: readonly string[] } =>
  strategy === "direct"
    ? {
        command: PYTHON_PATH,
        arguments: [helperPath, "--probe", "--strategy", "direct"],
      }
    : {
        command: UNSHARE_PATH,
        arguments: [
          "--user",
          "--map-root-user",
          "--mount",
          "--propagation",
          "private",
          PYTHON_PATH,
          helperPath,
          "--probe",
          "--strategy",
          "user-mount-namespace",
          "--mount-private-x11",
        ],
      };

const evaluatedProbe = async (
  strategy: LinuxPrivateDisplayRunnableStrategy,
  options: {
    readonly helperPath: string;
    readonly signal?: AbortSignal;
  },
  timeoutMs: number,
  runner: LinuxPrivateDisplayProbeRunner,
): Promise<
  | {
      readonly ok: true;
      readonly strategy: LinuxPrivateDisplayRunnableStrategy;
      readonly diagnostic: HopperStartupDiagnostic;
    }
  | {
      readonly ok: false;
      readonly diagnostic: HopperStartupDiagnostic;
    }
> => {
  let processResult: LinuxPrivateDisplayProbeProcessResult;
  try {
    processResult = await runner(strategy, {
      helperPath: options.helperPath,
      timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch {
    return {
      ok: false,
      diagnostic: syntheticDiagnostic(strategy, "probe_failed"),
    };
  }
  if (processResult.cancelled)
    return {
      ok: false,
      diagnostic: syntheticDiagnostic(strategy, "cancelled"),
    };
  if (processResult.timedOut)
    return {
      ok: false,
      diagnostic: syntheticDiagnostic(strategy, "probe_timeout"),
    };
  if (processResult.cleanupIncomplete)
    return {
      ok: false,
      diagnostic: syntheticDiagnostic(strategy, "cleanup_incomplete"),
    };
  const parsed = parseLinuxPrivateDisplayDiagnostic(
    processResult.stderr,
    processResult.stderrTruncated,
  );
  if (!parsed.ok)
    return {
      ok: false,
      diagnostic: syntheticDiagnostic(strategy, parsed.reason),
    };
  const diagnostic = parsed.value;
  if (
    diagnostic.strategy !== strategy ||
    diagnostic.operation !== "probe" ||
    !exitMatchesDiagnostic(processResult.exitCode, diagnostic)
  )
    return {
      ok: false,
      diagnostic: syntheticDiagnostic(strategy, "diagnostic_malformed"),
    };
  return diagnostic.status === "ready"
    ? { ok: true, strategy, diagnostic }
    : { ok: false, diagnostic };
};

const exitMatchesDiagnostic = (
  exitCode: number | null | undefined,
  diagnostic: HopperStartupDiagnostic,
): boolean =>
  diagnostic.status === "ready"
    ? exitCode === 0
    : diagnostic.failure_code !== null &&
      hopperStartupExitCode(diagnostic.failure_code) === exitCode;

const syntheticDiagnostic = (
  strategy: LinuxPrivateDisplayRunnableStrategy,
  reason: string,
  failureCode: HopperStartupFailureCode = "private_display_unavailable",
): HopperStartupDiagnostic => ({
  schema_version: 1,
  component: "hopper_private_display",
  operation: "probe",
  status: "error",
  failure_code: failureCode,
  reason,
  socket_directory: "/tmp/.X11-unix",
  socket_directory_mode: null,
  mount_read_only: null,
  effective_socket_directory_mode: null,
  effective_mount_read_only: null,
  wsl: false,
  strategy,
  fallback_reason: null,
  xvfb_stderr_bytes: 0,
  xvfb_stderr_truncated: false,
});

const unavailable = (
  diagnostic: HopperStartupDiagnostic,
): LinuxPrivateDisplaySelection => ({
  ok: false,
  strategy: "unavailable",
  exitCode:
    diagnostic.failure_code === null
      ? 70
      : (hopperStartupExitCode(diagnostic.failure_code) ?? 70),
  diagnostic: { ...diagnostic, strategy: "unavailable" },
});

const emptyProcessResult = (
  overrides: Partial<LinuxPrivateDisplayProbeProcessResult> = {},
): LinuxPrivateDisplayProbeProcessResult => ({
  exitCode: undefined,
  stderr: "",
  stderrBytes: 0,
  stderrTruncated: false,
  timedOut: false,
  cancelled: false,
  cleanupIncomplete: false,
  ...overrides,
});

const waitForProbeExit = async (
  supervisor: ProviderProcessSupervisor,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<"exit" | "timeout" | "cancelled"> => {
  if (signal?.aborted === true) return "cancelled";
  let releaseAbort: (() => void) | undefined;
  const aborted = new Promise<"cancelled">((resolve) => {
    if (signal === undefined) return;
    const listener = (): void => resolve("cancelled");
    signal.addEventListener("abort", listener, { once: true });
    releaseAbort = () => signal.removeEventListener("abort", listener);
  });
  try {
    return await Promise.race([
      supervisor
        .waitForExit(Math.max(1, timeoutMs))
        .then((exited): "exit" | "timeout" => (exited ? "exit" : "timeout")),
      aborted,
    ]);
  } finally {
    releaseAbort?.();
  }
};
