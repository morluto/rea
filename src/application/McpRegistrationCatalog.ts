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
  supportedClients,
  resolveSupportedClients,
  type ClientSystemPaths,
  type SetupClient,
  type SupportedClientName,
} from "./SupportedClients.js";
import { redirectedWriteBlocker } from "./MsixPackageStorage.js";
import type { ClientRegistrationProfile } from "./ClientRegistrationProfile.js";
import type { ArtifactResourceScope } from "../resources/index.js";
import {
  selectedPath,
  present,
  fixedProjectLocation,
  type McpRegistrationLocationContext,
  type McpRegistrationLocationResult,
} from "./McpRegistrationLocations.js";

/** The facts registration needs, from the client's single owner. */
interface ClientDescriptor {
  readonly displayName: string;
  readonly format: ClientConfigurationFormat;
  readonly aliases: readonly string[];
  readonly projectLocation?: (
    context: McpRegistrationLocationContext,
  ) => Promise<McpRegistrationLocationResult>;
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
  /** OpenCode's native project read scope, independent of the selected write target. */
  readonly projectConfiguration?: {
    readonly directory: string;
    readonly userClient: SetupClient;
  };
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

const selectedIds = (
  agents: readonly string[],
): Result<McpRegistrationClientId[], ConfigurationError> => {
  const ids: McpRegistrationClientId[] = [];
  for (const agent of agents) {
    const id = resolveMcpRegistrationClientId(agent);
    if (id === undefined)
      return err(
        new ConfigurationError(
          `Unknown MCP client ${agent}. Select a supported --agent value.`,
        ),
      );
    if (!ids.includes(id)) ids.push(id);
  }
  return ok(ids);
};

/** Each agent registers with its table row's exact profile. */
export const mcpClientRegistrationProfile = (
  id: McpRegistrationClientId,
): ClientRegistrationProfile => clientDescriptor(id).registrationProfile;

const projectTarget = async (
  id: McpRegistrationClientId,
  context: McpRegistrationLocationContext,
): Promise<Result<McpRegistrationClient, CatalogFailure>> => {
  const descriptor = clientDescriptor(id);
  if (descriptor.projectLocation === undefined)
    return err(
      new ConfigurationError(
        `${descriptor.displayName} has no project-scoped registration. Remove --no-global or select a project-capable client; no settings were written.`,
      ),
    );
  const resolved = await descriptor.projectLocation(context);
  if (!resolved.ok) return resolved;
  const [userClient] =
    id === "opencode"
      ? supportedClients(
          context.home,
          context.platform,
          context.environment,
          undefined,
          "opencode",
        )
      : [];
  if (id === "opencode" && userClient === undefined)
    return err(
      new ConfigurationError(
        "OpenCode's user configuration could not be located for project registration.",
      ),
    );
  return ok({
    id,
    displayName: descriptor.displayName,
    registrationProfile: mcpClientRegistrationProfile(id),
    ...resolved.value,
    scope: "project",
    ...(userClient === undefined
      ? {}
      : { projectConfiguration: { directory: context.cwd, userClient } }),
    format: descriptor.projectFormat ?? descriptor.format,
  });
};

/** The user-scope target is the client's resolved table row. */
const globalTarget = (
  id: McpRegistrationClientId,
  context: McpRegistrationLocationContext,
): Result<
  { client: McpRegistrationClient; markers: readonly string[] },
  ConfigurationError
> => {
  const descriptor = clientDescriptor(id);
  const setupClient = context.setup.find(
    ({ name }) => name === descriptor.setupName,
  );
  if (setupClient === undefined)
    return err(
      new ConfigurationError(
        `The registration catalog has no path owner for ${descriptor.setupName}.`,
      ),
    );
  if (setupClient.configPathError !== undefined)
    return err(
      setupClient.configPathFailure ??
        new ConfigurationError(setupClient.configPathError),
    );
  return ok({
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
  });
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

const selectRegistrationClients = async (
  selection: McpRegistrationSelection,
  resources: ArtifactResourceScope,
): Promise<Result<readonly McpRegistrationClient[], CatalogFailure>> => {
  checkCancellation(selection.signal);
  const selectedIdsResult = selectedIds(selection.agents);
  if (!selectedIdsResult.ok) return selectedIdsResult;
  const ids = selectedIdsResult.value;
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
  const clients: McpRegistrationClient[] = [];
  if (!selection.global) {
    // Default selection includes global-only Amp and cannot become project writes.
    if (ids.length === 0)
      return err(
        new ConfigurationError(
          "Default MCP registration includes global-only Amp. Select project-capable --agent values or remove --no-global; no settings were written.",
        ),
      );
    for (const id of ids) {
      checkCancellation(selection.signal);
      const target = await projectTarget(id, context);
      if (!target.ok) return target;
      clients.push(target.value);
    }
    checkCancellation(selection.signal);
    return ok(clients);
  }
  if (ids.length > 0) {
    for (const id of ids) {
      // The table already resolved this target before the signal was read.
      const target = globalTarget(id, context);
      if (!target.ok) return target;
      checkCancellation(selection.signal);
      clients.push(target.value.client);
    }
  } else {
    const all: McpRegistrationClient[] = [];
    for (const id of Object.keys(MCP_REGISTRATION_CLIENTS).filter(isClientId)) {
      checkCancellation(selection.signal);
      if (id === "amp") continue;
      const target = globalTarget(id, context);
      if (!target.ok) return target;
      const { client, markers } = target.value;
      all.push(client);
      // Examine every marker: unreadability cannot turn a partial observation into absence.
      let detected = false;
      for (const marker of markers) {
        const exists = await present(marker);
        if (!exists.ok) return exists;
        detected ||= exists.value;
      }
      if (detected) clients.push(client);
    }
    const amp = globalTarget("amp", context);
    if (!amp.ok) return amp;
    checkCancellation(selection.signal);
    if (clients.length === 0) clients.push(...all);
    clients.push(amp.value.client);
  }
  const blocker = msixWriteBlocker(clients, context);
  if (blocker !== undefined)
    return err(new ConfigurationError(`${blocker} No settings were written.`));
  checkCancellation(selection.signal);
  return ok(clients);
};

/** Resolve all selected paths before any registration writer receives authority. */
export const resolveMcpRegistrationClients = async (
  selection: McpRegistrationSelection,
  resources: ArtifactResourceScope,
): Promise<Result<readonly McpRegistrationClient[], CatalogFailure>> => {
  const result = await selectRegistrationClients(selection, resources).catch(
    (cause: unknown) =>
      err(
        cause instanceof AnalysisCancelledError
          ? cause
          : new ConfigurationError(
              "Could not resolve MCP registration locations.",
              { cause },
            ),
      ),
  );
  if (!result.ok && selection.signal?.aborted === true)
    analysisErrorWithCancellation(
      result.error,
      cancelledBy("MCP registration selection", selection.signal),
    );
  return result;
};
