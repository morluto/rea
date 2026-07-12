import { copyFile, lstat, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";

import { PRODUCT_IDENTITY } from "../identity.js";
import { supportedClients, type SetupClient } from "./Setup.js";

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
export const systemUninstallHost = (home = homedir()): UninstallHost => ({
  clients: () => Promise.resolve(supportedClients(home)),
  removeClient,
  removeSkill: () =>
    removeManagedPath(
      join(home, ".agents/skills", PRODUCT_IDENTITY.skillName),
      "skill",
    ),
  purgeData: async () => [
    await removeManagedPath(join(home, ".rea/cache"), "cache"),
    await removeManagedPath(join(home, ".rea/state"), "state"),
  ],
});

const removeClient = async (client: SetupClient): Promise<UninstallItem> => {
  if (client.format === "unsupported")
    return item(
      client.name,
      "skipped",
      "This client has no documented local MCP configuration boundary.",
    );
  let original: string;
  try {
    original = await readFile(client.configPath, "utf8");
  } catch (cause: unknown) {
    return isMissing(cause)
      ? item(client.name, "skipped", "Configuration does not exist.")
      : item(client.name, "failed", "Configuration could not be read.");
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
      "Malformed configuration was preserved without mutation.",
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
    await copyFile(client.configPath, backupPath);
  } catch {
    return item(
      client.name,
      "failed",
      "Configuration backup failed; no mutation was attempted.",
    );
  }
  try {
    const encoded =
      client.format === "toml"
        ? stringifyToml(document)
        : `${JSON.stringify(document, null, 2)}\n`;
    await writeFileAtomic(client.configPath, encoded, { encoding: "utf8" });
    const readback = objectSchema.parse(
      client.format === "toml"
        ? parseToml(await readFile(client.configPath, "utf8"))
        : JSON.parse(await readFile(client.configPath, "utf8")),
    );
    if (PRODUCT_IDENTITY.mcpServerKey in optionalObject(readback[key]))
      throw new Error("registration readback mismatch");
    return item(
      client.name,
      "removed",
      `Removed registration from ${client.configPath}.`,
    );
  } catch {
    await writeFileAtomic(client.configPath, original, {
      encoding: "utf8",
    }).catch(() => undefined);
    return item(
      client.name,
      "failed",
      `Configuration update failed; the original was restored and ${backupPath} was retained.`,
    );
  }
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
      JSON.stringify(args) ===
        JSON.stringify(["-y", PRODUCT_IDENTITY.packageName, "mcp"]))
  );
};

const removeManagedPath = async (
  path: string,
  name: string,
): Promise<UninstallItem> => {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink())
      return item(name, "retained", `Refused to follow symlink ${path}.`);
    await rm(path, { recursive: true });
    return item(name, "removed", `Removed ${path}.`);
  } catch (cause: unknown) {
    return isMissing(cause)
      ? item(name, "skipped", `${path} does not exist.`)
      : item(name, "failed", `${path} could not be removed.`);
  }
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
