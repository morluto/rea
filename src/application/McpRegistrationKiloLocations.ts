import { dirname, join, relative } from "node:path";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { parseClientConfiguration } from "./ClientConfigurationDocument.js";
import {
  resolveKiloRegistrationWorktree,
  pathWithin,
} from "./McpRegistrationGit.js";
import {
  selectedPath,
  platformPaths,
  present,
  type McpRegistrationLocationContext,
  type McpRegistrationLocation,
  type McpRegistrationGlobalLocation,
  type McpRegistrationInlineConfiguration,
} from "./McpRegistrationLocations.js";

/** Names from Kilo v7.8.27 loadGlobal and config-directory merge order. */
const KILO_GLOBAL_FILES = [
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
interface KiloFileLayer {
  readonly path: string;
  readonly authority: "global" | "project" | "readonly";
}
interface KiloConfigDirectory {
  readonly path: string;
  readonly authority: KiloFileLayer["authority"];
}

const observedFiles = async (
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
const kiloInline = (
  context: McpRegistrationLocationContext,
): McpRegistrationInlineConfiguration | undefined => {
  const text = context.environment.KILO_CONFIG_CONTENT;
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
const kiloRoot = (context: McpRegistrationLocationContext): string =>
  selectedPath(join(platformPaths(context).config, "kilo"), context);
const kiloHomeDirectories = async (
  context: McpRegistrationLocationContext,
): Promise<KiloConfigDirectory[]> => {
  const directories: KiloConfigDirectory[] = [];
  for (const name of [".kilocode", ".kilo"]) {
    const path = selectedPath(join(context.home, name), context);
    if (await present(path)) directories.push({ path, authority: "global" });
  }
  return directories;
};
const directoryFiles = async (
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
const kiloExplicitFile = (
  context: McpRegistrationLocationContext,
): string | undefined =>
  context.environment.KILO_CONFIG
    ? selectedPath(context.environment.KILO_CONFIG, context)
    : undefined;
const kiloExplicitDirectory = (
  context: McpRegistrationLocationContext,
): string | undefined =>
  context.environment.KILO_CONFIG_DIR
    ? selectedPath(context.environment.KILO_CONFIG_DIR, context)
    : undefined;

export const kiloLocation = async (
  context: McpRegistrationLocationContext,
): Promise<McpRegistrationGlobalLocation> => {
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
  const inlineConfiguration = kiloInline(context);
  return {
    configPath,
    configPaths:
      layers.length === 0 ? [configPath] : layers.map((layer) => layer.path),
    ...(inlineConfiguration === undefined ? {} : { inlineConfiguration }),
    markers: [
      root,
      join(
        platformPaths(context).vscode,
        "globalStorage",
        "kilocode.kilo-code",
      ),
    ],
  };
};

const ancestorsThrough = (directory: string, root: string): string[] => {
  const directories: string[] = [];
  let current = directory;
  while (true) {
    directories.push(current);
    if (current === root) return directories;
    const parent = dirname(current);
    if (parent === current)
      throw new ConfigurationError(
        "Kilo worktree boundary is not an ancestor; no project settings were written.",
      );
    current = parent;
  }
};
const projectDirectories = async (
  directories: readonly string[],
  authority: KiloFileLayer["authority"],
): Promise<KiloConfigDirectory[]> => {
  const found: KiloConfigDirectory[] = [];
  for (const directory of directories)
    for (const name of [".kilocode", ".kilo"]) {
      const path = join(directory, name);
      if (await present(path)) found.push({ path, authority });
    }
  return found;
};

/** Native project read order, with global/primary authorities retained read-only. */
export const kiloProjectLocation = async (
  context: McpRegistrationLocationContext,
): Promise<McpRegistrationLocation> => {
  if (
    ["true", "1"].includes(
      context.environment.KILO_DISABLE_PROJECT_CONFIG?.toLowerCase() ?? "",
    )
  )
    throw new ConfigurationError(
      "KILO_DISABLE_PROJECT_CONFIG disables project configuration. Remove that selected override or register globally; no project settings were written.",
    );
  const worktree = await resolveKiloRegistrationWorktree(context);
  const active = ancestorsThrough(worktree.activeDirectory, worktree.root);
  const root = kiloRoot(context);
  const layers = await observedFiles(root, KILO_GLOBAL_FILES, "readonly");
  const explicit = kiloExplicitFile(context);
  if (explicit !== undefined) {
    await present(explicit);
    layers.push({
      path: explicit,
      authority: pathWithin(worktree.root, explicit) ? "project" : "readonly",
    });
  }
  // ConfigPaths.files reverses nearest-first [jsonc,json] matches, first Kilo then OpenCode.
  for (const name of ["kilo", "opencode"])
    for (const directory of [...active].reverse())
      layers.push(
        ...(await observedFiles(
          directory,
          [`${name}.json`, `${name}.jsonc`],
          "project",
        )),
      );
  const primary: KiloConfigDirectory[] = [];
  if (worktree.primaryRoot !== worktree.root) {
    const mirrored = join(
      worktree.primaryRoot,
      relative(worktree.root, worktree.activeDirectory),
    );
    primary.push(
      ...(await projectDirectories(
        ancestorsThrough(mirrored, worktree.primaryRoot),
        "readonly",
      )),
    );
  }
  const nativeProject = await projectDirectories(active, "project");
  const custom = kiloExplicitDirectory(context);
  const directories: KiloConfigDirectory[] = [
    { path: root, authority: "readonly" },
    ...primary,
    ...nativeProject,
    ...(await kiloHomeDirectories(context).then((items) =>
      items.map((item) => ({ ...item, authority: "readonly" as const })),
    )),
  ];
  if (custom !== undefined)
    directories.push({
      path: custom,
      authority: pathWithin(worktree.root, custom) ? "project" : "readonly",
    });
  const directoryLayers = await directoryFiles(directories, custom);
  const writable = [...layers, ...directoryLayers].filter(
    (layer) => layer.authority === "project",
  );
  let configPath = writable.at(-1)?.path;
  if (configPath === undefined) {
    // Native updateProjectConfig's creation target must enter its future native position.
    const planned = join(worktree.activeDirectory, ".kilo");
    const activeIndex = directories.findIndex(
      (directory) => directory.authority === "project",
    );
    directories.splice(activeIndex < 0 ? 1 + primary.length : activeIndex, 0, {
      path: planned,
      authority: "project",
    });
    configPath = join(planned, "kilo.jsonc");
    const ordered: KiloFileLayer[] = [];
    const seen = new Set<string>();
    for (const directory of directories) {
      if (seen.has(directory.path)) continue;
      seen.add(directory.path);
      if (directory.path === planned)
        ordered.push({ path: configPath, authority: "project" });
      else ordered.push(...(await directoryFiles([directory], custom)));
    }
    layers.push(...ordered);
  } else layers.push(...directoryLayers);
  const inlineConfiguration = kiloInline(context);
  return {
    configPath,
    configPaths: layers.map((layer) => layer.path),
    ...(inlineConfiguration === undefined ? {} : { inlineConfiguration }),
  };
};
