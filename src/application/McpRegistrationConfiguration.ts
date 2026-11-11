import { ConfigurationError } from "../domain/configurationErrors.js";
import type { ClientRegistrationCommand } from "../domain/clientRegistrationCommand.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import {
  clientConfigurationValuesEqual,
  clientServerPath,
  clientServerForEdit,
  legacyClientServerPath,
  effectiveClientServer,
  parseClientConfiguration,
  serializeClientConfiguration,
  withClientServers,
  type ClientConfigurationDocument,
} from "./ClientConfigurationDocument.js";
import {
  clientConfigurationForWrite,
  mergeClientConfigurationDocuments,
  readConfigurationFile,
} from "./ClientConfigurationFiles.js";
import { replaceClientRegistrationLauncher } from "./ClientRegistration.js";
import { admitClientStdioConnection } from "./ClientRegistrationConnection.js";
import type { McpRegistrationClient } from "./McpRegistrationCatalog.js";
import { readRegularFileTextSnapshot } from "./RegularFileRead.js";

const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

export const prepareRegistration = async (
  path: string,
  client: McpRegistrationClient,
  launcher: ClientRegistrationCommand,
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
  const layers = await readRegistrationLayers(client, target);
  const parsed = clientConfigurationForWrite(target, layers);
  const paths = client.configPaths ?? [client.configPath];
  const targetIndex = paths.lastIndexOf(client.configPath);
  const inherited = mergeClientConfigurationDocuments(
    layers.slice(0, targetIndex),
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
  const updated = withClientServers(
    parsed,
    {
      ...parsed.servers,
      [PRODUCT_IDENTITY.mcpServerKey]: desired.value,
    },
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
  // Native loaders may visit one file at multiple precedence positions. A
  // physical update changes every occurrence without deduplicating its order.
  const candidateLayers = layers.map((document, index) =>
    paths[index] === client.configPath ? candidate : document,
  );
  assertEffectiveLauncher(client, candidateLayers, launcher);
  return {
    path,
    client,
    launcher,
    snapshot,
    original,
    parsed,
    updated,
    contents: serialized.value,
  };
};

/** File layers and inline authority remain distinct; only the selected target is replaced. */
const readRegistrationLayers = async (
  client: McpRegistrationClient,
  target: ClientConfigurationDocument,
): Promise<ClientConfigurationDocument[]> => {
  const layers: ClientConfigurationDocument[] = [];
  const paths = client.configPaths ?? [client.configPath];
  if (!paths.includes(client.configPath))
    throw new ConfigurationError(
      "The selected configuration is missing from the native load order.",
    );
  for (const path of paths) {
    if (path === client.configPath) {
      layers.push(target);
      continue;
    }
    const read = await readConfigurationFile(path, client.format);
    if (!read.ok)
      throw (
        read.error.cleanupFailure ?? new ConfigurationError(read.error.detail)
      );
    // Retain an empty layer for missing files so target positions do not shift.
    if (read.value !== undefined) layers.push(read.value);
    else {
      const empty = serializeClientConfiguration({}, client.format);
      if (!empty.ok)
        throw new ConfigurationError(
          "An empty native configuration could not be serialized.",
        );
      layers.push(parseClientConfiguration(empty.value, client.format));
    }
  }
  if (client.inlineConfiguration !== undefined)
    layers.push(client.inlineConfiguration.parsed);
  return layers;
};

const assertEffectiveLauncher = (
  client: McpRegistrationClient,
  layers: readonly ClientConfigurationDocument[],
  launcher: ClientRegistrationCommand,
): void => {
  const effective = mergeClientConfigurationDocuments(layers);
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
        ? "A higher-priority configuration overrides the selected stdio launcher. Update that source before registering this command."
        : admitted.error.cause.message,
      {
        ...(admitted.ok ? {} : { cause: admitted.error.cause }),
        diagnostics: {
          settings_path: client.configPath,
          ...(client.inlineConfiguration === undefined
            ? {}
            : { inline_origin: client.inlineConfiguration.origin }),
        },
      },
    );
};

/** Re-admit native layers around the caller's identity-verified target snapshot. */
export const verifyEffectiveRegistration = async (
  prepared: Awaited<ReturnType<typeof prepareRegistration>>,
  targetText: string,
): Promise<void> => {
  const { client, launcher } = prepared;
  assertEffectiveLauncher(
    client,
    await readRegistrationLayers(
      client,
      parseClientConfiguration(targetText, client.format),
    ),
    launcher,
  );
};
