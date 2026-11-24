import { dirname, join, relative } from "node:path";
import { err, ok, type Result } from "../domain/result.js";
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
  type McpRegistrationLocationResult,
} from "./McpRegistrationLocations.js";

/** `rea mcp add` resolves configured paths against its working directory. */
const kiloContext = (
  context: McpRegistrationLocationContext,
): KiloLocationContext => ({
  root: rootContext(context),
  path: (path) => selectedPath(path, context),
});

const ancestorsThrough = (
  directory: string,
  root: string,
): Result<string[], ConfigurationError> => {
  const directories: string[] = [];
  let current = directory;
  while (true) {
    directories.push(current);
    if (current === root) return ok(directories);
    const parent = dirname(current);
    if (parent === current)
      return err(
        new ConfigurationError(
          "Kilo worktree boundary is not an ancestor; no project settings were written.",
        ),
      );
    current = parent;
  }
};
const projectDirectories = async (
  directories: readonly string[],
  authority: KiloFileLayer["authority"],
): Promise<Result<KiloConfigDirectory[], ConfigurationError>> => {
  const found: KiloConfigDirectory[] = [];
  for (const directory of directories)
    for (const name of [".kilocode", ".kilo"]) {
      const path = join(directory, name);
      const exists = await present(path);
      if (!exists.ok) return exists;
      if (exists.value) found.push({ path, authority });
    }
  return ok(found);
};

/** Native project read order, with global/primary authorities retained read-only. */
export const kiloProjectLocation = async (
  context: McpRegistrationLocationContext,
): Promise<McpRegistrationLocationResult> => {
  if (
    ["true", "1"].includes(
      context.environment.KILO_DISABLE_PROJECT_CONFIG?.toLowerCase() ?? "",
    )
  )
    return err(
      new ConfigurationError(
        "KILO_DISABLE_PROJECT_CONFIG disables project configuration. Remove that selected override or register globally; no project settings were written.",
      ),
    );
  const resolved = await resolveKiloRegistrationWorktree(context);
  if (!resolved.ok) return resolved;
  const worktree = resolved.value;
  const active = ancestorsThrough(worktree.activeDirectory, worktree.root);
  if (!active.ok) return active;
  const kilo = kiloContext(context);
  const root = kiloRoot(kilo);
  const global = await observedFiles(root, KILO_GLOBAL_FILES, "readonly");
  if (!global.ok) return global;
  const layers = global.value;
  const explicit = kiloExplicitFile(kilo);
  if (explicit !== undefined) {
    const exists = await present(explicit);
    if (!exists.ok) return exists;
    layers.push({
      path: explicit,
      authority: pathWithin(worktree.root, explicit) ? "project" : "readonly",
    });
  }
  // ConfigPaths.files reverses nearest-first [jsonc,json] matches, first Kilo then OpenCode.
  for (const name of ["kilo", "opencode"])
    for (const directory of [...active.value].reverse()) {
      const files = await observedFiles(
        directory,
        [`${name}.json`, `${name}.jsonc`],
        "project",
      );
      if (!files.ok) return files;
      layers.push(...files.value);
    }
  const primary: KiloConfigDirectory[] = [];
  const { primaryRoot } = worktree;
  if (primaryRoot !== undefined && primaryRoot !== worktree.root) {
    const mirrored = join(
      primaryRoot,
      relative(worktree.root, worktree.activeDirectory),
    );
    const primaryAncestors = ancestorsThrough(mirrored, primaryRoot);
    if (!primaryAncestors.ok) return primaryAncestors;
    const observed = await projectDirectories(
      primaryAncestors.value,
      "readonly",
    );
    if (!observed.ok) return observed;
    primary.push(...observed.value);
  }
  const nativeProject = await projectDirectories(active.value, "project");
  if (!nativeProject.ok) return nativeProject;
  const custom = kiloExplicitDirectory(kilo);
  const homes = await kiloHomeDirectories(kilo);
  if (!homes.ok) return homes;
  const directories: KiloConfigDirectory[] = [
    { path: root, authority: "readonly" },
    ...primary,
    ...nativeProject.value,
    ...homes.value.map((item) => ({ ...item, authority: "readonly" as const })),
  ];
  if (custom !== undefined)
    directories.push({
      path: custom,
      authority: pathWithin(worktree.root, custom) ? "project" : "readonly",
    });
  const directoryLayers = await directoryFiles(directories, custom);
  if (!directoryLayers.ok) return directoryLayers;
  const writable = [...layers, ...directoryLayers.value].filter(
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
      else {
        const files = await directoryFiles([directory], custom);
        if (!files.ok) return files;
        ordered.push(...files.value);
      }
    }
    layers.push(...ordered);
  } else layers.push(...directoryLayers.value);
  const inline = kiloInlineConfiguration(kilo.root);
  if (!inline.ok) return inline;
  const inlineConfiguration = inline.value;
  return ok({
    configPath,
    configPaths: layers.map((layer) => layer.path),
    ...(inlineConfiguration === undefined ? {} : { inlineConfiguration }),
  });
};
