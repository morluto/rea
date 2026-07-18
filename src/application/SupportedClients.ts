import { join } from "node:path";

/** One supported client configuration location. */
export interface SetupClient {
  readonly name: string;
  readonly displayName?: string;
  readonly configPath: string;
  readonly markerPath?: string;
  readonly format?: "json" | "toml" | "unsupported";
}

/** Stable product metadata used to derive setup discovery and documentation. */
export const SUPPORTED_CLIENT_DEFINITIONS = [
  {
    name: "claude_code",
    displayName: "Claude Code",
    configPath: [".claude.json"],
    markerPath: [".claude"],
    format: "json",
  },
  {
    name: "claude_desktop",
    displayName: "Claude Desktop",
    configPath: [
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    ],
    markerPath: ["Library", "Application Support", "Claude"],
    format: "json",
  },
  {
    name: "codex",
    displayName: "Codex",
    configPath: [".codex", "config.toml"],
    markerPath: [".codex"],
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
    configPath: [".devin"],
    markerPath: [".devin"],
    format: "unsupported",
  },
] as const;

/** Describe every client location that setup, doctor, or uninstall may inspect. */
export const supportedClients = (home: string): readonly SetupClient[] =>
  SUPPORTED_CLIENT_DEFINITIONS.map((definition) => ({
    name: definition.name,
    displayName: definition.displayName,
    configPath: join(home, ...definition.configPath),
    markerPath: join(home, ...definition.markerPath),
    format: definition.format,
  }));
