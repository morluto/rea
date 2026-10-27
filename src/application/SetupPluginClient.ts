import { z } from "zod";
import { stat } from "node:fs/promises";
import { win32 } from "node:path";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import {
  isWindowsBatchFile,
  windowsBatchCommand,
} from "../process/WindowsBatchCommand.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import {
  launchRegistrationRunnerCommand,
  type RegistrationRunnerLauncher,
} from "./SetupRegistrationPrewarm.js";

export const REA_PLUGIN_ID = "rea@rea";
const REA_MARKETPLACE = "morluto/rea";
type PluginClientCommand = "codex" | "claude";
export type PluginInspection =
  | { readonly status: "unsupported" }
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

const launchPluginCommand: RegistrationRunnerLauncher = async (
  command,
  arguments_,
  options,
) => {
  if (options.platform !== "win32")
    return launchRegistrationRunnerCommand(command, arguments_, options);
  const selectedEnvironment = snapshotEnvironment(options.env, "win32");
  const environment = {
    ...selectedEnvironment,
    PATHEXT: selectedEnvironment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
  };
  // Resolve PATH explicitly: cmd would otherwise prefer a file in the project CWD.
  let executable: string | undefined;
  for (const entry of (selectedEnvironment.PATH ?? "").split(";")) {
    if (entry === "") continue;
    const directory =
      entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry;
    if (directory === "") continue;
    for (const extension of environment.PATHEXT.split(";")) {
      if (![".com", ".exe", ".bat", ".cmd"].includes(extension.toLowerCase()))
        continue;
      const candidate = win32.resolve(
        options.cwd,
        directory,
        `${command}${extension}`,
      );
      try {
        if ((await stat(candidate)).isFile()) {
          executable = candidate;
          break;
        }
      } catch (cause: unknown) {
        const code =
          cause instanceof Error && "code" in cause ? cause.code : undefined;
        if (code !== "ENOENT" && code !== "ENOTDIR")
          return {
            exitCode: null,
            signal: null,
            stdout: "",
            stderr:
              "Client PATH lookup failed. Check access to the selected PATH directories.",
            timedOut: false,
          };
      }
    }
    if (executable !== undefined) break;
  }
  if (executable === undefined)
    return {
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      spawnError: "ENOENT: client was not found on the selected PATH",
    };
  if (!isWindowsBatchFile(executable))
    return launchRegistrationRunnerCommand(executable, arguments_, {
      ...options,
      env: environment,
    });
  const invocation = windowsBatchCommand({
    environment,
    batchPath: executable,
    arguments: arguments_,
  });
  return launchRegistrationRunnerCommand(
    invocation.command,
    invocation.arguments,
    {
      ...options,
      env: environment,
      windowsVerbatimArguments: true,
    },
  );
};

/** Client commands own plugin state; never infer it from a cache directory. */
export class SetupPluginClient {
  constructor(
    readonly command: PluginClientCommand,
    private readonly environment: Readonly<NodeJS.ProcessEnv>,
    private readonly resources: ArtifactResourceScope,
    private readonly launch: RegistrationRunnerLauncher = launchPluginCommand,
  ) {}

  private async run(arguments_: readonly string[], timeoutMs: number) {
    const result = await this.launch(this.command, arguments_, {
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

  async inspect(): Promise<PluginInspection> {
    const result = await this.run(["plugin", "list", "--json"], 30_000);
    if (result.cleanupFailure !== undefined || result.timedOut)
      return {
        status: "invalid",
        remediation: `${this.command} plugin inspection did not finish safely. Check the client and rerun setup.`,
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
        return { status: "unsupported" };
      return {
        status: "invalid",
        remediation: `${this.command} plugin list failed. Run ${this.command} plugin list --json, resolve the reported error, and rerun setup.`,
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
        remediation: `${this.command} returned an unreadable plugin inventory. No registration was added; update the client or inspect its plugin list.`,
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
        return `${this.command} ${arguments_.join(" ")} did not complete. Run the command in your terminal, resolve its error, then rerun setup. Any successfully added marketplace is retained; no direct MCP registration was created.`;
    }
    const verified = await this.inspect();
    return verified.status === "available" &&
      verified.installed &&
      verified.enabled
      ? undefined
      : `The client did not confirm an enabled ${REA_PLUGIN_ID} installation. Check ${this.command} plugin list before rerunning setup.`;
  }
}
