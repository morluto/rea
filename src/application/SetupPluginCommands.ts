import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import {
  isWindowsBatchFile,
  windowsBatchCommand,
} from "../process/WindowsBatchCommand.js";
import { BoundedOutputExcerpt } from "../process/BoundedOutputExcerpt.js";
import { findWindowsExecutable } from "../process/WindowsExecutable.js";
import {
  supportsNodeVersion,
  SUPPORTED_NODE_VERSION_PROSE,
} from "../domain/runtimeVersion.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import {
  launchSetupPluginCommand,
  type SetupPluginCommandLauncher,
  type SetupPluginCommandResult,
} from "./SetupPluginCommand.js";

export const launchPluginCommand: SetupPluginCommandLauncher = async (
  command,
  arguments_,
  options,
) => {
  if (options.platform !== "win32")
    return launchSetupPluginCommand(command, arguments_, options);
  const selectedEnvironment = snapshotEnvironment(options.env, "win32");
  const environment = {
    ...selectedEnvironment,
    PATHEXT: selectedEnvironment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
  };
  const found = await findWindowsExecutable(command, environment, {
    signal:
      options.signal === undefined
        ? AbortSignal.timeout(options.timeoutMs)
        : AbortSignal.any([
            options.signal,
            AbortSignal.timeout(options.timeoutMs),
          ]),
    cwd: options.cwd,
    allowBatch: command !== "node",
  });
  if (!found.ok) {
    const failure = found.error;
    return {
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      timedOut: failure.kind === "interrupted",
      spawnError:
        failure.kind === "missing"
          ? `ENOENT: ${command} was not found on the selected PATH`
          : failure.kind === "inspection"
            ? `Client PATH lookup failed at ${failure.path} (${failure.code ?? "unknown filesystem error"}).`
            : failure.kind === "invalid_extension"
              ? `Client PATH lookup rejected PATHEXT entry ${failure.extension}.`
              : "Client PATH lookup reached its deadline.",
    };
  }
  const executable = found.value;
  if (!isWindowsBatchFile(executable))
    return launchSetupPluginCommand(executable, arguments_, {
      ...options,
      env: environment,
    });
  const invocation = windowsBatchCommand({
    environment,
    batchPath: executable,
    arguments: arguments_,
  });
  return launchSetupPluginCommand(invocation.command, invocation.arguments, {
    ...options,
    env: environment,
    windowsVerbatimArguments: true,
  });
};

export const pluginCommandFailure = (
  result: SetupPluginCommandResult,
): string => {
  const excerpt = new BoundedOutputExcerpt(2048);
  excerpt.append(
    Buffer.from(
      [
        result.timedOut
          ? "command timed out"
          : `exit ${result.exitCode ?? "unknown"}`,
        result.spawnError,
        result.cleanupFailure === undefined
          ? undefined
          : `child cleanup incomplete: ${result.cleanupFailure}`,
        result.stderr.trim(),
        result.stdout.trim(),
      ]
        .filter((value) => value !== undefined && value !== "")
        .join("; "),
    ),
  );
  return excerpt.text;
};

/** Shared supervised commands and runtime prerequisite for plugin installers. */
export class SetupPluginCommands {
  constructor(
    protected readonly environment: Readonly<NodeJS.ProcessEnv>,
    protected readonly resources: ArtifactResourceScope,
    private readonly launch: SetupPluginCommandLauncher = launchPluginCommand,
  ) {}
  protected async run(
    command: string,
    arguments_: readonly string[],
    timeoutMs: number,
  ) {
    const result = await this.launch(command, arguments_, {
      env: this.environment,
      cwd: process.cwd(),
      timeoutMs,
      platform: process.platform,
      resources: this.resources,
    });
    if (result.interruptedSignal !== undefined)
      throw new AnalysisCancelledError("setup", {
        cause: result.interruptedSignal,
        diagnostics: { interrupted_signal: result.interruptedSignal },
      });
    return result;
  }

  async inspectRuntime(): Promise<string | undefined> {
    const result = await this.run("node", ["--version"], 10_000);
    return result.exitCode === 0 &&
      result.spawnError === undefined &&
      !result.timedOut &&
      result.cleanupFailure === undefined &&
      result.stdoutTruncated !== true &&
      supportsNodeVersion(result.stdout.trim())
      ? undefined
      : `REA plugins require standalone ${SUPPORTED_NODE_VERSION_PROSE} on the client's PATH. Install a supported Node.js runtime or explicitly choose direct setup with --skill=false. Node check: ${pluginCommandFailure(result)}`;
  }
}
