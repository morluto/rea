import { isAbsolute } from "node:path";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import { parseEnvironmentValues } from "./environment.js";

/**
 * User-owned provider configuration persisted at
 * `${XDG_CONFIG_HOME:-~/.config}/rea/rea.json`.
 *
 * Precedence is env > config file > auto-detect. Values are merged into the
 * environment snapshot for provider inspection and execution. Retain the
 * names filled in from the file so client registrations can inherit them.
 */
export const USER_CONFIG_FILE_NAME = "rea.json";

/** Settings a user may persist; env vars keep winning over these. */
export const PERSISTED_SETTINGS = [
  "GHIDRA_INSTALL_DIR",
  "JAVA_HOME",
  "REA_IDA_MCP_CONFIG",
  "REA_JADX_MCP_JAR",
  "REA_GHIDRA_NATIVEAOT_JAR",
  "REA_ILSPY_CMD_PATH",
  "HOPPER_LAUNCHER_PATH",
] as const;

export type PersistedSetting = (typeof PERSISTED_SETTINGS)[number];
export type UserSettings = Partial<Record<PersistedSetting, string>>;

type RawUserConfig = Partial<Record<PersistedSetting, unknown>>;

/**
 * Parse and validate the persisted settings. Unknown keys and non-string
 * values are rejected so a typo'd edit fails loudly instead of silently
 * being ignored.
 */
export const parseUserConfig = (
  raw: unknown,
): Result<UserSettings, ConfigurationError> => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return err(
      new ConfigurationError("Invalid REA user configuration", {
        settings: [
          {
            setting: USER_CONFIG_FILE_NAME,
            constraint: "must be a JSON object of provider settings",
          },
        ],
      }),
    );
  }
  const settings: Array<{ setting: string; constraint: string }> = [];
  const parsed: UserSettings = {};
  for (const [key, value] of Object.entries(raw as RawUserConfig)) {
    if (!(PERSISTED_SETTINGS as readonly string[]).includes(key)) {
      settings.push({
        setting: key,
        constraint:
          "is not a persistable REA setting; supported: " +
          PERSISTED_SETTINGS.join(", "),
      });
      continue;
    }
    if (typeof value !== "string" || value.length === 0) {
      settings.push({
        setting: key,
        constraint: "must be a non-empty string",
      });
      continue;
    }
    (parsed as Record<string, string>)[key] = value;
  }
  if (settings.length > 0) {
    return err(
      new ConfigurationError("Invalid REA user configuration", { settings }),
    );
  }
  const native = parseEnvironmentValues(parsed);
  if (!native.ok) return native;
  const jadx = parsed.REA_JADX_MCP_JAR;
  if (jadx !== undefined && !isAbsolute(jadx))
    return err(
      new ConfigurationError("Invalid REA user configuration", {
        settings: [
          { setting: "REA_JADX_MCP_JAR", constraint: "must be absolute" },
        ],
      }),
    );
  return ok(parsed);
};

export interface UserConfiguration {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly savedDefaults: ReadonlySet<string>;
}

/** Fill unset variables from validated defaults and retain their origins. */
export const applyUserConfigurationDefaults = (
  environment: Readonly<NodeJS.ProcessEnv>,
  defaults: UserSettings,
): UserConfiguration => {
  const savedDefaults = new Set<string>();
  const merged: NodeJS.ProcessEnv = { ...environment };
  for (const [key, value] of Object.entries(defaults)) {
    if (merged[key] !== undefined) continue;
    merged[key] = value;
    savedDefaults.add(key);
  }
  return {
    environment: savedDefaults.size === 0 ? environment : Object.freeze(merged),
    savedDefaults,
  };
};

export const parseUserConfigText = (
  contents: string,
): Result<UserSettings, ConfigurationError> => {
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch (cause) {
    return err(
      new ConfigurationError("Invalid REA user configuration", {
        cause,
        settings: [
          {
            setting: USER_CONFIG_FILE_NAME,
            constraint: "must be valid JSON",
          },
        ],
      }),
    );
  }
  return parseUserConfig(raw);
};
