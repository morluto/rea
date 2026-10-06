import { join } from "node:path";
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
    readonly OPENCODE_CONFIG?: string | undefined;
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
    name: "vscode",
    displayName: "VS Code",
    configPath: (context: ClientPathContext) =>
      join(vscodeUserDirectory(context), "mcp.json"),
    markerPath: vscodeUserDirectory,
    format: "vscode",
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
    OPENCODE_CONFIG: process.env.OPENCODE_CONFIG,
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
