import { ConfigurationError } from "../domain/configurationErrors.js";
import type { ClientRegistrationCommand } from "../domain/clientRegistrationCommand.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { err, ok, type Result } from "../domain/result.js";
import { isEnoentError } from "./ClientConfigPath.js";
import {
  clientServerPath,
  clientServerForEdit,
  legacyClientServerPath,
  effectiveClientServer,
  parseClientConfiguration,
  serializeClientConfiguration,
  withClientServers,
  type ClientConfigurationDocument,
  type ClientConfigurationEditFailure,
  type ClientConfigurationParseFailure,
} from "./ClientConfigurationDocument.js";
import { clientConfigurationValuesEqual } from "./ClientConfigurationValues.js";
import {
  admitClientConfigurationCandidate,
  clientConfigurationForWrite,
  mergeClientConfigurationDocuments,
  readClientConfigurationFiles,
  readEffectiveClientRegistrationConfiguration,
  type ClientConfigurationFileError,
  type ProjectConfigurationReadOptions,
} from "./ClientConfigurationFiles.js";
import { replaceClientRegistrationLauncher } from "./ClientRegistration.js";
import { readClientPolicyBlock } from "./GeminiClientSettings.js";
import { admitClientStdioConnection } from "./ClientRegistrationConnection.js";
import type { McpRegistrationClient } from "./McpRegistrationCatalog.js";
import { readRegularFileTextSnapshot } from "../process/RegularFileRead.js";

const registrationLocation = (client: McpRegistrationClient) => ({
  ...client.setupClient,
  ...client,
  name: client.setupClient?.name ?? client.id,
});

const configurationLayerFailure = (
  error: ClientConfigurationFileError,
): Result<never, ConfigurationError> => {
  if (error.cleanupFailure !== undefined) throw error.cleanupFailure;
  return err(new ConfigurationError(error.detail));
};

const registrationDocumentFailure = (
  client: McpRegistrationClient,
  error:
    | ClientConfigurationParseFailure
    | Exclude<
        ClientConfigurationEditFailure,
        { readonly kind: "shadowed_member" }
      >,
): Result<never, ConfigurationError> =>
  error.kind === "document"
    ? err(error.cause)
    : err(
        new ConfigurationError(
          `Could not register MCP settings at ${client.configPath}: ${error.kind === "serialize" ? errorMessage(error.cause) : error.detail}`,
          {
            cause: error.cause,
            diagnostics: {
              settings_path: client.configPath,
              configured: false,
            },
          },
        ),
      );

/**
 * Merge REA's entry into one selected client document. `platform` is the host
 * the catalog resolved the client for; it decides the document's environment
 * name rules.
 */
export const prepareRegistration = async (
  path: string,
  client: McpRegistrationClient,
  launcher: ClientRegistrationCommand,
  platform: NodeJS.Platform,
) => {
  const snapshot = await readRegularFileTextSnapshot(path, {
    symlinks: "reject",
  }).catch((cause: unknown) => {
    if (isEnoentError(cause)) return undefined;
    throw cause;
  });
  const original = snapshot?.text;
  const empty = serializeClientConfiguration({}, client.format);
  if (!empty.ok)
    return err(
      new ConfigurationError(
        "An empty client configuration could not be serialized.",
      ),
    );
  const target = parseClientConfiguration(
    original ?? empty.value,
    client.format,
  );
  if (!target.ok) return registrationDocumentFailure(client, target.error);
  const location = registrationLocation(client);
  const read = await readClientConfigurationFiles(
    location,
    undefined,
    platform,
    {
      targetDocument: target.value,
    },
  );
  if (!read.ok) return configurationLayerFailure(read.error);
  const layers = read.value;
  const writeDocument = clientConfigurationForWrite(target.value, layers);
  if (!writeDocument.ok) return writeDocument;
  const parsed = writeDocument.value;
  const targetIndex = layers.findLastIndex(
    ({ sourcePath }) => sourcePath === client.configPath,
  );
  const inherited = mergeClientConfigurationDocuments(
    layers.slice(0, targetIndex),
    platform,
  );
  const desired = replaceClientRegistrationLauncher(
    { dialect: parsed.dialect, profile: client.registrationProfile },
    [launcher.command, ...launcher.args],
    clientServerForEdit(parsed, PRODUCT_IDENTITY.mcpServerKey),
    inherited === undefined
      ? undefined
      : effectiveClientServer(inherited, PRODUCT_IDENTITY.mcpServerKey),
  );
  if (!desired.ok) return desired;
  // The client's own settings policy can exclude or override this entry.
  if (client.setupClient !== undefined) {
    const policy = await readClientPolicyBlock(
      client.setupClient,
      parsed,
      desired.value,
    );
    if (!policy.ok) return configurationLayerFailure(policy.error);
    if (policy.value !== undefined)
      return err(
        new ConfigurationError(`${policy.value} No settings were written.`),
      );
  }
  const updated = withClientServers(
    parsed,
    {
      ...parsed.servers,
      [PRODUCT_IDENTITY.mcpServerKey]: desired.value,
    },
    platform,
    PRODUCT_IDENTITY.mcpServerKey,
  );
  const legacy = legacyClientServerPath(parsed, PRODUCT_IDENTITY.mcpServerKey);
  const serialized = serializeClientConfiguration(
    updated,
    client.format,
    original,
    [
      clientServerPath(parsed, PRODUCT_IDENTITY.mcpServerKey),
      ...(legacy === undefined ? [] : [legacy]),
    ],
    { removeShadowedMembersAt: legacy === undefined ? [] : [legacy] },
  );
  if (!serialized.ok)
    return serialized.error.kind === "shadowed_member"
      ? err(
          new ConfigurationError(
            `Client configuration member is shadowed at ${serialized.error.path.join(".")}.`,
          ),
        )
      : registrationDocumentFailure(client, serialized.error);
  const candidate = parseClientConfiguration(serialized.value, client.format);
  if (!candidate.ok)
    return registrationDocumentFailure(client, candidate.error);
  const effective = admitClientConfigurationCandidate(
    location,
    layers,
    candidate.value,
    platform,
  );
  if (!effective.ok) return configurationLayerFailure(effective.error);
  const admitted = admitEffectiveLauncher(client, effective.value, launcher);
  if (!admitted.ok) return admitted;
  const project = await verifyProjectLauncher(
    client,
    launcher,
    platform,
    path,
    {
      candidates: [
        {
          path: client.configPath,
          original: target.value,
          replacement: candidate.value,
        },
      ],
      allowMissing: snapshot === undefined,
    },
  );
  if (!project.ok) return project;
  return ok({
    path,
    client,
    launcher,
    platform,
    snapshot,
    original,
    parsed,
    updated,
    contents: serialized.value,
  });
};

const admitEffectiveLauncher = (
  client: McpRegistrationClient,
  effective: ClientConfigurationDocument | undefined,
  launcher: ClientRegistrationCommand,
  overridePath?: string,
): Result<void, ConfigurationError> => {
  const admitted = admitClientStdioConnection(
    effective === undefined
      ? undefined
      : effectiveClientServer(effective, PRODUCT_IDENTITY.mcpServerKey),
    {
      dialect: effective?.dialect ?? client.format,
      profile: client.registrationProfile,
    },
  );
  if (
    !admitted.ok ||
    admitted.value.command !== launcher.command ||
    !clientConfigurationValuesEqual(admitted.value.args, launcher.args)
  )
    return err(
      new ConfigurationError(
        admitted.ok
          ? `A higher-priority configuration${overridePath === undefined ? "" : ` at ${overridePath}`} overrides the selected stdio launcher. Update that source before registering this command.`
          : admitted.error.cause.message,
        {
          ...(admitted.ok ? {} : { cause: admitted.error.cause }),
          diagnostics: {
            settings_path: client.configPath,
            ...(overridePath === undefined
              ? {}
              : { override_path: overridePath }),
            ...(client.inlineConfiguration === undefined
              ? {}
              : { inline_origin: client.inlineConfiguration.origin }),
          },
        },
      ),
    );
  return ok(undefined);
};

const verifyProjectLauncher = async (
  client: McpRegistrationClient,
  launcher: ClientRegistrationCommand,
  platform: NodeJS.Platform,
  transactionPath: string,
  proposed?: Pick<ProjectConfigurationReadOptions, "candidates"> & {
    readonly allowMissing: boolean;
  },
): Promise<Result<void, ConfigurationError>> => {
  const project = client.projectConfiguration;
  if (project === undefined) return ok(undefined);
  const effective = await readEffectiveClientRegistrationConfiguration(
    project.userClient,
    undefined,
    platform,
    {
      projectDirectory: project.directory,
      writeTarget: {
        path: client.configPath,
        transactionPath,
        allowMissing: proposed?.allowMissing ?? false,
      },
      ...(proposed?.candidates === undefined
        ? {}
        : { candidates: proposed.candidates }),
    },
  );
  if (!effective.ok) return configurationLayerFailure(effective.error);
  const { document, launcherConfigPath } = effective.value;
  return admitEffectiveLauncher(
    client,
    document,
    launcher,
    launcherConfigPath === client.configPath ? undefined : launcherConfigPath,
  );
};

export type PreparedRegistration = Extract<
  Awaited<ReturnType<typeof prepareRegistration>>,
  { readonly ok: true }
>["value"];

/** Re-admit native layers around the caller's identity-verified target snapshot. */
export const verifyEffectiveRegistration = async (
  prepared: PreparedRegistration,
  targetText: string,
): Promise<Result<void, ConfigurationError>> => {
  const { client, launcher, platform } = prepared;
  const parsed = parseClientConfiguration(targetText, client.format);
  if (!parsed.ok) return registrationDocumentFailure(client, parsed.error);
  const layers = await readClientConfigurationFiles(
    registrationLocation(client),
    undefined,
    platform,
    { targetDocument: parsed.value },
  );
  if (!layers.ok) return configurationLayerFailure(layers.error);
  const admitted = admitEffectiveLauncher(
    client,
    mergeClientConfigurationDocuments(layers.value, platform),
    launcher,
  );
  return admitted.ok
    ? verifyProjectLauncher(client, launcher, platform, prepared.path)
    : admitted;
};
