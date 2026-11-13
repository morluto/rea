import {
  kiloLocation,
  kiloProjectLocation,
} from "./McpRegistrationKiloLocations.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { dirname, join, win32 } from "node:path";

import { analysisErrorWithCancellation } from "../domain/analysisErrorCancellation.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import type { ClientConfigurationFormat } from "./ClientConfigurationDocument.js";
import {
  supportedClients,
  supportedClientRegistrationProfile,
} from "./SupportedClients.js";
import type {
  ClientRegistrationConnectionProfile,
  ClientRegistrationProfile,
  NativeStdioIncompatibility,
} from "./ClientRegistrationProfile.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import {
  bindRegularFileCleanup,
  readRegularFileText,
} from "./RegularFileRead.js";
import { clientConfigurationRecordSchema } from "./ClientConfigurationDocument.js";
import {
  selectedPath,
  fromSetup,
  present,
  fixedProjectLocation,
  clineLocation,
  clineCliLocation,
  fxLocation,
  gooseLocation,
  junieLocation,
  kiroLocation,
  mastraLocation,
  mcporterLocation,
  zedLocation,
  ampLocation,
  type McpRegistrationLocationContext,
  type McpRegistrationGlobalLocation,
  type McpRegistrationLocation,
  type McpRegistrationInlineConfiguration,
} from "./McpRegistrationLocations.js";

interface ClientDescriptorBase {
  readonly displayName: string;
  readonly format: ClientConfigurationFormat;
  readonly globalLocation: (
    context: McpRegistrationLocationContext,
  ) => Promise<McpRegistrationGlobalLocation>;
  readonly projectLocation?: (
    context: McpRegistrationLocationContext,
  ) => Promise<McpRegistrationLocation>;
  readonly projectFormat?: ClientConfigurationFormat;
}

type ClientDescriptor = ClientDescriptorBase &
  (
    | {
        readonly registrationProfile: ClientRegistrationProfile;
        readonly registrationConnection?: never;
      }
    | {
        readonly registrationConnection: ClientRegistrationConnectionProfile;
        readonly registrationProfile?: never;
      }
  );

/** mcporter getUrl's native nullish priority; an empty first value suppresses later aliases. */
const MCPORTER_URL_FIELDS = [
  "baseUrl",
  "base_url",
  "url",
  "serverUrl",
  "server_url",
] as const;
const MCPORTER_STDIO_INCOMPATIBILITIES: readonly NativeStdioIncompatibility[] =
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

/** Reviewed add-mcp 2.6.1 client contracts plus Incur's separate Amp contract. */
export const MCP_REGISTRATION_CLIENTS = {
  antigravity: {
    displayName: "Antigravity",
    format: "json",
    globalLocation: fromSetup("antigravity"),
    registrationProfile: supportedClientRegistrationProfile("antigravity"),
  },
  cline: {
    displayName: "Cline VSCode Extension",
    format: "json",
    globalLocation: clineLocation,
    registrationConnection: { kind: "cline" },
  },
  "cline-cli": {
    displayName: "Cline CLI",
    format: "json",
    globalLocation: clineCliLocation,
    registrationConnection: { kind: "cline" },
  },
  "claude-code": {
    displayName: "Claude Code",
    format: "claude_code",
    globalLocation: fromSetup("claude_code"),
    registrationProfile: supportedClientRegistrationProfile("claude_code"),
    projectLocation: fixedProjectLocation([".mcp.json"]),
  },
  "claude-desktop": {
    displayName: "Claude Desktop",
    format: "json",
    globalLocation: fromSetup("claude_desktop"),
    registrationProfile: supportedClientRegistrationProfile("claude_desktop"),
  },
  codex: {
    displayName: "Codex",
    format: "toml",
    globalLocation: fromSetup("codex"),
    registrationProfile: supportedClientRegistrationProfile("codex"),
    projectLocation: fixedProjectLocation([".codex/config.toml"]),
  },
  cursor: {
    displayName: "Cursor",
    format: "json",
    globalLocation: fromSetup("cursor"),
    registrationProfile: supportedClientRegistrationProfile("cursor"),
    projectLocation: fixedProjectLocation([".cursor/mcp.json"]),
  },
  "factory-droid": {
    displayName: "Factory Droid",
    format: "json",
    globalLocation: fromSetup("droid"),
    registrationProfile: supportedClientRegistrationProfile("droid"),
    projectLocation: fixedProjectLocation([".factory/mcp.json"]),
  },
  fx: {
    displayName: "fx",
    format: "fx",
    globalLocation: fxLocation,
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
  },
  "gemini-cli": {
    displayName: "Gemini CLI",
    format: "json",
    globalLocation: fromSetup("gemini_cli"),
    registrationProfile: supportedClientRegistrationProfile("gemini_cli"),
    projectLocation: fixedProjectLocation([".gemini/settings.json"]),
  },
  goose: {
    displayName: "Goose",
    format: "goose",
    globalLocation: gooseLocation,
    registrationConnection: {
      kind: "flat",
      fields: ["uri"],
      stdio: [{ kind: "required-enum", field: "type", values: ["stdio"] }],
    },
  },
  "github-copilot-cli": {
    displayName: "GitHub Copilot CLI",
    format: "copilot_cli",
    globalLocation: fromSetup("copilot_cli"),
    registrationProfile: supportedClientRegistrationProfile("copilot_cli"),
    projectLocation: fixedProjectLocation([".mcp.json", ".github/mcp.json"]),
    projectFormat: "copilot_cli_project",
  },
  "grok-build": {
    displayName: "Grok Build",
    format: "grok",
    globalLocation: fromSetup("grok_build"),
    registrationProfile: supportedClientRegistrationProfile("grok_build"),
    projectLocation: fixedProjectLocation([".grok/config.toml"]),
  },
  hermes: {
    displayName: "Hermes Agent",
    format: "hermes",
    globalLocation: fromSetup("hermes"),
    registrationProfile: supportedClientRegistrationProfile("hermes"),
  },
  junie: {
    displayName: "Junie",
    format: "json",
    globalLocation: junieLocation,
    projectLocation: fixedProjectLocation([".junie/mcp/mcp.json"]),
    registrationConnection: {
      kind: "flat",
      fields: ["url"],
      stdio: [{ kind: "present", field: "url" }],
    },
  },
  "kilo-code": {
    displayName: "Kilo Code",
    format: "kilo",
    globalLocation: kiloLocation,
    projectLocation: kiloProjectLocation,
    registrationConnection: {
      kind: "flat",
      fields: ["url"],
      stdio: [{ kind: "required-enum", field: "type", values: ["local"] }],
    },
  },
  "kimi-code": {
    displayName: "Kimi Code",
    format: "kimi",
    globalLocation: fromSetup("kimi"),
    registrationProfile: supportedClientRegistrationProfile("kimi"),
    projectLocation: fixedProjectLocation([".kimi-code/mcp.json"]),
  },
  "kiro-cli": {
    displayName: "Kiro CLI",
    format: "json",
    globalLocation: kiroLocation,
    projectLocation: fixedProjectLocation([".kiro/settings/mcp.json"]),
    registrationConnection: {
      kind: "flat",
      fields: ["type", "url"],
      stdio: [
        { kind: "optional-enum", field: "type", values: ["stdio"] },
        { kind: "present", field: "url" },
      ],
    },
  },
  mastracode: {
    displayName: "Mastra Code",
    format: "json",
    globalLocation: mastraLocation,
    projectLocation: fixedProjectLocation([".mastracode/mcp.json"]),
    registrationConnection: {
      kind: "flat",
      fields: ["url"],
      stdio: [{ kind: "string", field: "url" }],
    },
  },
  mcporter: {
    displayName: "MCPorter",
    format: "json",
    globalLocation: mcporterLocation,
    projectLocation: fixedProjectLocation(["config/mcporter.json"]),
    registrationConnection: {
      kind: "flat",
      fields: [...MCPORTER_URL_FIELDS, "executable"],
      stdio: MCPORTER_STDIO_INCOMPATIBILITIES,
    },
  },
  opencode: {
    displayName: "OpenCode",
    format: "opencode",
    globalLocation: fromSetup("opencode"),
    registrationProfile: supportedClientRegistrationProfile("opencode"),
    projectLocation: fixedProjectLocation([
      "opencode.jsonc",
      "opencode.json",
      ".opencode/opencode.jsonc",
      ".opencode/opencode.json",
    ]),
  },
  pi: {
    displayName: "Pi",
    format: "pi",
    globalLocation: fromSetup("pi"),
    registrationProfile: supportedClientRegistrationProfile("pi"),
    projectLocation: fixedProjectLocation([".pi/mcp.json"]),
  },
  vscode: {
    displayName: "VS Code",
    format: "vscode",
    globalLocation: fromSetup("vscode"),
    registrationProfile: supportedClientRegistrationProfile("vscode"),
    projectLocation: fixedProjectLocation([".vscode/mcp.json"]),
  },
  windsurf: {
    displayName: "Windsurf",
    format: "json",
    globalLocation: fromSetup("windsurf"),
    registrationProfile: supportedClientRegistrationProfile("windsurf"),
  },
  zed: {
    displayName: "Zed",
    format: "zed",
    globalLocation: zedLocation,
    projectLocation: fixedProjectLocation([".zed/settings.json"]),
    registrationConnection: {
      kind: "flat",
      fields: ["url"],
      stdio: [{ kind: "present", field: "url" }],
    },
  },
  amp: {
    displayName: "Amp",
    format: "amp",
    globalLocation: ampLocation,
    registrationConnection: {
      kind: "flat",
      fields: ["url"],
      stdio: [{ kind: "present", field: "url" }],
    },
  },
} as const satisfies Record<string, ClientDescriptor>;

export type McpRegistrationClientId = keyof typeof MCP_REGISTRATION_CLIENTS;

const ALIASES = {
  "cline-vscode": "cline",
  codeium: "windsurf",
  cascade: "windsurf",
  droid: "factory-droid",
  factory: "factory-droid",
  gemini: "gemini-cli",
  "github-copilot": "vscode",
  grok: "grok-build",
  "hermes-agent": "hermes",
  kilo: "kilo-code",
  kilocode: "kilo-code",
  kimi: "kimi-code",
  kiro: "kiro-cli",
  mastra: "mastracode",
  "pi-agent": "pi",
} as const satisfies Record<string, McpRegistrationClientId>;

const isClientId = (value: string): value is McpRegistrationClientId =>
  Object.hasOwn(MCP_REGISTRATION_CLIENTS, value);

const resolveMcpRegistrationClientId = (
  input: string,
): McpRegistrationClientId | undefined => {
  const lower = input.toLowerCase();
  if (isClientId(lower)) return lower;
  return Object.entries(ALIASES).find(([alias]) => alias === lower)?.[1];
};

export interface McpRegistrationClient {
  readonly registrationProfile: ClientRegistrationProfile;
  readonly id: McpRegistrationClientId;
  readonly displayName: string;
  readonly configPath: string;
  /** Complete known file layers in native precedence; configPath alone grants write authority. */
  readonly configPaths?: readonly string[];
  readonly inlineConfiguration?: McpRegistrationInlineConfiguration;
  readonly scope: "global" | "project";
  readonly format: ClientConfigurationFormat;
  readonly privateProfile?: true;
}

export interface McpRegistrationSelection {
  readonly agents: readonly string[];
  readonly global: boolean;
  readonly cwd: string;
  readonly home: string;
  readonly platform: NodeJS.Platform;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly signal?: AbortSignal;
}

type CatalogFailure = ConfigurationError | AnalysisCancelledError;
const checkCancellation = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted)
    throw new AnalysisCancelledError("MCP registration selection", {
      cause: signal.reason,
    });
};

const selectedIds = (agents: readonly string[]): McpRegistrationClientId[] => {
  const ids: McpRegistrationClientId[] = [];
  for (const agent of agents) {
    const id = resolveMcpRegistrationClientId(agent);
    if (id === undefined)
      throw new ConfigurationError(
        `Unknown MCP client ${agent}. Select a supported --agent value.`,
      );
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
};

/** Existing setup bindings retain their exact profile; additional clients bind the descriptor key. */
export const mcpClientRegistrationProfile = (
  id: McpRegistrationClientId,
): ClientRegistrationProfile => {
  const descriptor: ClientDescriptor = MCP_REGISTRATION_CLIENTS[id];
  return (
    descriptor.registrationProfile ?? {
      nativeClient: id,
      connection: descriptor.registrationConnection,
    }
  );
};

const projectTarget = async (
  id: McpRegistrationClientId,
  context: McpRegistrationLocationContext,
): Promise<McpRegistrationClient> => {
  const descriptor: ClientDescriptor = MCP_REGISTRATION_CLIENTS[id];
  if (descriptor.projectLocation === undefined)
    throw new ConfigurationError(
      `${descriptor.displayName} has no project-scoped registration. Remove --no-global or select a project-capable client; no settings were written.`,
    );
  const resolved = await descriptor.projectLocation(context);
  return {
    id,
    displayName: descriptor.displayName,
    registrationProfile: mcpClientRegistrationProfile(id),
    ...resolved,
    scope: "project",
    format: descriptor.projectFormat ?? descriptor.format,
  };
};

const globalTarget = async (
  id: McpRegistrationClientId,
  context: McpRegistrationLocationContext,
): Promise<{ client: McpRegistrationClient; markers: readonly string[] }> => {
  const descriptor: ClientDescriptor = MCP_REGISTRATION_CLIENTS[id];
  const resolved = await descriptor.globalLocation(context);
  return {
    client: {
      id,
      displayName: descriptor.displayName,
      registrationProfile: mcpClientRegistrationProfile(id),
      configPath: selectedPath(resolved.configPath, context),
      ...(resolved.configPaths === undefined
        ? {}
        : {
            configPaths: resolved.configPaths.map((path) =>
              selectedPath(path, context),
            ),
          }),
      scope: "global",
      format: descriptor.format,
      ...(resolved.inlineConfiguration === undefined
        ? {}
        : { inlineConfiguration: resolved.inlineConfiguration }),
      ...(id === "fx" ? { privateProfile: true } : {}),
    },
    markers: resolved.markers.map((marker) => selectedPath(marker, context)),
  };
};

const validateJunieGlobal = async (
  client: McpRegistrationClient,
  context: McpRegistrationLocationContext,
): Promise<void> => {
  const env = context.environment;
  if (env.JUNIE_MCP_DEFAULT_LOCATIONS?.toLowerCase() === "false")
    throw new ConfigurationError(
      "Junie's default MCP locations are disabled by JUNIE_MCP_DEFAULT_LOCATIONS.",
    );
  if (env.JUNIE_CONFIG_LOCATION)
    throw new ConfigurationError(
      "Cannot determine Junie's MCP location selection while JUNIE_CONFIG_LOCATION is set. Inspect the additional Junie configuration before registering.",
    );
  if (env.JUNIE_CONFIG_DEFAULT_LOCATIONS?.toLowerCase() !== "false") {
    const paths = context.platform === "win32" ? win32 : { dirname, join };
    const configPath = selectedPath(
      paths.join(
        paths.dirname(paths.dirname(client.configPath)),
        "config.json",
      ),
      context,
    );
    let content: string | undefined;
    try {
      content = await readRegularFileText(configPath, {
        resources: context.resources,
        signal: context.signal,
      });
    } catch (cause: unknown) {
      if (
        !(cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      ) {
        const failure = new ConfigurationError(
          "Cannot inspect Junie's user configuration to determine its MCP locations.",
          { cause },
        );
        bindRegularFileCleanup(cause, failure);
        throw failure;
      }
    }
    if (content !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch (cause: unknown) {
        throw new ConfigurationError(
          "Cannot parse Junie's user configuration to determine its MCP locations.",
          { cause },
        );
      }
      const record = clientConfigurationRecordSchema.safeParse(parsed);
      if (
        !record.success ||
        (record.data["mcp-default-locations"] !== undefined &&
          typeof record.data["mcp-default-locations"] !== "boolean")
      )
        throw new ConfigurationError(
          "Junie's user configuration does not establish whether default MCP locations are enabled.",
        );
      if (record.data["mcp-default-locations"] === false)
        throw new ConfigurationError(
          "Junie's user configuration disables its default MCP locations.",
        );
    }
  }
};

/** Resolve all selected paths before any registration writer receives authority. */
export const resolveMcpRegistrationClients = async (
  selection: McpRegistrationSelection,
  resources: ArtifactResourceScope,
): Promise<Result<readonly McpRegistrationClient[], CatalogFailure>> => {
  try {
    checkCancellation(selection.signal);
    const ids = selectedIds(selection.agents);
    const context: McpRegistrationLocationContext = {
      ...selection,
      resources,
      setup: selection.global
        ? supportedClients(
            selection.home,
            selection.platform,
            selection.environment,
          )
        : [],
    };
    // Default selection includes global-only Amp and cannot become project writes.
    if (!selection.global && ids.length === 0)
      throw new ConfigurationError(
        "Default MCP registration includes global-only Amp. Select project-capable --agent values or remove --no-global; no settings were written.",
      );
    if (ids.length > 0) {
      const clients: McpRegistrationClient[] = [];
      for (const id of ids) {
        checkCancellation(selection.signal);
        clients.push(
          selection.global
            ? (await globalTarget(id, context)).client
            : await projectTarget(id, context),
        );
      }
      if (selection.global) {
        const junie = clients.find((client) => client.id === "junie");
        if (junie) await validateJunieGlobal(junie, context);
      }
      checkCancellation(selection.signal);
      return ok(clients);
    }
    const all: McpRegistrationClient[] = [];
    const detected: McpRegistrationClient[] = [];
    for (const id of Object.keys(MCP_REGISTRATION_CLIENTS).filter(isClientId)) {
      checkCancellation(selection.signal);
      if (id === "amp") continue;
      const { client, markers } = await globalTarget(id, context);
      all.push(client);
      // Examine every marker: unreadability cannot turn a partial observation into absence.
      const statuses: boolean[] = [];
      for (const marker of markers) statuses.push(await present(marker));
      if (statuses.some(Boolean)) detected.push(client);
    }
    const amp = (await globalTarget("amp", context)).client;
    checkCancellation(selection.signal);
    const selected = [...(detected.length === 0 ? all : detected), amp];
    const junie = selected.find((client) => client.id === "junie");
    if (junie) await validateJunieGlobal(junie, context);
    return ok(selected);
  } catch (cause: unknown) {
    const failure =
      cause instanceof ConfigurationError ||
      cause instanceof AnalysisCancelledError
        ? cause
        : new ConfigurationError(
            "Could not resolve MCP registration locations.",
            {
              cause,
            },
          );
    if (selection.signal?.aborted === true)
      analysisErrorWithCancellation(
        failure,
        new AnalysisCancelledError("MCP registration selection", {
          cause: selection.signal.reason,
        }),
      );
    return err(failure);
  }
};
