import { lstat } from "node:fs/promises";
import { dirname, join, posix, win32 } from "node:path";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import {
  absoluteXdgConfigHome,
  vscodeUserDirectory,
  type ClientRootContext,
} from "./ClientConfigRoots.js";
import { windowsAppDataRoots } from "./MsixPackageStorage.js";
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

/** The client-root context of one registration selection. */
export const rootContext = ({
  home,
  platform,
  environment,
}: McpRegistrationLocationContext): ClientRootContext => ({
  home,
  platform,
  env: environment,
});

/** Windows roaming application data, read as setup reads it. */
const windowsRoaming = (context: McpRegistrationLocationContext): string =>
  windowsAppDataRoots(context.home, context.environment).roaming;

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
      vscodeUserDirectory(rootContext(context)),
      "globalStorage",
      "saoudrizwan.claude-dev",
      "settings",
      "cline_mcp_settings.json",
    ),
  );
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
  // etcetera's Windows and XDG strategies; only an absolute XDG root counts.
  const path =
    platform === "win32"
      ? join(windowsRoaming(context), "Block", "goose", "config", "config.yaml")
      : join(
          absoluteXdgConfigHome({ home, env: environment }),
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
  // Zed's paths::config_dir. On Windows it reads the RoamingAppData known
  // folder, which APPDATA normally names; on Linux, `dirs::config_dir`
  // admits only an absolute XDG_CONFIG_HOME.
  location(
    context.platform === "darwin"
      ? join(context.home, ".config", "zed", "settings.json")
      : context.platform === "win32"
        ? join(windowsRoaming(context), "Zed", "settings.json")
        : join(
            absoluteXdgConfigHome({
              home: context.home,
              env: context.environment,
            }),
            "zed",
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
