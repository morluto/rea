import { isAbsolute, join, resolve } from "node:path";
import { lstatSync } from "node:fs";

/** One supported client configuration location. */
export interface SetupClient {
  readonly name: string;
  readonly displayName?: string;
  readonly configPath: string;
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
    | "hermes"
    | "unsupported";
}

type ClientPath = readonly string[] | ((paths: ClientPathContext) => string);

interface ClientPathContext {
  readonly home: string;
  readonly platform: NodeJS.Platform;
  readonly env: {
    readonly APPDATA?: string | undefined;
    readonly CLAUDE_CONFIG_DIR?: string | undefined;
    readonly CODEX_HOME?: string | undefined;
    readonly COPILOT_HOME?: string | undefined;
    readonly GROK_HOME?: string | undefined;
    readonly HERMES_DATA_DIR_SUFFIX?: string | undefined;
    readonly HERMES_HOME?: string | undefined;
    readonly LOCALAPPDATA?: string | undefined;
    readonly OMP_PROFILE?: string | undefined;
    readonly OPENCODE_CONFIG?: string | undefined;
    readonly PI_CODING_AGENT_DIR?: string | undefined;
    readonly PI_CONFIG_DIR?: string | undefined;
    readonly PI_PROFILE?: string | undefined;
    readonly QWEN_HOME?: string | undefined;
    readonly SAND_DATA_ROOT?: string | undefined;
    readonly XDG_CONFIG_HOME?: string | undefined;
  };
}

interface ClientDefinition {
  readonly name: string;
  readonly displayName: string;
  readonly configPath: ClientPath;
  readonly markerPath: ClientPath;
  readonly format: NonNullable<SetupClient["format"]>;
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
  env.CODEX_HOME ?? join(home, ".codex");

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
  env.GROK_HOME ?? join(home, ".grok");

/**
 * Hermes Agent home. `HERMES_HOME` wins; otherwise the platform default mirrors
 * Hermes's own resolver (`%LOCALAPPDATA%\\hermes` on Windows, `~/.hermes`
 * elsewhere), including the optional `HERMES_DATA_DIR_SUFFIX` that is appended
 * to the literal `hermes`/`.hermes` directory name.
 */
const hermesDirectory = ({
  home,
  platform,
  env,
}: ClientPathContext): string => {
  const override = env.HERMES_HOME;
  if (override !== undefined && override.trim() !== "") return override;
  const suffix = env.HERMES_DATA_DIR_SUFFIX ?? "";
  return platform === "win32"
    ? join(
        env.LOCALAPPDATA ?? join(home, "AppData", "Local"),
        `hermes${suffix}`,
      )
    : join(home, `.hermes${suffix}`);
};

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
 * PI_CODING_AGENT_DIR. OMP resolves a relative agent directory against each
 * process's working directory, so only an absolute override names one file.
 */
const ompAgentDirectory = (context: ClientPathContext): string => {
  const root = join(context.home, context.env.PI_CONFIG_DIR || ".omp");
  const profile = ompProfile(context);
  if (profile !== undefined) return join(root, "profiles", profile, "agent");
  const override = context.env.PI_CODING_AGENT_DIR;
  return override !== undefined && override !== "" && isAbsolute(override)
    ? override
    : join(root, "agent");
};

const copilotDirectory = ({ home, env }: ClientPathContext): string =>
  env.COPILOT_HOME ?? join(home, ".copilot");

const commandCodeDirectory = ({ home }: ClientPathContext): string =>
  join(home, ".commandcode");

const opencodeDirectory = ({ home, env }: ClientPathContext): string =>
  join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "opencode");

const existingOpenCodeConfigPath = (context: ClientPathContext): string => {
  if (context.env.OPENCODE_CONFIG !== undefined)
    return context.env.OPENCODE_CONFIG;
  const directory = opencodeDirectory(context);
  const candidates = [
    "opencode.json",
    "opencode.jsonc",
    ".opencode.json",
    ".opencode.jsonc",
  ].map((filename) => join(directory, filename));
  return (
    candidates.find((path) => {
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
    candidates[0] ??
    join(directory, "opencode.json")
  );
};

const devinDirectory = ({ home, platform, env }: ClientPathContext): string =>
  platform === "win32"
    ? join(env.APPDATA ?? join(home, "AppData", "Roaming"), "devin")
    : join(home, ".config", "devin");

/** Stable product metadata used to derive setup discovery and documentation. */
export const SUPPORTED_CLIENT_DEFINITIONS = [
  {
    name: "claude_code",
    displayName: "Claude Code",
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
    configPath: [".gemini", "settings.json"],
    markerPath: [".gemini"],
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
    markerPath: opencodeDirectory,
    format: "opencode",
  },
  {
    name: "antigravity",
    displayName: "Antigravity",
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
    name: "hermes",
    displayName: "Hermes",
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

const resolvePath = (path: ClientPath, context: ClientPathContext): string =>
  typeof path === "function" ? path(context) : join(context.home, ...path);

/** Describe every client location that setup, doctor, or uninstall may inspect. */
export const supportedClients = (
  home: string,
  platform: NodeJS.Platform = process.platform,
  env: ClientPathContext["env"] = {
    APPDATA: process.env.APPDATA,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    CODEX_HOME: process.env.CODEX_HOME,
    COPILOT_HOME: process.env.COPILOT_HOME,
    GROK_HOME: process.env.GROK_HOME,
    HERMES_DATA_DIR_SUFFIX: process.env.HERMES_DATA_DIR_SUFFIX,
    HERMES_HOME: process.env.HERMES_HOME,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    OMP_PROFILE: process.env.OMP_PROFILE,
    OPENCODE_CONFIG: process.env.OPENCODE_CONFIG,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_CONFIG_DIR: process.env.PI_CONFIG_DIR,
    PI_PROFILE: process.env.PI_PROFILE,
    QWEN_HOME: process.env.QWEN_HOME,
    SAND_DATA_ROOT: process.env.SAND_DATA_ROOT,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  },
): readonly SetupClient[] => {
  const context = { home, platform, env };
  return SUPPORTED_CLIENT_DEFINITIONS.map((definition) => ({
    name: definition.name,
    displayName: definition.displayName,
    configPath: resolvePath(definition.configPath, context),
    markerPath: resolvePath(definition.markerPath, context),
    format: definition.format,
  }));
};
