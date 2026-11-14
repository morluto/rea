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
  appDataRedirection,
  registrationWriteBlocker,
  supportedClientDefinition,
  supportedClients,
  type SetupClient,
  type SupportedClientName,
} from "./SupportedClients.js";
import { redirectedWriteBlocker } from "./MsixPackageStorage.js";
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

/**
 * A client `rea mcp add` knows but the client table does not yet hold. Its
 * facts are declared here until it joins that table; every other client
 * projects its table row.
 */
interface RegistrationOnlyDescriptor {
  readonly kind: "registration-only";
  readonly displayName: string;
  readonly format: ClientConfigurationFormat;
  readonly aliases?: readonly string[];
  readonly globalLocation: (
    context: McpRegistrationLocationContext,
  ) => Promise<McpRegistrationGlobalLocation>;
  readonly projectLocation?: (
    context: McpRegistrationLocationContext,
  ) => Promise<McpRegistrationLocation>;
  readonly registrationConnection: ClientRegistrationConnectionProfile;
}

/** An add-mcp agent backed by one client-table row. */
interface TableClient {
  readonly kind: "client";
  readonly name: SupportedClientName;
}

const tableClient = <const Name extends SupportedClientName>(
  name: Name,
): TableClient & { readonly name: Name } => ({ kind: "client", name });

type CatalogEntry = TableClient | RegistrationOnlyDescriptor;

/** The facts registration needs, from the client's single owner. */
interface ClientDescriptor {
  readonly displayName: string;
  readonly format: ClientConfigurationFormat;
  readonly aliases: readonly string[];
  readonly globalLocation: (
    context: McpRegistrationLocationContext,
  ) => Promise<McpRegistrationGlobalLocation>;
  readonly projectLocation?: (
    context: McpRegistrationLocationContext,
  ) => Promise<McpRegistrationLocation>;
  readonly projectFormat?: ClientConfigurationFormat;
  readonly registrationProfile: ClientRegistrationProfile;
  readonly setupName?: SupportedClientName;
}

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

/**
 * Reviewed add-mcp 2.6.1 agent ids plus Incur's separate Amp contract, in
 * add-mcp's order. Table-backed agents carry only their row name; the row owns
 * the location, format, profile, aliases, project documents and read scope.
 */
export const MCP_REGISTRATION_CLIENTS = {
  antigravity: tableClient("antigravity"),
  cline: {
    kind: "registration-only",
    displayName: "Cline VSCode Extension",
    format: "json",
    aliases: ["cline-vscode"],
    globalLocation: clineLocation,
    registrationConnection: { kind: "cline" },
  },
  "cline-cli": tableClient("cline"),
  "claude-code": tableClient("claude_code"),
  "claude-desktop": tableClient("claude_desktop"),
  codex: tableClient("codex"),
  cursor: tableClient("cursor"),
  "factory-droid": tableClient("droid"),
  fx: {
    kind: "registration-only",
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
  "gemini-cli": tableClient("gemini_cli"),
  goose: {
    kind: "registration-only",
    displayName: "Goose",
    format: "goose",
    globalLocation: gooseLocation,
    registrationConnection: {
      kind: "flat",
      fields: ["uri"],
      stdio: [{ kind: "required-enum", field: "type", values: ["stdio"] }],
    },
  },
  "github-copilot-cli": tableClient("copilot_cli"),
  "grok-build": tableClient("grok_build"),
  hermes: tableClient("hermes"),
  junie: {
    kind: "registration-only",
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
    kind: "registration-only",
    displayName: "Kilo Code",
    format: "kilo",
    aliases: ["kilo", "kilocode"],
    globalLocation: kiloLocation,
    projectLocation: kiloProjectLocation,
    registrationConnection: {
      kind: "flat",
      fields: ["url"],
      stdio: [{ kind: "required-enum", field: "type", values: ["local"] }],
    },
  },
  "kimi-code": tableClient("kimi"),
  "kiro-cli": {
    kind: "registration-only",
    displayName: "Kiro CLI",
    format: "json",
    aliases: ["kiro"],
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
    kind: "registration-only",
    displayName: "Mastra Code",
    format: "json",
    aliases: ["mastra"],
    globalLocation: mastraLocation,
    projectLocation: fixedProjectLocation([".mastracode/mcp.json"]),
    registrationConnection: {
      kind: "flat",
      fields: ["url"],
      stdio: [{ kind: "string", field: "url" }],
    },
  },
  mcporter: {
    kind: "registration-only",
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
  opencode: tableClient("opencode"),
  pi: tableClient("pi"),
  vscode: tableClient("vscode"),
  windsurf: tableClient("windsurf"),
  zed: {
    kind: "registration-only",
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
    kind: "registration-only",
    displayName: "Amp",
    format: "amp",
    globalLocation: ampLocation,
    registrationConnection: {
      kind: "flat",
      fields: ["url"],
      stdio: [{ kind: "present", field: "url" }],
    },
  },
} as const satisfies Record<string, CatalogEntry>;

export type McpRegistrationClientId = keyof typeof MCP_REGISTRATION_CLIENTS;

const isClientId = (value: string): value is McpRegistrationClientId =>
  Object.hasOwn(MCP_REGISTRATION_CLIENTS, value);

/** Project one agent's facts from its owner: the table row, or its pending descriptor. */
const clientDescriptor = (id: McpRegistrationClientId): ClientDescriptor => {
  const entry: CatalogEntry = MCP_REGISTRATION_CLIENTS[id];
  if (entry.kind === "registration-only") {
    const { registrationConnection, ...facts } = entry;
    return {
      aliases: [],
      ...facts,
      // Pending clients bind their add-mcp id as the native identity.
      registrationProfile: {
        nativeClient: id,
        connection: registrationConnection,
      },
    };
  }
  const row = supportedClientDefinition(entry.name);
  if (row.format === "unsupported")
    throw new Error(`${row.name} has no registration format`);
  const projectPaths = row.mcpAdd?.projectPaths;
  return {
    displayName: row.displayName,
    format: row.format,
    aliases: row.mcpAdd?.aliases ?? [],
    globalLocation: fromSetup(entry.name),
    ...(projectPaths === undefined
      ? {}
      : { projectLocation: fixedProjectLocation(projectPaths) }),
    ...(row.mcpAdd?.projectFormat === undefined
      ? {}
      : { projectFormat: row.mcpAdd.projectFormat }),
    registrationProfile: row.registrationProfile,
    setupName: entry.name,
  };
};

const resolveMcpRegistrationClientId = (
  input: string,
): McpRegistrationClientId | undefined => {
  const lower = input.toLowerCase();
  if (isClientId(lower)) return lower;
  return Object.keys(MCP_REGISTRATION_CLIENTS)
    .filter(isClientId)
    .find((id) => clientDescriptor(id).aliases.includes(lower));
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
  /**
   * The table row resolved for this user-scope registration. Its read-scope
   * facts (Gemini settings policy, MSIX package storage) govern the write.
   */
  readonly setupClient?: SetupClient;
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

/** Table rows retain their exact profile; pending clients bind the descriptor key. */
export const mcpClientRegistrationProfile = (
  id: McpRegistrationClientId,
): ClientRegistrationProfile => clientDescriptor(id).registrationProfile;

const projectTarget = async (
  id: McpRegistrationClientId,
  context: McpRegistrationLocationContext,
): Promise<McpRegistrationClient> => {
  const descriptor = clientDescriptor(id);
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
  const descriptor = clientDescriptor(id);
  const resolved = await descriptor.globalLocation(context);
  const setupClient =
    descriptor.setupName === undefined
      ? undefined
      : context.setup.find(({ name }) => name === descriptor.setupName);
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
      ...(setupClient === undefined ? {} : { setupClient }),
    },
    markers: resolved.markers.map((marker) => selectedPath(marker, context)),
  };
};

/**
 * Refuse writes a running MSIX client would overwrite, or that this process's
 * MSIX AppData redirection would divert, exactly as setup does.
 */
const msixWriteBlocker = (
  clients: readonly McpRegistrationClient[],
  context: McpRegistrationLocationContext,
): string | undefined => {
  for (const { setupClient } of clients) {
    const blocker =
      setupClient === undefined
        ? undefined
        : registrationWriteBlocker(setupClient, "mcp add");
    if (blocker !== undefined) return blocker;
  }
  return redirectedWriteBlocker(
    appDataRedirection(context.setup),
    clients.map(({ configPath }) => configPath),
    "mcp add",
  );
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

/** User-scope read-scope rules that must hold before any target is written. */
const admitGlobalTargets = async (
  clients: readonly McpRegistrationClient[],
  context: McpRegistrationLocationContext,
): Promise<void> => {
  const junie = clients.find((client) => client.id === "junie");
  if (junie) await validateJunieGlobal(junie, context);
  const blocker = msixWriteBlocker(clients, context);
  if (blocker !== undefined)
    throw new ConfigurationError(`${blocker} No settings were written.`);
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
      if (selection.global) await admitGlobalTargets(clients, context);
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
    await admitGlobalTargets(selected, context);
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
