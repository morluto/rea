import {
  parseClientConfiguration,
  serializeClientConfiguration,
  clientServerPath,
  legacyClientServerPath,
  withClientServers,
  type ClientConfigurationDocument,
} from "./ClientConfigurationDocument.js";
import { copyFile, lstat, readFile, realpath, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homeDirectoryFromEnvironment } from "../config/homeDirectory.js";
import { join } from "node:path";

import writeFileAtomic from "write-file-atomic";
import { z } from "zod";

import { PRODUCT_IDENTITY } from "../identity.js";
import {
  isManagedSkillManifest,
  MANAGED_SKILL_FILES,
  readSkillFile,
  skillDestinations,
} from "./SetupSkill.js";
import { isOwnedClientRegistrationCommand } from "./ClientRegistrationIdentity.js";
import { resolveClientConfigTransactionPath } from "./ClientConfigPath.js";
import {
  manualRegistrationRemediation,
  supportedClients,
  type SetupClient,
} from "./SupportedClients.js";

interface ManagedPathStats {
  readonly uid?: number;
  isFile?(): boolean;
  isDirectory?(): boolean;
  isSymbolicLink(): boolean;
}

/** Injectable filesystem operations used to prove uninstall failure recovery. */
export interface UninstallFileSystem {
  readText(path: string): Promise<string>;
  readRegularText?(path: string): Promise<string>;
  /** Preserve the first backup; reject an existing destination with EEXIST. */
  copy(source: string, destination: string): Promise<void>;
  writeText(path: string, contents: string): Promise<void>;
  stat(path: string): Promise<ManagedPathStats>;
  realpath?(path: string): Promise<string>;
  remove(path: string, recursive?: boolean): Promise<void>;
}

const systemFileSystem: UninstallFileSystem = {
  readText: (path) => readFile(path, "utf8"),
  readRegularText: readSkillFile,
  copy: (source, destination) =>
    copyFile(source, destination, fsConstants.COPYFILE_EXCL),
  writeText: (path, contents) =>
    writeFileAtomic(path, contents, { encoding: "utf8" }),
  stat: (path) => lstat(path),
  realpath: (path) => realpath(path),
  remove: (path, recursive = true) => rm(path, { recursive }),
};

/** One explicitly classified uninstall action. */
export interface UninstallItem {
  readonly name: string;
  readonly status: "removed" | "retained" | "skipped" | "failed";
  readonly detail: string;
}

/** Structured, idempotent result of removing REA-owned state. */
export interface UninstallResult {
  readonly status: "complete" | "failed";
  readonly items: readonly UninstallItem[];
}

/** Whether any requested REA-owned uninstall action failed. */
export const isUninstallFailure = (result: UninstallResult): boolean => {
  const status = result.status;
  switch (status) {
    case "complete":
      return false;
    case "failed":
      return true;
    default: {
      const exhaustive: never = status;
      throw new TypeError(
        `Unhandled uninstall result status: ${String(exhaustive)}`,
      );
    }
  }
};

/** Filesystem boundary used by the contained uninstall workflow. */
export interface UninstallHost {
  clients(): Promise<readonly SetupClient[]>;
  /** Report a configuration that cannot be read safely, before any removal. */
  inspectClient(client: SetupClient): Promise<UninstallItem | undefined>;
  removeClient(client: SetupClient): Promise<UninstallItem>;
  removeSkill(): Promise<UninstallItem>;
  purgeData(): Promise<readonly UninstallItem[]>;
}

/**
 * Remove only REA-owned registrations and managed files, optionally including
 * local state. A client configuration that cannot be read safely stops the
 * operation before anything is removed; one that fails during removal stops
 * the remaining removals.
 */
export const runUninstall = async (
  purgeData: boolean,
  host: UninstallHost = systemUninstallHost(),
): Promise<UninstallResult> => {
  const clients = await host.clients();
  const blocked: UninstallItem[] = [];
  for (const client of clients) {
    const blocking = await host.inspectClient(client);
    if (blocking !== undefined) blocked.push(blocking);
  }
  const items: UninstallItem[] =
    blocked.length > 0
      ? [
          ...blocked,
          item(
            "uninstall",
            "skipped",
            "No REA registration, skill, or data was removed. Repair each failed configuration, then rerun uninstall.",
          ),
        ]
      : await removeAll(clients, purgeData, host);
  items.push({
    name: "analysis_engine",
    status: "retained",
    detail: "Hopper is not owned by REA uninstall.",
  });
  const reported = collapseUninstallItems(items);
  return {
    status: reported.some(({ status }) => status === "failed")
      ? "failed"
      : "complete",
    items: reported,
  };
};

/**
 * Each client is reread when it is edited, so a concurrent change is never
 * overwritten. A client that fails then still stops the remaining removals.
 */
const removeAll = async (
  clients: readonly SetupClient[],
  purgeData: boolean,
  host: UninstallHost,
): Promise<UninstallItem[]> => {
  const items: UninstallItem[] = [];
  for (const client of clients) {
    const removed = await host.removeClient(client);
    items.push(removed);
    if (removed.status === "failed")
      return [
        ...items,
        item(
          "uninstall",
          "skipped",
          "Uninstall stopped at this failure; the items above report what changed. Repair the failed configuration, then rerun uninstall.",
        ),
      ];
  }
  items.push(await host.removeSkill());
  if (purgeData) items.push(...(await host.purgeData()));
  return items;
};

/** Create uninstall effects contained to detected client configs and REA-owned paths. */
export const systemUninstallHost = (
  selectedHome: string | undefined = undefined,
  fileSystem: UninstallFileSystem = systemFileSystem,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  platform: NodeJS.Platform = process.platform,
): UninstallHost => {
  const home =
    selectedHome ?? homeDirectoryFromEnvironment(environment, platform);
  return {
    clients: () =>
      Promise.resolve(
        supportedClients(home, platform, environment).flatMap((client) =>
          client.configPaths === undefined
            ? [client]
            : client.configPaths.map((configPath) => ({
                ...client,
                configPath,
              })),
        ),
      ),
    inspectClient: async (client) => {
      const read = await readClientConfiguration(client, fileSystem);
      return read.kind === "item" && read.item.status === "failed"
        ? read.item
        : undefined;
    },
    removeClient: (client) => removeClient(client, fileSystem),
    removeSkill: () =>
      removeManagedSkills(home, fileSystem, environment, platform),
    purgeData: async () => [
      await removeManagedPath(join(home, ".rea/cache"), "cache", fileSystem),
      await removeManagedPath(join(home, ".rea/state"), "state", fileSystem),
    ],
  };
};

type ClientConfigurationRead =
  | { readonly kind: "item"; readonly item: UninstallItem }
  | {
      readonly kind: "configuration";
      readonly transactionPath: string;
      readonly original: string;
      readonly parsed: ClientConfigurationDocument;
    };

const readClientConfiguration = async (
  client: SetupClient,
  fileSystem: UninstallFileSystem,
): Promise<ClientConfigurationRead> => {
  if (client.configPathError !== undefined)
    return itemRead(item(client.name, "failed", client.configPathError));
  if (client.format === "unsupported")
    return itemRead(
      item(
        client.name,
        "skipped",
        manualRegistrationRemediation(client.name) ??
          "This client has no documented local MCP configuration boundary.",
      ),
    );
  const resolved = await resolveUninstallConfigPath(client, fileSystem);
  if (typeof resolved !== "string") return itemRead(resolved);
  const transactionPath = resolved;
  let original: string;
  try {
    original = await fileSystem.readText(transactionPath);
  } catch (cause: unknown) {
    return itemRead(
      isMissing(cause)
        ? item(client.name, "skipped", "Configuration does not exist.")
        : item(
            client.name,
            "failed",
            "Configuration could not be read. Check file permissions, then rerun uninstall.",
          ),
    );
  }
  try {
    const parsed = parseClientConfiguration(original, client.format);
    return { kind: "configuration", transactionPath, original, parsed };
  } catch (cause: unknown) {
    void cause;
    return itemRead(
      item(
        client.name,
        "failed",
        `Configuration is not valid ${client.format === "toml" || client.format === "grok" ? "TOML" : client.format === "opencode" ? "JSONC" : "JSON"} and was not changed. Repair it, then rerun uninstall.`,
      ),
    );
  }
};

const itemRead = (result: UninstallItem): ClientConfigurationRead => ({
  kind: "item",
  item: result,
});

const removeClient = async (
  client: SetupClient,
  fileSystem: UninstallFileSystem,
): Promise<UninstallItem> => {
  const read = await readClientConfiguration(client, fileSystem);
  if (read.kind === "item") return read.item;
  const { transactionPath, original, parsed } = read;
  const name = PRODUCT_IDENTITY.mcpServerKey;
  // Beside a native OpenCode V2 table, OpenCode also loads a V1 `mcp.rea`.
  const legacyPath = legacyClientServerPath(parsed, name);
  const hasNative = Object.hasOwn(parsed.servers, name);
  if (!hasNative && legacyPath === undefined)
    return item(client.name, "skipped", "REA registration is absent.");
  const removeNative =
    hasNative && isOwnedRegistration(parsed.servers[name], client);
  const removeLegacy =
    legacyPath !== undefined &&
    isOwnedRegistration(parsed.legacyServers[name], client);
  if (!removeNative && !removeLegacy)
    return item(
      client.name,
      "retained",
      "The rea-named registration is not REA-owned.",
    );
  const remaining = { ...parsed.servers };
  if (removeNative) delete remaining[name];
  const document = withClientServers(
    parsed,
    remaining,
    removeLegacy ? name : undefined,
  );
  const editedPaths = [
    ...(removeNative ? [clientServerPath(parsed, name)] : []),
    ...(removeLegacy ? [legacyPath] : []),
  ];
  const backupPath = `${client.configPath}.rea.backup`;
  try {
    await fileSystem.copy(transactionPath, backupPath);
  } catch (cause: unknown) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST"))
      return item(
        client.name,
        "failed",
        "Configuration could not be backed up, so no change was made. Check file permissions, then rerun uninstall.",
      );
  }
  try {
    await fileSystem.writeText(
      transactionPath,
      serializeClientConfiguration(
        document,
        client.format,
        original,
        editedPaths,
      ),
    );
    const readback = parseClientConfiguration(
      await fileSystem.readText(transactionPath),
      client.format,
    );
    if (
      (removeNative && Object.hasOwn(readback.servers, name)) ||
      (removeLegacy && Object.hasOwn(readback.legacyServers, name))
    )
      throw new Error("registration readback mismatch");
    return item(
      client.name,
      "removed",
      `Removed registration from ${client.configPath}.`,
    );
  } catch (cause: unknown) {
    // Update failure attempts a restore before reporting; cause is preserved below.
    void cause;
    try {
      await fileSystem.writeText(transactionPath, original);
    } catch (restoreCause: unknown) {
      void restoreCause;
      return item(
        client.name,
        "failed",
        "Configuration could not be updated or restored. Restore its `.rea.backup` manually, then rerun uninstall.",
      );
    }
    return item(
      client.name,
      "failed",
      "Configuration could not be updated. The original was restored and its `.rea.backup` was retained. Repair the configuration or restore the backup, then rerun uninstall.",
    );
  }
};

const resolveUninstallConfigPath = async (
  client: SetupClient,
  fileSystem: UninstallFileSystem,
): Promise<string | UninstallItem> => {
  const path = await resolveClientConfigTransactionPath(
    client.configPath,
    fileSystem.realpath === undefined
      ? { lstat: fileSystem.stat }
      : { lstat: fileSystem.stat, realpath: fileSystem.realpath },
  );
  return (
    path ??
    item(
      client.name,
      "failed",
      "Configuration path could not be safely verified. Check its permissions and, if it is a symbolic link, verify that the link resolves to a regular file owned by the current user, then rerun uninstall.",
    )
  );
};

/** Ownership rule for persistent MCP registrations created by REA setup. */
const isOwnedRegistration = (value: unknown, client: SetupClient): boolean => {
  if (client.format === "opencode") {
    const parsed = z
      .object({ type: z.literal("local"), command: z.array(z.string()).min(1) })
      .passthrough()
      .safeParse(value);
    if (!parsed.success) return false;
    const command = parsed.data.command;
    return isOwnedClientRegistrationCommand(command);
  }
  const parsed = registrationSchema.safeParse(value);
  if (!parsed.success) return false;
  const { command, args } = parsed.data;
  return isOwnedClientRegistrationCommand([command, ...args]);
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

const removeManagedSkills = async (
  home: string,
  fileSystem: UninstallFileSystem,
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): Promise<UninstallItem> => {
  const results = await Promise.all(
    skillDestinations(home, undefined, environment, platform).map(
      ({ client, path }) =>
        removeManagedSkill(
          path,
          client === "claude_code" ? "Claude Code skill" : "skill",
          fileSystem,
        ),
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

const removeManagedSkill = async (
  path: string,
  name: string,
  fileSystem: UninstallFileSystem,
): Promise<UninstallItem> => {
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

  const manifestPath = join(path, "SKILL.md");
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
  else
    results.push(
      await removeManagedSkillFile(path, manifestName, name, fileSystem),
    );
  const failed = results.find(({ status }) => status === "failed");
  if (failed !== undefined)
    return item(name, "failed", results.map(({ detail }) => detail).join(" "));
  const removed = results.some(({ status }) => status === "removed");
  return item(
    name,
    removed ? "removed" : "skipped",
    "REA-managed skill files were removed; other files were preserved.",
  );
};

const removeManagedSkillFile = async (
  root: string,
  relativePath: string,
  name: string,
  fileSystem: UninstallFileSystem,
): Promise<UninstallItem> => {
  const segments = relativePath.split(/[\\/]/u);
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    parent = join(parent, segment);
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
            `${join(parent, segments.at(-1) ?? "")} does not exist.`,
          )
        : item(
            name,
            "failed",
            `Managed path parent could not be inspected: ${parent}.`,
          );
    }
  }

  const target = join(root, relativePath);
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

const item = (
  name: string,
  status: UninstallItem["status"],
  detail: string,
): UninstallItem => ({ name, status, detail });

/**
 * Layered clients are removed file by file, but callers look up one status by
 * client name. A missing earlier file must not hide a later removal.
 */
const collapseUninstallItems = (
  items: readonly UninstallItem[],
): UninstallItem[] => {
  const collapsed: UninstallItem[] = [];
  for (const next of items) {
    const index = collapsed.findIndex(({ name }) => name === next.name);
    const current = collapsed[index];
    if (current === undefined) {
      collapsed.push(next);
      continue;
    }
    collapsed[index] = mergeUninstallItems(current, next);
  }
  return collapsed;
};

const mergeUninstallItems = (
  current: UninstallItem,
  next: UninstallItem,
): UninstallItem => {
  const status = preferredUninstallStatus(current.status, next.status);
  const details = [current, next]
    .filter(
      (entry) =>
        entry.status === status ||
        (status === "removed" && entry.status === "retained"),
    )
    .map(({ detail }) => detail);
  return item(current.name, status, [...new Set(details)].join(" "));
};

const preferredUninstallStatus = (
  current: UninstallItem["status"],
  next: UninstallItem["status"],
): UninstallItem["status"] =>
  uninstallStatusPriority(next) > uninstallStatusPriority(current)
    ? next
    : current;

const uninstallStatusPriority = (status: UninstallItem["status"]): number => {
  switch (status) {
    case "failed":
      return 3;
    case "removed":
      return 2;
    case "retained":
      return 1;
    case "skipped":
      return 0;
    default: {
      const exhaustive: never = status;
      throw new TypeError(
        `Unhandled uninstall item status: ${String(exhaustive)}`,
      );
    }
  }
};
const registrationSchema = z
  .object({ command: z.string(), args: z.array(z.string()) })
  .passthrough();
const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";
