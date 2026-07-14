import { join } from "node:path";

/** One supported client configuration location. */
export interface SetupClient {
  readonly name: string;
  readonly configPath: string;
  readonly markerPath?: string;
  readonly format?: "json" | "toml" | "unsupported";
}

/** Describe every client location that setup, doctor, or uninstall may inspect. */
export const supportedClients = (home: string): readonly SetupClient[] => [
  {
    name: "claude_code",
    configPath: join(home, ".claude.json"),
    markerPath: join(home, ".claude"),
  },
  {
    name: "claude_desktop",
    configPath: join(
      home,
      "Library/Application Support/Claude/claude_desktop_config.json",
    ),
    markerPath: join(home, "Library/Application Support/Claude"),
  },
  {
    name: "codex",
    configPath: join(home, ".codex/config.toml"),
    markerPath: join(home, ".codex"),
    format: "toml",
  },
  {
    name: "cursor",
    configPath: join(home, ".cursor/mcp.json"),
    markerPath: join(home, ".cursor"),
  },
  {
    name: "gemini_cli",
    configPath: join(home, ".gemini/settings.json"),
    markerPath: join(home, ".gemini"),
  },
  {
    name: "windsurf",
    configPath: join(home, ".codeium/windsurf/mcp_config.json"),
    markerPath: join(home, ".codeium/windsurf"),
  },
  {
    name: "devin",
    configPath: join(home, ".devin"),
    markerPath: join(home, ".devin"),
    format: "unsupported",
  },
];
