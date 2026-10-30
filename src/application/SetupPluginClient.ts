import { z } from "zod";
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

export const REA_PLUGIN_ID = "rea@rea";
const REA_MARKETPLACE = "morluto/rea";
type PluginClientCommand = "codex" | "claude";
export type PluginInspection =
  | { readonly status: "unsupported"; readonly remediation: string }
  | { readonly status: "invalid"; readonly remediation: string }
  | {
      readonly status: "available";
      readonly installed: boolean;
      readonly enabled: boolean;
    };

const codexPlugins = z.object({
  installed: z.array(
    z.object({
      pluginId: z.string(),
      name: z.string(),
      enabled: z.boolean(),
    }),
  ),
});
const claudePlugins = z.array(
  z.object({
    id: z.string(),
    scope: z.string(),
    enabled: z.boolean(),
  }),
);

const launchPluginCommand: SetupPluginCommandLauncher = async (
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
    signal: AbortSignal.timeout(options.timeoutMs),
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

const pluginCommandFailure = (result: SetupPluginCommandResult): string => {
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

/** Client commands own plugin state; never infer it from a cache directory. */
export class SetupPluginClient {
  constructor(
    readonly command: PluginClientCommand,
    private readonly environment: Readonly<NodeJS.ProcessEnv>,
    private readonly resources: ArtifactResourceScope,
    private readonly launch: SetupPluginCommandLauncher = launchPluginCommand,
  ) {}

  private async run(
    arguments_: readonly string[],
    timeoutMs: number,
    command: string = this.command,
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
    const result = await this.run(["--version"], 10_000, "node");
    return result.exitCode === 0 &&
      result.spawnError === undefined &&
      !result.timedOut &&
      result.cleanupFailure === undefined &&
      result.stdoutTruncated !== true &&
      supportsNodeVersion(result.stdout.trim())
      ? undefined
      : `REA plugins require standalone ${SUPPORTED_NODE_VERSION_PROSE} on the client's PATH. Install a supported Node.js runtime or explicitly choose direct setup with --skill=false. Node check: ${pluginCommandFailure(result)}`;
  }

  async inspect(): Promise<PluginInspection> {
    const result = await this.run(["plugin", "list", "--json"], 30_000);
    if (result.cleanupFailure !== undefined || result.timedOut)
      return {
        status: "invalid",
        remediation: `${this.command} plugin inspection did not finish safely: ${pluginCommandFailure(result)}. Check the client and rerun setup.`,
      };
    if (result.stdoutTruncated === true)
      return {
        status: "invalid",
        remediation: `${this.command} plugin inventory exceeded the 64 KiB output capture limit. Use the client's plugin manager directly; setup cannot verify this inventory.`,
      };
    if (result.exitCode !== 0) {
      if (
        /ENOENT|not recognized|unknown (?:command|subcommand)|unrecognized subcommand|unexpected argument/iu.test(
          `${result.spawnError ?? ""} ${result.stderr}`,
        )
      )
        return {
          status: "unsupported",
          remediation: `${this.command} plugin commands are unavailable: ${pluginCommandFailure(result)}`,
        };
      return {
        status: "invalid",
        remediation: `${this.command} plugin list failed: ${pluginCommandFailure(result)}. Resolve the reported error and rerun setup.`,
      };
    }
    try {
      const value: unknown = JSON.parse(result.stdout);
      const entries =
        this.command === "codex"
          ? codexPlugins.parse(value).installed.map((entry) => ({
              id: entry.pluginId,
              scope: "user",
              enabled: entry.enabled,
            }))
          : claudePlugins.parse(value);
      const rea = entries.filter(({ id }) => id.startsWith("rea@"));
      if (
        rea.some(({ id, scope }) => id !== REA_PLUGIN_ID || scope !== "user") ||
        rea.length > 1
      )
        return {
          status: "invalid",
          remediation: `REA is already provided by another ${this.command} plugin source or scope. Use the client's plugin manager to select one installation before rerunning setup.`,
        };
      const installed = rea[0];
      return {
        status: "available",
        installed: installed !== undefined,
        enabled: installed?.enabled === true,
      };
    } catch {
      return {
        status: "invalid",
        remediation: `${this.command} returned an unreadable plugin inventory: ${pluginCommandFailure(result)}. No registration was added; update the client or inspect its plugin list.`,
      };
    }
  }

  commands(installed: boolean): readonly (readonly string[])[] {
    return installed
      ? [
          [
            "plugin",
            "enable",
            REA_PLUGIN_ID,
            ...(this.command === "claude" ? ["--scope", "user"] : []),
          ],
        ]
      : [
          ["plugin", "marketplace", "add", REA_MARKETPLACE],
          [
            "plugin",
            this.command === "codex" ? "add" : "install",
            REA_PLUGIN_ID,
            ...(this.command === "claude" ? ["--scope", "user"] : []),
          ],
        ];
  }

  async install(installed: boolean): Promise<string | undefined> {
    for (const arguments_ of this.commands(installed)) {
      const result = await this.run(arguments_, 180_000);
      if (
        result.exitCode !== 0 ||
        result.timedOut ||
        result.cleanupFailure !== undefined
      )
        return `${this.command} ${arguments_.join(" ")} did not complete: ${pluginCommandFailure(result)}. Resolve the reported error, then rerun setup. Any successfully added marketplace is retained; no direct MCP registration was created.`;
    }
    const verified = await this.inspect();
    if (verified.status !== "available") return verified.remediation;
    return verified.status === "available" &&
      verified.installed &&
      verified.enabled
      ? undefined
      : `The client did not confirm an enabled ${REA_PLUGIN_ID} installation. Check ${this.command} plugin list before rerunning setup.`;
  }
}
