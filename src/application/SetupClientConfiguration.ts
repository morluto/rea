import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import writeFileAtomic from "write-file-atomic";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import { PRODUCT_IDENTITY } from "../identity.js";
import { resolveClientConfigTransactionPath } from "./ClientConfigPath.js";
import type {
  ClientConfigurationResult,
  SetupProviderEnvironment,
} from "./Setup.js";
import type { SetupClient } from "./SupportedClients.js";

const defaultCommand = (): readonly string[] => [
  "npx",
  "-y",
  PRODUCT_IDENTITY.packageSpecifier,
  "mcp",
];

/** Back up, atomically update, and semantically read back one JSON MCP configuration. */
export const configureJsonClient = async (
  client: SetupClient,
  environment: SetupProviderEnvironment | string = {},
  command: readonly string[] = defaultCommand(),
): Promise<ClientConfigurationResult> => {
  const transactionPath = await resolveClientConfigTransactionPath(
    client.configPath,
  );
  if (transactionPath === undefined)
    return { status: "failed", reason: "path" };
  let document: Record<string, unknown> = {};
  let original: string | undefined;
  try {
    original = await readFile(transactionPath, "utf8");
    document = parseObject(original);
  } catch (cause: unknown) {
    if (!isMissing(cause)) return { status: "failed", reason: "readback" };
  }
  let servers: Record<string, unknown>;
  try {
    servers = parseOptionalObject(document.mcpServers);
  } catch {
    return { status: "failed", reason: "readback" };
  }
  const desired = clientConfigurationDesired(
    normalizeProviderEnvironment(environment),
    command,
  );
  if (sameConfiguration(servers[PRODUCT_IDENTITY.mcpServerKey], desired))
    return { status: "unchanged" };
  let backupPath: string | undefined;
  if (original !== undefined) {
    backupPath = `${client.configPath}.rea.backup`;
    if (!(await preserveConfigBackup(transactionPath, backupPath)))
      return { status: "failed", reason: "backup" };
  }
  document.mcpServers = {
    ...servers,
    [PRODUCT_IDENTITY.mcpServerKey]: desired,
  };
  try {
    await mkdir(dirname(client.configPath), { recursive: true });
    await writeFileAtomic(
      transactionPath,
      `${JSON.stringify(document, null, 2)}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
  } catch {
    return { status: "failed", reason: "write" };
  }
  try {
    const readback = parseObject(await readFile(transactionPath, "utf8"));
    if (
      !sameConfiguration(
        parseOptionalObject(readback.mcpServers)[PRODUCT_IDENTITY.mcpServerKey],
        desired,
      )
    ) {
      await restoreConfig(transactionPath, original);
      return { status: "failed", reason: "readback" };
    }
  } catch {
    await restoreConfig(transactionPath, original);
    return { status: "failed", reason: "readback" };
  }
  return {
    status: "configured",
    ...(backupPath === undefined ? {} : { backupPath }),
  };
};

/** Back up, atomically update, and semantically read back Codex TOML configuration. */
export const configureTomlClient = async (
  client: SetupClient,
  environment: SetupProviderEnvironment | string = {},
  command: readonly string[] = defaultCommand(),
): Promise<ClientConfigurationResult> => {
  const transactionPath = await resolveClientConfigTransactionPath(
    client.configPath,
  );
  if (transactionPath === undefined)
    return { status: "failed", reason: "path" };
  let document: Record<string, unknown> = {};
  let original: string | undefined;
  try {
    original = await readFile(transactionPath, "utf8");
    document = objectSchema.parse(parseToml(original));
  } catch (cause: unknown) {
    if (!isMissing(cause)) return { status: "failed", reason: "readback" };
  }
  let servers: Record<string, unknown>;
  try {
    servers = parseOptionalObject(document.mcp_servers);
  } catch {
    return { status: "failed", reason: "readback" };
  }
  const desired = clientConfigurationDesired(
    normalizeProviderEnvironment(environment),
    command,
  );
  if (sameConfiguration(servers[PRODUCT_IDENTITY.mcpServerKey], desired))
    return { status: "unchanged" };
  const backupPath =
    original === undefined ? undefined : `${client.configPath}.rea.backup`;
  if (
    backupPath !== undefined &&
    !(await preserveConfigBackup(transactionPath, backupPath))
  )
    return { status: "failed", reason: "backup" };
  document.mcp_servers = {
    ...servers,
    [PRODUCT_IDENTITY.mcpServerKey]: desired,
  };
  try {
    await mkdir(dirname(client.configPath), { recursive: true });
    await writeFileAtomic(transactionPath, stringifyToml(document), {
      encoding: "utf8",
      mode: 0o600,
    });
    const readback = objectSchema.parse(
      parseToml(await readFile(transactionPath, "utf8")),
    );
    if (
      !sameConfiguration(
        parseOptionalObject(readback.mcp_servers)[
          PRODUCT_IDENTITY.mcpServerKey
        ],
        desired,
      )
    )
      throw new Error("TOML readback mismatch");
  } catch {
    await restoreConfig(transactionPath, original);
    return { status: "failed", reason: "readback" };
  }
  return {
    status: "configured",
    ...(backupPath === undefined ? {} : { backupPath }),
  };
};

/** Determine whether an existing client configuration matches the desired registration. */
export const clientConfigurationAligned = async (
  client: SetupClient,
  providerEnvironment: SetupProviderEnvironment,
  command: readonly string[],
): Promise<boolean> => {
  const desired = clientConfigurationDesired(providerEnvironment, command);
  try {
    const original = await readFile(client.configPath, "utf8");
    const document =
      client.format === "toml"
        ? objectSchema.parse(parseToml(original))
        : parseObject(original);
    const servers = parseOptionalObject(
      client.format === "toml" ? document.mcp_servers : document.mcpServers,
    );
    return sameConfiguration(servers[PRODUCT_IDENTITY.mcpServerKey], desired);
  } catch {
    return false;
  }
};

const objectSchema = z.record(z.string(), z.unknown());
const parseOptionalObject = (value: unknown): Record<string, unknown> =>
  value === undefined ? {} : objectSchema.parse(value);
const parseObject = (text: string): Record<string, unknown> =>
  objectSchema.parse(JSON.parse(text));
const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";
const sameConfiguration = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const preserveConfigBackup = async (
  source: string,
  destination: string,
): Promise<boolean> => {
  try {
    await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
    return true;
  } catch (cause: unknown) {
    return cause instanceof Error && "code" in cause && cause.code === "EEXIST";
  }
};

const restoreConfig = async (
  path: string,
  original: string | undefined,
): Promise<void> => {
  try {
    if (original === undefined) await rm(path, { force: true });
    else await writeFile(path, original, { encoding: "utf8", mode: 0o600 });
  } catch {
    // The backup remains available for the remediation reported by setup.
  }
};

const clientConfigurationDesired = (
  providerEnvironment: SetupProviderEnvironment,
  command: readonly string[],
) => {
  const environment = Object.fromEntries(
    Object.entries(providerEnvironment).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  return {
    command: command[0] ?? PRODUCT_IDENTITY.cliBinary,
    args: command.slice(1),
    ...(Object.keys(environment).length === 0 ? {} : { env: environment }),
  };
};

const normalizeProviderEnvironment = (
  environment: SetupProviderEnvironment | string,
): SetupProviderEnvironment =>
  typeof environment === "string"
    ? { HOPPER_LAUNCHER_PATH: environment }
    : environment;
