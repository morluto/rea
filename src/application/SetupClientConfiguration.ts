import {
  clientRegistrationEntry,
  clientConfigurationValuesEqual,
  parseClientConfiguration,
  serializeClientConfiguration,
  type ClientConfigurationDocument,
} from "./ClientConfigurationDocument.js";
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import writeFileAtomic from "write-file-atomic";

import { PRODUCT_IDENTITY } from "../identity.js";
import { MCP_STARTUP_POLICY } from "../mcpStartupPolicy.js";
import { resolveClientConfigTransactionPath } from "./ClientConfigPath.js";
import type {
  ClientConfigurationInspection,
  ClientConfigurationResult,
  SetupProviderEnvironment,
} from "./SetupTypes.js";
import type { SetupClient } from "./SupportedClients.js";

const defaultCommand = (): readonly string[] => [
  "npx",
  "-y",
  PRODUCT_IDENTITY.registrationPackageSpecifier,
  "mcp",
];

/** Back up, atomically update, and semantically read back one JSON MCP configuration. */
export const configureJsonClient = (
  client: SetupClient,
  environment: SetupProviderEnvironment = {},
  command: readonly string[] = defaultCommand(),
): Promise<ClientConfigurationResult> =>
  configureClientDocument(client, environment, command, "json");

/** Back up, atomically update, and semantically read back one TOML MCP configuration. */
export const configureTomlClient = (
  client: SetupClient,
  environment: SetupProviderEnvironment = {},
  command: readonly string[] = defaultCommand(),
): Promise<ClientConfigurationResult> =>
  configureClientDocument(client, environment, command, "toml");

/** Configure one supported client's native stdio MCP registration shape. */
export const configureClientConfiguration = (
  client: SetupClient,
  environment: SetupProviderEnvironment = {},
  command: readonly string[] = defaultCommand(),
): Promise<ClientConfigurationResult> => {
  if (client.format === undefined || client.format === "unsupported")
    return Promise.resolve({ status: "failed", reason: "readback" });
  return configureClientDocument(client, environment, command, client.format);
};

const configureClientDocument = async (
  client: SetupClient,
  environment: SetupProviderEnvironment,
  command: readonly string[],
  format: NonNullable<SetupClient["format"]>,
): Promise<ClientConfigurationResult> => {
  const transactionPath = await resolveClientConfigTransactionPath(
    client.configPath,
  );
  if (transactionPath === undefined)
    return { status: "failed", reason: "path" };
  let original: string | undefined;
  try {
    original = await readFile(transactionPath, "utf8");
  } catch (cause: unknown) {
    if (!isMissing(cause)) return { status: "failed", reason: "readback" };
  }
  let parsed: ClientConfigurationDocument;
  try {
    parsed = parseClientConfiguration(
      original ?? (format === "toml" ? "" : "{}"),
      format,
    );
  } catch (cause: unknown) {
    // Malformed existing configuration fails the readback gate.
    void cause;
    return { status: "failed", reason: "readback" };
  }
  const { document, servers, serversKey } = parsed;
  const desired = clientConfigurationDesired(
    client,
    environment,
    command,
    format,
  );
  if (
    clientConfigurationValuesEqual(
      servers[PRODUCT_IDENTITY.mcpServerKey],
      desired,
    )
  )
    return { status: "unchanged" };
  const backupPath =
    original === undefined ? undefined : `${client.configPath}.rea.backup`;
  if (
    backupPath !== undefined &&
    !(await preserveConfigBackup(transactionPath, backupPath))
  )
    return { status: "failed", reason: "backup" };
  document[serversKey] = {
    ...servers,
    [PRODUCT_IDENTITY.mcpServerKey]: desired,
  };
  try {
    await mkdir(dirname(client.configPath), { recursive: true });
    await writeFileAtomic(
      transactionPath,
      serializeClientConfiguration(
        document,
        format,
        original,
        PRODUCT_IDENTITY.mcpServerKey,
      ),
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
  } catch (cause: unknown) {
    // Write failure is reported by the status reason.
    void cause;
    return { status: "failed", reason: "write" };
  }
  try {
    const readback = parseClientConfiguration(
      await readFile(transactionPath, "utf8"),
      format,
    );
    if (
      !clientConfigurationValuesEqual(
        readback.servers[PRODUCT_IDENTITY.mcpServerKey],
        desired,
      )
    ) {
      await restoreConfig(transactionPath, original);
      return { status: "failed", reason: "readback" };
    }
  } catch (cause: unknown) {
    // Readback failure restores the transaction before reporting.
    void cause;
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
  const desired = clientConfigurationDesired(
    client,
    providerEnvironment,
    command,
    client.format,
  );
  try {
    const original = await readFile(client.configPath, "utf8");
    const { servers } = parseClientConfiguration(original, client.format);
    return clientConfigurationValuesEqual(
      servers[PRODUCT_IDENTITY.mcpServerKey],
      desired,
    );
  } catch (cause: unknown) {
    // Unreadable configuration is treated as not aligned so setup repairs it.
    void cause;
    return false;
  }
};

/** Preflight one client configuration before setup presents any mutations. */
export const inspectClientConfiguration = async (
  client: SetupClient,
  providerEnvironment: SetupProviderEnvironment,
  command: readonly string[],
): Promise<ClientConfigurationInspection> => {
  if (client.format === "unsupported") return { status: "already_current" };
  const transactionPath = await resolveClientConfigTransactionPath(
    client.configPath,
  );
  if (transactionPath === undefined)
    return {
      status: "invalid",
      remediation:
        "The configuration path is unsafe or unresolved. Check ownership and symbolic links before rerunning setup.",
    };
  let original: string;
  try {
    original = await readFile(transactionPath, "utf8");
  } catch (cause: unknown) {
    if (isMissing(cause)) return { status: "create" };
    return {
      status: "invalid",
      remediation:
        "The configuration file could not be read. Check its permissions before rerunning setup.",
    };
  }
  const desired = clientConfigurationDesired(
    client,
    providerEnvironment,
    command,
    client.format,
  );
  try {
    const { servers } = parseClientConfiguration(original, client.format);
    if (
      clientConfigurationValuesEqual(
        servers[PRODUCT_IDENTITY.mcpServerKey],
        desired,
      )
    )
      return { status: "already_current" };
  } catch (cause: unknown) {
    // Malformed configuration is reported with the invalid remediation.
    void cause;
    return {
      status: "invalid",
      remediation:
        "The existing configuration is malformed. Repair it before setup applies any other changes.",
    };
  }
  return {
    status: "update",
    backupPath: `${client.configPath}.rea.backup`,
  };
};

const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";
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
  } catch (cause: unknown) {
    // The backup remains available for the remediation reported by setup.
    void cause;
  }
};

const clientConfigurationDesired = (
  client: SetupClient,
  providerEnvironment: SetupProviderEnvironment,
  command: readonly string[],
  format: NonNullable<SetupClient["format"]> | undefined,
) => {
  const environment = Object.fromEntries(
    Object.entries(providerEnvironment).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  const registration = clientRegistrationEntry(
    format ?? "json",
    command.length === 0 ? [PRODUCT_IDENTITY.cliBinary, "mcp"] : command,
    environment,
  );
  return {
    ...registration,
    ...(client.name === "codex"
      ? {
          startup_timeout_sec: MCP_STARTUP_POLICY.codexStartupTimeoutSeconds,
        }
      : {}),
  };
};
