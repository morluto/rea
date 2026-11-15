import {
  AnalysisCancelledError,
  cancelledBy,
} from "../domain/analysisErrorCore.js";

import { analysisErrorWithCancellation } from "../domain/analysisErrorCancellation.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import type {
  ClientConfigurationFormat,
  ClientInlineConfiguration,
} from "./ClientConfigurationDocument.js";
import {
  appDataRedirection,
  clientEvidencePaths,
  registrationWriteBlocker,
  supportedClientDefinition,
  resolveSupportedClients,
  type ClientSystemPaths,
  type SetupClient,
  type SupportedClientName,
} from "./SupportedClients.js";
import { redirectedWriteBlocker } from "./MsixPackageStorage.js";
import type { ClientRegistrationProfile } from "./ClientRegistrationProfile.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import {
  selectedPath,
  present,
  fixedProjectLocation,
  type McpRegistrationLocationContext,
  type McpRegistrationLocation,
} from "./McpRegistrationLocations.js";

/** The facts registration needs, from the client's single owner. */
interface ClientDescriptor {
  readonly displayName: string;
  readonly format: ClientConfigurationFormat;
  readonly aliases: readonly string[];
  readonly projectLocation?: (
    context: McpRegistrationLocationContext,
  ) => Promise<McpRegistrationLocation>;
  readonly projectFormat?: ClientConfigurationFormat;
  readonly registrationProfile: ClientRegistrationProfile;
  readonly setupName: SupportedClientName;
}

/**
 * Reviewed add-mcp 2.6.1 agent ids plus Incur's separate Amp contract, in
 * add-mcp's order, each naming its client-table row. The row owns the
 * location, format, profile, aliases, project location and read scope.
 */
export const MCP_REGISTRATION_CLIENTS = {
  antigravity: "antigravity",
  cline: "cline_vscode",
  "cline-cli": "cline",
  "claude-code": "claude_code",
  "claude-desktop": "claude_desktop",
  codex: "codex",
  cursor: "cursor",
  "factory-droid": "droid",
  fx: "fx",
  "gemini-cli": "gemini_cli",
  goose: "goose",
  "github-copilot-cli": "copilot_cli",
  "grok-build": "grok_build",
  hermes: "hermes",
  junie: "junie",
  "kilo-code": "kilo",
  "kimi-code": "kimi",
  "kiro-cli": "kiro",
  mastracode: "mastracode",
  mcporter: "mcporter",
  opencode: "opencode",
  pi: "pi",
  vscode: "vscode",
  windsurf: "windsurf",
  zed: "zed",
  amp: "amp",
} as const satisfies Record<string, SupportedClientName>;

export type McpRegistrationClientId = keyof typeof MCP_REGISTRATION_CLIENTS;

const isClientId = (value: string): value is McpRegistrationClientId =>
  Object.hasOwn(MCP_REGISTRATION_CLIENTS, value);

/** Project one agent's facts from its client-table row. */
const clientDescriptor = (id: McpRegistrationClientId): ClientDescriptor => {
  const name: SupportedClientName = MCP_REGISTRATION_CLIENTS[id];
  const row = supportedClientDefinition(name);
  if (row.format === "unsupported")
    throw new Error(`${row.name} has no registration format`);
  const projectPaths = row.mcpAdd?.projectPaths;
  const projectLocation =
    row.mcpAdd?.projectLocation ??
    (projectPaths === undefined
      ? undefined
      : fixedProjectLocation(projectPaths));
  return {
    displayName: row.displayName,
    format: row.format,
    aliases: row.mcpAdd?.aliases ?? [],
    ...(projectLocation === undefined ? {} : { projectLocation }),
    ...(row.mcpAdd?.projectFormat === undefined
      ? {}
      : { projectFormat: row.mcpAdd.projectFormat }),
    registrationProfile: row.registrationProfile,
    setupName: name,
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
  readonly inlineConfiguration?: ClientInlineConfiguration;
  readonly scope: "global" | "project";
  readonly format: ClientConfigurationFormat;
  readonly privateProfile?: SetupClient["privateProfile"];
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
  /** System-wide client configuration paths; defaults to each client's own. */
  readonly systemPaths?: ClientSystemPaths;
  readonly signal?: AbortSignal;
}

type CatalogFailure = ConfigurationError | AnalysisCancelledError;
const checkCancellation = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw cancelledBy("MCP registration selection", signal);
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

/** Each agent registers with its table row's exact profile. */
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

/** The user-scope target is the client's resolved table row. */
const globalTarget = (
  id: McpRegistrationClientId,
  context: McpRegistrationLocationContext,
): { client: McpRegistrationClient; markers: readonly string[] } => {
  const descriptor = clientDescriptor(id);
  const setupClient = context.setup.find(
    ({ name }) => name === descriptor.setupName,
  );
  if (setupClient === undefined)
    throw new ConfigurationError(
      `The registration catalog has no path owner for ${descriptor.setupName}.`,
    );
  if (setupClient.configPathError !== undefined)
    throw (
      setupClient.configPathFailure ??
      new ConfigurationError(setupClient.configPathError)
    );
  return {
    client: {
      id,
      displayName: descriptor.displayName,
      registrationProfile: mcpClientRegistrationProfile(id),
      configPath: selectedPath(setupClient.configPath, context),
      ...(setupClient.configPaths === undefined
        ? {}
        : {
            configPaths: setupClient.configPaths.map((path) =>
              selectedPath(path, context),
            ),
          }),
      scope: "global",
      format: descriptor.format,
      ...(setupClient.inlineConfiguration === undefined
        ? {}
        : { inlineConfiguration: setupClient.inlineConfiguration }),
      ...(setupClient.privateProfile === undefined
        ? {}
        : { privateProfile: setupClient.privateProfile }),
      setupClient,
    },
    // Setup's detection evidence, so both commands find the same clients.
    markers: clientEvidencePaths(setupClient).map((path) =>
      selectedPath(path, context),
    ),
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

/** User-scope read-scope rules that must hold before any target is written. */
const admitGlobalTargets = async (
  clients: readonly McpRegistrationClient[],
  context: McpRegistrationLocationContext,
): Promise<void> => {
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
        ? await resolveSupportedClients(
            selection.home,
            selection.platform,
            selection.environment,
            selection.systemPaths,
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
        // A user-scope target is already resolved with the table, so its
        // failure is reported before a cancellation that followed it.
        if (selection.global) clients.push(globalTarget(id, context).client);
        checkCancellation(selection.signal);
        if (!selection.global) clients.push(await projectTarget(id, context));
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
      const { client, markers } = globalTarget(id, context);
      all.push(client);
      // Examine every marker: unreadability cannot turn a partial observation into absence.
      const statuses: boolean[] = [];
      for (const marker of markers) statuses.push(await present(marker));
      if (statuses.some(Boolean)) detected.push(client);
    }
    const amp = globalTarget("amp", context).client;
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
        cancelledBy("MCP registration selection", selection.signal),
      );
    return err(failure);
  }
};
