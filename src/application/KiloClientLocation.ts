import { dirname, join, posix, win32 } from "node:path";
import {
  vscodeUserDirectory,
  type ClientRootContext,
} from "./ClientConfigRoots.js";
import { present } from "./McpRegistrationLocations.js";
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
): Promise<KiloFileLayer[]> => {
  const files: KiloFileLayer[] = [];
  for (const name of names) {
    const path = join(directory, name);
    if (await present(path)) files.push({ path, authority });
  }
  return files;
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
): Promise<KiloConfigDirectory[]> => {
  const directories: KiloConfigDirectory[] = [];
  for (const directory of kiloHomePaths(context)) {
    if (await present(directory))
      directories.push({ path: directory, authority: "global" });
  }
  return directories;
};

export const directoryFiles = async (
  directories: readonly KiloConfigDirectory[],
  custom: string | undefined,
  planned?: KiloFileLayer,
): Promise<KiloFileLayer[]> => {
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
    layers.push(
      ...(await observedFiles(
        directory.path,
        KILO_DIRECTORY_FILES,
        directory.authority,
      )),
    );
  }
  return layers;
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
): ClientInlineConfiguration | undefined => {
  const text = root.env.KILO_CONFIG_CONTENT;
  if (!text) return undefined;
  try {
    return {
      origin: "KILO_CONFIG_CONTENT",
      parsed: parseClientConfiguration(text, "kilo"),
    };
  } catch (cause: unknown) {
    throw new ConfigurationError(
      "KILO_CONFIG_CONTENT cannot be admitted as Kilo configuration. Repair that selected inline configuration; no settings were written.",
      { cause },
    );
  }
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
  return {
    configPath: join(root, "kilo.json"),
    configPaths: [
      ...KILO_GLOBAL_FILES.map((name) => join(root, name)),
      ...(explicit === undefined ? [] : [explicit]),
      ...[...homes, ...(custom === undefined ? [] : [custom])].flatMap(
        (directory) =>
          KILO_DIRECTORY_FILES.map((name) => join(directory, name)),
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
): Promise<KiloGlobalLocation> => {
  const root = kiloRoot(context);
  const layers = await observedFiles(root, KILO_GLOBAL_FILES, "global");
  const explicit = kiloExplicitFile(context);
  if (explicit !== undefined) {
    await present(explicit);
    layers.push({ path: explicit, authority: "global" });
  }
  const custom = kiloExplicitDirectory(context);
  const directories: KiloConfigDirectory[] = [
    { path: root, authority: "global" },
    ...(await kiloHomeDirectories(context)),
  ];
  if (custom !== undefined)
    directories.push({ path: custom, authority: "global" });
  const observed = await directoryFiles(directories, custom);
  let configPath = observed.at(-1)?.path ?? layers.at(-1)?.path;
  if (
    custom !== undefined &&
    ![...layers, ...observed].some((layer) => dirname(layer.path) === custom)
  ) {
    await present(custom);
    configPath = join(custom, "kilo.json");
    layers.push(
      ...(await directoryFiles(directories, custom, {
        path: configPath,
        authority: "global",
      })),
    );
  } else layers.push(...observed);
  configPath ??= join(root, "kilo.json");
  const inlineConfiguration = kiloInlineConfiguration(context.root);
  return {
    configPath,
    configPaths:
      layers.length === 0 ? [configPath] : layers.map((layer) => layer.path),
    ...(inlineConfiguration === undefined ? {} : { inlineConfiguration }),
    markerPath: root,
    discoveryPaths: [kiloExtensionStorage(context.root)],
  };
};
