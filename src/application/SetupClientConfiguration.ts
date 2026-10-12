import { readClientPolicyBlock } from "./GeminiClientSettings.js";
import { readClientConfigurationFiles } from "./ClientConfigurationFiles.js";
import {
  clientRegistrationEntry,
  clientConfigurationValuesEqual,
  clientServerListedDisabled,
  clientServerPath,
  legacyClientServerPath,
  OMP_DISABLED_SERVERS_KEY,
  parseClientConfiguration,
  serializeClientConfiguration,
  withClientServers,
  type ClientConfigurationDocument,
} from "./ClientConfigurationDocument.js";
import { dshDocument, DshCordisDocument } from "./DshCordisPatch.js";
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { clientRegistrationEnvironment } from "./ClientRegistrationEnvironment.js";

import { PRODUCT_IDENTITY } from "../identity.js";
import { npxRegistrationCommand } from "./ClientRegistrationIdentity.js";
import { MCP_STARTUP_POLICY } from "../mcpStartupPolicy.js";
import { resolveClientConfigTransactionPath } from "./ClientConfigPath.js";
import {
  readRegularFileText,
  RegularFileCleanupFailure,
} from "./RegularFileRead.js";
import type { ClientConfigurationFileError } from "./ClientConfigurationFiles.js";
import type {
  ClientConfigurationInspection,
  ClientConfigurationResult,
  SetupProviderEnvironment,
} from "./SetupTypes.js";
import type { SetupClient } from "./SupportedClients.js";

/** Configure one supported client's native stdio MCP registration shape. */
export const configureClientConfiguration = (
  client: SetupClient,
  environment: SetupProviderEnvironment = {},
  command: readonly string[] = npxRegistrationCommand(),
): Promise<ClientConfigurationResult> => {
  if (client.configPathError !== undefined)
    return Promise.resolve({ status: "failed", reason: "path" });
  return configureClientDocument(client, environment, command);
};

const configureClientDocument = async (
  client: SetupClient,
  environment: SetupProviderEnvironment,
  command: readonly string[],
): Promise<ClientConfigurationResult> => {
  const format = client.format;
  if (format === undefined || format === "unsupported")
    return { status: "failed", reason: "readback" };
  const files = await readClientConfigurationFiles(client);
  if (!files.ok) {
    throwCleanupFailure(files.error);
    return { status: "failed", reason: "readback" };
  }
  const existing = files.value.at(-1);
  const editabilityError =
    existing?.dialect === "dsh"
      ? dshDocument(existing.document).editabilityError
      : undefined;
  if (editabilityError !== undefined)
    return { status: "failed", reason: "readback" };
  const policy = await readClientPolicyBlock(
    client,
    undefined,
    clientConfigurationDesired(
      client,
      environment,
      command,
      files.value.at(-1),
    ),
  );
  if (!policy.ok) {
    throwCleanupFailure(policy.error);
    return { status: "failed", reason: "readback" };
  }
  if (policy.value !== undefined)
    return { status: "failed", reason: "readback" };
  const transactionPath = await resolveClientConfigTransactionPath(
    client.configPath,
  );
  if (transactionPath === undefined)
    return { status: "failed", reason: "path" };
  let original: string | undefined;
  try {
    original = await readRegularFileText(transactionPath);
  } catch (cause: unknown) {
    if (cause instanceof RegularFileCleanupFailure) throw cause;
    if (!isMissing(cause)) return { status: "failed", reason: "readback" };
  }
  let parsed: ClientConfigurationDocument;
  try {
    parsed = parseClientConfiguration(
      original ??
        (format === "toml" || format === "grok" || format === "dsh"
          ? ""
          : "{}"),
      format,
    );
    const policy = await readClientPolicyBlock(
      client,
      parsed,
      clientConfigurationDesired(client, environment, command, parsed),
    );
    if (!policy.ok) {
      throwCleanupFailure(policy.error);
      return { status: "failed", reason: "readback" };
    }
    if (policy.value !== undefined)
      return { status: "failed", reason: "readback" };
  } catch (cause: unknown) {
    if (cause instanceof RegularFileCleanupFailure) throw cause;
    // Malformed existing configuration fails the readback gate.
    void cause;
    return { status: "failed", reason: "readback" };
  }
  const desired = clientConfigurationDesired(
    client,
    environment,
    command,
    parsed,
  );
  if (registrationCurrent(parsed, desired)) return { status: "unchanged" };
  return persistClientConfiguration({
    client,
    transactionPath,
    format,
    original,
    parsed,
    desired,
  });
};

interface ClientConfigurationUpdate {
  readonly client: SetupClient;
  readonly transactionPath: string;
  readonly format: NonNullable<SetupClient["format"]>;
  readonly original: string | undefined;
  readonly parsed: ClientConfigurationDocument;
  readonly desired: unknown;
}

const persistClientConfiguration = async ({
  client,
  transactionPath,
  format,
  original,
  parsed,
  desired,
}: ClientConfigurationUpdate): Promise<ClientConfigurationResult> => {
  const backupPath =
    original === undefined ? undefined : `${client.configPath}.rea.backup`;
  if (
    backupPath !== undefined &&
    !(await preserveConfigBackup(transactionPath, backupPath))
  )
    return { status: "failed", reason: "backup" };
  // A native OpenCode V2 entry replaces REA's legacy V1 entry, which would
  // otherwise conflict with it.
  const legacyPath = legacyClientServerPath(
    parsed,
    PRODUCT_IDENTITY.mcpServerKey,
  );
  const registered = withClientServers(
    parsed,
    { ...parsed.servers, [PRODUCT_IDENTITY.mcpServerKey]: desired },
    PRODUCT_IDENTITY.mcpServerKey,
  );
  // OMP's denylist would hide the registration; keep every other listed name.
  const ompDisabled =
    parsed.dialect === "omp"
      ? parsed.document[OMP_DISABLED_SERVERS_KEY]
      : undefined;
  const enableOmp =
    Array.isArray(ompDisabled) &&
    ompDisabled.includes(PRODUCT_IDENTITY.mcpServerKey);
  const document =
    enableOmp && Array.isArray(ompDisabled)
      ? {
          ...registered,
          [OMP_DISABLED_SERVERS_KEY]: ompDisabled.filter(
            (name: unknown) => name !== PRODUCT_IDENTITY.mcpServerKey,
          ),
        }
      : registered;
  try {
    await mkdir(dirname(client.configPath), { recursive: true });
    await writeFileAtomic(
      transactionPath,
      serializeClientConfiguration(document, format, original, [
        clientServerPath(parsed, PRODUCT_IDENTITY.mcpServerKey),
        ...(legacyPath === undefined ? [] : [legacyPath]),
        ...(enableOmp ? [[OMP_DISABLED_SERVERS_KEY]] : []),
      ]),
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
      await readRegularFileText(transactionPath),
      format,
    );
    if (!registrationCurrent(readback, desired)) {
      await restoreConfig(transactionPath, original);
      return { status: "failed", reason: "readback" };
    }
  } catch (cause: unknown) {
    if (cause instanceof RegularFileCleanupFailure) throw cause;
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
  if (client.configPathError !== undefined) return false;
  try {
    const files = await readClientConfigurationFiles(client);
    if (!files.ok) {
      throwCleanupFailure(files.error);
      return false;
    }
    const original = await readRegularFileText(client.configPath);
    const parsed = parseClientConfiguration(original, client.format);
    const policy = await readClientPolicyBlock(
      client,
      parsed,
      clientConfigurationDesired(client, providerEnvironment, command, parsed),
    );
    if (!policy.ok) {
      throwCleanupFailure(policy.error);
      return false;
    }
    return (
      policy.value === undefined &&
      registrationCurrent(
        parsed,
        clientConfigurationDesired(
          client,
          providerEnvironment,
          command,
          parsed,
        ),
      )
    );
  } catch (cause: unknown) {
    if (cause instanceof RegularFileCleanupFailure) throw cause;
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
  if (client.configPathError !== undefined)
    return { status: "invalid", remediation: client.configPathError };
  if (client.format === "unsupported") return { status: "already_current" };
  const files = await readClientConfigurationFiles(client);
  if (!files.ok) {
    throwCleanupFailure(files.error);
    return {
      status: "invalid",
      remediation: files.error.detail,
    };
  }
  const existing = files.value.at(-1);
  const editabilityError =
    existing?.dialect === "dsh"
      ? dshDocument(existing.document).editabilityError
      : undefined;
  if (editabilityError !== undefined)
    return {
      status: "invalid",
      remediation: editabilityError.message,
    };
  const policy = await readClientPolicyBlock(
    client,
    undefined,
    clientConfigurationDesired(client, providerEnvironment, command, existing),
  );
  if (!policy.ok) {
    throwCleanupFailure(policy.error);
    return {
      status: "invalid",
      remediation: policy.error.detail,
    };
  }
  if (policy.value !== undefined)
    return { status: "invalid", remediation: policy.value };
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
    original = await readRegularFileText(transactionPath);
  } catch (cause: unknown) {
    if (cause instanceof RegularFileCleanupFailure) throw cause;
    if (isMissing(cause)) return { status: "create" };
    return {
      status: "invalid",
      remediation: `The configuration file could not be read. Check its permissions before rerunning setup. ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  try {
    const parsed = parseClientConfiguration(original, client.format);
    const policy = await readClientPolicyBlock(
      client,
      parsed,
      clientConfigurationDesired(client, providerEnvironment, command, parsed),
    );
    if (!policy.ok) {
      throwCleanupFailure(policy.error);
      return {
        status: "invalid",
        remediation: policy.error.detail,
      };
    }
    if (policy.value !== undefined)
      return { status: "invalid", remediation: policy.value };
    const desired = clientConfigurationDesired(
      client,
      providerEnvironment,
      command,
      parsed,
    );
    if (registrationCurrent(parsed, desired))
      return { status: "already_current" };
  } catch (cause: unknown) {
    if (cause instanceof RegularFileCleanupFailure) throw cause;
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

const throwCleanupFailure = (error: ClientConfigurationFileError): void => {
  if (error.cleanupFailure !== undefined) throw error.cleanupFailure;
};

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

/** Whether REA's entry matches, no legacy entry remains, and no client disable list suppresses it. */
const registrationCurrent = (
  parsed: ClientConfigurationDocument,
  desired: unknown,
): boolean =>
  (parsed.dialect !== "dsh" || dshDocument(parsed.document).ready) &&
  clientConfigurationValuesEqual(
    parsed.servers[PRODUCT_IDENTITY.mcpServerKey],
    desired,
  ) &&
  !Object.hasOwn(parsed.legacyServers, PRODUCT_IDENTITY.mcpServerKey) &&
  !clientServerListedDisabled(parsed, PRODUCT_IDENTITY.mcpServerKey);

const clientConfigurationDesired = (
  client: SetupClient,
  providerEnvironment: SetupProviderEnvironment,
  command: readonly string[],
  parsed?: ClientConfigurationDocument,
) => {
  const format = parsed?.dialect ?? client.format ?? "json";
  const launcher =
    command.length === 0 ? [PRODUCT_IDENTITY.cliBinary, "mcp"] : command;
  if (format === "dsh") {
    const desired = (
      parsed === undefined
        ? new DshCordisDocument("")
        : dshDocument(parsed.document)
    ).desired(launcher, providerEnvironment);
    if (!desired.ok) throw desired.error;
    return desired.value;
  }
  // Preserve explicitly configured server settings, never the ambient process
  // environment. Newly discovered provider paths win only for their own keys.
  const environment = clientRegistrationEnvironment(
    parsed,
    providerEnvironment,
  );
  if (!environment.ok) throw environment.error;
  const registration = clientRegistrationEntry(
    format,
    launcher,
    environment.value,
  );
  return {
    ...registration,
    ...(client.name === "codex" || client.name === "grok_build"
      ? {
          startup_timeout_sec: MCP_STARTUP_POLICY.codexStartupTimeoutSeconds,
        }
      : {}),
  };
};
