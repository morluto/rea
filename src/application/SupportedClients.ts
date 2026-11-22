import type { ClientRegistrationProfile } from "./ClientRegistrationProfile.js";
import type {
  ClientConfigurationFormat,
  ClientInlineConfiguration,
} from "./ClientConfigurationDocument.js";
import { dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { err, ok, type Result } from "../domain/result.js";
import {
  HermesClientPathError,
  resolveHermesClientHome,
} from "./HermesClientHome.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";
import { appendCallerPath } from "../filesystem/callerPath.js";
import {
  clientPathDependence,
  type ClientRootFailure,
  mcporterXdgConfigHome,
  vscodeUserDirectory,
  xdgConfigHomeOrDefault,
} from "./ClientConfigRoots.js";
import { resolveWindowsClaudeDesktopLocation } from "./ClaudeDesktopConfigLocation.js";
import { resolveClineCliSettingsPath } from "./ClineCliLocation.js";
import type { JunieLocationSettings } from "./JunieClientSettings.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import {
  type MsixPackageView,
  windowsAppDataRoots,
} from "./MsixPackageStorage.js";
import { kiloProjectLocation } from "./McpRegistrationKiloLocations.js";
import type {
  McpRegistrationLocation,
  McpRegistrationLocationContext,
} from "./McpRegistrationLocations.js";
import { errorMessage } from "../kernel/errorMessage.js";

import {
  ompAgentDirectory,
  piAgentDirectory,
  piProjectSettings,
  copilotDirectory,
  commandCodeDirectory,
  opencodeDirectory,
  openCodeUserOverridePaths,
  openCodeConfigurationPaths,
  existingOpenCodeConfigPath,
  geminiSettings,
  devinDirectory,
  clineSettingsDirectory,
  clineVscodeSettingsDirectory,
  zedLocation,
  mcporterLocation,
  MCPORTER_URL_FIELDS,
  ampLocation,
  fxLocation,
  junieLocation,
  gooseLocation,
  gooseConfigPaths,
  freebuffProfileDirectory,
  kiloLocation,
  kiloLayeredLocation,
  kiloCandidatePaths,
  kiloDiscoveryPaths,
  MCPORTER_STDIO_INCOMPATIBILITIES,
  type ClientDefinitionInput,
} from "./SupportedClientLocations.js";
export { clientProjectConfigurationPaths } from "./SupportedClientLocations.js";
/** One supported client configuration location. */
export interface SetupClient {
  readonly name: string;
  readonly registrationProfile: ClientRegistrationProfile;
  readonly displayName?: string;
  readonly configPath: string;
  /** User configuration files in increasing precedence, including the write target. */
  readonly configPaths?: readonly string[];
  /** User-selected OpenCode files can also occur in the native project walk. */
  readonly openCodeUserOverridePaths?: readonly string[];
  /** Read-only configuration the client merges over every file layer. */
  readonly inlineConfiguration?: ClientInlineConfiguration;
  /** The selected Pi profile's persisted project-trust inputs. */
  readonly piSettings?: PiProjectSettings;
  /** Read-only Gemini scopes and trust inputs; never setup write targets. */
  readonly geminiSettings?: {
    readonly systemPath: string;
    readonly defaultsPath: string;
    readonly workspaceDirectory: string;
    readonly trustedFoldersPath: string;
    readonly trustOverride?: boolean;
    readonly platform: NodeJS.Platform;
  };
  /** Inputs deciding whether Junie loads its default user MCP location. */
  readonly junieSettings?: JunieLocationSettings;
  /** Unresolved path evidence only; consumers must not perform I/O on it. */
  readonly configPathError?: string;
  /** The access failure behind `configPathError`, when one was observed. */
  readonly configPathFailure?: ConfigurationError;
  /** Same-scope fallback ZCode stops loading after its first native server. */
  readonly zcodeFallbackPath?: string;
  readonly markerPath?: string;
  /**
   * Registration storage shared with other products. Its presence never proves
   * this product is installed; only a recognizable REA-owned row in it proves
   * ownership of a registration REA wrote.
   */
  readonly sharedRegistration?: boolean;
  /**
   * Only a registration REA wrote makes this client applicable: setup never
   * detects it, and doctor reports it only when its file holds a `rea` row.
   */
  readonly registrationApplicability?: true;
  /**
   * The configuration is a private profile: folder 0700, file 0600. `home` is
   * the caller's home folder, which that folder mode must never reach.
   */
  readonly privateProfile?: { readonly home: string };
  /**
   * Layers before `configPath` belong to the system or an administrator: REA
   * reads them for the effective registration but changes only `configPath`.
   */
  readonly readOnlyLowerLayers?: true;
  /** MSIX package storage that decides which configuration the client reads. */
  readonly msixPackage?: MsixPackageView;
  /** A running client can rewrite its configuration from memory. */
  readonly quitBeforeSetup?: boolean;
  /** Product-specific applicability evidence when configuration storage is shared. */
  readonly discoveryPaths?: readonly string[];
  readonly format?:
    | "json"
    | "claude_code"
    | "toml"
    | "vscode"
    | "copilot_cli"
    | "opencode"
    | "commandcode"
    | "grok"
    | "omp"
    | "pi"
    | "kimi"
    | "lm_studio"
    | "hermes"
    | "zcode_fallback"
    | "zcode"
    | "dsh"
    | "zed"
    | "amp"
    | "fx"
    | "goose"
    | "kilo"
    | "unsupported";
}

export interface PiProjectSettings {
  readonly trustPath: string;
  readonly settingsPath: string;
}

export interface ClientPathFailure extends ClientRootFailure {
  readonly msixPackage?: MsixPackageView;
  /** The access failure that left the path unresolved, with its cause. */
  readonly failure?: ConfigurationError;
}

export type ClientPathResult = Result<string, ClientPathFailure>;
type ClientPath =
  | readonly string[]
  | ((paths: ClientPathContext) => string | ClientPathResult);

export interface ClientPathContext {
  readonly home: string;
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly systemPaths?: ClientSystemPaths;
}

/**
 * Fixed system-wide files a client reads that no environment variable moves.
 * Omitted entries use the client's native location; a caller supplies one only
 * to isolate the host's real file.
 */
export interface ClientSystemPaths {
  readonly gooseSystemConfig?: string;
}

/**
 * A user-scope location decided by which configuration layers exist, which
 * only an asynchronous probe can observe.
 */
export interface ClientLayeredLocation {
  readonly configPath: string;
  /** Every file layer in load order, including `configPath`. */
  readonly configPaths: readonly string[];
  readonly inlineConfiguration?: ClientInlineConfiguration;
}

/** One resolved configuration location and its detection evidence. */
export interface ClientLocation {
  readonly configPath: string;
  readonly markerPath: string;
  readonly msixPackage?: MsixPackageView;
}

type ClientDefinition = ClientDefinitionBase & ClientDefinitionLocation;
export type ClientDefinitionLocation =
  | {
      readonly configPath: ClientPath;
      readonly markerPath: ClientPath;
      readonly location?: undefined;
    }
  | {
      /** Resolve configuration and marker together when they share probes. */
      readonly location: (
        context: ClientPathContext,
      ) => Result<ClientLocation, ClientPathFailure>;
      readonly configPath?: undefined;
      readonly markerPath?: undefined;
    };

/**
 * How `rea mcp add` selects this client beyond its user-scope registration.
 * The registration itself uses this row's location, format, profile and
 * read-scope facts, so both commands share one definition.
 */
type McpAddExposure = {
  /** add-mcp agent aliases that select this client. */
  readonly aliases?: readonly string[];
  /** Dialect of the project document when it differs from the user one. */
  readonly projectFormat?: ClientConfigurationFormat;
} & (
  | {
      /** Project documents in native precedence; absent means global-only. */
      readonly projectPaths?: readonly [string, ...string[]];
      readonly projectLocation?: undefined;
    }
  | {
      /** A project location only an asynchronous probe can decide. */
      readonly projectLocation: (
        context: McpRegistrationLocationContext,
      ) => Promise<McpRegistrationLocation>;
      readonly projectPaths?: undefined;
    }
);

export interface ClientDefinitionBase {
  readonly name: string;
  readonly registrationProfile: ClientRegistrationProfile;
  readonly displayName: string;
  readonly mcpAdd?: McpAddExposure;
  readonly discoveryPaths?: (context: ClientPathContext) => readonly string[];
  readonly sharedRegistration?: true;
  readonly registrationApplicability?: true;
  readonly privateProfile?: true;
  readonly readOnlyLowerLayers?: true;
  readonly format: NonNullable<SetupClient["format"]>;
  readonly quitBeforeSetup?: boolean;
  readonly zcodeFallbackPath?: (context: ClientPathContext) => string;
  readonly skillPath?: ClientPath;
  readonly configPaths?: (context: ClientPathContext) => readonly string[];
  readonly geminiSettings?: (
    context: ClientPathContext,
  ) => NonNullable<SetupClient["geminiSettings"]>;
  readonly piSettings?: (context: ClientPathContext) => PiProjectSettings;
  /** Junie's location inputs, from the context and its resolved home. */
  readonly junieSettings?: (
    context: ClientPathContext,
    location: ClientLocation,
  ) => JunieLocationSettings;
  /**
   * The write target and layers once present layers are observed.
   * `resolveSupportedClients` applies it; the synchronous row keeps the
   * default target and every candidate layer.
   */
  readonly layeredLocation?: (
    context: ClientPathContext,
  ) => Promise<Result<ClientLayeredLocation, ClientPathFailure>>;
}

const traeUserDirectory = ({
  home,
  platform,
  env,
}: ClientPathContext): string => {
  if (platform === "win32")
    return join(windowsAppDataRoots(home, env).roaming, "Trae", "User");
  if (platform === "darwin")
    return join(home, "Library", "Application Support", "Trae", "User");
  return join(xdgConfigHomeOrDefault({ home, env }), "Trae", "User");
};

/** Windows packaging decides which file Claude Desktop reads; see its resolver. */
const claudeDesktopLocation = (
  context: ClientPathContext,
): Result<ClientLocation, ClientPathFailure> => {
  if (context.platform === "win32")
    return resolveWindowsClaudeDesktopLocation(context.home, context.env);
  const directory =
    context.platform === "linux"
      ? join(xdgConfigHomeOrDefault(context), "Claude")
      : join(context.home, "Library", "Application Support", "Claude");
  return ok({
    configPath: join(directory, "claude_desktop_config.json"),
    markerPath: directory,
  });
};

const claudeCodeConfigDirectory = ({ home, env }: ClientPathContext): string =>
  env.CLAUDE_CONFIG_DIR || home;

const claudeCodeMarkerDirectory = ({ home, env }: ClientPathContext): string =>
  env.CLAUDE_CONFIG_DIR || join(home, ".claude");

const codexDirectory = ({ home, env }: ClientPathContext): string =>
  env.CODEX_HOME || join(home, ".codex");

/** Kimi Code stores MCP declarations beside the rest of its home data. */
const kimiDirectory = ({ home, env }: ClientPathContext): string =>
  env.KIMI_CODE_HOME || join(home, ".kimi-code");

/**
 * LM Studio's findLMStudioHome, read-only: a home pointer file wins, then an
 * existing ~/.cache/lm-studio, then ~/.lmstudio. Setup never writes the pointer.
 */
const lmStudioLocation = ({
  home,
}: ClientPathContext): Result<ClientLocation, ClientPathFailure> => {
  const pointerPath = join(home, ".lmstudio-home-pointer");
  let directory: string;
  try {
    directory = readFileSync(pointerPath, "utf8").trim();
  } catch (cause: unknown) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT"))
      return err({
        path: pointerPath,
        message: `${pointerPath} could not be read, so REA cannot establish which LM Studio home holds mcp.json: ${errorMessage(cause)}. Repair access to that file, then rerun.`,
      });
    const cache = join(home, ".cache", "lm-studio");
    directory = existsSync(cache) ? cache : join(home, ".lmstudio");
  }
  if (!isAbsolute(directory))
    return err({
      path: pointerPath,
      message: `${pointerPath} does not hold an absolute LM Studio home path. Correct or remove that file, then rerun.`,
    });
  return ok({ configPath: join(directory, "mcp.json"), markerPath: directory });
};

const qoderDirectory = ({ home, env }: ClientPathContext): string =>
  env.QODER_CONFIG_DIR || join(home, ".qoder");

/** Droid's override selects the home containing .factory, including personal skills. */
const factoryDirectory = ({ home, env }: ClientPathContext): string =>
  join(env.FACTORY_HOME_OVERRIDE || home, ".factory");

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

/** Match Harness home-paths for both independent roots; trim only to detect blanks. */
const dshDirectory = (
  home: string,
  override: string | undefined,
  fallback: string,
): string => {
  const selected =
    override !== undefined && override.trim().length > 0
      ? override
      : join(home, fallback);
  const expanded =
    selected === "~"
      ? home
      : selected.startsWith("~/") || selected.startsWith("~\\")
        ? join(home, selected.slice(2))
        : selected;
  return resolve(expanded);
};

const dshHomeDirectory = ({ home, env }: ClientPathContext): string =>
  dshDirectory(home, env.DSH_HOME, ".dsh");

const dshPatchDirectory = (context: ClientPathContext): string =>
  join(dshHomeDirectory(context), "cordis.patch.yml");

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

/**
 * Facts a setup plan must disclose so an approved registration persists:
 * which file an MSIX package reads, and that a running client can overwrite it.
 */
export const registrationPersistenceDetail = (
  client: SetupClient,
): string | undefined => {
  const name = client.displayName ?? client.name;
  const msix = client.msixPackage;
  const packageDetail =
    msix === undefined
      ? undefined
      : client.configPath === msix.privateConfigPath
        ? `${name} is installed as MSIX package ${msix.packageFamilyName}, which reads this package-private file instead of ${msix.appDataConfigPath}.`
        : `${name} is installed as MSIX package ${msix.packageFamilyName}, which reads this file until it saves its own copy at ${msix.privateConfigPath}.`;
  const quitDetail =
    client.quitBeforeSetup === true
      ? `Quit ${name} fully before approving; closing its window is not enough. A running ${name} can rewrite this file from memory and drop the registration. Start it again after setup.`
      : undefined;
  const details = [packageDetail, quitDetail].filter(
    (detail): detail is string => detail !== undefined,
  );
  return details.length === 0 ? undefined : details.join(" ");
};

/**
 * What a direct registration (no approval step) must tell the caller after it
 * wrote a client that can rewrite its configuration from memory.
 */
export const runningClientRewriteNotice = (
  client: Pick<SetupClient, "name" | "displayName" | "quitBeforeSetup">,
): string | undefined => {
  if (client.quitBeforeSetup !== true) return undefined;
  const name = client.displayName ?? client.name;
  return `A running ${name} can rewrite its configuration from memory and drop the registration. If ${name} was running, quit it fully (closing its window is not enough), rerun rea mcp add, then start ${name} again.`;
};

/**
 * Why this process must not change an MSIX client's configuration. A process
 * the running app started sees its redirected AppData, and the app would
 * overwrite the change from memory; an unknown view cannot rule that out.
 */
export const registrationWriteBlocker = (
  client: SetupClient,
  operation: "setup" | "uninstall" | "mcp add",
): string | undefined => {
  const msix = client.msixPackage;
  if (msix === undefined || msix.processView === "direct") return undefined;
  const name = client.displayName ?? client.name;
  if (msix.processView === "redirected")
    return `This process was started from ${name}'s MSIX package ${msix.packageFamilyName}: its AppData is redirected into that package, so ${name} is running and would overwrite ${msix.privateConfigPath} from memory. Quit ${name} fully, then rerun ${operation} from a terminal that ${name} did not start.`;
  // Registration writes the configuration the app reads; uninstall cleans both files.
  const manualEdit =
    operation !== "uninstall"
      ? `Add REA's entry to ${client.configPath} by hand`
      : `Remove REA's entry by hand from each of ${msix.privateConfigPath} and ${msix.appDataConfigPath} that has one`;
  return `REA cannot tell whether ${name}'s MSIX package ${msix.packageFamilyName} started this process, because no private file under ${dirname(dirname(msix.privateConfigPath))} could be compared with ${dirname(dirname(msix.appDataConfigPath))}, and a ${name} that started it would overwrite the change from memory. ${manualEdit} while ${name} is fully quit, or rerun ${operation} from a terminal that ${name} did not start once REA can compare a private file there.`;
};

/** The MSIX package view, if any, that redirects this process's AppData writes. */
export const appDataRedirection = (
  clients: readonly SetupClient[],
): MsixPackageView | undefined =>
  clients.find(({ msixPackage }) => msixPackage?.processView === "redirected")
    ?.msixPackage;

const defineClient = <const Definition extends ClientDefinitionInput>(
  definition: Definition,
) => {
  const { registrationConnection, ...metadata } = definition;
  return {
    ...metadata,
    registrationProfile: {
      nativeClient: definition.name,
      connection: registrationConnection,
    },
  };
};

/** Stable product metadata used to derive setup discovery and documentation. */
export const SUPPORTED_CLIENT_DEFINITIONS = [
  defineClient({
    name: "claude_code",
    mcpAdd: { projectPaths: [".mcp.json"] },
    registrationConnection: {
      kind: "flat",
      fields: ["type", "url"],
      stdio: [
        { kind: "optional-enum", field: "type", values: ["stdio"] },
        { kind: "present", field: "url" },
      ],
    },
    displayName: "Claude Code",
    skillPath: (context: ClientPathContext) =>
      join(claudeCodeMarkerDirectory(context), "skills"),
    configPath: (context: ClientPathContext) =>
      join(claudeCodeConfigDirectory(context), ".claude.json"),
    markerPath: claudeCodeMarkerDirectory,
    format: "claude_code",
  }),
  defineClient({
    name: "claude_desktop",
    mcpAdd: {},
    registrationConnection: {
      kind: "flat",
      fields: ["type"],
      stdio: [{ kind: "optional-enum", field: "type", values: ["stdio"] }],
    },
    displayName: "Claude Desktop",
    location: claudeDesktopLocation,
    quitBeforeSetup: true,
    format: "json",
  }),
  defineClient({
    name: "codex",
    mcpAdd: { projectPaths: [".codex/config.toml"] },
    registrationConnection: {
      kind: "flat",
      fields: ["url"],
      stdio: [{ kind: "non-nullish", field: "url" }],
    },
    displayName: "Codex",
    configPath: (context: ClientPathContext) =>
      appendCallerPath(codexDirectory(context), "config.toml"),
    markerPath: codexDirectory,
    format: "toml",
  }),
  defineClient({
    name: "cursor",
    mcpAdd: { projectPaths: [".cursor/mcp.json"] },
    registrationConnection: {
      kind: "flat",
      fields: ["type", "url"],
      stdio: [
        { kind: "optional-enum", field: "type", values: ["stdio"] },
        { kind: "present", field: "url" },
      ],
    },
    displayName: "Cursor",
    configPath: [".cursor", "mcp.json"],
    markerPath: [".cursor"],
    format: "json",
  }),
  defineClient({
    name: "codebuddy",
    registrationConnection: {
      kind: "stdio-only",
      documentedFields: ["env", "type"],
    },
    displayName: "CodeBuddy",
    skillPath: [".codebuddy", "skills"],
    configPath: [".codebuddy", "mcp.json"],
    markerPath: [".codebuddy"],
    format: "json",
  }),
  defineClient({
    // Cline discovers the shared ~/.agents/skills directory. Keep REA's
    // existing shared destination instead of managing another skill copy.
    name: "cline",
    mcpAdd: {},
    registrationConnection: { kind: "cline" },
    displayName: "Cline CLI",
    location: ({ home, env, platform }: ClientPathContext) => {
      const selected = resolveClineCliSettingsPath({
        home,
        platform,
        environment: env,
      });
      const pathApi = platform === "win32" ? win32 : posix;
      return selected.ok
        ? ok({
            configPath: selected.value,
            markerPath: pathApi.dirname(selected.value),
          })
        : selected;
    },
    format: "json",
  }),
  defineClient({
    name: "gemini_cli",
    mcpAdd: { aliases: ["gemini"], projectPaths: [".gemini/settings.json"] },
    registrationConnection: {
      kind: "flat",
      fields: ["type", "url", "httpUrl"],
      stdio: [
        { kind: "truthy", field: "httpUrl" },
        { kind: "truthy", field: "url" },
      ],
    },
    displayName: "Gemini CLI",
    geminiSettings,
    configPath: ({ home, env }: ClientPathContext) =>
      join(env.GEMINI_CLI_HOME || home, ".gemini", "settings.json"),
    markerPath: ({ home, env }: ClientPathContext) =>
      join(env.GEMINI_CLI_HOME || home, ".gemini"),
    // Antigravity keeps its configuration under the same .gemini directory,
    // so the directory alone does not show Gemini CLI. Its own settings,
    // trusted-folder records and session state do.
    discoveryPaths: (context: ClientPathContext) => {
      const root = join(context.env.GEMINI_CLI_HOME || context.home, ".gemini");
      return [
        join(root, "settings.json"),
        geminiSettings(context).trustedFoldersPath,
        join(root, "tmp"),
      ];
    },
    skillPath: ({ home, env }: ClientPathContext) =>
      join(env.GEMINI_CLI_HOME || home, ".agents", "skills"),
    format: "json",
  }),
  defineClient({
    name: "windsurf",
    mcpAdd: { aliases: ["codeium", "cascade"] },
    registrationConnection: {
      kind: "flat",
      fields: ["serverUrl", "url"],
      stdio: [
        { kind: "present", field: "serverUrl" },
        { kind: "present", field: "url" },
      ],
    },
    displayName: "Windsurf",
    configPath: [".codeium", "windsurf", "mcp_config.json"],
    markerPath: [".codeium", "windsurf"],
    format: "json",
  }),
  defineClient({
    name: "devin",
    registrationConnection: {
      kind: "flat",
      fields: ["url", "transport"],
      stdio: [
        { kind: "optional-enum", field: "transport", values: ["stdio"] },
        { kind: "present", field: "url" },
      ],
    },
    displayName: "Devin",
    configPath: ({ home, platform, env }: ClientPathContext) =>
      join(devinDirectory({ home, platform, env }), "mcp_config.json"),
    markerPath: devinDirectory,
    format: "json",
  }),
  defineClient({
    name: "opencode",
    mcpAdd: {
      projectPaths: [
        "opencode.jsonc",
        "opencode.json",
        ".opencode/opencode.jsonc",
        ".opencode/opencode.json",
      ],
    },
    registrationConnection: {
      kind: "flat",
      fields: ["url"],
      stdio: [{ kind: "required-enum", field: "type", values: ["local"] }],
    },
    displayName: "OpenCode",
    configPath: existingOpenCodeConfigPath,
    configPaths: openCodeConfigurationPaths,
    markerPath: opencodeDirectory,
    format: "opencode",
  }),
  defineClient({
    name: "antigravity",
    mcpAdd: {},
    registrationConnection: {
      kind: "flat",
      fields: ["serverUrl", "url"],
      stdio: [
        { kind: "present", field: "serverUrl" },
        { kind: "present", field: "url" },
      ],
    },
    displayName: "Antigravity",
    skillPath: [".gemini", "config", "skills"],
    configPath: [".gemini", "config", "mcp_config.json"],
    markerPath: [".gemini", "config"],
    format: "json",
  }),
  defineClient({
    name: "copilot_cli",
    mcpAdd: {
      projectPaths: [".mcp.json", ".github/mcp.json"],
      projectFormat: "copilot_cli_project",
    },
    registrationConnection: {
      kind: "flat",
      fields: ["url"],
      stdio: [
        { kind: "optional-enum", field: "type", values: ["stdio", "local"] },
        { kind: "present", field: "url" },
      ],
    },
    displayName: "GitHub Copilot CLI",
    configPath: (context: ClientPathContext) =>
      join(copilotDirectory(context), "mcp-config.json"),
    markerPath: copilotDirectory,
    format: "copilot_cli",
  }),
  defineClient({
    name: "commandcode",
    registrationConnection: { kind: "commandcode" },
    displayName: "Command Code",
    configPath: (context: ClientPathContext) =>
      join(commandCodeDirectory(context), "mcp.json"),
    markerPath: commandCodeDirectory,
    format: "commandcode",
  }),
  defineClient({
    name: "qwen_code",
    registrationConnection: {
      kind: "flat",
      fields: ["type", "httpUrl", "url"],
      stdio: [
        { kind: "truthy", field: "httpUrl" },
        { kind: "truthy", field: "url" },
        { kind: "equals", field: "type", value: "sdk" },
      ],
    },
    displayName: "Qwen Code",
    configPath: (context: ClientPathContext) =>
      join(qwenCodeDirectory(context), "settings.json"),
    markerPath: qwenCodeDirectory,
    format: "json",
  }),
  defineClient({
    name: "kimi",
    mcpAdd: { aliases: ["kimi"], projectPaths: [".kimi-code/mcp.json"] },
    registrationConnection: {
      kind: "flat",
      fields: ["type", "url", "transport"],
      stdio: [
        { kind: "optional-enum", field: "type", values: ["stdio"] },
        { kind: "optional-enum", field: "transport", values: ["stdio"] },
        { kind: "present", field: "url" },
      ],
    },
    displayName: "Kimi Code",
    configPath: (context: ClientPathContext) =>
      join(kimiDirectory(context), "mcp.json"),
    markerPath: kimiDirectory,
    format: "kimi",
  }),
  defineClient({
    name: "vscode",
    mcpAdd: { aliases: ["github-copilot"], projectPaths: [".vscode/mcp.json"] },
    registrationConnection: {
      kind: "flat",
      fields: ["url", "transport"],
      stdio: [
        { kind: "required-enum", field: "type", values: ["stdio"] },
        { kind: "optional-enum", field: "transport", values: ["stdio"] },
        { kind: "present", field: "url" },
      ],
    },
    displayName: "VS Code",
    configPath: (context: ClientPathContext) =>
      join(vscodeUserDirectory(context), "mcp.json"),
    markerPath: vscodeUserDirectory,
    format: "vscode",
  }),
  defineClient({
    name: "trae",
    registrationConnection: {
      kind: "flat",
      fields: ["url"],
      stdio: [{ kind: "present", field: "url" }],
    },
    displayName: "Trae",
    skillPath: [".trae", "skills"],
    configPath: (context: ClientPathContext) =>
      join(traeUserDirectory(context), "mcp.json"),
    markerPath: traeUserDirectory,
    format: "json",
  }),
  defineClient({
    name: "workbuddy",
    registrationConnection: { kind: "stdio-only", documentedFields: ["env"] },
    displayName: "WorkBuddy",
    skillPath: [".workbuddy", "skills"],
    configPath: [".workbuddy", "mcp.json"],
    markerPath: [".workbuddy"],
    format: "json",
  }),
  defineClient({
    name: "lm_studio",
    registrationConnection: {
      kind: "flat",
      fields: ["url"],
      stdio: [{ kind: "present", field: "url" }],
    },
    displayName: "LM Studio",
    location: lmStudioLocation,
    format: "lm_studio",
  }),
  defineClient({
    name: "grok_build",
    mcpAdd: { aliases: ["grok"], projectPaths: [".grok/config.toml"] },
    registrationConnection: {
      kind: "flat",
      fields: ["url"],
      stdio: [{ kind: "non-nullish", field: "url" }],
    },
    displayName: "Grok Build",
    configPath: (context: ClientPathContext) =>
      join(grokDirectory(context), "config.toml"),
    markerPath: grokDirectory,
    format: "grok",
  }),
  defineClient({
    name: "omp",
    registrationConnection: {
      kind: "flat",
      fields: ["url"],
      stdio: [{ kind: "optional-enum", field: "type", values: ["stdio"] }],
    },
    displayName: "OMP",
    configPath: (context: ClientPathContext) => {
      const directory = ompAgentDirectory(context);
      return directory.ok ? ok(join(directory.value, "mcp.json")) : directory;
    },
    markerPath: ompAgentDirectory,
    format: "omp",
  }),
  defineClient({
    name: "pi",
    mcpAdd: { aliases: ["pi-agent"], projectPaths: [".pi/mcp.json"] },
    registrationConnection: {
      kind: "flat",
      fields: ["url"],
      stdio: [
        { kind: "optional-enum", field: "type", values: ["stdio"] },
        {
          kind: "all",
          conditions: [
            { kind: "missing", field: "type" },
            { kind: "string", field: "url" },
          ],
        },
      ],
    },
    displayName: "Pi",
    configPath: (context: ClientPathContext) =>
      (context.platform === "win32" ? win32 : { join }).join(
        piAgentDirectory(context),
        "mcp.json",
      ),
    markerPath: piAgentDirectory,
    piSettings: piProjectSettings,
    format: "pi",
  }),
  defineClient({
    name: "hermes",
    mcpAdd: { aliases: ["hermes-agent"] },
    registrationConnection: {
      kind: "flat",
      fields: ["url", "transport"],
      stdio: [
        { kind: "optional-enum", field: "transport", values: ["stdio"] },
        { kind: "present", field: "url" },
      ],
    },
    displayName: "Hermes",
    skillPath: (context: ClientPathContext) =>
      appendCallerPath(hermesDirectory(context), "skills"),
    configPath: (context: ClientPathContext) =>
      appendCallerPath(hermesDirectory(context), "config.yaml"),
    markerPath: hermesDirectory,
    format: "hermes",
  }),
  defineClient({
    name: "qoder",
    registrationConnection: {
      kind: "flat",
      fields: ["type", "url", "qoder_url", "tcp"],
      stdio: [
        { kind: "optional-enum", field: "type", values: ["stdio"] },
        { kind: "present", field: "url" },
        { kind: "present", field: "qoder_url" },
        { kind: "present", field: "tcp" },
      ],
    },
    displayName: "Qoder",
    skillPath: (context: ClientPathContext) =>
      join(qoderDirectory(context), "skills"),
    configPath: (context: ClientPathContext) =>
      join(qoderDirectory(context), "settings.json"),
    markerPath: qoderDirectory,
    format: "json",
  }),
  defineClient({
    name: "droid",
    mcpAdd: {
      aliases: ["droid", "factory"],
      projectPaths: [".factory/mcp.json"],
    },
    registrationConnection: {
      kind: "flat",
      fields: ["type", "url"],
      stdio: [
        { kind: "optional-enum", field: "type", values: ["stdio"] },
        { kind: "present", field: "url" },
      ],
    },
    displayName: "Factory Droid",
    skillPath: (context: ClientPathContext) =>
      join(factoryDirectory(context), "skills"),
    configPath: (context: ClientPathContext) =>
      join(factoryDirectory(context), "mcp.json"),
    markerPath: factoryDirectory,
    format: "json",
  }),
  defineClient({
    name: "zcode",
    registrationConnection: {
      kind: "flat",
      fields: ["type", "url"],
      stdio: [
        { kind: "optional-enum", field: "type", values: ["stdio"] },
        { kind: "present", field: "url" },
      ],
    },
    zcodeFallbackPath: ({ home }: ClientPathContext) =>
      join(home, ".agents", "mcp.json"),
    displayName: "ZCode",
    configPath: [".zcode", "cli", "config.json"],
    markerPath: [".zcode", "cli"],
    skillPath: [".zcode", "skills"],
    discoveryPaths: ({ home }: ClientPathContext) => [
      join(home, ".zcode", "cli"),
    ],
    format: "zcode",
  }),
  defineClient({
    name: "dsh",
    registrationConnection: {
      kind: "flat",
      fields: ["url"],
      stdio: [{ kind: "required-enum", field: "transport", values: ["stdio"] }],
    },
    displayName: "DeepSeek Harness",
    // The home Cordis patch applies to every profile; the skill directory is
    // shared agent storage Harness discovers.
    skillPath: ({ home, env }: ClientPathContext) =>
      join(dshDirectory(home, env.DSH_AGENTS_HOME, ".agents"), "skills"),
    configPath: dshPatchDirectory,
    markerPath: dshHomeDirectory,
    format: "dsh",
  }),
  defineClient({
    name: "freebuff",
    registrationConnection: {
      kind: "flat",
      fields: ["type", "url"],
      stdio: [
        { kind: "optional-enum", field: "type", values: ["stdio"] },
        { kind: "present", field: "url" },
      ],
    },
    displayName: "FreeBuff",
    // FreeBuff discovers personal skills in the shared user agents directory.
    skillPath: ({ home }: ClientPathContext) => join(home, ".agents", "skills"),
    // FreeBuff loads MCP servers from the shared user agents directory.
    configPath: ({ home }: ClientPathContext) =>
      join(home, ".agents", "mcp.json"),
    markerPath: freebuffProfileDirectory,
    discoveryPaths: (context: ClientPathContext) => [
      freebuffProfileDirectory(context),
    ],
    // The same file doubles as ZCode's user-scope fallback, so its presence
    // proves neither product is installed; see clientOwnershipEvidencePaths.
    sharedRegistration: true,
    format: "json",
  }),
  defineClient({
    name: "cline_vscode",
    mcpAdd: { aliases: ["cline-vscode"] },
    registrationConnection: { kind: "cline" },
    displayName: "Cline VS Code extension",
    configPath: (context: ClientPathContext) =>
      join(clineVscodeSettingsDirectory(context), "cline_mcp_settings.json"),
    markerPath: clineVscodeSettingsDirectory,
    format: "json",
  }),
  defineClient({
    name: "cline_vscode_insiders",
    registrationConnection: { kind: "cline" },
    displayName: "Cline in VS Code Insiders",
    configPath: (context: ClientPathContext) =>
      join(
        clineSettingsDirectory("Code - Insiders")(context),
        "cline_mcp_settings.json",
      ),
    markerPath: clineSettingsDirectory("Code - Insiders"),
    format: "json",
  }),
  defineClient({
    name: "cline_vscodium",
    registrationConnection: { kind: "cline" },
    displayName: "Cline in VSCodium",
    configPath: (context: ClientPathContext) =>
      join(
        clineSettingsDirectory("VSCodium")(context),
        "cline_mcp_settings.json",
      ),
    markerPath: clineSettingsDirectory("VSCodium"),
    format: "json",
  }),
  defineClient({
    name: "cline_cursor",
    registrationConnection: { kind: "cline" },
    displayName: "Cline in Cursor",
    configPath: (context: ClientPathContext) =>
      join(
        clineSettingsDirectory("Cursor")(context),
        "cline_mcp_settings.json",
      ),
    markerPath: clineSettingsDirectory("Cursor"),
    format: "json",
  }),
  defineClient({
    name: "cline_windsurf",
    registrationConnection: { kind: "cline" },
    displayName: "Cline in Windsurf",
    configPath: (context: ClientPathContext) =>
      join(
        clineSettingsDirectory("Windsurf")(context),
        "cline_mcp_settings.json",
      ),
    markerPath: clineSettingsDirectory("Windsurf"),
    format: "json",
  }),
  defineClient({
    name: "kiro",
    mcpAdd: { aliases: ["kiro"], projectPaths: [".kiro/settings/mcp.json"] },
    registrationConnection: {
      kind: "flat",
      fields: ["type", "url"],
      stdio: [
        { kind: "optional-enum", field: "type", values: ["stdio"] },
        { kind: "present", field: "url" },
      ],
    },
    // The IDE, CLI and web clients share the user file.
    displayName: "Kiro",
    configPath: [".kiro", "settings", "mcp.json"],
    markerPath: [".kiro"],
    format: "json",
  }),
  defineClient({
    name: "mastracode",
    mcpAdd: { aliases: ["mastra"], projectPaths: [".mastracode/mcp.json"] },
    registrationConnection: {
      kind: "flat",
      fields: ["url"],
      stdio: [{ kind: "string", field: "url" }],
    },
    displayName: "Mastra Code",
    configPath: [".mastracode", "mcp.json"],
    markerPath: [".mastracode"],
    format: "json",
  }),
  defineClient({
    name: "zed",
    mcpAdd: { projectPaths: [".zed/settings.json"] },
    registrationConnection: {
      kind: "flat",
      fields: ["url"],
      stdio: [{ kind: "present", field: "url" }],
    },
    displayName: "Zed",
    location: zedLocation,
    format: "zed",
  }),
  defineClient({
    name: "amp",
    mcpAdd: {},
    registrationConnection: {
      kind: "flat",
      fields: ["url"],
      stdio: [{ kind: "present", field: "url" }],
    },
    displayName: "Amp",
    location: ampLocation,
    format: "amp",
  }),
  defineClient({
    name: "mcporter",
    mcpAdd: { projectPaths: ["config/mcporter.json"] },
    registrationConnection: {
      kind: "flat",
      fields: [...MCPORTER_URL_FIELDS, "executable"],
      stdio: MCPORTER_STDIO_INCOMPATIBILITIES,
    },
    displayName: "MCPorter",
    location: mcporterLocation,
    // MCPorter imports setup-managed clients' registrations by default, so a
    // registration of its own is opt-in.
    registrationApplicability: true,
    format: "json",
  }),
  defineClient({
    name: "fx",
    mcpAdd: {},
    registrationConnection: {
      kind: "flat",
      fields: ["url", "args"],
      stdio: [
        { kind: "optional-enum", field: "type", values: ["local", "stdio"] },
        {
          kind: "all",
          conditions: [
            { kind: "missing", field: "type" },
            { kind: "present", field: "url" },
          ],
        },
      ],
    },
    displayName: "fx",
    location: fxLocation,
    privateProfile: true,
    format: "fx",
  }),
  defineClient({
    name: "junie",
    mcpAdd: { projectPaths: [".junie/mcp/mcp.json"] },
    registrationConnection: {
      kind: "flat",
      fields: ["url"],
      stdio: [{ kind: "present", field: "url" }],
    },
    displayName: "Junie",
    location: junieLocation,
    junieSettings: (context: ClientPathContext, { markerPath }) => ({
      userConfigPath: join(markerPath, "config.json"),
      ...(context.env.JUNIE_MCP_DEFAULT_LOCATIONS === undefined
        ? {}
        : { mcpDefaultLocations: context.env.JUNIE_MCP_DEFAULT_LOCATIONS }),
      ...(context.env.JUNIE_CONFIG_LOCATION === undefined
        ? {}
        : { configLocation: context.env.JUNIE_CONFIG_LOCATION }),
      ...(context.env.JUNIE_CONFIG_DEFAULT_LOCATIONS === undefined
        ? {}
        : {
            configDefaultLocations: context.env.JUNIE_CONFIG_DEFAULT_LOCATIONS,
          }),
    }),
    format: "json",
  }),
  defineClient({
    name: "goose",
    mcpAdd: {},
    registrationConnection: {
      kind: "flat",
      fields: ["uri"],
      stdio: [{ kind: "required-enum", field: "type", values: ["stdio"] }],
    },
    displayName: "Goose",
    location: gooseLocation,
    configPaths: gooseConfigPaths,
    readOnlyLowerLayers: true,
    format: "goose",
  }),
  defineClient({
    name: "kilo",
    registrationConnection: {
      kind: "flat",
      fields: ["url"],
      stdio: [{ kind: "required-enum", field: "type", values: ["local"] }],
    },
    displayName: "Kilo Code",
    mcpAdd: {
      aliases: ["kilo", "kilocode"],
      projectLocation: kiloProjectLocation,
    },
    location: kiloLocation,
    configPaths: kiloCandidatePaths,
    discoveryPaths: kiloDiscoveryPaths,
    layeredLocation: kiloLayeredLocation,
    format: "kilo",
  }),
  defineClient({
    name: "grok_bot",
    registrationConnection: {
      kind: "unavailable",
      reason:
        "Grok Bot has no supported configuration writer. Configure its MCP connection manually.",
    },
    displayName: "Grok Bot",
    configPath: grokBotDirectory,
    markerPath: grokBotDirectory,
    format: "unsupported",
  }),
] as const satisfies readonly ClientDefinition[];

export type SupportedClientName =
  (typeof SUPPORTED_CLIENT_DEFINITIONS)[number]["name"];

/** One client's row, for selection surfaces such as `rea mcp add` that project it. */
export const supportedClientDefinition = (
  name: SupportedClientName,
): Pick<
  ClientDefinition,
  "name" | "displayName" | "format" | "registrationProfile" | "mcpAdd"
> => {
  const definitions: readonly ClientDefinition[] = SUPPORTED_CLIENT_DEFINITIONS;
  const definition = definitions.find((candidate) => candidate.name === name);
  if (definition === undefined)
    throw new Error(`No supported client definition for ${name}`);
  return definition;
};

/**
 * Paths whose presence means the product itself is applicable, so doctor and
 * setup should inspect the client. Layered sources count: OpenCode still loads
 * its XDG files when a custom directory override does not exist. Shared
 * registration storage never establishes applicability; see
 * {@link clientOwnershipEvidencePaths}.
 */
export const clientEvidencePaths = (
  client: Pick<
    SetupClient,
    "configPath" | "configPaths" | "markerPath" | "discoveryPaths"
  >,
): readonly string[] => [
  ...new Set(
    (
      client.discoveryPaths ?? [
        client.configPath,
        ...(client.configPaths ?? []),
        client.markerPath,
      ]
    ).filter((path): path is string => path !== undefined && path.length > 0),
  ),
];

/**
 * Paths where a recognizable REA-owned row proves ownership of a registration
 * REA wrote, never that the product is installed: shared storage is created by
 * other products and by REA's own skill installs. A client whose registration
 * is product-local declares no shared storage, so this stays empty for it.
 */
export const clientOwnershipEvidencePaths = (
  client: Pick<
    SetupClient,
    "configPath" | "configPaths" | "sharedRegistration"
  >,
): readonly string[] =>
  client.sharedRegistration === true
    ? [client.configPath, ...(client.configPaths ?? [])].filter(
        (path): path is string => path !== undefined && path.length > 0,
      )
    : [];

/**
 * Registration storage this client shares with another product: its own shared
 * configuration plus any same-scope fallback another client also loads. Only
 * this storage may be retained when product applicability is unproven, because
 * failing closed on it would block REA removals for files REA does not own.
 * Product-local configuration is REA's own boundary and stays fail-closed.
 */
export const clientSharedRegistrationPaths = (
  client: Pick<
    SetupClient,
    "configPath" | "configPaths" | "sharedRegistration" | "zcodeFallbackPath"
  >,
): ReadonlySet<string> =>
  new Set([
    ...clientOwnershipEvidencePaths(client),
    ...(client.zcodeFallbackPath === undefined
      ? []
      : [client.zcodeFallbackPath]),
  ]);

const resolvePath = (
  path: ClientPath,
  context: ClientPathContext,
): ClientPathResult => {
  const resolved =
    typeof path === "function" ? path(context) : join(context.home, ...path);
  return typeof resolved === "string" ? ok(resolved) : resolved;
};

const resolveLocation = (
  definition: ClientDefinition,
  context: ClientPathContext,
): Result<ClientLocation, ClientPathFailure> => {
  if (definition.location !== undefined) return definition.location(context);
  const config = resolvePath(definition.configPath, context);
  if (!config.ok) return config;
  const marker = resolvePath(definition.markerPath, context);
  return marker.ok
    ? ok({ configPath: config.value, markerPath: marker.value })
    : marker;
};

/**
 * Layers in increasing precedence, ending with the writable file unless the
 * row already places it. A file loaded more than once takes effect at its last
 * load, so only that occurrence is kept.
 */
const layerLoadOrder = (
  paths: readonly string[],
  configPath: string,
): readonly string[] => {
  const ordered = paths.includes(configPath) ? paths : [...paths, configPath];
  return ordered.filter((path, index) => ordered.lastIndexOf(path) === index);
};

/** Describe every client location that setup, doctor, or uninstall may inspect. */
export const supportedClients = (
  home: string,
  platform: NodeJS.Platform,
  env: ClientPathContext["env"] = process.env,
  systemPaths: ClientSystemPaths = {},
  only?: SupportedClientName,
): readonly SetupClient[] => {
  const context = { home, platform, env, systemPaths };
  const definitions: readonly ClientDefinition[] = SUPPORTED_CLIENT_DEFINITIONS;
  const selected =
    only === undefined
      ? definitions
      : definitions.filter(({ name }) => name === only);
  return selected.map((definition) => {
    try {
      const location = resolveLocation(definition, context);
      if (!location.ok)
        return {
          name: definition.name,
          registrationProfile: definition.registrationProfile,
          displayName: definition.displayName,
          format: definition.format,
          configPath: location.error.path,
          configPathError: location.error.message,
          ...(location.error.msixPackage === undefined
            ? {}
            : { msixPackage: location.error.msixPackage }),
        };
      const { configPath, markerPath, msixPackage } = location.value;
      const userOverridePaths =
        definition.format === "opencode"
          ? openCodeUserOverridePaths(context)
          : [];
      return {
        name: definition.name,
        registrationProfile: definition.registrationProfile,
        displayName: definition.displayName,
        configPath,
        ...(userOverridePaths.length === 0
          ? {}
          : { openCodeUserOverridePaths: userOverridePaths }),
        ...(definition.geminiSettings === undefined
          ? {}
          : { geminiSettings: definition.geminiSettings(context) }),
        ...(definition.piSettings === undefined
          ? {}
          : { piSettings: definition.piSettings(context) }),
        ...(definition.junieSettings === undefined
          ? {}
          : {
              junieSettings: definition.junieSettings(context, location.value),
            }),
        ...(definition.configPaths === undefined
          ? {}
          : {
              configPaths: layerLoadOrder(
                definition.configPaths(context),
                configPath,
              ),
            }),
        ...(definition.zcodeFallbackPath === undefined
          ? {}
          : { zcodeFallbackPath: definition.zcodeFallbackPath(context) }),
        markerPath,
        ...(msixPackage === undefined ? {} : { msixPackage }),
        ...(definition.quitBeforeSetup === true
          ? { quitBeforeSetup: true }
          : {}),
        ...(definition.discoveryPaths === undefined
          ? {}
          : { discoveryPaths: definition.discoveryPaths(context) }),
        ...(definition.privateProfile === true
          ? { privateProfile: { home } }
          : {}),
        ...(definition.readOnlyLowerLayers === true
          ? { readOnlyLowerLayers: true }
          : {}),
        ...(definition.registrationApplicability === true
          ? { registrationApplicability: true }
          : {}),
        ...(definition.sharedRegistration === true
          ? { sharedRegistration: true }
          : {}),
        format: definition.format,
      };
    } catch (cause: unknown) {
      if (cause instanceof HermesClientPathError)
        return {
          name: definition.name,
          registrationProfile: definition.registrationProfile,
          displayName: definition.displayName,
          format: definition.format,
          configPath: cause.path,
          configPathError: cause.message,
        };
      if (definition.name !== "pi") throw cause;
      return {
        name: definition.name,
        registrationProfile: definition.registrationProfile,
        displayName: definition.displayName,
        format: definition.format,
        configPath: env.PI_CODING_AGENT_DIR ?? "",
        configPathError: `Invalid PI_CODING_AGENT_DIR: ${errorMessage(cause)}. Repair the override before configuring Pi.`,
      };
    }
  });
};

/**
 * The client table with each layered location resolved: the rows setup,
 * doctor, update and uninstall act on.
 */
export const resolveSupportedClients = async (
  home: string,
  platform: NodeJS.Platform,
  env: ClientPathContext["env"] = process.env,
  systemPaths: ClientSystemPaths = {},
): Promise<readonly SetupClient[]> => {
  const context = { home, platform, env, systemPaths };
  const definitions: readonly ClientDefinition[] = SUPPORTED_CLIENT_DEFINITIONS;
  const rows = supportedClients(home, platform, env, systemPaths);
  return Promise.all(
    rows.map(async (row) => {
      const resolve = definitions.find(
        ({ name }) => name === row.name,
      )?.layeredLocation;
      if (resolve === undefined || row.configPathError !== undefined)
        return row;
      const location = await resolve(context);
      return location.ok
        ? { ...row, ...location.value }
        : {
            ...row,
            configPath: location.error.path,
            configPathError: location.error.message,
            ...(location.error.failure === undefined
              ? {}
              : { configPathFailure: location.error.failure }),
          };
    }),
  );
};

/** Resolved destinations and unresolved selections share one path-resolution owner. */
export const clientSkillDirectories = (
  home: string,
  clientIds: readonly string[] | undefined,
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): {
  readonly directories: readonly {
    readonly client: string;
    readonly directory: string;
  }[];
  readonly unresolved: readonly {
    readonly client: string;
    readonly path: string;
    readonly detail: string;
  }[];
} => {
  const unresolved: { client: string; path: string; detail: string }[] = [];
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
  const sharedDirectory = appendCallerPath(home, ".agents/skills", platform);
  const destinations = new Map<string, { client: string; directory: string }>();
  for (const client of selected) {
    const definition = definitions.find(({ name }) => name === client);
    if (definition === undefined && client !== "shared") {
      unresolved.push({
        client,
        path: client,
        detail: `Unsupported skill client: ${client}`,
      });
      continue;
    }
    let directory: string;
    try {
      const resolved =
        definition?.skillPath === undefined
          ? ok(sharedDirectory)
          : resolvePath(definition.skillPath, {
              home,
              platform,
              env: environment,
            });
      if (!resolved.ok) {
        unresolved.push({
          client,
          path: resolved.error.path,
          detail: resolved.error.message,
        });
        continue;
      }
      directory = resolved.value;
    } catch (cause: unknown) {
      if (cause instanceof HermesClientPathError) {
        unresolved.push({ client, path: cause.path, detail: cause.message });
        continue;
      }
      throw cause;
    }
    if (!destinations.has(directory))
      destinations.set(directory, {
        client: directory === sharedDirectory ? "shared" : client,
        directory,
      });
  }
  return {
    directories: [...destinations.values()].sort((left, right) =>
      compareUnicodeCodePoints(left.directory, right.directory),
    ),
    unresolved,
  };
};
