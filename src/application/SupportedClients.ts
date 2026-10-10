import { dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { lstatSync } from "node:fs";
import {
  HermesClientPathError,
  resolveHermesClientHome,
} from "./HermesClientHome.js";

/** One supported client configuration location. */
export interface SetupClient {
  readonly name: string;
  readonly displayName?: string;
  readonly configPath: string;
  /** User configuration files in increasing precedence, including the write target. */
  readonly configPaths?: readonly string[];
  /** Read-only Gemini scopes and trust inputs; never setup write targets. */
  readonly geminiSettings?: {
    readonly systemPath: string;
    readonly defaultsPath: string;
    readonly workspaceDirectory: string;
    readonly trustedFoldersPath: string;
    readonly trustOverride?: boolean;
    readonly platform: NodeJS.Platform;
  };
  /** Unresolved path evidence only; consumers must not perform I/O on it. */
  readonly configPathError?: string;
  readonly markerPath?: string;
  readonly format?:
    | "json"
    | "toml"
    | "vscode"
    | "copilot_cli"
    | "opencode"
    | "commandcode"
    | "grok"
    | "omp"
    | "pi"
    | "hermes"
    | "unsupported";
}

type ClientPath = readonly string[] | ((paths: ClientPathContext) => string);

interface ClientPathContext {
  readonly home: string;
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<NodeJS.ProcessEnv>;
}

interface ClientDefinition {
  readonly name: string;
  readonly displayName: string;
  readonly configPath: ClientPath;
  readonly markerPath: ClientPath;
  readonly format: NonNullable<SetupClient["format"]>;
  readonly skillPath?: ClientPath;
  readonly configPaths?: (context: ClientPathContext) => readonly string[];
  readonly geminiSettings?: (
    context: ClientPathContext,
  ) => NonNullable<SetupClient["geminiSettings"]>;
}

const vscodeUserDirectory = ({
  home,
  platform,
  env,
}: ClientPathContext): string => {
  if (platform === "win32")
    return join(
      env.APPDATA ?? join(home, "AppData", "Roaming"),
      "Code",
      "User",
    );
  if (platform === "darwin")
    return join(home, "Library", "Application Support", "Code", "User");
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "Code", "User");
};

const claudeDesktopDirectory = ({
  home,
  platform,
  env,
}: ClientPathContext): string => {
  if (platform === "win32")
    return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude");
  if (platform === "linux")
    return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "Claude");
  return join(home, "Library", "Application Support", "Claude");
};

const claudeCodeConfigDirectory = ({ home, env }: ClientPathContext): string =>
  env.CLAUDE_CONFIG_DIR ?? home;

const claudeCodeMarkerDirectory = ({ home, env }: ClientPathContext): string =>
  env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");

const codexDirectory = ({ home, env }: ClientPathContext): string =>
  env.CODEX_HOME || join(home, ".codex");

/** Match Qwen Code's home override, including tilde and cwd-relative paths. */
const qwenCodeDirectory = ({ home, env }: ClientPathContext): string => {
  const override = env.QWEN_HOME;
  if (!override) return join(home, ".qwen");
  const expanded =
    override === "~"
      ? home
      : override.startsWith("~/") || override.startsWith("~\\")
        ? join(
            home,
            ...override
              .slice(2)
              .split(/[/\\]+/)
              .filter(Boolean),
          )
        : override;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
};

const grokDirectory = ({ home, env }: ClientPathContext): string =>
  env.GROK_HOME || join(home, ".grok");

const hermesDirectory = ({ home, platform, env }: ClientPathContext): string =>
  resolveHermesClientHome(home, platform, env);

/** Grok Bot uses an absolute SAND_DATA_ROOT; anything else stays ~/.grokbot. */
const grokBotDirectory = ({ home, env }: ClientPathContext): string => {
  const root = env.SAND_DATA_ROOT;
  return root !== undefined && root !== "" && isAbsolute(root)
    ? root
    : join(home, ".grokbot");
};

/**
 * Grok Bot stores connectors in the signed-in account and runs them on its
 * hosted computer. The data directory is only a detection marker.
 */
export const GROK_BOT_MANUAL_REGISTRATION_REMEDIATION =
  "Grok Bot keeps connectors in the signed-in account and runs them on its hosted computer. Setup does not write that account store, and a data-directory mcp.json is not a registration. In the Grok Bot chat, add a custom MCP server named rea that runs on the Bot's computer with `npx -y rea-agents@<version> mcp`. Do not put credentials in the command or arguments. A stdio server on this machine is not attached.";

/** Remediation for a client whose connector is not a local configuration file. */
export const manualRegistrationRemediation = (
  clientName: string,
): string | undefined =>
  clientName === "grok_bot"
    ? GROK_BOT_MANUAL_REGISTRATION_REMEDIATION
    : undefined;

const OMP_PROFILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

/**
 * OMP's active named profile. OMP_PROFILE wins over the legacy PI_PROFILE even
 * when empty; empty and "default" select the default profile. OMP refuses to
 * start with an invalid name, so one leaves the default location in place.
 */
const ompProfile = ({ env }: ClientPathContext): string | undefined => {
  const name = (env.OMP_PROFILE ?? env.PI_PROFILE)?.trim();
  return name === undefined ||
    name === "" ||
    name === "default" ||
    name.endsWith(".") ||
    !OMP_PROFILE_NAME.test(name)
    ? undefined
    : name;
};

/**
 * The OMP agent directory whose `mcp.json` holds user-scope MCP servers. OMP
 * joins PI_CONFIG_DIR to the home directory, and a named profile ignores
 * PI_CODING_AGENT_DIR. Relative overrides use the setup process working directory.
 */
const ompAgentDirectory = (context: ClientPathContext): string => {
  const root = join(context.home, context.env.PI_CONFIG_DIR || ".omp");
  const profile = ompProfile(context);
  if (profile !== undefined) return join(root, "profiles", profile, "agent");
  const override = context.env.PI_CODING_AGENT_DIR;
  return override ? resolve(override) : join(root, "agent");
};

/**
 * Pi's public getAgentDir()/normalizePath semantics, not OMP's profiles.
 * Keep relative overrides relative: filesystem consumers resolve them in cwd.
 */
const piAgentDirectory = ({
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

const copilotDirectory = ({ home, env }: ClientPathContext): string =>
  env.COPILOT_HOME ?? join(home, ".copilot");

const commandCodeDirectory = ({ home }: ClientPathContext): string =>
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

const opencodeDirectory = (context: ClientPathContext): string =>
  openCodeOverrideDirectory(context.env) ??
  join(
    context.env.XDG_CONFIG_HOME ?? join(context.home, ".config"),
    "opencode",
  );

/** OpenCode loads global JSON before JSONC, then explicit file and directory overrides. */
const openCodeConfigurationPaths = (
  context: ClientPathContext,
): readonly string[] => {
  const directory = join(
    context.env.XDG_CONFIG_HOME ?? join(context.home, ".config"),
    "opencode",
  );
  const overrideDirectory = openCodeOverrideDirectory(context.env);
  const paths = [
    join(directory, "config.json"),
    join(directory, "opencode.json"),
    join(directory, "opencode.jsonc"),
    ...(context.env.OPENCODE_CONFIG ? [context.env.OPENCODE_CONFIG] : []),
    ...(overrideDirectory !== undefined
      ? [
          join(overrideDirectory, "opencode.json"),
          join(overrideDirectory, "opencode.jsonc"),
        ]
      : []),
  ];
  const resolved = paths.map((path) => resolve(path));
  return resolved.filter((path, index) => resolved.lastIndexOf(path) === index);
};

const existingOpenCodeConfigPath = (context: ClientPathContext): string => {
  // The selected directory is loaded after an explicit file by OpenCode V1.
  const overrideDirectory = openCodeOverrideDirectory(context.env);
  const candidates =
    overrideDirectory !== undefined
      ? [
          join(overrideDirectory, "opencode.json"),
          join(overrideDirectory, "opencode.jsonc"),
        ].map((path) => resolve(path))
      : context.env.OPENCODE_CONFIG
        ? [resolve(context.env.OPENCODE_CONFIG)]
        : [
            join(opencodeDirectory(context), "opencode.json"),
            join(opencodeDirectory(context), "opencode.jsonc"),
          ].map((path) => resolve(path));
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
        : context.env.OPENCODE_CONFIG ||
            join(opencodeDirectory(context), "opencode.json"),
    )
  );
};

const geminiSettings = ({
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

const devinDirectory = ({ home, platform, env }: ClientPathContext): string =>
  platform === "win32"
    ? join(env.APPDATA ?? join(home, "AppData", "Roaming"), "devin")
    : join(env.XDG_CONFIG_HOME || join(home, ".config"), "devin");

/** Stable product metadata used to derive setup discovery and documentation. */
export const SUPPORTED_CLIENT_DEFINITIONS = [
  {
    name: "claude_code",
    displayName: "Claude Code",
    skillPath: ({ home, env }: ClientPathContext) =>
      join(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), "skills"),
    configPath: (context: ClientPathContext) =>
      join(claudeCodeConfigDirectory(context), ".claude.json"),
    markerPath: claudeCodeMarkerDirectory,
    format: "json",
  },
  {
    name: "claude_desktop",
    displayName: "Claude Desktop",
    configPath: (context: ClientPathContext) =>
      join(claudeDesktopDirectory(context), "claude_desktop_config.json"),
    markerPath: claudeDesktopDirectory,
    format: "json",
  },
  {
    name: "codex",
    displayName: "Codex",
    configPath: (context: ClientPathContext) =>
      join(codexDirectory(context), "config.toml"),
    markerPath: codexDirectory,
    format: "toml",
  },
  {
    name: "cursor",
    displayName: "Cursor",
    configPath: [".cursor", "mcp.json"],
    markerPath: [".cursor"],
    format: "json",
  },
  {
    name: "gemini_cli",
    displayName: "Gemini CLI",
    geminiSettings,
    configPath: ({ home, env }: ClientPathContext) =>
      join(env.GEMINI_CLI_HOME || home, ".gemini", "settings.json"),
    markerPath: ({ home, env }: ClientPathContext) =>
      join(env.GEMINI_CLI_HOME || home, ".gemini"),
    skillPath: ({ home, env }: ClientPathContext) =>
      join(env.GEMINI_CLI_HOME || home, ".agents", "skills"),
    format: "json",
  },
  {
    name: "windsurf",
    displayName: "Windsurf",
    configPath: [".codeium", "windsurf", "mcp_config.json"],
    markerPath: [".codeium", "windsurf"],
    format: "json",
  },
  {
    name: "devin",
    displayName: "Devin",
    configPath: ({ home, platform, env }: ClientPathContext) =>
      join(devinDirectory({ home, platform, env }), "mcp_config.json"),
    markerPath: devinDirectory,
    format: "json",
  },
  {
    name: "opencode",
    displayName: "OpenCode",
    configPath: existingOpenCodeConfigPath,
    configPaths: openCodeConfigurationPaths,
    markerPath: opencodeDirectory,
    format: "opencode",
  },
  {
    name: "antigravity",
    displayName: "Antigravity",
    skillPath: [".gemini", "config", "skills"],
    configPath: [".gemini", "config", "mcp_config.json"],
    markerPath: [".gemini", "config"],
    format: "json",
  },
  {
    name: "copilot_cli",
    displayName: "GitHub Copilot CLI",
    configPath: (context: ClientPathContext) =>
      join(copilotDirectory(context), "mcp-config.json"),
    markerPath: copilotDirectory,
    format: "copilot_cli",
  },
  {
    name: "commandcode",
    displayName: "Command Code",
    configPath: (context: ClientPathContext) =>
      join(commandCodeDirectory(context), "mcp.json"),
    markerPath: commandCodeDirectory,
    format: "commandcode",
  },
  {
    name: "qwen_code",
    displayName: "Qwen Code",
    configPath: (context: ClientPathContext) =>
      join(qwenCodeDirectory(context), "settings.json"),
    markerPath: qwenCodeDirectory,
    format: "json",
  },
  {
    name: "vscode",
    displayName: "VS Code",
    configPath: (context: ClientPathContext) =>
      join(vscodeUserDirectory(context), "mcp.json"),
    markerPath: vscodeUserDirectory,
    format: "vscode",
  },
  {
    name: "grok_build",
    displayName: "Grok Build",
    configPath: (context: ClientPathContext) =>
      join(grokDirectory(context), "config.toml"),
    markerPath: grokDirectory,
    format: "grok",
  },
  {
    name: "omp",
    displayName: "OMP",
    configPath: (context: ClientPathContext) =>
      join(ompAgentDirectory(context), "mcp.json"),
    markerPath: ompAgentDirectory,
    format: "omp",
  },
  {
    name: "pi",
    displayName: "Pi",
    configPath: (context: ClientPathContext) =>
      (context.platform === "win32" ? win32 : { join }).join(
        piAgentDirectory(context),
        "mcp.json",
      ),
    markerPath: piAgentDirectory,
    format: "pi",
  },
  {
    name: "hermes",
    displayName: "Hermes",
    skillPath: (context: ClientPathContext) =>
      join(hermesDirectory(context), "skills"),
    configPath: (context: ClientPathContext) =>
      join(hermesDirectory(context), "config.yaml"),
    markerPath: hermesDirectory,
    format: "hermes",
  },
  {
    name: "grok_bot",
    displayName: "Grok Bot",
    configPath: grokBotDirectory,
    markerPath: grokBotDirectory,
    format: "unsupported",
  },
] as const satisfies readonly ClientDefinition[];

/**
 * Paths whose presence means doctor and setup should inspect the client.
 * Layered sources count: OpenCode still loads its XDG files when a custom
 * directory override does not exist.
 */
export const clientEvidencePaths = (
  client: Pick<SetupClient, "configPath" | "configPaths" | "markerPath">,
): readonly string[] => [
  ...new Set(
    [
      client.configPath,
      ...(client.configPaths ?? []),
      client.markerPath,
    ].filter((path): path is string => path !== undefined && path.length > 0),
  ),
];

const resolvePath = (path: ClientPath, context: ClientPathContext): string =>
  typeof path === "function" ? path(context) : join(context.home, ...path);

/** Describe every client location that setup, doctor, or uninstall may inspect. */
export const supportedClients = (
  home: string,
  platform: NodeJS.Platform = process.platform,
  env: ClientPathContext["env"] = process.env,
): readonly SetupClient[] => {
  const context = { home, platform, env };
  const definitions: readonly ClientDefinition[] = SUPPORTED_CLIENT_DEFINITIONS;
  return definitions.map((definition) => {
    try {
      const configPath = resolvePath(definition.configPath, context);
      return {
        name: definition.name,
        displayName: definition.displayName,
        configPath,
        ...(definition.geminiSettings === undefined
          ? {}
          : { geminiSettings: definition.geminiSettings(context) }),
        ...(definition.configPaths === undefined
          ? {}
          : {
              configPaths: [
                ...new Set([...definition.configPaths(context), configPath]),
              ],
            }),
        markerPath: resolvePath(definition.markerPath, context),
        format: definition.format,
      };
    } catch (cause: unknown) {
      if (cause instanceof HermesClientPathError)
        return {
          name: definition.name,
          displayName: definition.displayName,
          format: definition.format,
          configPath: cause.path,
          configPathError: cause.message,
        };
      if (definition.name !== "pi") throw cause;
      return {
        name: definition.name,
        displayName: definition.displayName,
        format: definition.format,
        configPath: env.PI_CODING_AGENT_DIR ?? "",
        configPathError: `Invalid PI_CODING_AGENT_DIR: ${cause instanceof Error ? cause.message : String(cause)}. Repair the override before configuring Pi.`,
      };
    }
  });
};

/** Resolve personal skill roots using the same client environment as setup. */
export const clientSkillDirectories = (
  home: string,
  clientIds: readonly string[] | undefined,
  environment: Readonly<NodeJS.ProcessEnv> = {},
  platform: NodeJS.Platform = process.platform,
): readonly { readonly client: string; readonly directory: string }[] => {
  const definitions: readonly ClientDefinition[] = SUPPORTED_CLIENT_DEFINITIONS;
  const selected =
    clientIds === undefined
      ? [
          "shared",
          ...definitions
            .filter(({ skillPath }) => skillPath !== undefined)
            .map(({ name }) => name),
        ]
      : clientIds.length === 0
        ? ["shared"]
        : clientIds;
  const destinations = new Map<string, { client: string; directory: string }>();
  for (const client of selected) {
    const definition = definitions.find(({ name }) => name === client);
    let directory: string;
    try {
      directory =
        definition?.skillPath === undefined
          ? join(home, ".agents", "skills")
          : resolvePath(definition.skillPath, {
              home,
              platform,
              env: environment,
            });
    } catch (cause: unknown) {
      // Registration diagnostics own an unresolved profile; never fall back to another skill root.
      if (cause instanceof HermesClientPathError) continue;
      throw cause;
    }
    if (!destinations.has(directory))
      destinations.set(directory, {
        client:
          directory === join(home, ".agents", "skills") ? "shared" : client,
        directory,
      });
  }
  return [...destinations.values()].sort((left, right) =>
    left.directory.localeCompare(right.directory),
  );
};
