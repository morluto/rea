import type {
  ClientRegistrationConnectionProfile,
  NativeStdioIncompatibility,
} from "./ClientRegistrationProfile.js";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { lstatSync, statSync } from "node:fs";
import { err, ok, type Result } from "../domain/result.js";
import {
  absoluteCallerPath,
  appendCallerPath,
  isQualifiedCallerPath,
} from "../filesystem/callerPath.js";
import {
  absoluteClientRoot,
  clientPathDependence,
  absoluteXdgConfigHome,
  mcporterExpandHome,
  mcporterXdgConfigHome,
  vscodeUserDirectory,
  xdgConfigHomeOrDefault,
} from "./ClientConfigRoots.js";
import {
  kiloDefaultLocation,
  kiloGlobalLocation,
  type KiloLocationContext,
} from "./KiloClientLocation.js";
import { windowsAppDataRoots } from "./MsixPackageStorage.js";
import { errorMessage } from "../kernel/errorMessage.js";

import type {
  ClientDefinitionBase,
  ClientDefinitionLocation,
  ClientLayeredLocation,
  ClientLocation,
  ClientPathContext,
  ClientPathFailure,
  ClientPathResult,
  PiProjectSettings,
  SetupClient,
} from "./SupportedClients.js";

const OMP_PROFILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const OMP_RESERVED_PROFILE =
  /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/iu;

/**
 * The OMP agent directory whose `mcp.json` holds user-scope MCP servers. OMP
 * joins PI_CONFIG_DIR to the home directory, and a named profile ignores
 * PI_CODING_AGENT_DIR. Relative overrides use the setup process working directory.
 */
export const ompAgentDirectory = (
  context: ClientPathContext,
): ClientPathResult => {
  const root = join(context.home, context.env.PI_CONFIG_DIR || ".omp");
  // OMP_PROFILE wins even when empty. Match OMP's validation on every host.
  const profile = (context.env.OMP_PROFILE ?? context.env.PI_PROFILE)?.trim();
  if (profile !== undefined && profile !== "" && profile !== "default") {
    if (
      !OMP_PROFILE_NAME.test(profile) ||
      profile.endsWith(".") ||
      OMP_RESERVED_PROFILE.test(profile)
    )
      return err({
        path: root,
        message: `Invalid OMP profile ${JSON.stringify(profile)}: names must match ^[a-z0-9][a-z0-9._-]{0,63}$, cannot end with ".", and cannot be a Windows reserved device name (CON, PRN, AUX, NUL, COM0-9, LPT0-9, including extensions). Repair OMP_PROFILE or PI_PROFILE before configuring OMP.`,
      });
    return ok(join(root, "profiles", profile, "agent"));
  }
  const override = context.env.PI_CODING_AGENT_DIR;
  return ok(override ? resolve(override) : join(root, "agent"));
};

/**
 * Pi's public getAgentDir()/normalizePath semantics, not OMP's profiles.
 * Keep relative overrides relative: filesystem consumers resolve them in cwd.
 */
export const piAgentDirectory = ({
  home,
  platform,
  env,
}: ClientPathContext): string => {
  const paths = platform === "win32" ? win32 : { join };
  let directory = env.PI_CODING_AGENT_DIR;
  if (!directory) return paths.join(home, ".pi", "agent");
  if (
    platform === "win32" &&
    directory.startsWith("/") &&
    !directory.startsWith("//") &&
    !directory.includes("\\")
  ) {
    const drive = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/iu.exec(
      directory,
    );
    if (drive !== null)
      directory = `${drive[1]?.toUpperCase()}:\\${drive[2]?.replaceAll("/", "\\") ?? ""}`;
  }
  if (directory === "~") return home;
  if (
    directory.startsWith("~/") ||
    (platform === "win32" && directory.startsWith("~\\"))
  )
    return paths.join(home, directory.slice(2));
  if (directory.startsWith("file://"))
    return fileURLToPath(directory, { windows: platform === "win32" });
  return directory;
};

export const piProjectSettings = (
  context: ClientPathContext,
): PiProjectSettings => {
  const paths = context.platform === "win32" ? win32 : posix;
  const agentDirectory = piAgentDirectory(context);
  return {
    trustPath: paths.join(agentDirectory, "trust.json"),
    settingsPath: paths.join(agentDirectory, "settings.json"),
  };
};

/** Native cwd-relative candidates in load order. This provides no write authority. */
export const clientProjectConfigurationPaths = (
  client: Pick<SetupClient, "format">,
  projectDirectory: string,
  platform: NodeJS.Platform,
): readonly string[] => {
  if (!isQualifiedCallerPath(projectDirectory, platform)) return [];
  const paths = platform === "win32" ? win32 : posix;
  if (client.format === "pi")
    return [paths.join(projectDirectory, ".pi", "mcp.json")];
  if (client.format !== "opencode") return [];
  const directories: string[] = [];
  let current = projectDirectory;
  for (;;) {
    directories.push(current);
    const parent = paths.dirname(current);
    if (current === parent) break;
    current = parent;
  }
  directories.reverse();
  const names = ["opencode.json", "opencode.jsonc"];
  // OpenCode loads all direct files before visiting any nested .opencode directory.
  return [
    ...directories.flatMap((directory) =>
      names.map((name) => paths.join(directory, name)),
    ),
    ...directories.flatMap((directory) =>
      names.map((name) => paths.join(directory, ".opencode", name)),
    ),
  ];
};

export const copilotDirectory = ({ home, env }: ClientPathContext): string =>
  env.COPILOT_HOME || join(home, ".copilot");

export const commandCodeDirectory = ({ home }: ClientPathContext): string =>
  join(home, ".commandcode");

/**
 * OpenCode appends `OPENCODE_CONFIG_DIR` only when the value is non-empty.
 * An empty variable is the same as unset and leaves the XDG directory in place.
 */
const openCodeOverrideDirectory = (
  env: ClientPathContext["env"],
): string | undefined => {
  const directory = env.OPENCODE_CONFIG_DIR;
  return directory === undefined || directory === "" ? undefined : directory;
};

export const opencodeDirectory = (context: ClientPathContext): string =>
  openCodeOverrideDirectory(context.env) ??
  join(xdgConfigHomeOrDefault(context), "opencode");

const openCodeExplicitConfigPath = ({
  env,
}: ClientPathContext): string | undefined =>
  env.OPENCODE_CONFIG ? resolve(env.OPENCODE_CONFIG) : undefined;

const openCodeDirectoryConfigPaths = (directory: string): readonly string[] => [
  resolve(directory, "opencode.json"),
  resolve(directory, "opencode.jsonc"),
];

export const openCodeUserOverridePaths = (
  context: ClientPathContext,
): readonly string[] => {
  const file = openCodeExplicitConfigPath(context);
  const directory = openCodeOverrideDirectory(context.env);
  return [
    ...(file === undefined ? [] : [file]),
    ...(directory === undefined ? [] : openCodeDirectoryConfigPaths(directory)),
  ];
};

/** OpenCode loads global JSON before JSONC, then explicit file and directory overrides. */
export const openCodeConfigurationPaths = (
  context: ClientPathContext,
): readonly string[] => {
  const directory = join(xdgConfigHomeOrDefault(context), "opencode");
  const paths = [
    resolve(directory, "config.json"),
    ...openCodeDirectoryConfigPaths(directory),
    ...openCodeUserOverridePaths(context),
  ];
  return paths;
};

export const existingOpenCodeConfigPath = (
  context: ClientPathContext,
): string => {
  // The selected directory is loaded after an explicit file by OpenCode V1.
  const overrideDirectory = openCodeOverrideDirectory(context.env);
  const explicitPath = openCodeExplicitConfigPath(context);
  const candidates =
    overrideDirectory !== undefined
      ? openCodeDirectoryConfigPaths(overrideDirectory)
      : explicitPath !== undefined
        ? [explicitPath]
        : openCodeDirectoryConfigPaths(opencodeDirectory(context));
  return (
    [...candidates].reverse().find((path) => {
      try {
        lstatSync(path);
        return true;
      } catch (cause: unknown) {
        return !(
          cause instanceof Error &&
          "code" in cause &&
          cause.code === "ENOENT"
        );
      }
    }) ??
    resolve(
      overrideDirectory !== undefined
        ? join(overrideDirectory, "opencode.json")
        : (explicitPath ?? join(opencodeDirectory(context), "opencode.json")),
    )
  );
};

export const geminiSettings = ({
  home,
  platform,
  env,
}: ClientPathContext): NonNullable<SetupClient["geminiSettings"]> => {
  const system =
    env.GEMINI_CLI_SYSTEM_SETTINGS_PATH ||
    (platform === "darwin"
      ? "/Library/Application Support/GeminiCli/settings.json"
      : platform === "win32"
        ? "C:\\ProgramData\\gemini-cli\\settings.json"
        : "/etc/gemini-cli/settings.json");
  const trustOverride =
    env.GEMINI_RESTRICTED_MODE === "true" ||
    env.GEMINI_CLI_TRUST_WORKSPACE === "false"
      ? false
      : env.GEMINI_CLI_TRUST_WORKSPACE === "true"
        ? true
        : undefined;
  return {
    systemPath: system,
    defaultsPath:
      env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH ||
      join(dirname(system), "system-defaults.json"),
    workspaceDirectory: process.cwd(),
    trustedFoldersPath:
      env.GEMINI_CLI_TRUSTED_FOLDERS_PATH ||
      join(env.GEMINI_CLI_HOME || home, ".gemini", "trustedFolders.json"),
    ...(trustOverride === undefined ? {} : { trustOverride }),
    platform,
  };
};

export const devinDirectory = ({
  home,
  platform,
  env,
}: ClientPathContext): string =>
  platform === "win32"
    ? join(windowsAppDataRoots(home, env).roaming, "devin")
    : join(xdgConfigHomeOrDefault({ home, env }), "devin");

/** The Cline extension's settings in one editor's global storage. */
export const clineSettingsDirectory =
  (dataFolder: string) =>
  (context: ClientPathContext): string =>
    join(
      vscodeUserDirectory(context, dataFolder),
      "globalStorage",
      "saoudrizwan.claude-dev",
      "settings",
    );
export const clineVscodeSettingsDirectory = clineSettingsDirectory("Code");

/** Flathub's Zed (`dev.zed.Zed`) gets this XDG_CONFIG_HOME inside its sandbox. */
const ZED_FLATPAK_CONFIG = [".var", "app", "dev.zed.Zed", "config"] as const;

const directoryPresent = (path: string): Result<boolean, ClientPathFailure> => {
  try {
    lstatSync(path);
    return ok(true);
  } catch (cause: unknown) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return ok(false);
    return err({
      path,
      message: `Cannot determine whether ${path} exists: ${errorMessage(cause)}. Repair its access before configuring Zed.`,
    });
  }
};

/** Whether two existing paths resolve to the same folder, by device and inode. */
const sameDirectory = (
  first: string,
  second: string,
): Result<boolean, ClientPathFailure> => {
  const identities: { dev: bigint; ino: bigint }[] = [];
  for (const path of [first, second]) {
    try {
      const { dev, ino } = statSync(path, { bigint: true });
      identities.push({ dev, ino });
    } catch (cause: unknown) {
      return err({
        path,
        message: `Cannot resolve ${path}: ${errorMessage(cause)}. Repair it before configuring Zed.`,
      });
    }
  }
  const [a, b] = identities;
  return ok(
    a !== undefined && b !== undefined && a.dev === b.dev && a.ino === b.ino,
  );
};

/**
 * Zed's `paths::config_dir`. On Windows it reads the RoamingAppData known
 * folder, which APPDATA normally names. On Linux and FreeBSD,
 * `FLATPAK_XDG_CONFIG_HOME` wins, then `dirs::config_dir`, which admits only an
 * absolute XDG_CONFIG_HOME. A Flathub Zed reads its sandbox's config folder,
 * so REA uses it when only that folder exists and refuses to guess when a
 * native configuration exists too.
 */
export const zedLocation = ({
  home,
  platform,
  env,
}: ClientPathContext): Result<ClientLocation, ClientPathFailure> => {
  const at = (directory: string): ClientLocation => ({
    configPath: join(directory, "settings.json"),
    markerPath: directory,
  });
  if (platform === "darwin") return ok(at(join(home, ".config", "zed")));
  if (platform === "win32")
    return ok(at(join(windowsAppDataRoots(home, env).roaming, "Zed")));
  const flatpakOverride = env.FLATPAK_XDG_CONFIG_HOME;
  if (flatpakOverride) {
    const selected = absoluteClientRoot(
      flatpakOverride,
      "FLATPAK_XDG_CONFIG_HOME",
      "Zed",
      platform,
    );
    return selected.ok ? ok(at(join(selected.value, "zed"))) : selected;
  }
  const native = join(absoluteXdgConfigHome({ home, env }), "zed");
  const sandboxed = join(home, ...ZED_FLATPAK_CONFIG, "zed");
  const flatpak = directoryPresent(sandboxed);
  if (!flatpak.ok) return flatpak;
  if (!flatpak.value) return ok(at(native));
  const nativePresent = directoryPresent(native);
  if (!nativePresent.ok) return nativePresent;
  if (!nativePresent.value) return ok(at(sandboxed));
  // XDG_CONFIG_HOME or a link may make both names one folder.
  const same = sameDirectory(native, sandboxed);
  if (!same.ok) return same;
  return same.value
    ? ok(at(native))
    : err({
        path: sandboxed,
        message: `Both ${native} and the Flatpak Zed folder ${sandboxed} exist, so REA cannot tell which Zed you use. Remove the configuration of the Zed you no longer use, then configure Zed again.`,
      });
};

const regularPathPresent = (
  path: string,
): Result<boolean, ClientPathFailure> => {
  try {
    lstatSync(path);
    return ok(true);
  } catch (cause: unknown) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return ok(false);
    return err({
      path,
      message: `Cannot determine whether ${path} exists: ${errorMessage(cause)}. Repair its access before configuring MCPorter.`,
    });
  }
};

/**
 * MCPorter's home layer (`listConfigLayerPaths`): a non-empty
 * `MCPORTER_CONFIG` is the only file it loads; otherwise the first existing of
 * the XDG and legacy `~/.mcporter` candidates (`mcporterConfigCandidates`),
 * where only an absolute `XDG_CONFIG_HOME` counts. A new file goes where
 * `mcporter config add --scope home` puts it. A relative `MCPORTER_CONFIG`
 * follows each invocation's directory, which REA cannot know.
 */
export const mcporterLocation = ({
  home,
  platform,
  env,
}: ClientPathContext): Result<ClientLocation, ClientPathFailure> => {
  const pathApi = platform === "win32" ? win32 : posix;
  const legacy = join(home, ".mcporter");
  const selected = env.MCPORTER_CONFIG?.trim();
  if (selected) {
    const path = mcporterExpandHome(selected, home);
    // MCPorter applies path.resolve: `..` collapses lexically, not through
    // links. The selected file is also the evidence that MCPorter is in use.
    const absolute = absoluteClientRoot(
      path,
      "MCPORTER_CONFIG",
      "MCPorter",
      platform,
    );
    return absolute.ok
      ? ok({
          configPath: pathApi.resolve(absolute.value),
          markerPath: pathApi.resolve(absolute.value),
        })
      : absolute;
  }
  const configHome = mcporterXdgConfigHome({ home, platform, env });
  const base = configHome === undefined ? legacy : join(configHome, "mcporter");
  const candidates = [base, ...(base === legacy ? [] : [legacy])].flatMap(
    (directory) => [
      join(directory, "mcporter.json"),
      join(directory, "mcporter.jsonc"),
    ],
  );
  for (const candidate of candidates) {
    const present = regularPathPresent(candidate);
    if (!present.ok) return present;
    // The loaded file's folder is the evidence, even when it is the legacy one.
    if (present.value)
      return ok({ configPath: candidate, markerPath: dirname(candidate) });
  }
  return ok({ configPath: join(base, "mcporter.json"), markerPath: base });
};

/** mcporter getUrl's native nullish priority; an empty first value suppresses later aliases. */
export const MCPORTER_URL_FIELDS = [
  "baseUrl",
  "base_url",
  "url",
  "serverUrl",
  "server_url",
] as const;
export const MCPORTER_STDIO_INCOMPATIBILITIES: readonly NativeStdioIncompatibility[] =
  [
    // RawEntrySchema admits only optional strings, including an empty string.
    ...MCPORTER_URL_FIELDS.map((field): NativeStdioIncompatibility => ({
      kind: "invalid-string",
      field,
    })),
    ...MCPORTER_URL_FIELDS.map((field, index): NativeStdioIncompatibility =>
      index === 0
        ? { kind: "truthy", field }
        : {
            kind: "all",
            conditions: [
              ...MCPORTER_URL_FIELDS.slice(0, index).map(
                (prior): NativeStdioIncompatibility => ({
                  kind: "nullish",
                  field: prior,
                }),
              ),
              { kind: "truthy", field },
            ],
          },
    ),
  ];

/**
 * Amp's user settings: `settings.json` or `settings.jsonc` in
 * `~/.config/amp` on every platform. Amp does not document which one wins
 * when both exist, so that case stays unresolved.
 */
export const ampLocation = ({
  home,
}: ClientPathContext): Result<ClientLocation, ClientPathFailure> => {
  const directory = join(home, ".config", "amp");
  const candidates = ["settings.json", "settings.jsonc"].map((name) =>
    join(directory, name),
  );
  const present: string[] = [];
  for (const candidate of candidates) {
    try {
      lstatSync(candidate);
      present.push(candidate);
    } catch (cause: unknown) {
      if (
        !(cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      )
        return err({
          path: candidate,
          message: `Cannot determine whether ${candidate} exists: ${errorMessage(cause)}. Repair its access before configuring Amp.`,
        });
    }
  }
  if (present.length > 1)
    return err({
      path: directory,
      message: `Both ${candidates[0]} and ${candidates[1]} exist, and Amp does not document which one it reads. Merge them into one file before configuring Amp.`,
    });
  return ok({
    configPath: present[0] ?? join(directory, "settings.json"),
    markerPath: directory,
  });
};

/**
 * fx's profile folder (`useFxHome`): a non-empty `FX_HOME` must be absolute
 * and name neither the root nor the home folder, ignoring trailing slashes;
 * otherwise `~/.fx`. fx refuses an invalid value, so REA does too.
 */
export const fxLocation = ({
  home,
  platform,
  env,
}: ClientPathContext): Result<ClientLocation, ClientPathFailure> => {
  const value = env.FX_HOME;
  const pathApi = platform === "win32" ? win32 : posix;
  if (!value) {
    const directory = join(home, ".fx");
    return ok({
      configPath: join(directory, "mcp.json"),
      markerPath: directory,
    });
  }
  const trimmed = value.replace(/\/+$/u, "");
  // fx opens FX_HOME as written, so `.` and `..` resolve through links on the
  // filesystem. Refusing them keeps REA's file and its root/home check on the
  // folder fx opens, so the private profile mode can never land on home.
  const dotSegment = trimmed
    .split(/[\\/]/u)
    .some((segment) => segment === "." || segment === "..");
  if (
    !pathApi.isAbsolute(value) ||
    trimmed.length === 0 ||
    dotSegment ||
    pathApi.parse(trimmed).root === trimmed ||
    trimmed === home.replace(/[\\/]+$/u, "")
  )
    return err({
      path: value,
      message:
        "FX_HOME must be an absolute path without . or .. segments, other than the root and home folders. Repair FX_HOME before configuring fx; no settings were written.",
    });
  return ok({
    configPath: pathApi.join(trimmed, "mcp.json"),
    markerPath: trimmed,
  });
};

/**
 * Junie's home: `JUNIE_HOME` for Junie CLI, else `~/.junie`. add-mcp notes the
 * JetBrains plugin always reads `~/.junie`. Junie resolves a relative
 * `JUNIE_HOME` against its own working directory, so REA refuses one.
 */
export const junieLocation = ({
  home,
  platform,
  env,
}: ClientPathContext): Result<ClientLocation, ClientPathFailure> => {
  const selected = env.JUNIE_HOME
    ? absoluteClientRoot(env.JUNIE_HOME, "JUNIE_HOME", "Junie", platform)
    : ok(join(home, ".junie"));
  return selected.ok
    ? ok({
        configPath: join(selected.value, "mcp", "mcp.json"),
        markerPath: selected.value,
      })
    : selected;
};

/**
 * Goose's user configuration (`Paths::config_dir`): an absolute
 * `GOOSE_PATH_ROOT` selects `<root>/config`; otherwise etcetera's app strategy,
 * where only an absolute `XDG_CONFIG_HOME` counts.
 */
const gooseUserConfigPath = ({ home, platform, env }: ClientPathContext) => {
  const root = env.GOOSE_PATH_ROOT;
  if (root !== undefined && isQualifiedCallerPath(root, platform))
    return appendCallerPath(root, "config/config.yaml", platform);
  return platform === "win32"
    ? win32.join(
        windowsAppDataRoots(home, env).roaming,
        "Block",
        "goose",
        "config",
        "config.yaml",
      )
    : appendCallerPath(
        absoluteXdgConfigHome({ home, env }),
        "goose/config.yaml",
        platform,
      );
};

/**
 * `GOOSE_ADDITIONAL_CONFIG_FILES`, split as Rust's `env::split_paths`: `:` on
 * Unix; on Windows `;` outside double quotes, which are removed.
 */
const gooseAdditionalConfigFiles = ({
  platform,
  env,
}: Pick<ClientPathContext, "platform" | "env">): string[] => {
  const value = env.GOOSE_ADDITIONAL_CONFIG_FILES ?? "";
  if (platform !== "win32")
    return value.split(":").filter((path) => path.length > 0);
  const paths: string[] = [];
  let current = "";
  let quoted = false;
  for (const character of value) {
    if (character === '"') quoted = !quoted;
    else if (character === ";" && !quoted) {
      paths.push(current);
      current = "";
    } else current += character;
  }
  paths.push(current);
  return paths.filter((path) => path.length > 0);
};

/**
 * Goose's layers in increasing precedence (`Config::default`): the system
 * file, each `GOOSE_ADDITIONAL_CONFIG_FILES` entry, then the user file it
 * writes. A relative additional entry follows Goose's working directory, and a
 * Windows drive-less one its current drive, which REA cannot know.
 */
export const gooseLocation = (
  context: ClientPathContext,
): Result<ClientLocation, ClientPathFailure> => {
  const configPath = gooseUserConfigPath(context);
  for (const path of gooseAdditionalConfigFiles(context)) {
    const dependence = clientPathDependence(path, context.platform);
    if (dependence === "relative")
      return err({
        path,
        message: `GOOSE_ADDITIONAL_CONFIG_FILES names the relative path ${path}, which Goose resolves against its own working directory. Use absolute paths before configuring Goose.`,
      });
    if (dependence === "driveless")
      return err({
        path,
        message: `GOOSE_ADDITIONAL_CONFIG_FILES names ${path}, which has no drive, so the file Goose reads depends on its current drive. Use a path with a drive letter or a UNC path before configuring Goose.`,
      });
  }
  return ok({ configPath, markerPath: configPath });
};

/**
 * Goose's load order: the system file, each additional file, then the user
 * file it writes. An additional entry can name the user file too; Goose then
 * loads it twice, and its last load decides precedence.
 */
export const gooseConfigPaths = (context: ClientPathContext) => [
  context.systemPaths?.gooseSystemConfig ??
    (context.platform === "win32"
      ? win32.join(
          context.env.PROGRAMDATA || "C:\\ProgramData",
          "goose",
          "config.yaml",
        )
      : "/etc/goose/config.yaml"),
  ...gooseAdditionalConfigFiles(context),
  gooseUserConfigPath(context),
];

/**
 * FreeBuff's own profile directory (its `state.json` root, fixed under
 * `.config` on every platform). The shared `~/.agents` folder is not
 * FreeBuff-specific: REA's own skill installs create it, so it cannot
 * prove FreeBuff is installed.
 */
export const freebuffProfileDirectory = ({ home }: ClientPathContext): string =>
  join(home, ".config", "freebuff-desktop");

export type ClientDefinitionInput = Omit<
  ClientDefinitionBase,
  "registrationProfile"
> &
  ClientDefinitionLocation & {
    readonly registrationConnection: ClientRegistrationConnectionProfile;
  };

/** Bind native identity once while retaining the original definition's literal name. */
/**
 * Kilo resolves its configured paths against its own working directory, which
 * setup cannot know, so the table accepts only absolute ones.
 */
const kiloTableContext = (context: ClientPathContext): KiloLocationContext => ({
  root: context,
  path: (path) => {
    // Normalized as rea mcp add normalizes it, so joined layer paths compare.
    const dependence = clientPathDependence(path, context.platform);
    if (dependence === undefined)
      return absoluteCallerPath(path, { platform: context.platform });
    throw new KiloPathDependenceError(path, dependence);
  },
});

class KiloPathDependenceError extends Error {
  constructor(
    readonly path: string,
    dependence: "relative" | "driveless",
  ) {
    super(
      dependence === "relative"
        ? `Kilo's configuration path ${path} is relative, so the file Kilo reads depends on its working directory. Set an absolute path before configuring Kilo.`
        : `Kilo's configuration path ${path} has no drive, so the file Kilo reads depends on its current drive. Set a path with a drive letter or a UNC path before configuring Kilo.`,
    );
  }
}

const kiloPathFailure = (cause: unknown): ClientPathFailure => {
  if (cause instanceof KiloPathDependenceError)
    return { path: cause.path, message: cause.message };
  throw cause;
};

export const kiloLocation = (
  context: ClientPathContext,
): Result<ClientLocation, ClientPathFailure> => {
  try {
    const { configPath, markerPath } = kiloDefaultLocation(
      kiloTableContext(context),
    );
    return ok({ configPath, markerPath });
  } catch (cause: unknown) {
    return err(kiloPathFailure(cause));
  }
};

export const kiloLayeredLocation = async (
  context: ClientPathContext,
): Promise<Result<ClientLayeredLocation, ClientPathFailure>> => {
  const kilo = kiloTableContext(context);
  try {
    const location = await kiloGlobalLocation(kilo);
    if (!location.ok)
      return err({
        path: kiloDefaultLocation(kilo).markerPath,
        message: location.error.message,
        failure: location.error,
      });
    const { configPath, configPaths, inlineConfiguration } = location.value;
    return ok({
      configPath,
      configPaths,
      ...(inlineConfiguration === undefined ? {} : { inlineConfiguration }),
    });
  } catch (cause: unknown) {
    return err(kiloPathFailure(cause));
  }
};

/** Candidate layers when relative paths leave the location unresolved. */
export const kiloCandidatePaths = (
  context: ClientPathContext,
): readonly string[] => {
  try {
    return kiloDefaultLocation(kiloTableContext(context)).configPaths;
  } catch (cause: unknown) {
    kiloPathFailure(cause);
    return [];
  }
};

export const kiloDiscoveryPaths = (
  context: ClientPathContext,
): readonly string[] => {
  try {
    return kiloDefaultLocation(kiloTableContext(context)).discoveryPaths;
  } catch (cause: unknown) {
    kiloPathFailure(cause);
    return [];
  }
};
