import { z } from "zod";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import type { SetupPluginCommandLauncher } from "./SetupPluginCommand.js";
import {
  SetupPluginCommands,
  pluginCommandFailure,
} from "./SetupPluginCommands.js";

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

/** Client commands own plugin state; never infer it from a cache directory. */
export class SetupPluginClient extends SetupPluginCommands {
  constructor(
    readonly command: PluginClientCommand,
    environment: Readonly<NodeJS.ProcessEnv>,
    resources: ArtifactResourceScope,
    launch?: SetupPluginCommandLauncher,
  ) {
    super(environment, resources, launch);
  }

  async inspect(): Promise<PluginInspection> {
    const result = await this.run(
      this.command,
      ["plugin", "list", "--json"],
      30_000,
    );
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
      const result = await this.run(this.command, arguments_, 180_000);
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
