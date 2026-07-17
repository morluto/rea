import { copyFile, lstat, readFile, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";

import { PRODUCT_IDENTITY } from "../identity.js";
import { resolveClientConfigTransactionPath } from "./ClientConfigPath.js";
import { supportedClients, type SetupClient } from "./SupportedClients.js";

interface ManagedPathStats {
  readonly uid?: number;
  isFile?(): boolean;
  isSymbolicLink(): boolean;
}

/** Injectable filesystem operations used to prove uninstall failure recovery. */
export interface UninstallFileSystem {
  readText(path: string): Promise<string>;
  copy(source: string, destination: string): Promise<void>;
  writeText(path: string, contents: string): Promise<void>;
  stat(path: string): Promise<ManagedPathStats>;
  realpath?(path: string): Promise<string>;
  remove(path: string): Promise<void>;
}

const systemFileSystem: UninstallFileSystem = {
  readText: (path) => readFile(path, "utf8"),
  copy: (source, destination) => copyFile(source, destination),
  writeText: (path, contents) =>
    writeFileAtomic(path, contents, { encoding: "utf8" }),
  stat: (path) => lstat(path),
  realpath: (path) => realpath(path),
  remove: (path) => rm(path, { recursive: true }),
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

/** Filesystem boundary used by the contained uninstall workflow. */
export interface UninstallHost {
  clients(): Promise<readonly SetupClient[]>;
  removeClient(client: SetupClient): Promise<UninstallItem>;
  removeSkill(): Promise<UninstallItem>;
  purgeData(): Promise<readonly UninstallItem[]>;
}

/** Remove only REA-owned registrations and managed files, optionally including local state. */
export const runUninstall = async (
  purgeData: boolean,
  host: UninstallHost = systemUninstallHost(),
): Promise<UninstallResult> => {
  const items: UninstallItem[] = [];
  for (const client of await host.clients())
    items.push(await host.removeClient(client));
  items.push(await host.removeSkill());
  if (purgeData) items.push(...(await host.purgeData()));
  items.push({
    name: "analysis_engine",
    status: "retained",
    detail: "Hopper is not owned by REA uninstall.",
  });
  return {
    status: items.some(({ status }) => status === "failed")
      ? "failed"
      : "complete",
    items,
  };
};

/** Create uninstall effects contained to detected client configs and REA-owned paths. */
export const systemUninstallHost = (
  home = homedir(),
  fileSystem: UninstallFileSystem = systemFileSystem,
): UninstallHost => ({
  clients: () => Promise.resolve(supportedClients(home)),
  removeClient: (client) => removeClient(client, fileSystem),
  removeSkill: () => removeManagedSkills(home, fileSystem),
  purgeData: async () => [
    await removeManagedPath(join(home, ".rea/cache"), "cache", fileSystem),
    await removeManagedPath(join(home, ".rea/state"), "state", fileSystem),
  ],
});

const removeClient = async (
  client: SetupClient,
  fileSystem: UninstallFileSystem,
): Promise<UninstallItem> => {
  if (client.format === "unsupported")
    return item(
      client.name,
      "skipped",
      "This client has no documented local MCP configuration boundary.",
    );
  const resolved = await resolveUninstallConfigPath(client, fileSystem);
  if (typeof resolved !== "string") return resolved;
  const transactionPath = resolved;
  let original: string;
  try {
    original = await fileSystem.readText(transactionPath);
  } catch (cause: unknown) {
    return isMissing(cause)
      ? item(client.name, "skipped", "Configuration does not exist.")
      : item(
          client.name,
          "failed",
          "Configuration could not be read. Check file permissions, then rerun uninstall.",
        );
  }
  let document: Record<string, unknown>;
  let key: "mcp_servers" | "mcpServers";
  let servers: Record<string, unknown>;
  try {
    document = objectSchema.parse(
      client.format === "toml" ? parseToml(original) : JSON.parse(original),
    );
    key = client.format === "toml" ? "mcp_servers" : "mcpServers";
    servers = optionalObject(document[key]);
  } catch {
    return item(
      client.name,
      "failed",
      `Configuration is not valid ${client.format === "toml" ? "TOML" : "JSON"} and was not changed. Repair it, then rerun uninstall.`,
    );
  }
  const registration = servers[PRODUCT_IDENTITY.mcpServerKey];
  if (registration === undefined)
    return item(client.name, "skipped", "REA registration is absent.");
  if (!isOwnedRegistration(registration))
    return item(
      client.name,
      "retained",
      "The rea-named registration is not REA-owned.",
    );
  const remaining = { ...servers };
  delete remaining[PRODUCT_IDENTITY.mcpServerKey];
  document[key] = remaining;
  const backupPath = `${client.configPath}.rea.backup`;
  try {
    await fileSystem.copy(transactionPath, backupPath);
  } catch {
    return item(
      client.name,
      "failed",
      "Configuration could not be backed up, so no change was made. Check file permissions, then rerun uninstall.",
    );
  }
  try {
    const encoded =
      client.format === "toml"
        ? stringifyToml(document)
        : `${JSON.stringify(document, null, 2)}\n`;
    await fileSystem.writeText(transactionPath, encoded);
    const readback = objectSchema.parse(
      client.format === "toml"
        ? parseToml(await fileSystem.readText(transactionPath))
        : JSON.parse(await fileSystem.readText(transactionPath)),
    );
    if (PRODUCT_IDENTITY.mcpServerKey in optionalObject(readback[key]))
      throw new Error("registration readback mismatch");
    return item(
      client.name,
      "removed",
      `Removed registration from ${client.configPath}.`,
    );
  } catch {
    try {
      await fileSystem.writeText(transactionPath, original);
    } catch {
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
const isOwnedRegistration = (value: unknown): boolean => {
  const parsed = registrationSchema.safeParse(value);
  if (!parsed.success) return false;
  const { command, args } = parsed.data;
  return (
    ((command === "rea" ||
      (isAbsolute(command) && basename(command) === "rea")) &&
      args.length === 1 &&
      args[0] === "mcp") ||
    (command === "npx" &&
      (JSON.stringify(args) ===
        JSON.stringify(["-y", PRODUCT_IDENTITY.packageSpecifier, "mcp"]) ||
        JSON.stringify(args) ===
          JSON.stringify(["-y", PRODUCT_IDENTITY.packageName, "mcp"])))
  );
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
): Promise<UninstallItem> => {
  const results: UninstallItem[] = [];
  for (const name of [
    PRODUCT_IDENTITY.skillName,
    ...PRODUCT_IDENTITY.legacySkillNames,
  ])
    results.push(
      await removeManagedPath(
        join(home, ".agents/skills", name),
        "skill",
        fileSystem,
      ),
    );
  const failed = results.find(({ status }) => status === "failed");
  if (failed !== undefined) return failed;
  const retained = results.find(({ status }) => status === "retained");
  if (retained !== undefined) return retained;
  const removed = results.filter(({ status }) => status === "removed");
  if (removed.length > 0)
    return item(
      "skill",
      "removed",
      removed.map(({ detail }) => detail).join(" "),
    );
  return item("skill", "skipped", "No managed REA skill installation exists.");
};

const item = (
  name: string,
  status: UninstallItem["status"],
  detail: string,
): UninstallItem => ({ name, status, detail });
const objectSchema = z.record(z.string(), z.unknown());
const optionalObject = (value: unknown): Record<string, unknown> =>
  value === undefined ? {} : objectSchema.parse(value);
const registrationSchema = z
  .object({ command: z.string(), args: z.array(z.string()) })
  .passthrough();
const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";
