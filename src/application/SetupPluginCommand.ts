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
import { BoundedOutputExcerpt } from "../process/BoundedOutputExcerpt.js";

const PLUGIN_COMMAND_CAPTURE_LIMIT = 64 * 1024;

/** Facts of one supervised client plugin command. */
export interface SetupPluginCommandResult {
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
export type SetupPluginCommandLauncher = (
  command: string,
  arguments_: readonly string[],
  options: {
    readonly env: Readonly<NodeJS.ProcessEnv>;
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly platform: NodeJS.Platform;
    readonly resources: ArtifactResourceScope;
    readonly launcher?: typeof spawnOwnedProviderProcess;
    readonly windowsVerbatimArguments?: boolean;
  },
) => Promise<SetupPluginCommandResult>;

/** Own the launcher and token-marked descendants until cleanup is verified. */
export const launchSetupPluginCommand: SetupPluginCommandLauncher = (
  command,
  arguments_,
  options,
) => {
  const environment = snapshotEnvironment(options.env, options.platform);
  return options.resources.run(async () => {
    const stdout = new BoundedOutputExcerpt(PLUGIN_COMMAND_CAPTURE_LIMIT);
    const stderr = new BoundedOutputExcerpt(PLUGIN_COMMAND_CAPTURE_LIMIT);
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
        runId: `rea-plugin-command-${randomUUID()}`,
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
              : "Plugin command ownership was not confirmed.",
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

/** Terminal interrupts must also stop the owned plugin command tree. */
const FORWARD_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
