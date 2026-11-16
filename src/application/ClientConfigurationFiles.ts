import { err, ok, type Result } from "../domain/result.js";
import { RegularFileCleanupFailure } from "../filesystem/OwnedRegularFile.js";
import { readRegularFileText } from "../process/RegularFileRead.js";
import {
  effectiveClientServer,
  parseClientConfiguration,
  clientConfigurationValuesEqual,
  type ClientConfigurationDocument,
  type ClientConfigurationFormat,
  type ClientInlineConfiguration,
  type ClientRegistrationDialect,
} from "./ClientConfigurationDocument.js";
import type { SetupClient } from "./SupportedClients.js";
import { clientRegistrationEnvironment } from "./ClientRegistrationEnvironment.js";
import type { ArtifactResourceScope } from "../resources/index.js";
import type { ConfigurationError } from "../domain/configurationErrors.js";
import { mergeEnvironmentOverrides } from "../process/snapshotEnvironment.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { isRecord } from "../domain/isRecord.js";
import { errorMessage } from "../kernel/errorMessage.js";

/**
 * A parsed layer retains its path so rereading the write target replaces only
 * that layer. An inline layer has no path, so nothing can select it for writing.
 */
export type ClientConfigurationSource = ClientConfigurationDocument &
  (
    | { readonly sourcePath: string; readonly inlineOrigin?: undefined }
    | {
        readonly sourcePath?: undefined;
        readonly inlineOrigin: ClientInlineConfiguration["origin"];
      }
  );

const invalidEnvironment = (
  path: string,
  error: ConfigurationError,
  overrides: Readonly<Record<string, string>> | undefined,
  platform: NodeJS.Platform,
): ClientConfigurationFileError => {
  const constraints = error.settings
    .map(({ setting, constraint }) => `${setting}: ${constraint}`)
    .join("; ");
  const overrideNames = new Set(
    Object.keys(overrides ?? {}).map((name) =>
      platform === "win32" ? name.toUpperCase() : name,
    ),
  );
  const overrideSettings = error.settings
    .map(({ setting }) => setting)
    .filter((setting) =>
      overrideNames.has(platform === "win32" ? setting.toUpperCase() : setting),
    );
  const location =
    overrideSettings.length > 0
      ? `The proposed registration environment includes launch overrides (${overrideSettings.join(", ")}) that do not satisfy the effective REA configuration constraints`
      : overrideNames.size > 0
        ? `The effective REA server environment for ${path} is invalid; check the client configuration and proposed launch overrides`
        : `Configuration ${path} has an invalid REA server environment`;
  return {
    kind: "malformed",
    path,
    detail: `${location}: ${constraints}${constraints.endsWith(".") ? "" : "."} ${overrideNames.size === 0 ? "Repair it" : "Check the launch environment and any existing registration settings"} before rerunning setup.`,
  };
};

/** A named source failure that setup can explain without losing the bad path. */
export interface ClientConfigurationFileError {
  readonly kind: "unreadable" | "malformed";
  readonly path: string;
  readonly detail: string;
  readonly cleanupFailure?: RegularFileCleanupFailure;
}

/** Preserve named read failures and distinguish a missing source from an empty file. */
export const readConfigurationText = async (
  path: string,
  resources?: ArtifactResourceScope,
): Promise<Result<string | undefined, ClientConfigurationFileError>> => {
  try {
    return ok(
      await readRegularFileText(
        path,
        resources === undefined ? {} : { resources },
      ),
    );
  } catch (cause: unknown) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return ok(undefined);
    return err({
      kind: "unreadable",
      path,
      detail: `Configuration ${path} could not be read: ${errorMessage(cause)}`,
      ...(cause instanceof RegularFileCleanupFailure
        ? { cleanupFailure: cause }
        : {}),
    });
  }
};

/** Read and parse one configuration at its source boundary. */
export const readConfigurationFile = async (
  path: string,
  format: ClientConfigurationFormat | undefined,
  resources?: ArtifactResourceScope,
): Promise<
  Result<ClientConfigurationDocument | undefined, ClientConfigurationFileError>
> => {
  const source = await readConfigurationText(path, resources);
  if (!source.ok) return source;
  const content = source.value;
  if (content === undefined) return ok(undefined);
  try {
    return ok(parseClientConfiguration(content, format));
  } catch (cause: unknown) {
    return err({
      kind: "malformed",
      path,
      detail: `Configuration ${path} is malformed: ${errorMessage(cause)}`,
    });
  }
};

/** Read each layer; setup may validate its writable layer with proposed overrides. */
export const readClientConfigurationFiles = async (
  client: SetupClient,
  resources: ArtifactResourceScope | undefined,
  platform: NodeJS.Platform,
  writeOverrides?: Readonly<Record<string, string>>,
): Promise<
  Result<readonly ClientConfigurationSource[], ClientConfigurationFileError>
> => {
  // An unresolved location is evidence only: its path may be relative to
  // REA's own folder, so reading it would inspect a file the client never
  // loads.
  if (client.configPathError !== undefined)
    return err({
      kind: "unreadable",
      path: client.configPath,
      detail: client.configPathError,
    });
  const documents: ClientConfigurationSource[] = [];
  for (const path of client.configPaths ?? [client.configPath]) {
    const document = await readConfigurationFile(
      path,
      client.format,
      resources,
    );
    if (!document.ok) return document;
    // A read-only lower layer's environment can be replaced as a whole map
    // by a later layer (Goose), so only the effective view is validated.
    const validatesLayer =
      client.readOnlyLowerLayers !== true || path === client.configPath;
    if (document.value !== undefined && !validatesLayer)
      documents.push({ ...document.value, sourcePath: path });
    else if (document.value !== undefined) {
      const environment = clientRegistrationEnvironment(
        document.value,
        client,
        platform,
        path === client.configPath ? writeOverrides : undefined,
        "fragment",
      );
      if (!environment.ok)
        return err(
          invalidEnvironment(
            path,
            environment.error,
            path === client.configPath ? writeOverrides : undefined,
            platform,
          ),
        );
      documents.push({ ...document.value, sourcePath: path });
    }
  }
  // The inline layer is read-only and may replace a lower environment map,
  // so like a read-only lower layer only the effective view is validated.
  if (client.inlineConfiguration !== undefined)
    documents.push({
      ...client.inlineConfiguration.parsed,
      inlineOrigin: client.inlineConfiguration.origin,
    });
  const environment = clientRegistrationEnvironment(
    effectiveClientConfiguration(documents, undefined, platform),
    client,
    platform,
    writeOverrides,
    "effective",
  );
  if (!environment.ok)
    return err(
      invalidEnvironment(
        client.configPath,
        environment.error,
        writeOverrides,
        platform,
      ),
    );
  return ok(documents);
};

/** OpenCode merges server objects in file order, replacing arrays and scalar values. */
const mergeConfigurationValue = (previous: unknown, next: unknown): unknown => {
  if (!isRecord(previous) || !isRecord(next)) return next;
  return Object.fromEntries(
    [...new Set([...Object.keys(previous), ...Object.keys(next)])].map(
      (key) => [
        key,
        Object.hasOwn(next, key)
          ? mergeConfigurationValue(previous[key], next[key])
          : previous[key],
      ],
    ),
  );
};

/** Native OpenCode dialect applies across all selected configuration layers. */
export const clientWriteDialect = (
  dialect: ClientRegistrationDialect,
  sources: readonly ClientConfigurationDocument[],
): ClientRegistrationDialect =>
  dialect === "opencode" &&
  sources.some(({ dialect }) => dialect === "opencode_v2")
    ? "opencode_v2"
    : dialect;

/** Interpret the write fragment using the effective client dialect, preserving peers. */
export const clientConfigurationForWrite = (
  parsed: ClientConfigurationDocument,
  sources: readonly ClientConfigurationDocument[],
): ClientConfigurationDocument => {
  if (
    parsed.dialect !== "opencode" ||
    clientWriteDialect(parsed.dialect, sources) !== "opencode_v2"
  )
    return parsed;
  if (Object.hasOwn(parsed.servers, "servers"))
    throw new TypeError(
      "A legacy OpenCode server named servers conflicts with the effective native server table; repair this ambiguity before setup",
    );
  return {
    ...parsed,
    dialect: "opencode_v2",
    serversPath: ["mcp", "servers"],
    servers: {},
    legacyServers: parsed.servers,
  };
};

/** Project a client's effective user registration without modifying its source files. */
export const effectiveClientConfiguration = (
  sources: readonly ClientConfigurationSource[],
  target:
    | {
        readonly client: Pick<SetupClient, "configPath" | "configPaths">;
        readonly document: ClientConfigurationDocument | undefined;
      }
    | undefined,
  platform: NodeJS.Platform,
): ClientConfigurationDocument | undefined => {
  const documents =
    target === undefined
      ? sources
      : [
          ...(target.client.configPaths ?? [target.client.configPath]).flatMap(
            (path) => {
              const document =
                path === target.client.configPath
                  ? target.document
                  : sources.find(({ sourcePath }) => sourcePath === path);
              return document === undefined ? [] : [document];
            },
          ),
          ...sources.filter(({ inlineOrigin }) => inlineOrigin !== undefined),
        ];
  return mergeClientConfigurationDocuments(documents, platform);
};

/** The client's read-only inline layers that set REA's entry. */
export const inlineRegistrationOrigins = (
  client: Pick<SetupClient, "inlineConfiguration">,
): readonly ClientInlineConfiguration["origin"][] => {
  const inline = client.inlineConfiguration;
  const name = PRODUCT_IDENTITY.mcpServerKey;
  return inline !== undefined &&
    (Object.hasOwn(inline.parsed.servers, name) ||
      Object.hasOwn(inline.parsed.legacyServers, name))
    ? [inline.origin]
    : [];
};

/**
 * The inline layer that would change the REA registration setup writes as
 * `desired` into the write target, which setup cannot edit around.
 */
export const inlineRegistrationOverride = (
  client: Pick<SetupClient, "configPath" | "configPaths">,
  sources: readonly ClientConfigurationSource[],
  desired: unknown,
  platform: NodeJS.Platform,
): ClientInlineConfiguration["origin"] | undefined => {
  const name = PRODUCT_IDENTITY.mcpServerKey;
  const inline = sources.filter(
    ({ inlineOrigin }) => inlineOrigin !== undefined,
  );
  const declaring = inline.find(
    (layer) =>
      Object.hasOwn(layer.servers, name) ||
      Object.hasOwn(layer.legacyServers, name),
  );
  if (declaring?.inlineOrigin === undefined) return undefined;
  const files = sources.filter(({ sourcePath }) => sourcePath !== undefined);
  const written = effectiveClientConfiguration(
    files,
    {
      client,
      document: {
        ...declaring,
        servers: { [name]: desired },
        legacyServers: {},
      },
    },
    platform,
  );
  const effective = mergeClientConfigurationDocuments(
    [...(written === undefined ? [] : [written]), ...inline],
    platform,
  );
  const launched = (entry: unknown): unknown =>
    launchedRegistrationEntry(entry, declaring.environmentKey, platform);
  return clientConfigurationValuesEqual(
    launched(written?.servers[name]),
    launched(effective?.servers[name]),
  )
    ? undefined
    : declaring.inlineOrigin;
};

/**
 * The string settings the inline layer declares in REA's entry environment,
 * or an empty record when no inline layer sets REA's entry.
 */
export const inlineRegistrationEnvironment = (
  sources: readonly ClientConfigurationSource[],
): Readonly<Record<string, string>> => {
  const name = PRODUCT_IDENTITY.mcpServerKey;
  const declaring = sources.find(
    (layer) =>
      layer.inlineOrigin !== undefined &&
      (Object.hasOwn(layer.servers, name) ||
        Object.hasOwn(layer.legacyServers, name)),
  );
  if (declaring === undefined) return {};
  const entry = Object.hasOwn(declaring.servers, name)
    ? declaring.servers[name]
    : declaring.legacyServers[name];
  const environment = isRecord(entry)
    ? entry[declaring.environmentKey]
    : undefined;
  return isRecord(environment)
    ? Object.fromEntries(
        Object.entries(environment).filter(
          (setting): setting is [string, string] =>
            typeof setting[1] === "string",
        ),
      )
    : {};
};

/**
 * An entry as the client launches it: Windows environment names are one name
 * whatever their case, so `PATH` and an equal `Path` start the same server.
 */
export const launchedRegistrationEntry = (
  entry: unknown,
  environmentKey: string,
  platform: NodeJS.Platform,
): unknown => {
  if (platform !== "win32" || !isRecord(entry)) return entry;
  const environment = entry[environmentKey];
  if (!isRecord(environment)) return entry;
  return {
    ...entry,
    [environmentKey]: Object.fromEntries(
      Object.entries(mergeEnvironmentOverrides({}, environment, platform)).map(
        ([key, value]) => [key.toUpperCase(), value],
      ),
    ),
  };
};

/** Merge admitted layers without re-reading or changing their source documents. */
export const mergeClientConfigurationDocuments = (
  documents: readonly ClientConfigurationDocument[],
  platform: NodeJS.Platform,
): ClientConfigurationDocument | undefined => {
  const last = documents.at(-1);
  if (last === undefined) return undefined;
  if (documents.length === 1) return last;
  const servers: Record<string, unknown> = Object.create(null);
  for (const document of documents) {
    const names = new Set([
      ...Object.keys(document.legacyServers),
      ...Object.keys(document.servers),
    ]);
    for (const name of names) {
      const previous = servers[name];
      const next = effectiveClientServer(document, name);
      // Goose overlays each extension one field deep (`merge_nested_entries`),
      // replacing nested values such as `envs` whole.
      const goose = document.dialect === "goose";
      const merged = goose
        ? isRecord(previous) && isRecord(next)
          ? { ...previous, ...next }
          : next
        : mergeConfigurationValue(previous, next);
      const key = document.environmentKey;
      if (
        !goose &&
        name === PRODUCT_IDENTITY.mcpServerKey &&
        isRecord(merged) &&
        isRecord(merged[key])
      ) {
        const before =
          isRecord(previous) && isRecord(previous[key]) ? previous[key] : {};
        const after = isRecord(next) && isRecord(next[key]) ? next[key] : {};
        servers[name] = {
          ...merged,
          [key]: mergeEnvironmentOverrides(before, after, platform),
        };
      } else servers[name] = merged;
    }
  }
  return {
    ...last,
    dialect: clientWriteDialect(last.dialect, documents),
    servers,
    legacyServers: {},
  };
};

/** Read the configuration ZCode will load, preserving its same-scope fallback rule. */
export const readEffectiveClientRegistrationConfiguration = async (
  client: SetupClient,
  resources: ArtifactResourceScope | undefined,
  platform: NodeJS.Platform,
): Promise<
  Result<
    {
      readonly document: ClientConfigurationDocument | undefined;
      readonly configPath: string;
    },
    ClientConfigurationFileError
  >
> => {
  const nativeSources = await readClientConfigurationFiles(
    client,
    resources,
    platform,
  );
  if (!nativeSources.ok) return nativeSources;
  const nativeDocument = effectiveClientConfiguration(
    nativeSources.value,
    undefined,
    platform,
  );
  const fallbackPath =
    client.format === "zcode" ? client.zcodeFallbackPath : undefined;
  if (
    fallbackPath === undefined ||
    (nativeDocument !== undefined &&
      Object.keys(nativeDocument.servers).length > 0)
  )
    return ok({ document: nativeDocument, configPath: client.configPath });

  const fallbackClient: SetupClient = {
    ...client,
    configPath: fallbackPath,
    configPaths: [fallbackPath],
    format: "zcode_fallback",
  };
  const fallbackSources = await readClientConfigurationFiles(
    fallbackClient,
    resources,
    platform,
  );
  if (!fallbackSources.ok) return fallbackSources;
  const fallbackDocument = effectiveClientConfiguration(
    fallbackSources.value,
    undefined,
    platform,
  );
  return ok(
    fallbackDocument === undefined
      ? { document: nativeDocument, configPath: client.configPath }
      : { document: fallbackDocument, configPath: fallbackPath },
  );
};
