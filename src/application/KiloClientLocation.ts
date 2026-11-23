import { dirname, join, posix, win32 } from "node:path";
import {
  vscodeUserDirectory,
  type ClientRootContext,
} from "./ClientConfigRoots.js";
import { present } from "./McpRegistrationLocations.js";
import { err, ok, type Result } from "../domain/result.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import {
  parseClientConfiguration,
  type ClientInlineConfiguration,
} from "./ClientConfigurationDocument.js";

/** Names from Kilo v7.8.27 loadGlobal and config-directory merge order. */
export const KILO_GLOBAL_FILES = [
  "config.json",
  "kilo.json",
  "kilo.jsonc",
  "opencode.json",
  "opencode.jsonc",
] as const;
const KILO_DIRECTORY_FILES = [
  "kilo.jsonc",
  "kilo.json",
  "opencode.jsonc",
  "opencode.json",
] as const;

export interface KiloFileLayer {
  readonly path: string;
  readonly authority: "global" | "project" | "readonly";
}
export interface KiloConfigDirectory {
  readonly path: string;
  readonly authority: KiloFileLayer["authority"];
}

/**
 * How one caller turns a configured path into the path Kilo reads. `rea mcp
 * add` resolves it against its working directory; the client table refuses a
 * relative one because Kilo's own working directory is unknown.
 */
export interface KiloLocationContext {
  readonly root: ClientRootContext;
  readonly path: (path: string) => string;
}

export const observedFiles = async (
  directory: string,
  names: readonly string[],
  authority: KiloFileLayer["authority"],
): Promise<Result<KiloFileLayer[], ConfigurationError>> => {
  const files: KiloFileLayer[] = [];
  for (const name of names) {
    const path = join(directory, name);
    const exists = await present(path);
    if (!exists.ok) return exists;
    if (exists.value) files.push({ path, authority });
  }
  return ok(files);
};

/** Kilo's Global.Path.config: xdg-basedir's config home joined with "kilo". */
export const kiloRoot = ({ root, path }: KiloLocationContext): string => {
  const joinPath = root.platform === "win32" ? win32.join : posix.join;
  const xdg = root.env.XDG_CONFIG_HOME;
  // Appending a child first can turn an incomplete Windows root into a share.
  return xdg
    ? joinPath(path(xdg), "kilo")
    : joinPath(path(root.home), ".config", "kilo");
};

const kiloHomePaths = ({
  root,
  path,
}: KiloLocationContext): readonly string[] => {
  const home = path(root.home);
  const joinPath = root.platform === "win32" ? win32.join : posix.join;
  return [joinPath(home, ".kilocode"), joinPath(home, ".kilo")];
};

/** Kilo's legacy and current home folders, when present. */
export const kiloHomeDirectories = async (
  context: KiloLocationContext,
): Promise<Result<KiloConfigDirectory[], ConfigurationError>> => {
  const directories: KiloConfigDirectory[] = [];
  for (const directory of kiloHomePaths(context)) {
    const exists = await present(directory);
    if (!exists.ok) return exists;
    if (exists.value)
      directories.push({ path: directory, authority: "global" });
  }
  return ok(directories);
};

export const directoryFiles = async (
  directories: readonly KiloConfigDirectory[],
  custom: string | undefined,
  planned?: KiloFileLayer,
): Promise<Result<KiloFileLayer[], ConfigurationError>> => {
  const seen = new Set<string>();
  const layers: KiloFileLayer[] = [];
  for (const directory of directories) {
    if (seen.has(directory.path)) continue;
    seen.add(directory.path);
    if (
      !directory.path.endsWith(".kilo") &&
      !directory.path.endsWith(".kilocode") &&
      directory.path !== custom
    )
      continue;
    if (planned !== undefined && dirname(planned.path) === directory.path)
      layers.push(planned);
    const files = await observedFiles(
      directory.path,
      KILO_DIRECTORY_FILES,
      directory.authority,
    );
    if (!files.ok) return files;
    layers.push(...files.value);
  }
  return ok(layers);
};

export const kiloExplicitFile = ({
  root,
  path,
}: KiloLocationContext): string | undefined =>
  root.env.KILO_CONFIG ? path(root.env.KILO_CONFIG) : undefined;

export const kiloExplicitDirectory = ({
  root,
  path,
}: KiloLocationContext): string | undefined =>
  root.env.KILO_CONFIG_DIR ? path(root.env.KILO_CONFIG_DIR) : undefined;

/**
 * KILO_CONFIG_CONTENT, which Kilo merges over every file layer. A value Kilo
 * would read but REA cannot parse is refused rather than ignored.
 */
export const kiloInlineConfiguration = (
  root: ClientRootContext,
): Result<ClientInlineConfiguration | undefined, ConfigurationError> => {
  const text = root.env.KILO_CONFIG_CONTENT;
  if (!text) return ok(undefined);
  const parsed = parseClientConfiguration(text, "kilo");
  return parsed.ok
    ? ok({ origin: "KILO_CONFIG_CONTENT", parsed: parsed.value })
    : err(
        new ConfigurationError(
          "KILO_CONFIG_CONTENT cannot be admitted as Kilo configuration. Repair that selected inline configuration; no settings were written.",
          { cause: parsed.error.cause },
        ),
      );
};

/** Kilo's user-scope write target, its file layers in load order, and evidence. */
export interface KiloGlobalLocation {
  readonly configPath: string;
  readonly configPaths: readonly string[];
  readonly inlineConfiguration?: ClientInlineConfiguration;
  readonly markerPath: string;
  readonly discoveryPaths: readonly string[];
}

/** Evidence that Kilo's VS Code extension is installed. */
const kiloExtensionStorage = (root: ClientRootContext): string =>
  join(vscodeUserDirectory(root), "globalStorage", "kilocode.kilo-code");

/**
 * The location before any probe: `kilo.json` in Kilo's config root, with
 * every candidate layer. Only `kiloGlobalLocation` decides the write target.
 */
export const kiloDefaultLocation = (
  context: KiloLocationContext,
): KiloGlobalLocation => {
  const root = kiloRoot(context);
  const explicit = kiloExplicitFile(context);
  const custom = kiloExplicitDirectory(context);
  const homes = kiloHomePaths(context);
  // The row is planned for its platform, which tests choose apart from the host.
  const pathApi = context.root.platform === "win32" ? win32 : posix;
  return {
    configPath: pathApi.join(root, "kilo.json"),
    configPaths: [
      ...KILO_GLOBAL_FILES.map((name) => pathApi.join(root, name)),
      ...(explicit === undefined ? [] : [explicit]),
      ...[...homes, ...(custom === undefined ? [] : [custom])].flatMap(
        (directory) =>
          KILO_DIRECTORY_FILES.map((name) => pathApi.join(directory, name)),
      ),
    ],
    markerPath: root,
    // Evidence replaces the default probe of every candidate layer, so it
    // names each folder Kilo reads besides its extension storage.
    discoveryPaths: [
      root,
      ...homes,
      ...(explicit === undefined ? [] : [explicit]),
      ...(custom === undefined ? [] : [custom]),
      kiloExtensionStorage(context.root),
    ],
  };
};

/**
 * Kilo's user-scope layers as Kilo v7.8.27 loads them, and the file it writes:
 * the last present layer, or `kilo.json` in KILO_CONFIG_DIR when that folder
 * holds none yet.
 */
export const kiloGlobalLocation = async (
  context: KiloLocationContext,
): Promise<Result<KiloGlobalLocation, ConfigurationError>> => {
  const root = kiloRoot(context);
  const global = await observedFiles(root, KILO_GLOBAL_FILES, "global");
  if (!global.ok) return global;
  const layers = global.value;
  const explicit = kiloExplicitFile(context);
  if (explicit !== undefined) {
    const exists = await present(explicit);
    if (!exists.ok) return exists;
    layers.push({ path: explicit, authority: "global" });
  }
  const custom = kiloExplicitDirectory(context);
  const homes = await kiloHomeDirectories(context);
  if (!homes.ok) return homes;
  const directories: KiloConfigDirectory[] = [
    { path: root, authority: "global" },
    ...homes.value,
  ];
  if (custom !== undefined)
    directories.push({ path: custom, authority: "global" });
  const files = await directoryFiles(directories, custom);
  if (!files.ok) return files;
  const observed = files.value;
  let configPath = observed.at(-1)?.path ?? layers.at(-1)?.path;
  if (
    custom !== undefined &&
    ![...layers, ...observed].some((layer) => dirname(layer.path) === custom)
  ) {
    const exists = await present(custom);
    if (!exists.ok) return exists;
    configPath = join(custom, "kilo.json");
    const planned = await directoryFiles(directories, custom, {
      path: configPath,
      authority: "global",
    });
    if (!planned.ok) return planned;
    layers.push(...planned.value);
  } else layers.push(...observed);
  configPath ??= join(root, "kilo.json");
  const inline = kiloInlineConfiguration(context.root);
  if (!inline.ok) return inline;
  const inlineConfiguration = inline.value;
  return ok({
    configPath,
    configPaths:
      layers.length === 0 ? [configPath] : layers.map((layer) => layer.path),
    ...(inlineConfiguration === undefined ? {} : { inlineConfiguration }),
    markerPath: root,
    discoveryPaths: [kiloExtensionStorage(context.root)],
  });
};
