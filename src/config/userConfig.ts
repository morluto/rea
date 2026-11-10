import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import { homeDirectoryFromEnvironment } from "./homeDirectory.js";

/**
 * User-owned provider configuration persisted at
 * `${XDG_CONFIG_HOME:-~/.config}/rea/rea.json`.
 *
 * Precedence is env > config file > auto-detect. Values are merged into the
 * environment snapshot at the single seam that every consumer already reads
 * (doctor, setup, the registered MCP server, and direct analysis), so all
 * entry points resolve provider settings identically.
 */
const CONFIG_DIRECTORY_NAME = "rea";
const CONFIG_FILE_NAME = "rea.json";

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

export const userConfigFilePath = (
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): string => {
  const xdg = environment.XDG_CONFIG_HOME;
  const configRoot =
    xdg !== undefined && xdg.length > 0 && isAbsolute(xdg)
      ? xdg
      : join(
          homeDirectoryFromEnvironment(
            environment as Readonly<NodeJS.ProcessEnv>,
            platform,
          ),
          ".config",
        );
  return join(configRoot, CONFIG_DIRECTORY_NAME, CONFIG_FILE_NAME);
};

type RawUserConfig = Partial<Record<PersistedSetting, unknown>>;

/**
 * Parse and validate the persisted settings. Unknown keys and non-string
 * values are rejected so a typo'd edit fails loudly instead of silently
 * being ignored.
 */
export const parseUserConfig = (
  raw: unknown,
): Result<Partial<Record<PersistedSetting, string>>, ConfigurationError> => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return err(
      new ConfigurationError("Invalid REA user configuration", {
        settings: [
          {
            setting: CONFIG_FILE_NAME,
            constraint: "must be a JSON object of provider settings",
          },
        ],
      }),
    );
  }
  const settings: Array<{ setting: string; constraint: string }> = [];
  const parsed: Partial<Record<PersistedSetting, string>> = {};
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
  return ok(parsed);
};

/**
 * Overlay persisted settings onto an environment snapshot. Ambient env
 * values always win; a missing or unreadable config file is not an error
 * (absent), while a present-but-malformed one is, so a broken edit is
 * diagnosed at startup instead of being ignored.
 */
export const mergeUserConfig = (
  environment: Readonly<NodeJS.ProcessEnv>,
  configContents: string | undefined,
): Result<Readonly<NodeJS.ProcessEnv>, ConfigurationError> => {
  if (configContents === undefined) return ok(environment);
  let raw: unknown;
  try {
    raw = JSON.parse(configContents);
  } catch (cause) {
    return err(
      new ConfigurationError("Invalid REA user configuration", {
        cause,
        settings: [
          {
            setting: CONFIG_FILE_NAME,
            constraint: "must be valid JSON",
          },
        ],
      }),
    );
  }
  const parsed = parseUserConfig(raw);
  if (!parsed.ok) return parsed;
  const merged: NodeJS.ProcessEnv = { ...environment };
  for (const [key, value] of Object.entries(parsed.value)) {
    if (merged[key] === undefined) merged[key] = value;
  }
  return ok(Object.freeze(merged));
};

/** Read the user config file; absent files yield undefined. */
export const readUserConfig = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform = process.platform,
  readFileImpl: (path: string, encoding: "utf8") => Promise<string> = readFile,
): Promise<string | undefined> => {
  const path = userConfigFilePath(environment, platform);
  try {
    return await readFileImpl(path, "utf8");
  } catch (cause) {
    const code =
      typeof cause === "object" && cause !== null && "code" in cause
        ? String((cause as NodeJS.ErrnoException).code)
        : "";
    if (code === "ENOENT") return undefined;
    throw cause;
  }
};

/**
 * Persist one or more settings to the user config file, creating parent
 * directories as needed. The file is rewritten in full, sorted for stable
 * diffs, with a trailing newline. The new content is staged next to the file
 * and moved into place with rename, so an interrupted write never leaves a
 * partial JSON document behind.
 */
export const writeUserConfig = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  settings: Partial<Record<PersistedSetting, string>>,
  platform: NodeJS.Platform = process.platform,
  io: ConfigFileIo = defaultConfigFileIo(),
): Promise<Partial<Record<PersistedSetting, string>>> => {
  const existing = await readUserConfig(environment, platform, io.readFile);
  let current: Partial<Record<PersistedSetting, string>> = {};
  if (existing !== undefined) {
    const parsed = parseUserConfig(JSON.parse(existing));
    if (!parsed.ok) throw parsed.error;
    current = parsed.value;
  }
  const next = { ...current, ...settings };
  await persistUserConfig(environment, next, platform, io);
  return next;
};

/** Remove settings from the config file, returning the removed keys. */
export const unsetUserConfig = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  keys: readonly PersistedSetting[],
  platform: NodeJS.Platform = process.platform,
  io: ConfigFileIo = defaultConfigFileIo(),
): Promise<readonly PersistedSetting[]> => {
  const existing = await readUserConfig(environment, platform, io.readFile);
  if (existing === undefined) return [];
  const parsed = parseUserConfig(JSON.parse(existing));
  if (!parsed.ok) throw parsed.error;
  const before = new Set(Object.keys(parsed.value));
  const next: Partial<Record<PersistedSetting, string>> = {};
  for (const [key, value] of Object.entries(parsed.value)) {
    if (!keys.includes(key as PersistedSetting))
      (next as Record<string, string>)[key] = value;
  }
  await persistUserConfig(environment, next, platform, io);
  const removed = [...before].filter((key) =>
    keys.includes(key as PersistedSetting),
  );
  return removed as PersistedSetting[];
};

/** Injectable file operations for persisting the user config. */
interface ConfigFileIo {
  readFile: typeof readFile;
  writeFile: (path: string, data: string, encoding: "utf8") => Promise<void>;
  mkdir: (path: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
}

const defaultConfigFileIo = (): ConfigFileIo => ({
  readFile,
  writeFile: (path, data, encoding) =>
    writeFile(path, data, encoding).then(() => undefined),
  mkdir: (path) =>
    mkdir(dirname(path), { recursive: true }).then(() => undefined),
  rename: (from, to) => rename(from, to).then(() => undefined),
});

/**
 * The single read/change/write tail shared by every mutation: stage the
 * document beside the real file, then rename it into place. Rename is
 * atomic, so readers never observe a half-written file.
 */
const persistUserConfig = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  settings: Partial<Record<PersistedSetting, string>>,
  platform: NodeJS.Platform,
  io: ConfigFileIo,
): Promise<void> => {
  const path = userConfigFilePath(environment, platform);
  const staged = `${path}.tmp`;
  await io.mkdir(path);
  await io.writeFile(
    staged,
    JSON.stringify(sortedSettings(settings), null, 2) + "\n",
    "utf8",
  );
  await io.rename(staged, path);
};

const sortedSettings = (
  settings: Partial<Record<PersistedSetting, string>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(settings).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  ) as Record<string, string>;
