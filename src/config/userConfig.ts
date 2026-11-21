import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import { homeDirectoryFromEnvironment } from "./homeDirectory.js";
import { parseEnvironmentValues } from "./environment.js";
import { HOST_PLATFORM } from "../platform/HostPlatform.js";

/**
 * User-owned provider configuration persisted at
 * `${XDG_CONFIG_HOME:-~/.config}/rea/rea.json`.
 *
 * Precedence is env > config file > auto-detect. Values are merged into the
 * environment snapshot for provider inspection and execution. Retain the
 * names filled in from the file so client registrations can inherit them.
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

const defaultConfigHome = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): string =>
  join(homeDirectoryFromEnvironment(environment, platform), ".config");

const selectedConfigHome = (environment: Readonly<NodeJS.ProcessEnv>) => {
  const xdg = environment.XDG_CONFIG_HOME;
  return xdg !== undefined && isAbsolute(xdg) ? xdg : undefined;
};

const configFileAt = (home: string): string =>
  join(home, CONFIG_DIRECTORY_NAME, CONFIG_FILE_NAME);

export const userConfigFilePath = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): string =>
  configFileAt(
    selectedConfigHome(environment) ?? defaultConfigHome(environment, platform),
  );

/** A session-independent locator for clients that rely on saved defaults. */
export const userConfigRegistrationEnvironment = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): Readonly<Record<string, string>> => {
  const selected = selectedConfigHome(environment);
  return selected === undefined ||
    configFileAt(selected) ===
      configFileAt(defaultConfigHome(environment, platform))
    ? {}
    : { XDG_CONFIG_HOME: selected };
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

interface UserConfiguration {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly savedDefaults: ReadonlySet<string>;
}

/** Fill unset variables from the saved file and retain the origin of each default. */
export const mergeUserConfig = (
  environment: Readonly<NodeJS.ProcessEnv>,
  configContents: string | undefined,
): Result<UserConfiguration, ConfigurationError> => {
  const savedDefaults = new Set<string>();
  if (configContents === undefined) return ok({ environment, savedDefaults });
  const parsed = parseUserConfigText(configContents);
  if (!parsed.ok) return parsed;
  const merged: NodeJS.ProcessEnv = { ...environment };
  for (const [key, value] of Object.entries(parsed.value)) {
    if (merged[key] !== undefined) continue;
    merged[key] = value;
    savedDefaults.add(key);
  }
  return ok({ environment: Object.freeze(merged), savedDefaults });
};

const parseUserConfigText = (contents: string) => {
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
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
  return parseUserConfig(raw);
};

/** Read the user config file; absent files yield undefined. */
export const readUserConfig = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform = HOST_PLATFORM.platform,
): Promise<Result<string | undefined, ConfigurationError>> => {
  const path = userConfigFilePath(environment, platform);
  try {
    return ok(await readFile(path, "utf8"));
  } catch (cause) {
    const code =
      typeof cause === "object" && cause !== null && "code" in cause
        ? String((cause as NodeJS.ErrnoException).code)
        : "";
    if (code === "ENOENT") return ok(undefined);
    return err(configFileError(path, "could not be read", cause));
  }
};

/** Resolve saved settings for a production invocation and retain the file failure. */
export const loadUserConfiguration = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform = HOST_PLATFORM.platform,
): Promise<Result<UserConfiguration, ConfigurationError>> => {
  const contents = await readUserConfig(environment, platform);
  if (!contents.ok) return contents;
  const result = mergeUserConfig(environment, contents.value);
  if (result.ok) return result;
  const detail = result.error.settings
    .map(({ setting, constraint }) => `${setting}: ${constraint}`)
    .join(", ");
  return err(
    configFileError(
      userConfigFilePath(environment, platform),
      detail,
      result.error,
    ),
  );
};

type UserSettings = Partial<Record<PersistedSetting, string>>;

const errorCode = (cause: unknown): unknown =>
  cause instanceof Error && "code" in cause ? cause.code : undefined;

const configFileError = (path: string, detail: string, cause?: unknown) =>
  new ConfigurationError(
    `Cannot use the REA user configuration at ${path}. ${detail}`,
    {
      cause,
      settings: [{ setting: path, constraint: detail }],
      remediationAction:
        "Check the named file and its parent directory before retrying.",
    },
  );

/** Apply a complete edit under one cross-process lock. */
export const updateUserConfig = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  settings: UserSettings,
  remove: readonly PersistedSetting[],
  platform: NodeJS.Platform = HOST_PLATFORM.platform,
): Promise<{
  readonly settings: UserSettings;
  readonly removed: readonly PersistedSetting[];
}> => {
  const path = userConfigFilePath(environment, platform);
  const checked = parseUserConfig(settings);
  if (!checked.ok) throw checked.error;
  if (remove.some((name) => Object.hasOwn(settings, name)))
    throw configFileError(
      path,
      "a setting cannot be set and unset in the same edit",
    );

  const parent = dirname(path);
  if (Object.keys(settings).length > 0)
    await mkdir(parent, { recursive: true }).catch((cause: unknown) => {
      throw configFileError(
        path,
        "could not create the configuration directory",
        cause,
      );
    });
  const lock = `${path}.lock`;
  try {
    await mkdir(lock);
  } catch (cause) {
    if (errorCode(cause) === "ENOENT" && Object.keys(settings).length === 0)
      return { settings: {}, removed: [] };
    if (errorCode(cause) === "EEXIST")
      throw configFileError(
        path,
        `another edit holds ${lock}. Retry after it finishes. If a previous process was interrupted, remove the empty lock directory after confirming no edit is active`,
        cause,
      );
    throw configFileError(
      path,
      "could not acquire the configuration lock",
      cause,
    );
  }
  let failure: ConfigurationError | undefined;
  try {
    const existing = await lstat(path).catch((cause: unknown) => {
      if (errorCode(cause) === "ENOENT") return undefined;
      throw cause;
    });
    if (existing !== undefined && !existing.isFile()) {
      failure = configFileError(path, "must name a regular file for an edit");
      throw failure;
    }
    const contents =
      existing === undefined
        ? ok(undefined)
        : await readUserConfig(environment, platform);
    if (!contents.ok) {
      failure = contents.error;
      throw failure;
    }
    const parsed =
      contents.value === undefined
        ? ok({} as UserSettings)
        : parseUserConfigText(contents.value);
    if (!parsed.ok) {
      failure = parsed.error;
      throw failure;
    }
    const next = { ...parsed.value, ...checked.value };
    const removed = [...new Set(remove)].filter((key) =>
      Object.hasOwn(next, key),
    );
    for (const key of removed) delete next[key];
    const canonical = (value: UserSettings) =>
      JSON.stringify(
        Object.fromEntries(
          Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
        ),
        null,
        2,
      );
    const before = canonical(parsed.value);
    const after = canonical(next);
    if (before !== after)
      await publishConfig(path, after + "\n", existing?.mode);
    return { settings: next, removed };
  } catch (cause) {
    failure ??= configFileError(
      path,
      "could not write the configuration",
      cause,
    );
    throw failure;
  } finally {
    try {
      await rmdir(lock);
    } catch (cause) {
      throw configFileError(
        lock,
        "could not release the configuration lock",
        failure === undefined ? cause : new AggregateError([failure, cause]),
      );
    }
  }
};

const publishConfig = async (
  path: string,
  contents: string,
  mode: number | undefined,
): Promise<void> => {
  const staging = await mkdtemp(join(dirname(path), ".rea-config-"));
  const staged = join(staging, "content");
  let failure: unknown;
  try {
    await writeFile(staged, contents, { flag: "wx", mode: 0o600 });
    if (mode !== undefined) {
      await chmod(staged, mode & 0o777);
      try {
        await link(path, `${path}.rea.backup`);
      } catch (cause) {
        if (errorCode(cause) !== "EEXIST") throw cause;
      }
    }
    await rename(staged, path);
  } catch (cause) {
    failure = cause;
    throw cause;
  } finally {
    try {
      await unlink(staged).catch((cause: unknown) => {
        if (errorCode(cause) !== "ENOENT") throw cause;
      });
      await rmdir(staging);
    } catch (cause) {
      throw configFileError(
        staging,
        "could not clear the staged configuration",
        failure === undefined ? cause : new AggregateError([failure, cause]),
      );
    }
  }
};

export const writeUserConfig = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  settings: UserSettings,
  platform: NodeJS.Platform = HOST_PLATFORM.platform,
): Promise<UserSettings> =>
  (await updateUserConfig(environment, settings, [], platform)).settings;

export const unsetUserConfig = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  keys: readonly PersistedSetting[],
  platform: NodeJS.Platform = HOST_PLATFORM.platform,
): Promise<readonly PersistedSetting[]> =>
  (await updateUserConfig(environment, {}, keys, platform)).removed;
