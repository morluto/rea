import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import { randomUUID } from "node:crypto";
import {
  ArtifactResourceScope,
  type ArtifactResourceOwner,
} from "../artifacts/ArtifactResourceScope.js";
import { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../process/ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "../process/ProcessOwnership.js";
import { ownedCommandResources } from "../process/OwnedCommand.js";
import { tmpdir } from "node:os";
import { BoundedOutputExcerpt } from "../process/BoundedOutputExcerpt.js";

import { inspectClientRegistrationCommand } from "./ClientRegistrationIdentity.js";

/**
 * Best-effort outcome of materializing the pinned package-runner cache entry.
 * A failure never blocks setup; the first client start then performs the
 * one-time install inside its own startup deadline.
 */
export type SetupRegistrationPrewarm =
  | { readonly status: "skipped"; readonly reason: "direct_launcher" }
  | { readonly status: "warmed" }
  | {
      readonly status: "failed";
      readonly reason: string;
      readonly interruptedSignal?: string;
    };

/** One cold package install at setup time; client startup deadlines stay untouched. */
const PREWARM_TIMEOUT_MS = 180_000;
const PREWARM_CAPTURE_LIMIT = 64 * 1024;
const PREWARM_REASON_LIMIT = 300;

/** Facts of one supervised package-runner launch. */
export interface RegistrationRunnerLaunch {
  readonly exitCode: string | number | null;
  readonly signal: string | null;
  readonly stdout: string;
  /** Machine-readable consumers must reject an incomplete excerpt. */
  readonly stdoutTruncated?: boolean;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly spawnError?: string;
  readonly cleanupFailure?: string;
  /** Terminal interrupt that was forwarded to the runner tree, if any. */
  readonly interruptedSignal?: string;
}

/** Launch shape shared with the supervised spawn so tests can observe it. */
export type RegistrationRunnerLauncher = (
  command: string,
  arguments_: readonly string[],
  options: {
    readonly env: Readonly<NodeJS.ProcessEnv>;
    /** Neutral directory; inside a REA source checkout the package runner
     * would resolve the local project instead of the published entry. */
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly platform: NodeJS.Platform;
    readonly resources: ArtifactResourceScope;
    readonly launcher?: typeof spawnOwnedProviderProcess;
    readonly windowsVerbatimArguments?: boolean;
  },
) => Promise<RegistrationRunnerLaunch>;

/**
 * Resolve the cache-materializing variant of a registration command. The
 * package-runner cache entry is keyed by the requested spec, so a terminating
 * subcommand with the same spec warms the entry the client will launch.
 * Direct launchers keep no package-runner cache; they return undefined.
 */
export const registrationPrewarmCommand = (
  command: readonly string[],
): readonly string[] | undefined => {
  if (
    command.length === 0 ||
    command[command.length - 1] !== "mcp" ||
    inspectClientRegistrationCommand(command, undefined).package === undefined
  )
    return undefined;
  return [...command.slice(0, -1), "--version"];
};

/** Materialize the pinned package-runner cache entry once, best-effort. */
export const materializeRegistrationRunnerCache = async (
  command: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv>,
  resources: ArtifactResourceScope,
  launchCommand: RegistrationRunnerLauncher = launchRegistrationRunnerCommand,
): Promise<SetupRegistrationPrewarm> => {
  const prewarm = registrationPrewarmCommand(command);
  if (prewarm === undefined)
    return { status: "skipped", reason: "direct_launcher" };
  const launch = await launchCommand(prewarm[0] ?? "", prewarm.slice(1), {
    env: environment,
    cwd: tmpdir(),
    timeoutMs: PREWARM_TIMEOUT_MS,
    platform: process.platform,
    resources,
  });
  return launch.timedOut ||
    launch.spawnError !== undefined ||
    launch.cleanupFailure !== undefined ||
    launch.interruptedSignal !== undefined ||
    launch.exitCode !== 0
    ? {
        status: "failed",
        reason: prewarmFailureReason(launch),
        ...(launch.interruptedSignal === undefined
          ? {}
          : { interruptedSignal: launch.interruptedSignal }),
      }
    : { status: "warmed" };
};

/** Own the launcher and token-marked descendants until cleanup is verified. */
export const launchRegistrationRunnerCommand: RegistrationRunnerLauncher = (
  command,
  arguments_,
  options,
) => {
  const environment = snapshotEnvironment(options.env, options.platform);
  return options.resources.run(async () => {
    const stdout = new BoundedOutputExcerpt(PREWARM_CAPTURE_LIMIT);
    const stderr = new BoundedOutputExcerpt(PREWARM_CAPTURE_LIMIT);
    const controller = new AbortController();
    let timedOut = false;
    let spawnError: string | undefined;
    let cleanupFailure: string | undefined;
    let interruptedSignal: NodeJS.Signals | undefined;
    let supervisor: ProviderProcessSupervisor | undefined;
    let resource: ArtifactResourceOwner | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs);
    const signalHandlers = new Map<NodeJS.Signals, () => void>(
      FORWARD_SIGNALS.map((signal) => [
        signal,
        () => {
          if (interruptedSignal !== undefined) return;
          interruptedSignal = signal;
          controller.abort();
        },
      ]),
    );
    for (const [signal, handler] of signalHandlers) process.on(signal, handler);
    try {
      const launched = await (options.launcher ?? spawnOwnedProviderProcess)({
        command,
        arguments: arguments_,
        cwd: options.cwd,
        hostEnvironment: environment,
        platform: options.platform,
        runId: `rea-registration-prewarm-${randomUUID()}`,
        expectedCommand: null,
        sweepTokenOwnedProcesses: true,
        ...(options.windowsVerbatimArguments === undefined
          ? {}
          : { windowsVerbatimArguments: options.windowsVerbatimArguments }),
        signal: controller.signal,
      });
      supervisor = new ProviderProcessSupervisor(
        {
          ...launched,
          ownsProcessLifetime: true,
          cleanup:
            launched.cleanup ??
            (() => cleanupOwnedProcessGroup(launched.ownership)),
        },
        {
          captureStdout: false,
          maxDiagnosticBytes: 0,
          onDiagnostic: (event) => {
            if (event.type === "error") spawnError = event.message;
          },
        },
      );
      const owner = supervisor;
      const lease = new AnalysisCleanupLease(async () => {
        const stopped = await owner.stop();
        if (stopped.status === "incomplete" || stopped.status === "not-owned")
          throw new Error(
            stopped.status === "incomplete"
              ? stopped.reason
              : "Registration runner ownership was not confirmed.",
          );
      }, ownedCommandResources(launched.ownership));
      resource = { kind: "lease", resource: command, lease };
      options.resources.retain(resource);
      launched.process.stdout?.on("data", (chunk: Buffer) =>
        stdout.append(chunk),
      );
      launched.process.stderr?.on("data", (chunk: Buffer) =>
        stderr.append(chunk),
      );
      await supervisor.waitForOutputClose(undefined, controller.signal);
    } catch (cause: unknown) {
      if (!controller.signal.aborted)
        spawnError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      clearTimeout(timer);
      try {
        if (resource !== undefined) {
          const released = await options.resources.release(resource);
          if (released.kind === "failed") throw released.cause;
        }
      } catch (cause: unknown) {
        cleanupFailure = cause instanceof Error ? cause.message : String(cause);
      }
      for (const [signal, handler] of signalHandlers)
        process.removeListener(signal, handler);
      // Restore default termination only after stopping the owned runner tree.
      if (interruptedSignal !== undefined && cleanupFailure === undefined)
        process.kill(process.pid, interruptedSignal);
    }
    const exit = supervisor?.observedExit();
    return {
      exitCode: exit?.code ?? exit?.signal ?? null,
      signal: exit?.signal ?? null,
      stdout: stdout.text,
      stdoutTruncated: stdout.truncated,
      stderr: stderr.text,
      timedOut,
      ...(spawnError === undefined ? {} : { spawnError }),
      ...(cleanupFailure === undefined ? {} : { cleanupFailure }),
      ...(interruptedSignal === undefined ? {} : { interruptedSignal }),
    };
  });
};

/** Terminal interrupts that must also stop a detached package-runner tree. */
const FORWARD_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

const prewarmFailureReason = (launch: RegistrationRunnerLaunch): string => {
  const outcome =
    launch.cleanupFailure !== undefined
      ? "runner cleanup remains incomplete"
      : launch.spawnError !== undefined
        ? "spawn failed"
        : launch.interruptedSignal !== undefined
          ? `the package runner was stopped by ${launch.interruptedSignal}`
          : launch.timedOut
            ? `the package runner timed out after the bounded prewarm window`
            : `exit ${launch.exitCode === null ? "unknown" : String(launch.exitCode)}`;
  const normalized = (
    launch.cleanupFailure ??
    launch.spawnError ??
    launch.stderr
  )
    .replace(/\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\([0-9A-Za-z]|[@-Z\\^_])/gu, "")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const detailLimit = PREWARM_REASON_LIMIT - outcome.length - 2;
  const detail =
    normalized.length > detailLimit
      ? `… ${normalized.slice(-(detailLimit - 2))}`
      : normalized;
  const observed = `${outcome}${detail === "" ? "" : `: ${detail}`}`;
  return `The pinned package-runner entry could not be materialized before the first client start (${observed}); the first client start will install it inside its startup deadline.`;
};
