import {
  ClientConfigurationShapeError,
  parseClientConfiguration,
  serializeClientConfiguration,
  clientServerPath,
  legacyClientServerPath,
  withClientServers,
  type ClientConfigurationDocument,
} from "./ClientConfigurationDocument.js";
import { copyFile, lstat, realpath, rm, rmdir } from "node:fs/promises";
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
import { dshDocument } from "./DshCordisPatch.js";
import { resolveClientConfigTransactionPath } from "./ClientConfigPath.js";
import {
  InvalidUtf8FileError,
  RegularFileCleanupFailure,
  readRegularFileText,
} from "./RegularFileRead.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import {
  appDataRedirection,
  manualRegistrationRemediation,
  registrationWriteBlocker,
  supportedClients,
  type SetupClient,
} from "./SupportedClients.js";
import {
  redirectedWriteBlocker,
  type MsixPackageView,
} from "./MsixPackageStorage.js";
export { isUninstallFailure } from "./UninstallFailure.js";

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
  /** Remove a directory only if it is empty; a non-empty one is kept. */
  removeEmptyDirectory?(path: string): Promise<void>;
}

const systemFileSystem = (
  resources: ArtifactResourceScope,
): UninstallFileSystem => ({
  readText: (path) => readRegularFileText(path, { resources }),
  readRegularText: (path) => readSkillFile(path, resources),
  copy: (source, destination) =>
    copyFile(source, destination, fsConstants.COPYFILE_EXCL),
  writeText: (path, contents) =>
    writeFileAtomic(path, contents, { encoding: "utf8" }),
  stat: (path) => lstat(path),
  realpath: (path) => realpath(path),
  remove: (path, recursive = true) => rm(path, { recursive }),
  removeEmptyDirectory: (path) => rmdir(path),
});

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

/** Filesystem boundary used by the contained uninstall workflow. */
export interface UninstallHost {
  clients(): Promise<readonly SetupClient[]>;
  /** Report a configuration that cannot be read safely, before any removal. */
  inspectClient(client: SetupClient): Promise<UninstallItem | undefined>;
  removeClient(client: SetupClient): Promise<UninstallItem>;
  inspectSkill?(): Promise<UninstallItem | undefined>;
  removeSkill(): Promise<UninstallItem>;
  purgeData(): Promise<readonly UninstallItem[]>;
  close?(): Promise<string | undefined>;
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
  let result: UninstallResult | undefined;
  let primaryFailure: unknown;
  let failed = false;
  try {
    const clients = await host.clients();
    const blocked: UninstallItem[] = [];
    for (const client of clients) {
      const blocking = await host.inspectClient(client);
      if (blocking !== undefined) blocked.push(blocking);
    }
    const skillBlocker = await host.inspectSkill?.();
    if (skillBlocker !== undefined) blocked.push(skillBlocker);
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
    result = {
      status: reported.some(({ status }) => status === "failed")
        ? "failed"
        : "complete",
      items: reported,
    };
  } catch (cause: unknown) {
    failed = true;
    primaryFailure = cause;
  }
  let cleanupFailure: string | undefined;
  try {
    cleanupFailure = await host.close?.();
  } catch (cause: unknown) {
    cleanupFailure = `Uninstall resource cleanup failed: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
  if (failed) {
    if (cleanupFailure !== undefined)
      throw new AggregateError(
        [primaryFailure, new Error(cleanupFailure)],
        "Uninstall failed and its resource cleanup remains incomplete.",
        { cause: primaryFailure },
      );
    throw primaryFailure;
  }
  if (result === undefined)
    throw new Error("Uninstall result was not produced.");
  if (cleanupFailure === undefined) return result;
  const items = collapseUninstallItems([
    ...result.items,
    item("uninstall_cleanup", "failed", cleanupFailure),
  ]);
  return { status: "failed", items };
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
  selectedFileSystem: UninstallFileSystem | undefined = undefined,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  platform: NodeJS.Platform = process.platform,
): UninstallHost => {
  const home =
    selectedHome ?? homeDirectoryFromEnvironment(environment, platform);
  const resources = new ArtifactResourceScope();
  const fileSystem = selectedFileSystem ?? systemFileSystem(resources);
  // Set with the client list: the package view that redirects this
  // process's AppData writes, if any.
  let redirection: MsixPackageView | undefined;
  const clientWriteBlocker = (client: SetupClient): string | undefined =>
    registrationWriteBlocker(client, "uninstall") ??
    redirectedWriteBlocker(redirection, [client.configPath], "uninstall");
  const skillWriteBlocker = (path: string): string | undefined =>
    redirectedWriteBlocker(redirection, [path], "uninstall");
  return {
    clients: () => {
      const clients = supportedClients(home, platform, environment);
      redirection = appDataRedirection(clients);
      return Promise.resolve(
        clients.flatMap((client) =>
          uninstallConfigPaths(client).map((configPath) => ({
            ...client,
            configPath,
          })),
        ),
      );
    },
    inspectClient: async (client) => {
      const read = await readClientConfiguration(client, fileSystem);
      if (read.kind === "item")
        return read.item.status === "failed" ? read.item : undefined;
      const removal = clientRegistrationRemoval(read.parsed, client);
      if (!removal.removeNative && removal.legacyPath === undefined)
        return undefined;
      // A removal the running package would revert, or redirect into its
      // private storage, would leave the registration in place.
      const blocker = clientWriteBlocker(client);
      return blocker === undefined
        ? undefined
        : item(client.name, "failed", blocker);
    },
    removeClient: (client) =>
      removeClient(client, fileSystem, () => clientWriteBlocker(client)),
    inspectSkill: async () => {
      for (const destination of skillDestinations(
        home,
        undefined,
        environment,
        platform,
      )) {
        const inspected = await inspectManagedSkill(
          destination.path,
          destination.client,
          fileSystem,
        );
        if (inspected?.status === "failed") return inspected;
        if (inspected !== undefined) continue;
        const blocker = skillWriteBlocker(destination.path);
        if (blocker !== undefined) return item("skill", "failed", blocker);
      }
      return undefined;
    },
    removeSkill: () =>
      removeManagedSkills(
        home,
        fileSystem,
        environment,
        platform,
        skillWriteBlocker,
      ),
    purgeData: () => purgeManagedData(join(home, ".rea"), fileSystem),
    close: async () => {
      try {
        await resources.close();
        return undefined;
      } catch (cause: unknown) {
        return `Uninstall resource cleanup failed: ${cause instanceof Error ? cause.message : String(cause)}`;
      }
    },
  };
};

/**
 * Every user file that can hold REA's registration for one client. An MSIX
 * package can read either its private copy or the AppData file, and earlier
 * setups wrote the AppData file, so both lose REA's entry.
 */
const uninstallConfigPaths = (client: SetupClient): readonly string[] => [
  ...new Set([
    ...(client.configPaths ?? [client.configPath]),
    ...(client.msixPackage === undefined
      ? []
      : [
          client.msixPackage.privateConfigPath,
          client.msixPackage.appDataConfigPath,
        ]),
  ]),
];

/** Whether removal would change this configuration. */
const registrationPresent = (parsed: ClientConfigurationDocument): boolean => {
  const name = PRODUCT_IDENTITY.mcpServerKey;
  return (
    Object.hasOwn(parsed.servers, name) ||
    // Beside a native OpenCode V2 table, OpenCode also loads a V1 `mcp.rea`.
    legacyClientServerPath(parsed, name) !== undefined ||
    // Harness ownership is the stable entry id. A stale or malformed launcher
    // still belongs to that id, and so does a direct patch that projects no row.
    (parsed.dialect === "dsh" && dshDocument(parsed.document).carriesEntry)
  );
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
    const readFailure =
      cause instanceof RegularFileCleanupFailure ? cause.cause : cause;
    return itemRead(
      isMissing(cause)
        ? item(client.name, "skipped", "Configuration does not exist.")
        : item(
            client.name,
            "failed",
            readFailure instanceof InvalidUtf8FileError
              ? "Configuration is not valid UTF-8 and was not changed. Repair it, then rerun uninstall."
              : "Configuration could not be read. Check file permissions, then rerun uninstall.",
          ),
    );
  }
  try {
    const parsed = parseClientConfiguration(original, client.format);
    return { kind: "configuration", transactionPath, original, parsed };
  } catch (cause: unknown) {
    return itemRead(
      item(
        client.name,
        "failed",
        cause instanceof ClientConfigurationShapeError
          ? `Configuration was not changed: ${cause.message}. Repair it, then rerun uninstall.`
          : `Configuration is not valid ${client.format === "toml" || client.format === "grok" ? "TOML" : client.format === "opencode" ? "JSONC" : client.format === "hermes" || client.format === "dsh" ? "YAML" : "JSON"} and was not changed. Repair it, then rerun uninstall.`,
      ),
    );
  }
};

const itemRead = (result: UninstallItem): ClientConfigurationRead => ({
  kind: "item",
  item: result,
});

/**
 * Share the exact ownership and applicability decision with preflight. A
 * removable legacy entry carries its document path, so removal edits exactly
 * the entry this decision admitted.
 */
const clientRegistrationRemoval = (
  parsed: ClientConfigurationDocument,
  client: SetupClient,
): {
  readonly removeNative: boolean;
  readonly legacyPath: readonly string[] | undefined;
} => {
  const name = PRODUCT_IDENTITY.mcpServerKey;
  if (
    parsed.dialect === "dsh" &&
    dshDocument(parsed.document).hasUnknownStructure
  )
    return { removeNative: false, legacyPath: undefined };
  const legacyPath = legacyClientServerPath(parsed, name);
  return {
    removeNative:
      (parsed.dialect === "dsh" && dshDocument(parsed.document).carriesEntry) ||
      (Object.hasOwn(parsed.servers, name) &&
        isOwnedRegistration(parsed.servers[name], client)),
    legacyPath:
      legacyPath !== undefined &&
      isOwnedRegistration(parsed.legacyServers[name], client)
        ? legacyPath
        : undefined,
  };
};

const removeClient = async (
  client: SetupClient,
  fileSystem: UninstallFileSystem,
  writeBlocker?: () => string | undefined,
): Promise<UninstallItem> => {
  const read = await readClientConfiguration(client, fileSystem);
  if (read.kind === "item") return read.item;
  const { transactionPath, original, parsed } = read;
  const name = PRODUCT_IDENTITY.mcpServerKey;
  if (
    parsed.dialect === "dsh" &&
    dshDocument(parsed.document).hasUnknownStructure
  )
    return item(
      client.name,
      "retained",
      "A Cordis expression may produce registration rows, so the patch was retained without changes.",
    );
  if (!registrationPresent(parsed))
    return item(client.name, "skipped", "REA registration is absent.");
  const { removeNative, legacyPath } = clientRegistrationRemoval(
    parsed,
    client,
  );
  const removeLegacy = legacyPath !== undefined;
  if (!removeNative && !removeLegacy)
    return item(
      client.name,
      "retained",
      "The rea-named registration is not REA-owned.",
    );
  const blocker = writeBlocker?.();
  if (blocker !== undefined) return item(client.name, "failed", blocker);
  const remaining = { ...parsed.servers };
  if (removeNative) delete remaining[name];
  const document = withClientServers(
    parsed,
    remaining,
    removeLegacy ? name : undefined,
  );
  const editedPaths = [
    ...(removeNative ? [clientServerPath(parsed, name)] : []),
    ...(legacyPath === undefined ? [] : [legacyPath]),
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
      (readback.dialect === "dsh" &&
        dshDocument(readback.document).carriesEntry) ||
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

const purgeManagedData = async (
  root: string,
  fileSystem: UninstallFileSystem,
): Promise<readonly UninstallItem[]> => {
  const names = ["cache", "state"];
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
        ? item(name, "skipped", `${join(root, name)} does not exist.`)
        : item(
            name,
            "failed",
            `The managed data root ${root} could not be verified. Check its permissions, then rerun uninstall.`,
          ),
    );
  }
  const items: UninstallItem[] = [];
  for (const name of names)
    items.push(await removeManagedPath(join(root, name), name, fileSystem));
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

const removeManagedSkills = async (
  home: string,
  fileSystem: UninstallFileSystem,
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
  writeBlocker?: (path: string) => string | undefined,
): Promise<UninstallItem> => {
  // Every destination shares one summary item; preserve both client and path.
  const results = await Promise.all(
    skillDestinations(home, undefined, environment, platform).map(
      ({ client, path }) =>
        removeManagedSkill(
          path,
          `${client} (${path})`,
          fileSystem,
          writeBlocker,
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

const inspectManagedSkill = async (
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
    ...MANAGED_SKILL_DIRECTORIES.map((relative) => join(root, relative)),
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
