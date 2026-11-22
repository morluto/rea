import { appendCallerPath } from "../filesystem/callerPath.js";
import {
  ClientConfigurationShapeError,
  clientConfigurationServersKey,
  clientConfigurationSyntaxName,
  parseClientConfiguration,
  serializeClientConfiguration,
  clientServerPath,
  effectiveClientServer,
  legacyClientServerPath,
  shadowedClientServers,
  withClientServers,
  type ClientConfigurationDocument,
} from "./ClientConfigurationDocument.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { analysisErrorWithCleanupDependencies } from "../domain/analysisErrorCleanup.js";
import { copyFile, lstat, realpath, rm, rmdir } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { basename, dirname } from "node:path";
import {
  defaultKunaCacheDirectory,
  hasParentTraversal,
  sameLexicalDirectory,
  withinLexicalDirectory,
} from "../filesystem/cacheDirectory.js";
import { defaultDarwinHelperCacheDirectory } from "../process/DarwinHelperCache.js";
import { linuxHopperReleaseCacheDirectory } from "./LinuxHopperCacheDirectory.js";

import {
  effectiveClientConfiguration,
  readEffectiveClientRegistrationConfiguration,
  type ClientConfigurationSource,
} from "./ClientConfigurationFiles.js";

import {
  isManagedSkillManifest,
  MANAGED_SKILL_FILES,
  skillDestinationSelection,
} from "./SetupSkill.js";
import {
  isAbsentClientConfigPath,
  resolveClientConfigTransactionPath,
} from "./ClientConfigPath.js";
import { preservePrivateRecoveryBackup } from "./ClientRegistrationBackup.js";
import {
  InvalidUtf8FileError,
  readRegularFileText,
  bindRegularFileCleanup,
} from "../process/RegularFileRead.js";
import {
  appDataRedirection,
  clientOwnershipEvidencePaths,
  clientProjectConfigurationPaths,
  clientSharedRegistrationPaths,
  manualRegistrationRemediation,
  registrationWriteBlocker,
  resolveSupportedClients,
  type ClientSystemPaths,
  type SetupClient,
} from "./SupportedClients.js";

import {
  isMissing,
  item,
  type ManagedPathStats,
  type UninstallFileSystem,
  type UninstallItem,
} from "./Uninstall.js";

/** Purge the same default cache namespaces selected by their producers. */
export const purgeSelectedData = async (
  home: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
  fileSystem: UninstallFileSystem,
): Promise<readonly UninstallItem[]> => {
  const items: UninstallItem[] = [];
  const directories: string[] = [];
  let custom: string | undefined;
  if (platform === "darwin" || platform === "linux") {
    const defaultCache = defaultKunaCacheDirectory(environment, platform, home);
    directories.push(defaultCache);
    custom = environment.REA_KUNA_CACHE_DIR;
    // Lexical spellings identify the default namespace for reporting.
    // Removal still uses the owned-path checks below. Other selections
    // remain separately reported without resolving symbolic links.
    if (
      custom !== undefined &&
      custom !== defaultCache &&
      !sameLexicalDirectory(custom, defaultCache, platform)
    )
      items.push(
        item(
          "kuna-custom-cache",
          "retained",
          `Caller-selected Kuna cache ${custom} was retained because purge does not establish ownership of that entire directory.`,
        ),
      );
    else custom = undefined;
  }
  // The ownership helper cache has no caller-selected location to retain.
  if (platform === "darwin")
    directories.push(defaultDarwinHelperCacheDirectory(home));
  if (platform === "linux") {
    const hopper = linuxHopperReleaseCacheDirectory(environment, home);
    if (hopper.ok) directories.push(hopper.value);
    else items.push(item("hopper-releases", "failed", hopper.error.message));
  }
  // Resolve selections before a managed namespace removal can delete cwd.
  // A namespace that contains the caller-selected cache is kept whole, so
  // the retained report is true.
  const reaRoot = appendCallerPath(home, ".rea");
  // A spelling with `..` is judged only where the filesystem resolves it,
  // because collapsing it lexically is wrong after a symbolic link.
  // `undefined` means the location could not be established.
  const resolve = async (path: string): Promise<string[] | undefined> => {
    const resolved = await existingRealpath(fileSystem, path);
    return resolved === undefined
      ? undefined
      : [...(hasParentTraversal(path) ? [] : [path]), ...resolved];
  };
  const selections = custom === undefined ? [] : await resolve(custom);
  const purge = async (root: string, names: readonly string[]) => {
    const kept: { readonly name: string; readonly unknown: boolean }[] = [];
    for (const name of names) {
      const targets = await resolve(appendCallerPath(root, name));
      // An unestablished selection or namespace may contain the selection,
      // so it is kept rather than treated as absent.
      const contains =
        custom !== undefined &&
        (selections === undefined ||
          targets === undefined ||
          targets.some((target) =>
            selections.some((selection) =>
              withinLexicalDirectory(selection, target, platform),
            ),
          ));
      if (contains)
        kept.push({
          name,
          unknown: selections === undefined || targets === undefined,
        });
    }
    const keptItems = kept.map(({ name, unknown }) =>
      item(
        name,
        "retained",
        unknown
          ? `${appendCallerPath(root, name)} was retained because purge could not establish whether it contains the caller-selected Kuna cache ${custom}.`
          : `${appendCallerPath(root, name)} was retained because it contains the caller-selected Kuna cache ${custom}, which purge does not remove.`,
      ),
    );
    const owned = names.filter(
      (name) => !kept.some((entry) => entry.name === name),
    );
    return async () => [
      ...keptItems,
      ...(await purgeManagedData(root, fileSystem, owned)),
    ];
  };
  const reaPlan = await purge(reaRoot, ["cache", "state"]);
  const plans: (() => Promise<readonly UninstallItem[]>)[] = [];
  for (const directory of directories)
    plans.push(await purge(dirname(directory), [basename(directory)]));
  items.unshift(...(await reaPlan()));
  for (const plan of plans) items.push(...(await plan()));
  return items;
};

/**
 * Canonical spelling of an existing path, nothing when the path is absent,
 * or `undefined` when its location cannot be established (for example an
 * inaccessible parent, or `..` without a realpath to judge it).
 */
const existingRealpath = async (
  fileSystem: UninstallFileSystem,
  path: string,
): Promise<string[] | undefined> => {
  if (fileSystem.realpath === undefined)
    return hasParentTraversal(path) ? undefined : [];
  try {
    return [await fileSystem.realpath(path)];
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? [] : undefined;
  }
};

const purgeManagedData = async (
  root: string,
  fileSystem: UninstallFileSystem,
  names: readonly string[],
): Promise<readonly UninstallItem[]> => {
  try {
    const stats = await fileSystem.stat(root);
    const linked = stats.isSymbolicLink();
    if (linked || stats.isDirectory?.() !== true)
      return names.map((name) =>
        item(
          name,
          "retained",
          `REA did not remove this item because its managed data root ${root} is ${linked ? "a symbolic link" : "not a directory"}. Verify the root before removing its data manually.`,
        ),
      );
  } catch (cause: unknown) {
    return names.map((name) =>
      isMissing(cause)
        ? item(
            name,
            "skipped",
            `${appendCallerPath(root, name)} does not exist.`,
          )
        : item(
            name,
            "failed",
            `The managed data root ${root} could not be verified. Check its permissions, then rerun uninstall.`,
          ),
    );
  }
  const items: UninstallItem[] = [];
  for (const name of names)
    items.push(
      await removeManagedPath(appendCallerPath(root, name), name, fileSystem),
    );
  return items;
};

const removeManagedPath = async (
  path: string,
  name: string,
  fileSystem: UninstallFileSystem,
): Promise<UninstallItem> => {
  try {
    const stats = await fileSystem.stat(path);
    if (stats.isSymbolicLink())
      return item(
        name,
        "retained",
        "REA did not remove this item because its managed path is a symbolic link. Verify the link target before removing it manually.",
      );
    await fileSystem.remove(path);
    return item(name, "removed", `Removed ${path}.`);
  } catch (cause: unknown) {
    return isMissing(cause)
      ? item(name, "skipped", `${path} does not exist.`)
      : item(
          name,
          "failed",
          "This item could not be removed. Check file permissions, then rerun uninstall.",
        );
  }
};

export const removeManagedSkills = async (
  home: string,
  fileSystem: UninstallFileSystem,
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
  writeBlocker?: (path: string) => string | undefined,
): Promise<UninstallItem> => {
  const selection = skillDestinationSelection(
    home,
    undefined,
    environment,
    platform,
  );
  if (selection.issues.length > 0)
    return item(
      "skill",
      "failed",
      selection.issues
        .map(({ path, detail }) => `${detail} (${path})`)
        .join(" "),
    );
  // Every destination shares one summary item; preserve both client and path.
  const results = await Promise.all(
    selection.destinations.map(({ client, path }) =>
      removeManagedSkill(path, `${client} (${path})`, fileSystem, writeBlocker),
    ),
  );
  const failed = results.find(({ status }) => status === "failed");
  if (failed !== undefined)
    return item(
      "skill",
      "failed",
      results
        .map(({ name, status, detail }) => `${name}: ${status} (${detail})`)
        .join(" "),
    );
  const status = results.some(
    ({ status: resultStatus }) => resultStatus === "removed",
  )
    ? "removed"
    : results.some(({ status: resultStatus }) => resultStatus === "retained")
      ? "retained"
      : "skipped";
  return item(
    "skill",
    status,
    results
      .map(
        ({ name, status: resultStatus, detail }) =>
          `${name}: ${resultStatus} (${detail})`,
      )
      .join(" "),
  );
};

export const inspectManagedSkill = async (
  path: string,
  name: string,
  fileSystem: UninstallFileSystem,
): Promise<UninstallItem | undefined> => {
  let root: ManagedPathStats;
  try {
    root = await fileSystem.stat(path);
  } catch (cause: unknown) {
    return isMissing(cause)
      ? item(name, "skipped", "Skill directory does not exist.")
      : item(name, "failed", "Skill directory could not be inspected.");
  }
  if (root.isSymbolicLink())
    return item(name, "retained", "Skill directory is a symbolic link.");
  if (root.isDirectory?.() !== true)
    return item(name, "retained", "Skill path is not a directory.");

  const manifestPath = appendCallerPath(path, "SKILL.md");
  try {
    const manifest = await fileSystem.stat(manifestPath);
    if (manifest.isSymbolicLink())
      return item(name, "retained", "Skill manifest is a symbolic link.");
    if (manifest.isFile?.() !== true)
      return item(name, "retained", "Skill manifest is not a regular file.");
  } catch (cause: unknown) {
    return isMissing(cause)
      ? item(name, "retained", "Skill ownership could not be established.")
      : item(name, "failed", "Skill manifest could not be inspected.");
  }
  let content: string;
  try {
    content = await (fileSystem.readRegularText?.(manifestPath) ??
      fileSystem.readText(manifestPath));
  } catch (cause: unknown) {
    return isMissing(cause)
      ? item(name, "retained", "Skill ownership could not be established.")
      : item(name, "failed", "Skill manifest could not be read.");
  }
  if (!isManagedSkillManifest(content))
    return item(name, "retained", "Skill manifest is not REA-owned.");

  return undefined;
};

const removeManagedSkill = async (
  path: string,
  name: string,
  fileSystem: UninstallFileSystem,
  writeBlocker?: (path: string) => string | undefined,
): Promise<UninstallItem> => {
  const inspection = await inspectManagedSkill(path, name, fileSystem);
  if (inspection !== undefined) return inspection;
  const blocker = writeBlocker?.(path);
  if (blocker !== undefined) return item(name, "failed", blocker);

  const manifestName = "SKILL.md";
  const otherFiles = MANAGED_SKILL_FILES.filter(
    (relativePath) => relativePath !== manifestName,
  );
  const results: UninstallItem[] = [];
  for (const relativePath of otherFiles)
    results.push(
      await removeManagedSkillFile(path, relativePath, name, fileSystem),
    );
  if (
    results.some(({ status }) => status === "failed" || status === "retained")
  )
    results.push(
      item(
        name,
        "retained",
        "REA ownership manifest was retained because a managed file could not be safely removed.",
      ),
    );
  else {
    const manifest = await removeManagedSkillFile(
      path,
      manifestName,
      name,
      fileSystem,
    );
    results.push(manifest);
    const directories =
      manifest.status === "removed"
        ? await removeEmptyManagedDirectories(path, name, fileSystem)
        : undefined;
    if (directories !== undefined) results.push(directories);
  }
  const failed = results.find(({ status }) => status === "failed");
  if (failed !== undefined)
    return item(name, "failed", results.map(({ detail }) => detail).join(" "));
  if (results.some(({ status }) => status === "retained"))
    return item(
      name,
      "retained",
      [...new Set(results.map(({ detail }) => detail))].join(" "),
    );
  const removed = results.some(({ status }) => status === "removed");
  return item(
    name,
    removed ? "removed" : "skipped",
    "REA-managed skill files were removed; other files were preserved.",
  );
};

/** Directories setup creates for managed files, deepest first, then the root. */
const MANAGED_SKILL_DIRECTORIES = [
  ...new Set(
    MANAGED_SKILL_FILES.map((relativePath) =>
      relativePath.split("/").slice(0, -1).join("/"),
    ).filter((directory) => directory.length > 0),
  ),
].sort((left, right) => right.split("/").length - left.split("/").length);

/** Remove managed directories left empty; any remaining user file keeps them. */
const removeEmptyManagedDirectories = async (
  root: string,
  name: string,
  fileSystem: UninstallFileSystem,
): Promise<UninstallItem | undefined> => {
  if (fileSystem.removeEmptyDirectory === undefined) return undefined;
  for (const directory of [
    ...MANAGED_SKILL_DIRECTORIES.map((relative) =>
      appendCallerPath(root, relative),
    ),
    root,
  ]) {
    try {
      await fileSystem.removeEmptyDirectory(directory);
    } catch (cause: unknown) {
      // User files, an absent directory, or a non-directory keep it as is.
      if (!isKeptDirectory(cause))
        return item(
          name,
          "failed",
          `Managed skill directory could not be removed: ${directory}.`,
        );
    }
  }
  return undefined;
};

const isKeptDirectory = (cause: unknown): boolean =>
  cause instanceof Error &&
  "code" in cause &&
  ["ENOTEMPTY", "EEXIST", "ENOENT", "ENOTDIR"].includes(String(cause.code));

const removeManagedSkillFile = async (
  root: string,
  relativePath: string,
  name: string,
  fileSystem: UninstallFileSystem,
): Promise<UninstallItem> => {
  const segments = relativePath.split(/[\\/]/u);
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    parent = appendCallerPath(parent, segment);
    try {
      const stats = await fileSystem.stat(parent);
      if (stats.isSymbolicLink() || stats.isDirectory?.() !== true)
        return item(
          name,
          "retained",
          `Managed path parent was retained: ${parent}.`,
        );
    } catch (cause: unknown) {
      return isMissing(cause)
        ? item(
            name,
            "skipped",
            `${appendCallerPath(parent, segments.at(-1) ?? "")} does not exist.`,
          )
        : item(
            name,
            "failed",
            `Managed path parent could not be inspected: ${parent}.`,
          );
    }
  }

  const target = appendCallerPath(root, relativePath);
  let stats: ManagedPathStats;
  try {
    stats = await fileSystem.stat(target);
  } catch (cause: unknown) {
    return isMissing(cause)
      ? item(name, "skipped", `${target} does not exist.`)
      : item(name, "failed", `Managed file could not be inspected: ${target}.`);
  }
  if (stats.isSymbolicLink())
    return item(
      name,
      "retained",
      `Managed file is a symbolic link: ${target}.`,
    );
  if (stats.isFile?.() !== true)
    return item(
      name,
      "retained",
      `Managed path is not a regular file: ${target}.`,
    );
  try {
    await fileSystem.remove(target, false);
    return item(name, "removed", `Removed ${target}.`);
  } catch (cause: unknown) {
    return isMissing(cause)
      ? item(name, "skipped", `${target} does not exist.`)
      : item(name, "failed", `Managed file could not be removed: ${target}.`);
  }
};
