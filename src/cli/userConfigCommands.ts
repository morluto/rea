import type { Logger } from "pino";
import { z } from "zod";
import { logCliCommand } from "../cliLogging.js";
import { CLI_COMMANDS } from "../contracts/cliCommandNames.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import {
  loadUserConfiguration,
  PERSISTED_SETTINGS,
  updateUserConfig,
  userConfigFilePath,
  type PersistedSetting,
} from "../config/userConfig.js";
import { registerCliCommand } from "./commandRegistry.js";
import type { CliInstance } from "./types.js";

export const registerUserConfigCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  registerCliCommand(cli, CLI_COMMANDS.config, {
    description: "Show or persist provider settings in the user config file",
    args: z.object({}),
    options: z.object({
      set: z
        .array(z.string())
        .default([])
        .describe(
          "NAME=VALUE pairs to persist (repeatable); e.g. --set GHIDRA_INSTALL_DIR=/opt/ghidra",
        ),
      unset: z
        .array(z.string())
        .default([])
        .describe("Setting names to remove from the config file (repeatable)"),
      get: z
        .string()
        .optional()
        .describe("Show the configured value and source for one setting"),
    }),
    run: async ({ options }) =>
      logCliCommand(logger, CLI_COMMANDS.config, async () => {
        const persistable = PERSISTED_SETTINGS as readonly string[];
        const supported = `is not a persistable REA setting; supported: ${persistable.join(", ")}`;
        const rejectSetting = (setting: string, constraint: string): never => {
          throw new ConfigurationError("Invalid rea config request", {
            settings: [{ setting, constraint }],
          });
        };
        if (
          options.get !== undefined &&
          (options.set.length > 0 || options.unset.length > 0)
        ) {
          rejectSetting("--get", "cannot be combined with --set or --unset");
        }
        const effectiveSettings = async (): Promise<
          Record<string, { value: string; source: string }>
        > => {
          const read = await loadUserConfiguration(environment);
          if (!read.ok) throw read.error;
          const result: Record<string, { value: string; source: string }> = {};
          for (const name of persistable) {
            const value = read.value.environment[name];
            if (value === undefined || value.length === 0) continue;
            result[name] = {
              value,
              source: read.value.savedDefaults.has(name) ? "config" : "env",
            };
          }
          return result;
        };
        if (options.get !== undefined) {
          if (!persistable.includes(options.get)) {
            rejectSetting(options.get, supported);
          }
          const entry = (await effectiveSettings())[options.get];
          return entry === undefined
            ? { setting: options.get, value: null, source: "auto-detect" }
            : { setting: options.get, ...entry };
        }
        if (options.set.length > 0 || options.unset.length > 0) {
          const settings: Partial<Record<PersistedSetting, string>> = {};
          for (const pair of options.set) {
            const eq = pair.indexOf("=");
            if (eq <= 0) {
              rejectSetting(pair, "--set expects NAME=VALUE");
            }
            const name = pair.slice(0, eq);
            if (!persistable.includes(name)) {
              rejectSetting(name, supported);
            }
            const value = pair.slice(eq + 1);
            if (value.length === 0) {
              rejectSetting(name, "must be a non-empty string");
            }
            settings[name as PersistedSetting] = value;
          }
          for (const name of options.unset) {
            if (!persistable.includes(name)) {
              rejectSetting(name, supported);
            }
          }
          const path = userConfigFilePath(
            environment as Readonly<NodeJS.ProcessEnv>,
            HOST_PLATFORM.platform,
          );
          const { removed } = await updateUserConfig(
            environment as Readonly<NodeJS.ProcessEnv>,
            settings,
            options.unset as readonly PersistedSetting[],
          );
          return { path, saved: Object.keys(settings), removed };
        }
        return { settings: await effectiveSettings() };
      }),
  });
};
