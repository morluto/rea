import { ConfigurationError } from "../domain/configurationErrors.js";
import type { ClientRegistrationCommand } from "../domain/clientRegistrationCommand.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import type { Result } from "../domain/result.js";
import {
  clientServerPath,
  clientServerForEdit,
  legacyClientServerPath,
  effectiveClientServer,
  parseClientConfiguration,
  serializeClientConfiguration,
  withClientServers,
  type ClientConfigurationDocument,
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

const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

const registrationLocation = (client: McpRegistrationClient) => ({
  ...client.setupClient,
  ...client,
  name: client.setupClient?.name ?? client.id,
});

const requireAdmittedConfiguration = <T>(
  result: Result<T, ClientConfigurationFileError>,
): T => {
  if (!result.ok)
    throw (
      result.error.cleanupFailure ?? new ConfigurationError(result.error.detail)
    );
  return result.value;
};

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
    if (isMissing(cause)) return undefined;
    throw cause;
  });
  const original = snapshot?.text;
  const empty = serializeClientConfiguration({}, client.format);
  if (!empty.ok)
    throw new ConfigurationError(
      "An empty client configuration could not be serialized.",
    );
  const target = parseClientConfiguration(
    original ?? empty.value,
    client.format,
  );
  const location = registrationLocation(client);
  const layers = requireAdmittedConfiguration(
    await readClientConfigurationFiles(location, undefined, platform, {
      targetDocument: target,
    }),
  );
  const parsed = clientConfigurationForWrite(target, layers);
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
  if (!desired.ok) throw desired.error;
  // The client's own settings policy can exclude or override this entry.
  if (client.setupClient !== undefined) {
    const policy = await readClientPolicyBlock(
      client.setupClient,
      parsed,
      desired.value,
    );
    if (!policy.ok)
      throw (
        policy.error.cleanupFailure ??
        new ConfigurationError(policy.error.detail)
      );
    if (policy.value !== undefined)
      throw new ConfigurationError(`${policy.value} No settings were written.`);
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
    throw new ConfigurationError(
      `Client configuration member is shadowed at ${serialized.error.path.join(".")}.`,
    );
  const candidate = parseClientConfiguration(serialized.value, client.format);
  const effective = requireAdmittedConfiguration(
    admitClientConfigurationCandidate(location, layers, candidate, platform),
  );
  assertEffectiveLauncher(client, effective, launcher);
  await verifyProjectLauncher(client, launcher, platform, path, {
    candidates: [
      { path: client.configPath, original: target, replacement: candidate },
    ],
    allowMissing: snapshot === undefined,
  });
  return {
    path,
    client,
    launcher,
    platform,
    snapshot,
    original,
    parsed,
    updated,
    contents: serialized.value,
  };
};

const assertEffectiveLauncher = (
  client: McpRegistrationClient,
  effective: ClientConfigurationDocument | undefined,
  launcher: ClientRegistrationCommand,
  overridePath?: string,
): void => {
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
    throw new ConfigurationError(
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
    );
};

const verifyProjectLauncher = async (
  client: McpRegistrationClient,
  launcher: ClientRegistrationCommand,
  platform: NodeJS.Platform,
  transactionPath: string,
  proposed?: Pick<ProjectConfigurationReadOptions, "candidates"> & {
    readonly allowMissing: boolean;
  },
): Promise<void> => {
  const project = client.projectConfiguration;
  if (project === undefined) return;
  const { document, launcherConfigPath } = requireAdmittedConfiguration(
    await readEffectiveClientRegistrationConfiguration(
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
    ),
  );
  assertEffectiveLauncher(
    client,
    document,
    launcher,
    launcherConfigPath === client.configPath ? undefined : launcherConfigPath,
  );
};

/** Re-admit native layers around the caller's identity-verified target snapshot. */
export const verifyEffectiveRegistration = async (
  prepared: Awaited<ReturnType<typeof prepareRegistration>>,
  targetText: string,
): Promise<void> => {
  const { client, launcher, platform } = prepared;
  const layers = requireAdmittedConfiguration(
    await readClientConfigurationFiles(
      registrationLocation(client),
      undefined,
      platform,
      { targetDocument: parseClientConfiguration(targetText, client.format) },
    ),
  );
  assertEffectiveLauncher(
    client,
    mergeClientConfigurationDocuments(layers, platform),
    launcher,
  );
  await verifyProjectLauncher(client, launcher, platform, prepared.path);
};
