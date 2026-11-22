import { dirname, join, relative } from "node:path";
import { ConfigurationError } from "../domain/configurationErrors.js";
import {
  directoryFiles,
  kiloExplicitDirectory,
  kiloExplicitFile,
  kiloHomeDirectories,
  kiloInlineConfiguration,
  kiloRoot,
  KILO_GLOBAL_FILES,
  observedFiles,
  type KiloConfigDirectory,
  type KiloFileLayer,
  type KiloLocationContext,
} from "./KiloClientLocation.js";
import {
  resolveKiloRegistrationWorktree,
  pathWithin,
} from "./McpRegistrationGit.js";
import {
  selectedPath,
  rootContext,
  present,
  type McpRegistrationLocationContext,
  type McpRegistrationLocation,
} from "./McpRegistrationLocations.js";

/** `rea mcp add` resolves configured paths against its working directory. */
const kiloContext = (
  context: McpRegistrationLocationContext,
): KiloLocationContext => ({
  root: rootContext(context),
  path: (path) => selectedPath(path, context),
});

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
  const kilo = kiloContext(context);
  const root = kiloRoot(kilo);
  const layers = await observedFiles(root, KILO_GLOBAL_FILES, "readonly");
  const explicit = kiloExplicitFile(kilo);
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
  const { primaryRoot } = worktree;
  if (primaryRoot !== undefined && primaryRoot !== worktree.root) {
    const mirrored = join(
      primaryRoot,
      relative(worktree.root, worktree.activeDirectory),
    );
    primary.push(
      ...(await projectDirectories(
        ancestorsThrough(mirrored, primaryRoot),
        "readonly",
      )),
    );
  }
  const nativeProject = await projectDirectories(active, "project");
  const custom = kiloExplicitDirectory(kilo);
  const directories: KiloConfigDirectory[] = [
    { path: root, authority: "readonly" },
    ...primary,
    ...nativeProject,
    ...(await kiloHomeDirectories(kilo).then((items) =>
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
  const inlineConfiguration = kiloInlineConfiguration(kilo.root);
  return {
    configPath,
    configPaths: layers.map((layer) => layer.path),
    ...(inlineConfiguration === undefined ? {} : { inlineConfiguration }),
  };
};
