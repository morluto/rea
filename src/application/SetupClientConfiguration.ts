import { readClientPolicyBlock } from "./GeminiClientSettings.js";
import {
  readClientConfigurationFiles,
  readConfigurationText,
} from "./ClientConfigurationFiles.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  clientRegistrationEntry,
  clientConfigurationValuesEqual,
  clientServerListedDisabled,
  clientServerPath,
  legacyClientServerPath,
  OMP_DISABLED_SERVERS_KEY,
  parseClientConfiguration,
  parseZcodeFallbackConfiguration,
  serializeClientConfiguration,
  withClientServers,
  type ClientConfigurationDocument,
} from "./ClientConfigurationDocument.js";
import { dshDocument, DshCordisDocument } from "./DshCordisPatch.js";
import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { clientRegistrationEnvironment } from "./ClientRegistrationEnvironment.js";

import { PRODUCT_IDENTITY } from "../identity.js";
import { npxRegistrationCommand } from "./ClientRegistrationIdentity.js";
import { MCP_STARTUP_POLICY } from "../mcpStartupPolicy.js";
import { resolveClientConfigTransactionPath } from "./ClientConfigPath.js";
import { packageReadTargetChanged } from "./MsixPackageStorage.js";
import {
  readRegularFile,
  readRegularFileText,
  RegularFileCleanupFailure,
} from "./RegularFileRead.js";
import type { ClientConfigurationFileError } from "./ClientConfigurationFiles.js";
import type {
  ClientConfigurationInspection,
  ClientConfigurationResult,
  SetupProviderEnvironment,
} from "./SetupTypes.js";
import {
  registrationWriteBlocker,
  type SetupClient,
} from "./SupportedClients.js";

export class ClientConfigurationCleanupRollbackFailure extends RegularFileCleanupFailure<string> {
  constructor(
    failure: RegularFileCleanupFailure<string>,
    readonly configurationFailure: Extract<
      ClientConfigurationResult,
      { readonly status: "failed"; readonly reason: "rollback" }
    >,
  ) {
    super(
      failure.path,
      failure.owner,
      failure.outcome,
      new AggregateError(
        [failure.cleanupCause, new Error(configurationFailure.failure.detail)],
        `Configuration readback cleanup and rollback failed: ${configurationFailure.failure.path}`,
      ),
    );
  }
}

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
  const fallback = await readZcodeFallbackServers(client, parsed);
  if (!fallback.ok) {
    throwCleanupFailure(fallback.error);
    return { status: "failed", reason: "readback" };
  }
  const desired = clientConfigurationDesired(client, environment, command, {
    ...parsed,
    servers: { ...fallback.value, ...parsed.servers },
  });
  if (registrationCurrent(parsed, desired)) return { status: "unchanged" };
  return persistClientConfiguration({
    client,
    transactionPath,
    format,
    original,
    parsed,
    desired,
    fallbackServers: fallback.value,
  });
};

interface ClientConfigurationUpdate {
  readonly client: SetupClient;
  readonly transactionPath: string;
  readonly format: NonNullable<SetupClient["format"]>;
  readonly original: string | undefined;
  readonly parsed: ClientConfigurationDocument;
  readonly desired: unknown;
  readonly fallbackServers: Readonly<Record<string, unknown>>;
}

const persistClientConfiguration = async ({
  client,
  transactionPath,
  format,
  original,
  parsed,
  desired,
  fallbackServers,
}: ClientConfigurationUpdate): Promise<ClientConfigurationResult> => {
  // The plan chose this file; an MSIX package may have switched to its
  // private copy since, for example when it quit.
  if (
    client.msixPackage !== undefined &&
    (await packageReadTargetChanged(client.msixPackage, client.configPath))
  )
    return { status: "failed", reason: "target_changed" };
  const backupPath =
    original === undefined ? undefined : `${client.configPath}.rea.backup`;
  let recoveryBackupPath: string | undefined;
  if (backupPath !== undefined && original !== undefined) {
    const selection = await selectCurrentRecoveryBackup(backupPath, original);
    if (!selection.ok) return { status: "failed", reason: "backup" };
    if (
      !(await preserveConfigBackup(transactionPath, selection.value.backupPath))
    )
      return { status: "failed", reason: "backup" };
    const verified = await selectCurrentRecoveryBackup(backupPath, original);
    if (
      !verified.ok ||
      verified.value.backupPath !== selection.value.backupPath ||
      !verified.value.present
    )
      return { status: "failed", reason: "backup" };
    recoveryBackupPath = verified.value.backupPath;
  }
  // A native OpenCode V2 entry replaces REA's legacy V1 entry, which would
  // otherwise conflict with it.
  const legacyPath = legacyClientServerPath(
    parsed,
    PRODUCT_IDENTITY.mcpServerKey,
  );
  const registered = withClientServers(
    parsed,
    {
      ...fallbackServers,
      ...parsed.servers,
      [PRODUCT_IDENTITY.mcpServerKey]: desired,
    },
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
        ...Object.keys(fallbackServers)
          .filter((name) => name !== PRODUCT_IDENTITY.mcpServerKey)
          .map((name) => clientServerPath(parsed, name)),
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
    if (
      !registrationCurrent(readback, desired) ||
      Object.entries(fallbackServers).some(
        ([name, entry]) =>
          name !== PRODUCT_IDENTITY.mcpServerKey &&
          !clientConfigurationValuesEqual(readback.servers[name], entry),
      )
    ) {
      return rollbackOrReadbackFailure(
        transactionPath,
        original,
        recoveryBackupPath,
      );
    }
  } catch (cause: unknown) {
    if (cause instanceof RegularFileCleanupFailure) {
      const rollback = await restoreConfig(transactionPath, original);
      if (!rollback.ok)
        throw new ClientConfigurationCleanupRollbackFailure(cause, {
          status: "failed",
          reason: "rollback",
          ...(recoveryBackupPath === undefined
            ? {}
            : { backupPath: recoveryBackupPath }),
          failure: rollback.error,
        });
      throw cause;
    }
    // Readback failure restores the transaction before reporting.
    void cause;
    return rollbackOrReadbackFailure(
      transactionPath,
      original,
      recoveryBackupPath,
    );
  }
  return {
    status: "configured",
    ...(recoveryBackupPath === undefined
      ? {}
      : { backupPath: recoveryBackupPath }),
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
  const inspection = await inspectClientDocument(
    client,
    providerEnvironment,
    command,
  );
  if (inspection.status !== "create" && inspection.status !== "update")
    return inspection;
  // A change the running client would overwrite is not a persisted registration.
  const blocker = registrationWriteBlocker(client, "setup");
  return blocker === undefined
    ? inspection
    : { status: "invalid", remediation: blocker };
};

const inspectClientDocument = async (
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
    if (isMissing(cause)) {
      const fallback = await readZcodeFallbackServers(client);
      if (!fallback.ok) {
        throwCleanupFailure(fallback.error);
        return { status: "invalid", remediation: fallback.error.detail };
      }
      return { status: "create" };
    }
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
    const fallback = await readZcodeFallbackServers(client, parsed);
    if (!fallback.ok) {
      throwCleanupFailure(fallback.error);
      return { status: "invalid", remediation: fallback.error.detail };
    }
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
  const backupSelection = await selectCurrentRecoveryBackup(
    `${client.configPath}.rea.backup`,
    original,
  );
  if (!backupSelection.ok)
    return {
      status: "invalid",
      remediation: backupSelection.error.detail,
    };
  return {
    status: "update",
    backupPath: backupSelection.value.backupPath,
  };
};

const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

const throwCleanupFailure = (error: ClientConfigurationFileError): void => {
  if (error.cleanupFailure !== undefined) throw error.cleanupFailure;
};

/** Admit the fallback only when the first native ZCode server would suppress it. */
const readZcodeFallbackServers = async (
  client: SetupClient,
  parsed?: ClientConfigurationDocument,
): Promise<
  Result<Readonly<Record<string, unknown>>, ClientConfigurationFileError>
> => {
  if (
    client.format !== "zcode" ||
    (parsed !== undefined && Object.keys(parsed.servers).length > 0)
  )
    return ok({});
  const path = client.zcodeFallbackPath;
  const detail = `The ZCode fallback configuration ${path ?? "path"} is unresolved, malformed or unreadable. Repair it before rerunning setup: the first native server would suppress that fallback.`;
  if (path === undefined)
    return err({ kind: "unreadable", path: client.configPath, detail });
  const transactionPath = await resolveClientConfigTransactionPath(path);
  if (transactionPath === undefined)
    return err({ kind: "unreadable", path, detail });
  const source = await readConfigurationText(transactionPath);
  if (!source.ok)
    return err({ ...source.error, detail: `${detail} ${source.error.detail}` });
  if (source.value === undefined) return ok({});
  try {
    const parsed = parseZcodeFallbackConfiguration(source.value);
    const environment = clientRegistrationEnvironment(parsed);
    if (!environment.ok)
      return err({
        kind: "malformed",
        path,
        detail: `${detail} ${environment.error.settings.map(({ setting, constraint }) => `${setting}: ${constraint}`).join("; ")}`,
      });
    return ok(parsed.servers);
  } catch (cause: unknown) {
    return err({
      kind: "malformed",
      path,
      detail: `${detail} ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }
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

interface RecoveryBackupSelection {
  readonly backupPath: string;
  readonly present: boolean;
}

interface RecoveryBackupSelectionFailure {
  readonly kind: "unreadable" | "occupied";
  readonly path: string;
  readonly detail: string;
}

const selectCurrentRecoveryBackup = async (
  firstBackupPath: string,
  original: string,
): Promise<Result<RecoveryBackupSelection, RecoveryBackupSelectionFailure>> => {
  const expected = Buffer.from(original, "utf8");
  let firstBackup: Buffer | undefined;
  try {
    firstBackup = await readRegularFile(firstBackupPath, {
      symlinks: "reject",
    });
  } catch (cause: unknown) {
    if (cause instanceof RegularFileCleanupFailure) throw cause;
    if (!isMissing(cause))
      return err({
        kind: "unreadable",
        path: firstBackupPath,
        detail: `The recovery backup could not be checked: ${errorDetail(cause)}`,
      });
  }
  if (firstBackup === undefined)
    return ok({ backupPath: firstBackupPath, present: false });
  if (firstBackup.equals(expected))
    return ok({ backupPath: firstBackupPath, present: true });

  const digest = createHash("sha256").update(original, "utf8").digest("hex");
  const recoveryPath = `${firstBackupPath}.${digest}.recovery`;
  let recovery: Buffer | undefined;
  try {
    recovery = await readRegularFile(recoveryPath, { symlinks: "reject" });
  } catch (cause: unknown) {
    if (cause instanceof RegularFileCleanupFailure) throw cause;
    if (!isMissing(cause))
      return err({
        kind: "unreadable",
        path: recoveryPath,
        detail: `The recovery backup could not be checked: ${errorDetail(cause)}`,
      });
  }
  if (recovery !== undefined && !recovery.equals(expected))
    return err({
      kind: "occupied",
      path: recoveryPath,
      detail: `The recovery path already contains different data: ${recoveryPath}`,
    });
  return ok({ backupPath: recoveryPath, present: recovery !== undefined });
};

const restoreConfig = async (
  path: string,
  original: string | undefined,
): Promise<
  Result<
    void,
    { readonly kind: "restore"; readonly path: string; readonly detail: string }
  >
> => {
  try {
    if (original === undefined) await rm(path, { force: true });
    else await writeFile(path, original, { encoding: "utf8", mode: 0o600 });
    return ok(undefined);
  } catch (cause: unknown) {
    return err({ kind: "restore", path, detail: errorDetail(cause) });
  }
};

const rollbackOrReadbackFailure = async (
  targetPath: string,
  original: string | undefined,
  backupPath: string | undefined,
): Promise<ClientConfigurationResult> => {
  const rollback = await restoreConfig(targetPath, original);
  return rollback.ok
    ? { status: "failed", reason: "readback" }
    : {
        status: "failed",
        reason: "rollback",
        ...(backupPath === undefined ? {} : { backupPath }),
        failure: rollback.error,
      };
};

const errorDetail = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

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
