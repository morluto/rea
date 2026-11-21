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
import {
  clientProjectConfigurationPaths,
  type SetupClient,
} from "./SupportedClients.js";
import { clientRegistrationEnvironment } from "./ClientRegistrationEnvironment.js";
import type { ArtifactResourceScope } from "../resources/index.js";
import type { ConfigurationError } from "../domain/configurationErrors.js";
import { mergeEnvironmentOverrides } from "../process/snapshotEnvironment.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { isRecord } from "../kernel/isRecord.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { lstat, realpath } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { isQualifiedCallerPath } from "../filesystem/callerPath.js";

export type ClientRegistrationScope = "user" | "project";

/**
 * A parsed layer retains its path so rereading the write target replaces only
 * that layer. An inline layer has no path, so nothing can select it for writing.
 */
export type ClientConfigurationSource = ClientConfigurationDocument &
  (
    | {
        readonly sourcePath: string;
        readonly inlineOrigin?: undefined;
        readonly scope?: ClientRegistrationScope;
      }
    | {
        readonly sourcePath?: undefined;
        readonly inlineOrigin: ClientInlineConfiguration["origin"];
        readonly scope?: undefined;
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
    detail: `${location}: ${constraints}${constraints.endsWith(".") ? "" : "."} ${overrideNames.size === 0 ? "Repair it" : "Check the launch environment and any existing registration settings"} before retrying.`,
  };
};

/** A named source failure that setup can explain without losing the bad path. */
export interface ClientConfigurationFileError {
  readonly kind: "unreadable" | "malformed";
  readonly path: string;
  readonly detail: string;
  readonly cleanupFailure?: RegularFileCleanupFailure;
  readonly scope?: ClientRegistrationScope;
}

type ClientConfigurationLocation = Pick<
  SetupClient,
  | "name"
  | "registrationProfile"
  | "configPath"
  | "configPaths"
  | "configPathError"
  | "readOnlyLowerLayers"
  | "inlineConfiguration"
> & { readonly format?: ClientConfigurationFormat };

interface ClientConfigurationReadOptions {
  readonly writeOverrides?: Readonly<Record<string, string>>;
  /** The writer's verified snapshot of the selected path, which must not be reopened here. */
  readonly targetDocument?: ClientConfigurationDocument;
}

const configurationEnvironmentFailure = (
  client: ClientConfigurationLocation,
  platform: NodeJS.Platform,
  {
    path,
    document,
    validation,
    overrides,
  }: {
    readonly path: string;
    readonly document: ClientConfigurationDocument | undefined;
    readonly validation: "fragment" | "effective";
    readonly overrides?: Readonly<Record<string, string>> | undefined;
  },
): ClientConfigurationFileError | undefined => {
  const environment = clientRegistrationEnvironment(
    document,
    client,
    platform,
    overrides,
    validation,
  );
  return environment.ok
    ? undefined
    : invalidEnvironment(path, environment.error, overrides, platform);
};

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
  client: ClientConfigurationLocation,
  resources: ArtifactResourceScope | undefined,
  platform: NodeJS.Platform,
  { writeOverrides, targetDocument }: ClientConfigurationReadOptions = {},
): Promise<
  Result<readonly ClientConfigurationSource[], ClientConfigurationFileError>
> => {
  const documents = await readUserConfigurationSources(
    client,
    resources,
    targetDocument,
    (path, document) => {
      const isTarget = path === client.configPath;
      // Goose can replace the environment of a read-only lower layer as a whole map.
      return isTarget || client.readOnlyLowerLayers !== true
        ? configurationEnvironmentFailure(client, platform, {
            path,
            document,
            validation: "fragment",
            overrides: isTarget ? writeOverrides : undefined,
          })
        : undefined;
    },
  );
  if (!documents.ok) return documents;
  const failure = configurationEnvironmentFailure(client, platform, {
    path: client.configPath,
    document: mergeClientConfigurationDocuments(documents.value, platform),
    validation: "effective",
    overrides: writeOverrides,
  });
  return failure === undefined ? documents : err(failure);
};

const readUserConfigurationSources = async (
  client: ClientConfigurationLocation,
  resources: ArtifactResourceScope | undefined,
  targetDocument?: ClientConfigurationDocument,
  validate?: (
    path: string,
    document: ClientConfigurationDocument,
  ) => ClientConfigurationFileError | undefined,
): Promise<
  Result<readonly ClientConfigurationSource[], ClientConfigurationFileError>
> => {
  if (client.configPathError !== undefined)
    return err({
      kind: "unreadable",
      path: client.configPath,
      detail: client.configPathError,
    });
  const paths = client.configPaths ?? [client.configPath];
  if (targetDocument !== undefined && !paths.includes(client.configPath))
    return err({
      kind: "unreadable",
      path: client.configPath,
      detail:
        "The selected configuration is missing from the native load order.",
    });
  const documents: ClientConfigurationSource[] = [];
  for (const path of paths) {
    const document =
      path === client.configPath && targetDocument !== undefined
        ? ok(targetDocument)
        : await readConfigurationFile(path, client.format, resources);
    if (!document.ok) return document;
    if (document.value === undefined) continue;
    const failure = validate?.(path, document.value);
    if (failure !== undefined) return err(failure);
    documents.push({ ...document.value, sourcePath: path });
  }
  // The inline layer is read-only and can replace lower file values.
  if (client.inlineConfiguration !== undefined)
    documents.push({
      ...client.inlineConfiguration.parsed,
      inlineOrigin: client.inlineConfiguration.origin,
    });
  return ok(documents);
};

/** Reuse admitted peers and substitute the candidate at every occurrence of the write target. */
export const admitClientConfigurationCandidate = (
  client: ClientConfigurationLocation,
  sources: readonly ClientConfigurationSource[],
  candidate: ClientConfigurationDocument,
  platform: NodeJS.Platform,
): Result<
  ClientConfigurationDocument | undefined,
  ClientConfigurationFileError
> => {
  const path = client.configPath;
  const fragment = configurationEnvironmentFailure(client, platform, {
    path,
    document: candidate,
    validation: "fragment",
  });
  if (fragment !== undefined) return err(fragment);
  const effective = mergeClientConfigurationDocuments(
    sources.map((source) => (source.sourcePath === path ? candidate : source)),
    platform,
  );
  const failure = configurationEnvironmentFailure(client, platform, {
    path,
    document: effective,
    validation: "effective",
  });
  return failure === undefined ? ok(effective) : err(failure);
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

export interface EffectiveClientRegistrationConfiguration {
  readonly document: ClientConfigurationDocument | undefined;
  readonly configPath: string;
  readonly scope?: ClientRegistrationScope;
  readonly launcherScope?: ClientRegistrationScope;
  readonly launcherConfigPath?: string;
  readonly activationScope?: ClientRegistrationScope;
  readonly activationConfigPath?: string;
  readonly declarations: readonly ServerDeclaration[];
  readonly projectInspection?: "evaluated" | "untrusted";
  /** Every admitted project file, in native load order, when proving ownership. */
  readonly projectSources?: readonly ClientConfigurationSource[];
  /** Readiness can fail while parsed launcher identity remains available. */
  readonly environmentError?: ClientConfigurationFileError;
  /** Project candidate spellings already owned by the same physical user files. */
  readonly projectUserAliases?: readonly string[];
}

interface ProjectConfigurationReadOptions {
  readonly projectDirectory: string;
  readonly mode?: "ownership";
  /** Admitted project sources with proposed bytes parsed by their transaction owner. */
  readonly candidates?: readonly {
    readonly path: string;
    readonly document: ClientConfigurationDocument;
  }[];
}

/** Read actual user layers, with a project view only when a directory is expressly supplied. */
export const readEffectiveClientRegistrationConfiguration = async (
  client: SetupClient,
  resources: ArtifactResourceScope | undefined,
  platform: NodeJS.Platform,
  project?: ProjectConfigurationReadOptions,
): Promise<
  Result<EffectiveClientRegistrationConfiguration, ClientConfigurationFileError>
> => {
  if (
    project === undefined ||
    (client.format !== "opencode" && client.format !== "pi")
  )
    return readEffectiveUserConfiguration(client, resources, platform);
  if (client.configPathError !== undefined)
    return readEffectiveUserConfiguration(client, resources, platform);
  if (!isQualifiedCallerPath(project.projectDirectory, platform))
    return err({
      kind: "unreadable",
      path: project.projectDirectory,
      scope: "project",
      detail:
        "Project configuration inspection requires an absolute directory.",
    });

  const paths = await presentProjectSources(
    client,
    project.projectDirectory,
    platform,
  );
  if (!paths.ok) return paths;
  const candidates = new Map<string, ClientConfigurationDocument>();
  const admitted = new Set(paths.value.project);
  for (const { path, document } of project.candidates ?? []) {
    if (candidates.has(path))
      return err({
        kind: "unreadable",
        path,
        scope: "project",
        detail: "A proposed project file appears more than once.",
      });
    if (!admitted.has(path))
      return err({
        kind: "unreadable",
        path,
        scope: "project",
        detail:
          "The selected file is missing from the native project configuration load order.",
      });
    candidates.set(path, document);
  }
  if (paths.value.project.length === 0) {
    const user = await readEffectiveUserConfiguration(
      client,
      resources,
      platform,
    );
    return user.ok && paths.value.userAliases.length > 0
      ? ok(
          projectViewOfUserRegistration(
            { ...user.value, projectUserAliases: paths.value.userAliases },
            "evaluated",
          ),
        )
      : user;
  }

  if (client.format === "pi") {
    const trust = await isPiProjectTrusted(
      client.piSettings,
      project.projectDirectory,
      platform,
      resources,
    );
    if (!trust.ok) return err({ ...trust.error, scope: "project" });
    if (!trust.value) {
      const replacementPath = candidates.keys().next().value;
      if (replacementPath !== undefined)
        return err({
          kind: "unreadable",
          path: replacementPath,
          scope: "project",
          detail:
            "Pi does not load MCP configuration from this untrusted project.",
        });
      const user = await readEffectiveUserConfiguration(
        client,
        resources,
        platform,
      );
      return user.ok
        ? ok(projectViewOfUserRegistration(user.value, "untrusted"))
        : user;
    }
  }

  const projectSources: ClientConfigurationSource[] = [];
  for (const path of paths.value.project) {
    const candidate = candidates.get(path);
    const configuration =
      candidate === undefined
        ? await readConfigurationFile(path, client.format, resources)
        : ok(candidate);
    if (!configuration.ok)
      return err({ ...configuration.error, scope: "project" });
    if (configuration.value !== undefined)
      projectSources.push({
        ...configuration.value,
        sourcePath: path,
        scope: "project",
      });
  }

  const user = await readUserConfigurationSources(client, resources);
  if (!user.ok) return user;
  const sources = [...user.value, ...projectSources];
  const wholeRows =
    client.format === "opencode" &&
    sources.some(({ dialect }) => dialect === "opencode_v2");
  const projectedSources =
    client.format === "opencode"
      ? sources.map((source) => projectOpenCodeSource(source, wholeRows))
      : sources;
  const declarations = serverDeclarations(projectedSources);
  const winning = declarations.at(-1);
  const piOverride =
    client.format === "pi" &&
    winning?.source.scope === "project" &&
    isPiPartialServerOverride(winning.entry);
  const replaces = wholeRows || client.format === "pi";
  const active = activeDeclarations(declarations, replaces && !piOverride);
  const last = active.at(-1);
  if (piOverride && last !== undefined) {
    const override = piProjectOverride(active, last);
    if (!override.ok) return override;
  }

  const document = piOverride
    ? withPiOverride(sources, active)
    : replaces
      ? replacedServerConfiguration(projectedSources)
      : mergeClientConfigurationDocuments(projectedSources, platform);
  const environment = clientRegistrationEnvironment(document, client, platform);
  let environmentError: ClientConfigurationFileError | undefined;
  if (!environment.ok) {
    const source =
      contributingEnvironmentSource(active, environment.error, platform) ??
      last?.source;
    environmentError = {
      ...invalidEnvironment(
        source?.sourcePath ?? client.configPath,
        environment.error,
        undefined,
        platform,
      ),
      ...(source?.scope === "project" ? { scope: "project" } : {}),
    };
    if (project.mode !== "ownership") return err(environmentError);
  }

  const projectFacts = {
    declarations: active,
    projectInspection: "evaluated" as const,
    ...(project.mode === "ownership" ? { projectSources } : {}),
    ...(environmentError === undefined ? {} : { environmentError }),
    ...(paths.value.userAliases.length === 0
      ? {}
      : { projectUserAliases: paths.value.userAliases }),
  };
  if (last === undefined || last.source.scope !== "project")
    return ok(
      projectViewOfUserRegistration(
        { document, configPath: client.configPath, ...projectFacts },
        "evaluated",
      ),
    );

  const launcher = active.findLast(declaresLauncher) ?? last;
  const activation =
    active.findLast(
      ({ entry }) =>
        isRecord(entry) &&
        ["disabled", "enabled", "enable"].some((key) =>
          Object.hasOwn(entry, key),
        ),
    ) ?? last;
  return ok({
    document,
    configPath: last.source.sourcePath ?? client.configPath,
    scope: "project",
    launcherScope: launcher.source.scope ?? "user",
    launcherConfigPath: launcher.source.sourcePath ?? client.configPath,
    activationScope: activation.source.scope ?? "user",
    activationConfigPath: activation.source.sourcePath ?? client.configPath,
    ...projectFacts,
  });
};

const projectViewOfUserRegistration = (
  user: EffectiveClientRegistrationConfiguration,
  projectInspection: NonNullable<
    EffectiveClientRegistrationConfiguration["projectInspection"]
  >,
): EffectiveClientRegistrationConfiguration => {
  const source = user.declarations.at(-1)?.source.sourcePath;
  const launcher =
    user.declarations.findLast(declaresLauncher)?.source.sourcePath;
  return {
    ...user,
    scope: "user",
    configPath: source ?? user.configPath,
    projectInspection,
    ...(launcher === undefined
      ? {}
      : {
          launcherScope: "user",
          launcherConfigPath: launcher,
        }),
  };
};

const readEffectiveUserConfiguration = async (
  client: SetupClient,
  resources: ArtifactResourceScope | undefined,
  platform: NodeJS.Platform,
): Promise<
  Result<EffectiveClientRegistrationConfiguration, ClientConfigurationFileError>
> => {
  const nativeSources = await readClientConfigurationFiles(
    client,
    resources,
    platform,
  );
  if (!nativeSources.ok) return nativeSources;
  const nativeDocument = mergeClientConfigurationDocuments(
    nativeSources.value,
    platform,
  );
  const native = {
    document: nativeDocument,
    configPath: client.configPath,
    declarations: activeDeclarations(
      serverDeclarations(nativeSources.value),
      false,
    ),
  };
  const fallbackPath =
    client.format === "zcode" ? client.zcodeFallbackPath : undefined;
  if (
    fallbackPath === undefined ||
    (nativeDocument !== undefined &&
      Object.keys(nativeDocument.servers).length > 0)
  )
    return ok(native);
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
  const document = mergeClientConfigurationDocuments(
    fallbackSources.value,
    platform,
  );
  return ok(
    document === undefined
      ? native
      : {
          document,
          configPath: fallbackPath,
          declarations: activeDeclarations(
            serverDeclarations(fallbackSources.value),
            false,
          ),
        },
  );
};

const filesystemPathKey = (path: string, platform: NodeJS.Platform): string =>
  platform === "win32"
    ? win32.normalize(path).toLowerCase()
    : posix.normalize(path);

const physicalPathKey = async (
  path: string,
  platform: NodeJS.Platform,
): Promise<string> =>
  filesystemPathKey(await realpath(path).catch(() => path), platform);

const fileMissing = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  (error.code === "ENOENT" || error.code === "ENOTDIR");

/** Project discovery cannot reclassify the current user's physical settings file. */
const presentProjectSources = async (
  client: SetupClient,
  projectDirectory: string,
  platform: NodeJS.Platform,
): Promise<
  Result<
    {
      readonly project: readonly string[];
      readonly userAliases: readonly string[];
    },
    ClientConfigurationFileError
  >
> => {
  const user = new Set(
    await Promise.all(
      (client.configPaths ?? [client.configPath]).map((path) =>
        physicalPathKey(path, platform),
      ),
    ),
  );
  const project: string[] = [];
  const userAliases: string[] = [];
  for (const candidate of clientProjectConfigurationPaths(
    client,
    projectDirectory,
    platform,
  )) {
    try {
      await lstat(candidate);
    } catch (cause: unknown) {
      if (fileMissing(cause)) continue;
      return err({
        kind: "unreadable",
        path: candidate,
        scope: "project",
        detail: `Project configuration ${candidate} could not be inspected: ${errorMessage(cause)}`,
      });
    }
    if (user.has(await physicalPathKey(candidate, platform)))
      userAliases.push(candidate);
    else project.push(candidate);
  }
  return ok({ project, userAliases });
};

const readPiTrustDocument = async (
  path: string,
  resources: ArtifactResourceScope | undefined,
): Promise<
  Result<Record<string, unknown> | undefined, ClientConfigurationFileError>
> => {
  const text = await readConfigurationText(path, resources);
  if (!text.ok) return text;
  if (text.value === undefined) return ok(undefined);
  try {
    const parsed: unknown = JSON.parse(text.value.replace(/^\uFEFF/u, ""));
    if (isRecord(parsed)) return ok(parsed);
    throw new TypeError("expected a JSON object");
  } catch (cause: unknown) {
    return err({
      kind: "malformed",
      path,
      scope: "project",
      detail: `Pi trust configuration in ${path} is malformed: ${errorMessage(cause)}`,
    });
  }
};

const isPiProjectTrusted = async (
  settings: SetupClient["piSettings"],
  projectDirectory: string,
  platform: NodeJS.Platform,
  resources: ArtifactResourceScope | undefined,
): Promise<Result<boolean, ClientConfigurationFileError>> => {
  if (settings === undefined) return ok(false);
  const trust = await readPiTrustDocument(settings.trustPath, resources);
  if (!trust.ok) return trust;
  const paths = platform === "win32" ? win32 : posix;
  // Pi canonicalizes the current project and walks its physical ancestors.
  // Persisted keys already use that identity and Windows compares case-insensitively.
  let current = await realpath(projectDirectory).catch(() => projectDirectory);
  if (trust.value !== undefined) {
    const records = Object.entries(trust.value);
    for (;;) {
      const identity = filesystemPathKey(current, platform);
      const entry = records.find(
        ([path, decision]) =>
          typeof decision === "boolean" &&
          isQualifiedCallerPath(path, platform) &&
          filesystemPathKey(path, platform) === identity,
      );
      if (entry !== undefined) return ok(entry[1] === true);
      const parent = paths.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  const configuration = await readPiTrustDocument(
    settings.settingsPath,
    resources,
  );
  return configuration.ok
    ? ok(configuration.value?.defaultProjectTrust === "always")
    : configuration;
};

interface ServerDeclaration {
  readonly source: ClientConfigurationSource;
  readonly entry: unknown;
}

const declaresLauncher = ({ entry }: ServerDeclaration): boolean =>
  isRecord(entry) &&
  ["command", "url", "type", "transport"].some((key) =>
    Object.hasOwn(entry, key),
  );

const serverDeclarations = (
  sources: readonly ClientConfigurationSource[],
): readonly ServerDeclaration[] =>
  sources.flatMap((source) => {
    const entry = effectiveClientServer(source, PRODUCT_IDENTITY.mcpServerKey);
    return entry === undefined ? [] : [{ source, entry }];
  });

const activeDeclarations = (
  declarations: readonly ServerDeclaration[],
  wholeRows: boolean,
): readonly ServerDeclaration[] =>
  wholeRows
    ? declarations.slice(-1)
    : declarations.slice(
        Math.max(
          0,
          declarations.findLastIndex(({ entry }) => !isRecord(entry)),
        ),
      );

/** Report the active source of a registration schema failure. */
export const contributingRegistrationSource = (
  { declarations }: EffectiveClientRegistrationConfiguration,
  error: ConfigurationError,
): ClientConfigurationSource | undefined => {
  const last = declarations.at(-1);
  if (last === undefined || !isRecord(last.entry)) return last?.source;
  const fields = new Set(
    error.settings.map(({ setting }) => setting.split(".")[0]),
  );
  return (
    declarations.findLast(
      ({ entry }) =>
        isRecord(entry) && Object.keys(entry).some((key) => fields.has(key)),
    ) ??
    declarations.findLast(
      ({ entry }) =>
        isRecord(entry) &&
        ["command", "args", "type", "transport"].some((key) =>
          Object.hasOwn(entry, key),
        ),
    ) ??
    last
  ).source;
};

const contributingEnvironmentSource = (
  declarations: readonly ServerDeclaration[],
  error: ConfigurationError,
  platform: NodeJS.Platform,
): ClientConfigurationSource | undefined => {
  const normalize = (name: string): string =>
    platform === "win32" ? name.toUpperCase() : name;
  const rejected = new Set(
    error.settings.flatMap(({ setting }) => {
      const parts = setting.split(".");
      return [normalize(setting), normalize(parts.at(-1) ?? setting)];
    }),
  );
  return declarations.findLast(({ source, entry }) => {
    if (!isRecord(entry) || !Object.hasOwn(entry, source.environmentKey))
      return false;
    const environment = entry[source.environmentKey];
    return (
      rejected.has(normalize(source.environmentKey)) ||
      (isRecord(environment) &&
        Object.keys(environment).some((key) => rejected.has(normalize(key))))
    );
  })?.source;
};

/** OpenCode V2 migrates enabled from legacy rows and only reads disabled on native rows. */
const projectOpenCodeSource = (
  source: ClientConfigurationSource,
  nativeProjection: boolean,
): ClientConfigurationSource => {
  const normalize = (
    servers: Readonly<Record<string, unknown>>,
    native: boolean,
  ) =>
    Object.fromEntries(
      Object.entries(servers).map(([name, entry]) => {
        if (!isRecord(entry)) return [name, entry];
        const { enabled, disabled, ...server } = entry;
        if (native)
          return [
            name,
            disabled === undefined ? server : { ...server, disabled },
          ];
        if (enabled === undefined) return [name, server];
        return [
          name,
          nativeProjection
            ? {
                ...server,
                disabled: typeof enabled === "boolean" ? !enabled : enabled,
              }
            : { ...server, enabled },
        ];
      }),
    );
  return {
    ...source,
    servers: normalize(source.servers, source.dialect === "opencode_v2"),
    legacyServers: normalize(source.legacyServers, false),
  };
};

const replacedServerConfiguration = (
  sources: readonly ClientConfigurationSource[],
): ClientConfigurationDocument | undefined => {
  const last = sources.at(-1);
  if (last === undefined) return undefined;
  const servers = Object.fromEntries(
    sources.flatMap((source) =>
      [
        ...new Set([
          ...Object.keys(source.legacyServers),
          ...Object.keys(source.servers),
        ]),
      ].map((name) => [name, effectiveClientServer(source, name)]),
    ),
  );
  return {
    ...last,
    dialect: clientWriteDialect(last.dialect, sources),
    servers,
    legacyServers: {},
  };
};

const isPiPartialServerOverride = (
  entry: unknown,
): entry is Record<string, unknown> =>
  isRecord(entry) &&
  !["command", "url", "type"].some((key) => Object.hasOwn(entry, key));

const piProjectOverride = (
  active: readonly ServerDeclaration[],
  project: ServerDeclaration,
): Result<void, ClientConfigurationFileError> => {
  if (!isRecord(project.entry) || project.source.sourcePath === undefined)
    return ok(undefined);
  const allowed = ["enabled", "exposure", "toolExposure"];
  const invalid = Object.keys(project.entry).filter(
    (key) => !allowed.includes(key),
  );
  let reason: string | undefined;
  if (invalid.length > 0)
    reason = `a flags-only override may only set ${allowed.join(", ")}; found ${invalid.join(", ")}`;
  else if (!isRecord(active.at(-2)?.entry))
    reason = "a flags-only override requires an existing user-level server";
  if (reason === undefined) return ok(undefined);
  return err({
    kind: "malformed",
    path: project.source.sourcePath,
    scope: "project",
    detail: `Invalid Pi project REA server in ${project.source.sourcePath}: ${reason}.`,
  });
};

const withPiOverride = (
  sources: readonly ClientConfigurationSource[],
  declarations: readonly ServerDeclaration[],
): ClientConfigurationDocument | undefined => {
  const document = replacedServerConfiguration(sources);
  if (document === undefined) return document;
  const base = declarations.at(-2)?.entry;
  const project = declarations.at(-1)?.entry;
  if (!isRecord(base) || !isRecord(project)) return document;
  return {
    ...document,
    servers: {
      ...document.servers,
      [PRODUCT_IDENTITY.mcpServerKey]: { ...base, ...project },
    },
  };
};
