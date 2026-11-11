import { lstat } from "node:fs/promises";
import { dirname, join, posix, win32 } from "node:path";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import type { SetupClient, SupportedClientName } from "./SupportedClients.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import type { ClientConfigurationDocument } from "./ClientConfigurationDocument.js";

export interface McpRegistrationLocationContext {
  readonly home: string;
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly setup: readonly SetupClient[];
  readonly resources: ArtifactResourceScope;
  readonly signal?: AbortSignal;
}

export interface McpRegistrationInlineConfiguration {
  readonly origin: "KILO_CONFIG_CONTENT";
  readonly parsed: ClientConfigurationDocument;
}

export interface McpRegistrationLocation {
  readonly configPath: string;
  /** Complete known file layers in native precedence; configPath alone grants write authority. */
  readonly configPaths?: readonly string[];
  readonly inlineConfiguration?: McpRegistrationInlineConfiguration;
}

export interface McpRegistrationGlobalLocation extends McpRegistrationLocation {
  readonly markers: readonly string[];
}

export const selectedPath = (
  path: string,
  context: McpRegistrationLocationContext,
): string =>
  absoluteCallerPath(path, { cwd: context.cwd, platform: context.platform });

export const fromSetup =
  (name: SupportedClientName) =>
  async (
    context: McpRegistrationLocationContext,
  ): Promise<McpRegistrationGlobalLocation> => {
    const client = context.setup.find((candidate) => candidate.name === name);
    if (client === undefined)
      throw new ConfigurationError(
        `The registration catalog has no path owner for ${name}.`,
      );
    if (client.configPathError !== undefined)
      throw new ConfigurationError(client.configPathError);
    return {
      configPath: selectedPath(client.configPath, context),
      ...(client.configPaths === undefined
        ? {}
        : {
            configPaths: client.configPaths.map((path) =>
              selectedPath(path, context),
            ),
          }),
      markers: [selectedPath(client.markerPath ?? client.configPath, context)],
    };
  };

export const platformPaths = (context: McpRegistrationLocationContext) => {
  const { home, platform, environment } = context;
  const config = environment.XDG_CONFIG_HOME || join(home, ".config");
  const appSupport =
    platform === "win32"
      ? environment.APPDATA || win32.join(home, "AppData", "Roaming")
      : platform === "darwin"
        ? join(home, "Library", "Application Support")
        : config;
  return { config, appSupport, vscode: join(appSupport, "Code", "User") };
};

const location = (
  path: string,
  marker = dirname(path),
): McpRegistrationGlobalLocation => ({
  configPath: path,
  markers: [marker],
});

export const present = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (cause: unknown) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return false;
    throw new ConfigurationError(
      `Cannot determine the registration location at ${path}. Repair its access or path before registering.`,
      { cause },
    );
  }
};

export const firstExisting = async (
  candidates: readonly string[],
  fallback: string,
): Promise<string> => {
  for (const candidate of candidates)
    if (await present(candidate)) return candidate;
  return fallback;
};

export const clineLocation = async (
  context: McpRegistrationLocationContext,
): Promise<McpRegistrationGlobalLocation> =>
  location(
    join(
      platformPaths(context).vscode,
      "globalStorage",
      "saoudrizwan.claude-dev",
      "settings",
      "cline_mcp_settings.json",
    ),
  );
export const clineCliLocation = async (
  context: McpRegistrationLocationContext,
): Promise<McpRegistrationGlobalLocation> => {
  const { environment, home } = context;
  const explicitPath = environment.CLINE_MCP_SETTINGS_PATH?.trim();
  if (explicitPath) return location(explicitPath);
  const explicitData = environment.CLINE_DATA_DIR?.trim();
  if (explicitData)
    return location(join(explicitData, "settings", "cline_mcp_settings.json"));
  const explicitDirectory = environment.CLINE_DIR?.trim();
  if (explicitDirectory)
    return location(
      join(explicitDirectory, "data", "settings", "cline_mcp_settings.json"),
    );
  const envHome = environment.HOME?.trim();
  const profile = environment.USERPROFILE?.trim();
  const drive = environment.HOMEDRIVE?.trim();
  const path = environment.HOMEPATH?.trim();
  // Cline falls back to os.homedir(), then to the literal "~". On POSIX,
  // a present HOME is returned by os.homedir() even if empty or "~".
  // Otherwise use the supplied account home only when it was not selected
  // from a rejected environment value; that value cannot prove the OS home.
  const rejectedHome =
    context.platform !== "win32" && environment.HOME !== undefined;
  const fallbackUncertain =
    (context.platform === "win32" &&
      (environment.USERPROFILE !== undefined ||
        Boolean(environment.HOMEDRIVE && environment.HOMEPATH) ||
        Boolean(environment.HOME))) ||
    (context.platform !== "win32" &&
      environment.HOME === undefined &&
      environment.USERPROFILE !== undefined);
  const nativeHome = rejectedHome
    ? "~"
    : fallbackUncertain
      ? undefined
      : home.trim() || "~";
  const clineHome =
    (envHome && envHome !== "~" ? envHome : undefined) ||
    profile ||
    (drive && path ? `${drive}${path}` : undefined) ||
    nativeHome;
  if (!clineHome)
    throw new ConfigurationError(
      "Cannot determine Cline CLI's system home from the selected environment. Set CLINE_MCP_SETTINGS_PATH, CLINE_DATA_DIR, or CLINE_DIR to select its configuration location.",
    );
  return location(
    join(clineHome, ".cline", "data", "settings", "cline_mcp_settings.json"),
  );
};
export const gooseLocation = async (
  context: McpRegistrationLocationContext,
): Promise<McpRegistrationGlobalLocation> => {
  const { home, platform, environment } = context;
  const pathApi = platform === "win32" ? win32 : posix;
  const root = environment.GOOSE_PATH_ROOT;
  if (root && pathApi.isAbsolute(root)) {
    const selected = pathApi.join(root, "config", "config.yaml");
    return location(selected, selected);
  }
  const xdg = environment.XDG_CONFIG_HOME;
  const path =
    platform === "win32"
      ? join(
          platformPaths(context).appSupport,
          "Block",
          "goose",
          "config",
          "config.yaml",
        )
      : join(
          xdg && posix.isAbsolute(xdg) ? xdg : join(home, ".config"),
          "goose",
          "config.yaml",
        );
  return location(path, path);
};
export const junieLocation = async (
  context: McpRegistrationLocationContext,
): Promise<McpRegistrationGlobalLocation> => {
  const root = context.environment.JUNIE_HOME || join(context.home, ".junie");
  return location(join(root, "mcp", "mcp.json"), root);
};
/** Fixed relative target precedence used by clients with a single project document. */
export const fixedProjectLocation =
  (candidates: readonly [string, ...string[]]) =>
  async (
    context: McpRegistrationLocationContext,
  ): Promise<McpRegistrationLocation> => {
    const paths = candidates.map((path) => selectedPath(path, context));
    return {
      configPath: await firstExisting(
        paths,
        selectedPath(candidates[0], context),
      ),
    };
  };
export const kiroLocation = async (
  context: McpRegistrationLocationContext,
): Promise<McpRegistrationGlobalLocation> =>
  location(
    join(context.home, ".kiro", "settings", "mcp.json"),
    join(context.home, ".kiro"),
  );
export const mcporterLocation = async (
  context: McpRegistrationLocationContext,
): Promise<McpRegistrationGlobalLocation> => {
  const root = join(context.home, ".mcporter");
  const primary = join(root, "mcporter.json");
  return location(
    await firstExisting([primary, join(root, "mcporter.jsonc")], primary),
    root,
  );
};
export const zedLocation = async (
  context: McpRegistrationLocationContext,
): Promise<McpRegistrationGlobalLocation> =>
  location(
    context.platform === "darwin"
      ? join(context.home, ".config", "zed", "settings.json")
      : join(
          platformPaths(context).appSupport,
          context.platform === "win32" ? "Zed" : "zed",
          "settings.json",
        ),
  );

export const fxLocation = async (
  context: McpRegistrationLocationContext,
): Promise<McpRegistrationGlobalLocation> =>
  location(join(context.home, ".fx", "mcp.json"));
export const mastraLocation = async (
  context: McpRegistrationLocationContext,
): Promise<McpRegistrationGlobalLocation> =>
  location(join(context.home, ".mastracode", "mcp.json"));
export const ampLocation = async (
  context: McpRegistrationLocationContext,
): Promise<McpRegistrationGlobalLocation> =>
  location(join(context.home, ".config", "amp", "settings.json"));
