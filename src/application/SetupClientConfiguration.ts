import type { ArtifactResourceScope } from "../resources/index.js";
import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import { readClientPolicyBlock } from "./GeminiClientSettings.js";
import {
  readClientConfigurationFiles,
  inlineRegistrationEnvironment,
  inlineRegistrationOrigins,
  inlineRegistrationOverride,
  clientConfigurationForWrite,
  clientWriteDialect,
  effectiveClientConfiguration,
  readConfigurationText,
  type ClientConfigurationSource,
  type ClientConfigurationFileError,
} from "./ClientConfigurationFiles.js";
import { err, ok, type Result } from "../domain/result.js";
import type { ConfigurationError } from "../domain/configurationErrors.js";
import {
  effectiveClientServer,
  clientServerListedDisabled,
  clientServerPath,
  legacyClientServerPath,
  shadowedClientServers,
  OMP_DISABLED_SERVERS_KEY,
  parseClientConfiguration,
  serializeClientConfiguration,
  withClientServers,
  type ClientConfigurationDocument,
  type ClientInlineConfiguration,
  type ClientRegistrationDialect,
} from "./ClientConfigurationDocument.js";
import { clientConfigurationValuesEqual } from "./ClientConfigurationValues.js";
import { DISCOVERED_REGISTRATION_SETTINGS } from "./SetupRegistrationEnvironment.js";
import { registrationEnvironmentProposal } from "./UserConfigurationLocation.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import { dshDocument, DshCordisDocument } from "./DshCordisPatch.js";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ClientPrivateProfileError,
  PRIVATE_PROFILE_MODES,
  privateProfileModesCurrent,
  securePrivateDirectory,
} from "./ClientPrivateProfile.js";
import { RegularFileChangedError } from "../filesystem/RegularFile.js";
import { withClientConfigurationTransaction } from "./ClientConfigurationTransaction.js";
import { isClientConfigurationCleanupFailure } from "./ClientConfigurationCleanup.js";
import {
  ClientConfigurationPublication,
  ClientConfigurationWriteError,
} from "./ClientConfigurationPublication.js";
import {
  clientRegistrationEnvironment,
  clientRegistrationEnvironmentDetailsWithBudget,
  type ProviderRequestBudgetResolver,
} from "./ClientRegistrationEnvironment.js";

import {
  clientRegistrationOwnership,
  clientRegistrationOwnershipRemediation,
  refreshClientRegistration,
} from "./ClientRegistration.js";
import { recommendedMcpToolTimeoutMs } from "../config/mcpStartupPolicy.js";

import { PRODUCT_IDENTITY } from "../identity.js";
import { currentClientRegistrationCommand } from "./ClientRegistrationIdentity.js";
import {
  isEnoentError,
  resolveClientConfigTransactionPath,
} from "./ClientConfigPath.js";
import { packageReadTargetChanged } from "./MsixPackageStorage.js";
import { RegularFileCleanupFailure } from "../filesystem/OwnedRegularFile.js";
import {
  readRegularFileText,
  readRegularFileTextSnapshot,
  InvalidUtf8FileError,
} from "../process/RegularFileRead.js";
import {
  preserveCurrentRecoveryBackup,
  selectCurrentRecoveryBackup,
} from "./SetupRecoveryBackup.js";
import { preservePrivateRecoveryBackup } from "./ClientRegistrationBackup.js";
import type {
  ClientConfigurationInspection,
  ClientConfigurationResult,
  SetupProviderEnvironment,
} from "./SetupTypes.js";
import {
  registrationWriteBlocker,
  type SetupClient,
} from "./SupportedClients.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { isRecord } from "../kernel/isRecord.js";

export class ClientConfigurationCleanupRollbackFailure extends RegularFileCleanupFailure<string> {
  constructor(
    failure: RegularFileCleanupFailure<string>,
    readonly configurationFailure: Extract<
      ClientConfigurationResult,
      { readonly status: "failed" }
    >,
  ) {
    super({
      ...failure,
      cleanupCause: new AggregateError(
        [failure.cleanupCause, configurationFailure],
        `Configuration readback cleanup and rollback failed: ${failure.path}`,
      ),
    });
  }
}

/** Configure one supported client's native stdio MCP registration shape. */
export const configureClientConfiguration = async (
  client: SetupClient,
  environment: SetupProviderEnvironment = {},
  command: readonly string[] = currentClientRegistrationCommand(),
  resolveProviderRequestBudget?: ProviderRequestBudgetResolver,
  // Setup writes the running host's client files unless its host selects one.
  platform: NodeJS.Platform = HOST_PLATFORM.platform,
  launcherEnvironment: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<ClientConfigurationResult> => {
  if (command.length === 0)
    return {
      status: "failed",
      reason: "registration_ownership",
      detail:
        "The running REA entrypoint could not be identified; run setup from an installed REA command.",
    };
  if (client.configPathError !== undefined)
    return { status: "failed", reason: "path" };
  const transactionPath = await resolveClientConfigTransactionPath(
    client.configPath,
  );
  if (transactionPath === undefined)
    return { status: "failed", reason: "path" };
  return withClientConfigurationTransaction(transactionPath, () =>
    configureClientDocument(
      { client, transactionPath, platform, launcherEnvironment },
      environment,
      command,
      resolveProviderRequestBudget,
    ),
  );
};

const configurationRemediation = (error: ConfigurationError): string =>
  error.settings.length === 0
    ? error.message
    : `${error.message}: ${error.settings.map(({ setting, constraint }) => `${setting}: ${constraint}`).join("; ")}`;

const configureClientDocument = async (
  {
    client,
    transactionPath,
    platform,
    launcherEnvironment,
  }: {
    readonly client: SetupClient;
    readonly transactionPath: string;
    readonly platform: NodeJS.Platform;
    readonly launcherEnvironment: Readonly<NodeJS.ProcessEnv>;
  },
  environment: SetupProviderEnvironment,
  command: readonly string[],
  resolveProviderRequestBudget?: ProviderRequestBudgetResolver,
): Promise<ClientConfigurationResult> => {
  const format = client.format;
  if (format === undefined || format === "unsupported")
    return { status: "failed", reason: "readback" };
  const files = await readClientConfigurationFiles(
    client,
    undefined,
    platform,
    { writeOverrides: environment },
  );
  if (!files.ok) {
    throwCleanupFailure(files.error);
    return { status: "failed", reason: "readback" };
  }
  const existing = files.value.find(
    ({ sourcePath }) => sourcePath === client.configPath,
  );
  const editabilityError =
    existing?.dialect === "dsh"
      ? dshDocument(existing.document).editabilityError
      : undefined;
  if (editabilityError !== undefined)
    return { status: "failed", reason: "readback" };
  // Policy admission belongs to the transaction snapshot below, not the
  // earlier layered discovery document.
  let snapshot:
    | Awaited<ReturnType<typeof readRegularFileTextSnapshot>>
    | undefined;
  try {
    snapshot = await readRegularFileTextSnapshot(transactionPath, {
      symlinks: "reject",
    });
  } catch (cause: unknown) {
    if (cause instanceof RegularFileCleanupFailure) throw cause;
    if (!isEnoentError(cause)) return { status: "failed", reason: "readback" };
  }
  const original = snapshot?.text;
  const document = parseClientConfiguration(
    original ??
      (format === "toml" || format === "grok" || format === "dsh" ? "" : "{}"),
    format,
  );
  if (!document.ok) return { status: "failed", reason: "readback" };
  const writeDocument = clientConfigurationForWrite(
    document.value,
    files.value,
  );
  if (!writeDocument.ok)
    return {
      status: "failed",
      reason: "invalid_configuration",
      detail: configurationRemediation(writeDocument.error),
    };
  const parsed = writeDocument.value;
  const ownershipBlocker = registrationOwnershipBlocker(
    client,
    parsed,
    original ?? "",
    files.value,
    platform,
  );
  if (ownershipBlocker !== undefined)
    return {
      status: "failed",
      reason: "registration_ownership",
      detail: ownershipBlocker,
    };
  const policyEntry = await clientConfigurationDesired(
    client,
    environment,
    command,
    parsed,
    files.value,
    platform,
    launcherEnvironment,
    resolveProviderRequestBudget,
  );
  if (!policyEntry.ok) return desiredReadbackFailure(policyEntry.error);
  const policy = await readClientPolicyBlock(client, parsed, policyEntry.value);
  if (!policy.ok) {
    throwCleanupFailure(policy.error);
    return { status: "failed", reason: "readback" };
  }
  if (policy.value !== undefined)
    return { status: "failed", reason: "readback" };
  const fallback = await readZcodeFallbackServers(client, platform, parsed);
  if (!fallback.ok) {
    if (fallback.error.kind !== "registration_ownership")
      throwCleanupFailure(fallback.error);
    return fallback.error.kind === "registration_ownership"
      ? {
          status: "failed",
          reason: "registration_ownership",
          detail: fallback.error.detail,
        }
      : { status: "failed", reason: "readback" };
  }
  const desiredResult = await clientConfigurationDesired(
    client,
    environment,
    command,
    {
      ...parsed,
      servers: { ...fallback.value, ...parsed.servers },
    },
    files.value,
    platform,
    launcherEnvironment,
    resolveProviderRequestBudget,
  );
  if (!desiredResult.ok) return desiredReadbackFailure(desiredResult.error);
  const desired = desiredResult.value;
  // The settings written now can differ from the ones inspection admitted,
  // for example a Hopper path set by an installation earlier in this setup.
  const override = inlineOverrideBlocker(
    client,
    files.value,
    desired,
    platform,
  );
  if (override !== undefined)
    return { status: "failed", reason: "read_only_override", detail: override };
  if (
    registrationCurrent(parsed, desired) &&
    (await privateProfileCurrent(client, original))
  )
    return { status: "unchanged" };
  return persistClientConfiguration({
    client,
    transactionPath,
    snapshot,
    format,
    original,
    parsed,
    desired,
    fallbackServers: fallback.value,
    platform,
  });
};

const desiredReadbackFailure = (
  error: ConfigurationError,
): ClientConfigurationResult => {
  if (error.cleanupIncomplete) throw error;
  return { status: "failed", reason: "readback" };
};

interface ClientConfigurationUpdate {
  readonly client: SetupClient;
  readonly transactionPath: string;
  readonly snapshot:
    | Awaited<ReturnType<typeof readRegularFileTextSnapshot>>
    | undefined;
  readonly format: NonNullable<SetupClient["format"]>;
  readonly original: string | undefined;
  readonly parsed: ClientConfigurationDocument;
  readonly desired: unknown;
  readonly fallbackServers: Readonly<Record<string, unknown>>;
  readonly platform: NodeJS.Platform;
}

const persistClientConfiguration = async ({
  client,
  transactionPath,
  snapshot,
  format,
  original,
  parsed,
  desired,
  fallbackServers,
  platform,
}: ClientConfigurationUpdate): Promise<ClientConfigurationResult> => {
  // The plan chose this file; an MSIX package may have switched to its
  // private copy since, for example when it quit.
  if (client.msixPackage !== undefined) {
    const target = await packageReadTargetChanged(
      client.msixPackage,
      client.configPath,
    );
    if (!target.ok)
      return {
        status: "failed",
        reason: "target_unavailable",
        failure: {
          kind: "inspect",
          path: target.error.path,
          detail: target.error.detail,
        },
      };
    if (target.value) return { status: "failed", reason: "target_changed" };
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
    platform,
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
  const serialized = serializeClientConfiguration(
    document,
    format,
    original,
    [
      ...Object.keys(fallbackServers)
        .filter((name) => name !== PRODUCT_IDENTITY.mcpServerKey)
        .map((name) => clientServerPath(parsed, name)),
      clientServerPath(parsed, PRODUCT_IDENTITY.mcpServerKey),
      ...(legacyPath === undefined ? [] : [legacyPath]),
      ...(enableOmp ? [[OMP_DISABLED_SERVERS_KEY]] : []),
    ],
    // Ownership admission above covers every legacy member removed here.
    { removeShadowedMembersAt: legacyPath === undefined ? [] : [legacyPath] },
  );
  if (!serialized.ok)
    return serialized.error.kind === "shadowed_member"
      ? {
          status: "failed",
          reason: "shadowed_member",
          path: serialized.error.path,
        }
      : {
          status: "failed",
          reason: "write",
          failure: new ClientConfigurationWriteError(
            client.configPath,
            "serialize",
            serialized.error.cause,
          ).problem,
        };
  let recoveryBackupPath: string | undefined;
  if (original !== undefined) {
    // A private profile's backup stays owner-only even when it sits beside
    // a requested link outside the secured target directory.
    const preserved = await (
      client.privateProfile === undefined
        ? preserveCurrentRecoveryBackup
        : preservePrivateRecoveryBackup
    )(`${client.configPath}.rea.backup`, transactionPath, original);
    if (!preserved.ok) return { status: "failed", reason: "backup" };
    recoveryBackupPath = preserved.value;
  }
  let publication: ClientConfigurationPublication;
  try {
    await mkdir(dirname(client.configPath), {
      recursive: true,
      ...(client.privateProfile !== undefined
        ? { mode: PRIVATE_PROFILE_MODES.directory }
        : {}),
    });
    // File modes are this host's, whatever platform the registration targets.
    if (
      client.privateProfile !== undefined &&
      HOST_PLATFORM.platform !== "win32"
    )
      await securePrivateDirectory(
        dirname(transactionPath),
        client.privateProfile.home,
        () => {},
        undefined,
      );
    publication = await ClientConfigurationPublication.write(
      transactionPath,
      serialized.value,
      original,
      {
        requestedPath: client.configPath,
        state: snapshot?.state,
        ...(client.privateProfile !== undefined
          ? { requiredMode: PRIVATE_PROFILE_MODES.file }
          : {}),
      },
    );
  } catch (cause: unknown) {
    if (isClientConfigurationCleanupFailure(cause)) throw cause;
    if (cause instanceof ClientPrivateProfileError && cause.cleanupIncomplete)
      throw cause;
    if (isConfigurationConflict(cause))
      return conflictFailure(recoveryBackupPath);
    return {
      status: "failed",
      reason: "write",
      failure: (cause instanceof ClientConfigurationWriteError
        ? cause
        : new ClientConfigurationWriteError(client.configPath, "publish", cause)
      ).problem,
      ...(recoveryBackupPath === undefined
        ? {}
        : { backupPath: recoveryBackupPath }),
    };
  }
  return publication.verify(async () => {
    try {
      const text = await readRegularFileText(publication.path);
      await publication.assertCurrent(text);
      const readback = parseClientConfiguration(text, format);
      if (
        !readback.ok ||
        !registrationCurrent(readback.value, desired) ||
        Object.entries(fallbackServers).some(
          ([name, entry]) =>
            name !== PRODUCT_IDENTITY.mcpServerKey &&
            !clientConfigurationValuesEqual(
              readback.value.servers[name],
              entry,
            ),
        )
      ) {
        return await rollbackOrReadbackFailure(
          publication,
          original,
          recoveryBackupPath,
        );
      }
    } catch (cause: unknown) {
      if (isConfigurationConflict(cause) || isEnoentError(cause))
        return conflictFailure(recoveryBackupPath);
      if (cause instanceof RegularFileCleanupFailure) {
        const rollback = await restoreConfig(publication, original);
        if (!rollback.ok)
          throw new ClientConfigurationCleanupRollbackFailure(
            cause,
            rollbackFailure(rollback.error, recoveryBackupPath),
          );
        throw cause;
      }
      // Readback failure restores the transaction before reporting.
      void cause;
      return rollbackOrReadbackFailure(
        publication,
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
  });
};

/** What setup would write into a client's target file, from one read. */
interface ClientRefresh {
  readonly original: string | undefined;
  readonly parsed: ClientConfigurationDocument | undefined;
  readonly desired: unknown;
  /** The layers the registration was read from. */
  readonly sources: readonly ClientConfigurationSource[];
  /** The inline layer whose override is the refusal, when it is. */
  readonly overrideOrigin?: ClientInlineConfiguration["origin"];
  /** Why setup refuses this write: write-target ownership, a client policy or an overriding inline layer. */
  readonly refusal: string | undefined;
}

/**
 * Read a client's layers and compute the registration setup would write,
 * with setup's own refusal checks. An unreadable or malformed layer is a typed
 * failure that keeps its path and recovery.
 */
const readClientRefresh = async (
  client: SetupClient,
  providerEnvironment: SetupProviderEnvironment,
  command: readonly string[],
  {
    platform,
    resolveProviderRequestBudget,
    resources,
    currentCommandPath,
    launcherEnvironment,
  }: {
    readonly platform: NodeJS.Platform;
    readonly resolveProviderRequestBudget?: ProviderRequestBudgetResolver;
    readonly resources?: ArtifactResourceScope;
    readonly launcherEnvironment: Readonly<NodeJS.ProcessEnv>;
    /** The entry point whose registrations setup owns; update names the new one. */
    readonly currentCommandPath?: string;
  },
): Promise<Result<ClientRefresh, ClientConfigurationFileError>> => {
  const files = await readClientConfigurationFiles(
    client,
    resources,
    platform,
    { writeOverrides: providerEnvironment },
  );
  if (!files.ok) {
    throwCleanupFailure(files.error);
    return files;
  }
  let original: string | undefined;
  try {
    original = await readRegularFileText(
      client.configPath,
      resources === undefined ? {} : { resources },
    );
  } catch (cause: unknown) {
    if (!isEnoentError(cause)) throw cause;
  }
  const document =
    original === undefined
      ? undefined
      : parseClientConfiguration(original, client.format);
  if (document?.ok === false)
    return err({
      kind: "malformed",
      path: client.configPath,
      detail: document.error.detail,
    });
  const writeDocument =
    document === undefined
      ? undefined
      : clientConfigurationForWrite(document.value, files.value);
  if (writeDocument?.ok === false)
    return err({
      kind: "malformed",
      path: client.configPath,
      detail: configurationRemediation(writeDocument.error),
    });
  const parsed = writeDocument?.value;
  const desiredResult = await clientConfigurationDesired(
    client,
    providerEnvironment,
    command,
    parsed,
    files.value,
    platform,
    launcherEnvironment,
    resolveProviderRequestBudget,
  );
  if (!desiredResult.ok)
    return err({
      kind: "malformed",
      path: client.configPath,
      detail: configurationRemediation(desiredResult.error),
    });
  const desired = desiredResult.value;
  const target =
    dshEditabilityBlocker(client, files.value) ??
    writeTargetOwnershipBlocker(
      client,
      files.value,
      parsed,
      original,
      platform,
      currentCommandPath,
    );
  if (target !== undefined)
    return ok({
      original,
      parsed,
      desired,
      sources: files.value,
      refusal: target,
    });
  const overrideOrigin = inlineRegistrationOverride(
    client,
    files.value,
    desired,
    platform,
  );
  if (overrideOrigin !== undefined)
    return ok({
      original,
      parsed,
      desired,
      sources: files.value,
      overrideOrigin,
      refusal: inlineOverrideRemediation(client, overrideOrigin),
    });
  const policy = await readClientPolicyBlock(
    client,
    parsed,
    desired,
    resources,
  );
  if (!policy.ok) {
    throwCleanupFailure(policy.error);
    return ok({
      original,
      parsed,
      desired,
      sources: files.value,
      refusal: policy.error.detail,
    });
  }
  return ok({
    original,
    parsed,
    desired,
    sources: files.value,
    refusal: policy.value,
  });
};

/** Determine whether an existing client configuration matches the desired registration. */
export const clientConfigurationAligned = async (
  client: SetupClient,
  providerEnvironment: SetupProviderEnvironment,
  command: readonly string[],
  resolveProviderRequestBudget?: ProviderRequestBudgetResolver,
  // Setup reads the running host's client files unless its host selects one.
  platform: NodeJS.Platform = HOST_PLATFORM.platform,
  launcherEnvironment: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<boolean> => {
  if (client.configPathError !== undefined) return false;
  try {
    const refresh = await readClientRefresh(
      client,
      providerEnvironment,
      command,
      resolveProviderRequestBudget === undefined
        ? { platform, launcherEnvironment }
        : { platform, launcherEnvironment, resolveProviderRequestBudget },
    );
    return (
      refresh.ok &&
      refresh.value.original !== undefined &&
      refresh.value.parsed !== undefined &&
      refresh.value.refusal === undefined &&
      registrationCurrent(refresh.value.parsed, refresh.value.desired) &&
      (await privateProfileCurrent(client, refresh.value.original))
    );
  } catch (cause: unknown) {
    if (cause instanceof RegularFileCleanupFailure) throw cause;
    // Unreadable configuration is treated as not aligned so setup repairs it.
    void cause;
    return false;
  }
};

/** Why maintenance leaves a client to setup, with whether alignment is known. */
export interface ClientRefreshRefusal {
  readonly alignment: "refused" | "unknown";
  readonly remediation: string;
}

/**
 * Why update maintenance cannot refresh a client with `command`: setup's
 * refusal (a client policy, an unreadable layer, or a read-only inline layer
 * that would override the refreshed entry), or `unknown` alignment when the
 * inline layer differs only in settings setup discovers from the installed
 * providers. Maintenance has only the explicitly selected settings and does
 * not run that discovery, so such a client needs `rea setup`. One refused
 * client blocks the whole setup plan, so maintenance asks before selecting a
 * client. Registration ownership is not checked here; the caller has already
 * established it. A supplied scope retains the owner of a file whose cleanup
 * failed.
 */
export const clientRefreshRefusal = async (
  client: SetupClient,
  providerEnvironment: SetupProviderEnvironment,
  command: readonly string[],
  {
    platform,
    currentCommandPath,
    resources,
    launcherEnvironment = process.env,
  }: {
    readonly platform: NodeJS.Platform;
    readonly launcherEnvironment?: Readonly<NodeJS.ProcessEnv>;
    /** The entry point the refreshing setup runs from. */
    readonly currentCommandPath: string;
    readonly resources?: ArtifactResourceScope;
  },
): Promise<ClientRefreshRefusal | undefined> => {
  const refused = (remediation: string): ClientRefreshRefusal => ({
    alignment: "refused",
    remediation,
  });
  if (client.configPathError !== undefined)
    return refused(client.configPathError);
  try {
    const refresh = await readClientRefresh(
      client,
      providerEnvironment,
      command,
      {
        platform,
        currentCommandPath,
        launcherEnvironment,
        ...(resources === undefined ? {} : { resources }),
      },
    );
    // An unreadable or malformed layer is a refusal too: setup's preflight
    // reports it the same way.
    if (!refresh.ok) return refused(refresh.error.detail);
    const discoveredResult = await discoveredInlineSettings(
      client,
      providerEnvironment,
      command,
      refresh.value,
      platform,
      launcherEnvironment,
    );
    if (!discoveredResult.ok)
      return refused(configurationRemediation(discoveredResult.error));
    const discovered = discoveredResult.value;
    if (discovered !== undefined)
      return {
        alignment: "unknown",
        remediation: `${discovered.origin} sets ${discovered.settings.join(", ")} in REA's ${PRODUCT_IDENTITY.mcpServerKey} registration for ${client.configPath}; setup discovers ${discovered.settings.length === 1 ? "that setting" : "those settings"} from the installed providers and update does not, so REA cannot tell whether this registration is current. Run ${PRODUCT_IDENTITY.cliBinary} setup to check and refresh it.`,
      };
    return refresh.value.refusal === undefined
      ? undefined
      : refused(refresh.value.refusal);
  } catch (cause: unknown) {
    if (cause instanceof RegularFileCleanupFailure) throw cause;
    return refused(
      `The configuration could not be read. Check its permissions before rerunning setup. ${errorMessage(cause)}`,
    );
  }
};

/**
 * The read-only inline layer's settings that setup discovers and the caller
 * did not select, when they decide this client's refresh: setup may write a
 * different discovered value than the layer holds (the layer would then
 * override it), so an entry that matches now is not known to stay current, and
 * an override those values alone explain is not known to remain. Another
 * refusal (ownership, policy, or an override other settings cause) does not
 * depend on discovery.
 */
const discoveredInlineSettings = async (
  client: SetupClient,
  providerEnvironment: SetupProviderEnvironment,
  command: readonly string[],
  refresh: ClientRefresh,
  platform: NodeJS.Platform,
  launcherEnvironment: Readonly<NodeJS.ProcessEnv>,
): Promise<
  Result<
    | {
        readonly origin: ClientInlineConfiguration["origin"];
        readonly settings: readonly string[];
      }
    | undefined,
    ConfigurationError
  >
> => {
  const [origin] = inlineRegistrationOrigins(client);
  if (origin === undefined) return ok(undefined);
  if (refresh.refusal !== undefined && refresh.overrideOrigin === undefined)
    return ok(undefined);
  // Setting names are matched by the platform's environment identity, so a
  // Windows layer's `Java_Home` is the discovered `JAVA_HOME`.
  const declared = snapshotEnvironment(
    inlineRegistrationEnvironment(refresh.sources),
    platform,
  );
  const selected = snapshotEnvironment(providerEnvironment, platform);
  const adopted = Object.fromEntries(
    DISCOVERED_REGISTRATION_SETTINGS.flatMap((setting) => {
      const value = declared[setting];
      return Object.hasOwn(selected, setting) || value === undefined
        ? []
        : [[setting, value]];
    }),
  );
  const settings = Object.keys(adopted);
  if (settings.length === 0) return ok(undefined);
  if (refresh.overrideOrigin === undefined) return ok({ origin, settings });
  const desired = await clientConfigurationDesired(
    client,
    { ...providerEnvironment, ...adopted },
    command,
    refresh.parsed,
    refresh.sources,
    platform,
    launcherEnvironment,
  );
  if (!desired.ok) return desired;
  return ok(
    inlineRegistrationOverride(
      client,
      refresh.sources,
      desired.value,
      platform,
    ) === undefined
      ? { origin, settings }
      : undefined,
  );
};

/** Preflight one client configuration before setup presents any mutations. */
export const inspectClientConfiguration = async (
  client: SetupClient,
  providerEnvironment: SetupProviderEnvironment,
  command: readonly string[],
  resolveProviderRequestBudget?: ProviderRequestBudgetResolver,
  // Setup reads the running host's client files unless its host selects one.
  platform: NodeJS.Platform = HOST_PLATFORM.platform,
  launcherEnvironment: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<ClientConfigurationInspection> => {
  const inspection = await inspectClientDocument(
    client,
    providerEnvironment,
    command,
    platform,
    launcherEnvironment,
    resolveProviderRequestBudget,
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
  platform: NodeJS.Platform,
  launcherEnvironment: Readonly<NodeJS.ProcessEnv>,
  resolveProviderRequestBudget?: ProviderRequestBudgetResolver,
): Promise<ClientConfigurationInspection> => {
  if (client.configPathError !== undefined)
    return { status: "invalid", remediation: client.configPathError };
  if (client.format === "unsupported") return { status: "already_current" };
  const files = await readClientConfigurationFiles(
    client,
    undefined,
    platform,
    { writeOverrides: providerEnvironment },
  );
  if (!files.ok) {
    throwCleanupFailure(files.error);
    return {
      status: "invalid",
      remediation: files.error.detail,
    };
  }
  const editabilityError = dshEditabilityBlocker(client, files.value);
  if (editabilityError !== undefined)
    return { status: "invalid", remediation: editabilityError };
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
    if (isEnoentError(cause)) {
      const ownershipBlocker = writeTargetOwnershipBlocker(
        client,
        files.value,
        undefined,
        undefined,
        platform,
      );
      if (ownershipBlocker !== undefined)
        return { status: "invalid", remediation: ownershipBlocker };
      const desired = await clientConfigurationDesired(
        client,
        providerEnvironment,
        command,
        undefined,
        files.value,
        platform,
        launcherEnvironment,
        resolveProviderRequestBudget,
      );
      if (!desired.ok)
        return {
          status: "invalid",
          remediation: configurationRemediation(desired.error),
        };
      const override = inlineOverrideBlocker(
        client,
        files.value,
        desired.value,
        platform,
      );
      if (override !== undefined)
        return { status: "invalid", remediation: override };
      // This read establishes absence; do not reuse an earlier user-file policy.
      const policy = await readClientPolicyBlock(
        client,
        undefined,
        desired.value,
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
      const fallback = await readZcodeFallbackServers(client, platform);
      if (!fallback.ok) {
        if (fallback.error.kind !== "registration_ownership")
          throwCleanupFailure(fallback.error);
        return { status: "invalid", remediation: fallback.error.detail };
      }
      return { status: "create" };
    }
    return {
      status: "invalid",
      remediation: `The configuration file could not be read. Check its permissions before rerunning setup. ${errorMessage(cause)}`,
    };
  }
  try {
    const document = parseClientConfiguration(original, client.format);
    if (!document.ok)
      return {
        status: "invalid",
        remediation:
          document.error.kind === "document"
            ? configurationRemediation(document.error.cause)
            : "The existing configuration is malformed. Repair it before setup applies any other changes.",
      };
    const writeDocument = clientConfigurationForWrite(
      document.value,
      files.value,
    );
    if (!writeDocument.ok)
      return {
        status: "invalid",
        remediation: configurationRemediation(writeDocument.error),
      };
    const parsed = writeDocument.value;
    const ownershipBlocker = writeTargetOwnershipBlocker(
      client,
      files.value,
      parsed,
      original,
      platform,
    );
    if (ownershipBlocker !== undefined)
      return { status: "invalid", remediation: ownershipBlocker };
    const desired = await clientConfigurationDesired(
      client,
      providerEnvironment,
      command,
      parsed,
      files.value,
      platform,
      launcherEnvironment,
      resolveProviderRequestBudget,
    );
    if (!desired.ok)
      return {
        status: "invalid",
        remediation: configurationRemediation(desired.error),
      };
    const override = inlineOverrideBlocker(
      client,
      files.value,
      desired.value,
      platform,
    );
    if (override !== undefined)
      return { status: "invalid", remediation: override };
    const policy = await readClientPolicyBlock(client, parsed, desired.value);
    if (!policy.ok) {
      throwCleanupFailure(policy.error);
      return {
        status: "invalid",
        remediation: policy.error.detail,
      };
    }
    if (policy.value !== undefined)
      return { status: "invalid", remediation: policy.value };
    if (
      registrationCurrent(parsed, desired.value) &&
      (await privateProfileCurrent(client, original))
    )
      return { status: "already_current" };
    const fallback = await readZcodeFallbackServers(client, platform, parsed);
    if (!fallback.ok) {
      if (fallback.error.kind !== "registration_ownership")
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

const throwCleanupFailure = (error: ClientConfigurationFileError): void => {
  if (error.cleanupFailure !== undefined) throw error.cleanupFailure;
};

/** Setup cannot write around a read-only inline layer that overrides REA. */
const inlineOverrideBlocker = (
  client: SetupClient,
  sources: readonly ClientConfigurationSource[],
  desired: unknown,
  platform: NodeJS.Platform,
): string | undefined => {
  const origin = inlineRegistrationOverride(client, sources, desired, platform);
  return origin === undefined
    ? undefined
    : inlineOverrideRemediation(client, origin);
};

const inlineOverrideRemediation = (
  client: SetupClient,
  origin: ClientInlineConfiguration["origin"],
): string =>
  `${origin} overrides REA's ${PRODUCT_IDENTITY.mcpServerKey} registration in ${client.configPath}, and REA does not edit it. Remove the ${PRODUCT_IDENTITY.mcpServerKey} server from ${origin} or make it match, then rerun setup.`;

/** A Cordis document setup cannot edit. */
const dshEditabilityBlocker = (
  client: SetupClient,
  sources: readonly ClientConfigurationSource[],
): string | undefined => {
  const existing = sources.find(
    ({ sourcePath }) => sourcePath === client.configPath,
  );
  return existing?.dialect === "dsh"
    ? dshDocument(existing.document).editabilityError?.message
    : undefined;
};

/**
 * Setup's ownership check of the row it would replace: the target file's own
 * row, or, when the file is absent, the row the lower layers supply.
 */
const writeTargetOwnershipBlocker = (
  client: SetupClient,
  sources: readonly ClientConfigurationSource[],
  parsed: ClientConfigurationDocument | undefined,
  original: string | undefined,
  platform: NodeJS.Platform,
  currentCommandPath?: string,
): string | undefined => {
  if (parsed !== undefined)
    return registrationOwnershipBlocker(
      client,
      parsed,
      original ?? "",
      sources,
      platform,
      currentCommandPath,
    );
  const inherited = effectiveClientConfiguration(
    sources,
    { client, document: undefined },
    platform,
  );
  return inherited === undefined
    ? undefined
    : registrationOwnershipBlocker(
        client,
        inherited,
        "",
        sources,
        platform,
        currentCommandPath,
      );
};

/** Admit only absent or proven-owned rows that this setup would replace. */
const registrationOwnershipBlocker = (
  client: SetupClient,
  parsed: ClientConfigurationDocument,
  original: string,
  sources: readonly ClientConfigurationSource[],
  platform: NodeJS.Platform,
  currentCommandPath?: string,
): string | undefined => {
  // Cordis owns registrations by stable entry ID, including malformed launchers.
  if (parsed.dialect === "dsh") return undefined;
  const name = PRODUCT_IDENTITY.mcpServerKey;
  const entries: { value: unknown; paths: readonly string[] }[] = [];
  const effective = effectiveClientConfiguration(
    sources,
    { client, document: parsed },
    platform,
  );
  if (effective !== undefined && Object.hasOwn(effective.servers, name))
    entries.push({
      value: effective.servers[name],
      // An inline layer is named by its origin; it has no path.
      paths: [
        ...(client.configPaths ?? [client.configPath]),
        ...inlineRegistrationOrigins(client),
      ],
    });
  const fragment = parsed.servers[name];
  // A layered policy fragment inherits its launcher. Classify the effective
  // launcher above, but also admit any explicit command this write replaces.
  const inheritsLauncher =
    effective !== undefined &&
    effective !== parsed &&
    isRecord(fragment) &&
    !Object.hasOwn(fragment, "command");
  if (Object.hasOwn(parsed.servers, name) && !inheritsLauncher)
    entries.push({ value: parsed.servers[name], paths: [client.configPath] });
  if (legacyClientServerPath(parsed, name) !== undefined) {
    entries.push({
      value: parsed.legacyServers[name],
      paths: [client.configPath],
    });
    entries.push(
      ...shadowedClientServers(original, parsed, name).legacyServers.map(
        (value) => ({ value, paths: [client.configPath] }),
      ),
    );
  }
  for (const entry of entries) {
    const ownership =
      currentCommandPath === undefined
        ? clientRegistrationOwnership(entry.value, client)
        : clientRegistrationOwnership(entry.value, client, currentCommandPath);
    if (ownership !== "owned")
      return clientRegistrationOwnershipRemediation(ownership, entry.paths);
  }
  return undefined;
};

/** Admit the fallback only when the first native ZCode server would suppress it. */
const readZcodeFallbackServers = async (
  client: SetupClient,
  platform: NodeJS.Platform,
  parsed?: ClientConfigurationDocument,
): Promise<
  Result<
    Readonly<Record<string, unknown>>,
    | ClientConfigurationFileError
    | {
        readonly kind: "registration_ownership";
        readonly path: string;
        readonly detail: string;
      }
  >
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
  const document = parseClientConfiguration(source.value, "zcode_fallback");
  if (!document.ok)
    return err({
      kind: "malformed",
      path,
      detail: `${detail} ${document.error.detail}`,
    });
  const fallback = document.value;
  try {
    const ownershipBlocker = registrationOwnershipBlocker(
      { ...client, configPath: path, format: "zcode_fallback" },
      fallback,
      source.value,
      [],
      platform,
    );
    if (ownershipBlocker !== undefined)
      return err({
        kind: "registration_ownership",
        path,
        detail: ownershipBlocker,
      });
    const environment = clientRegistrationEnvironment(
      fallback,
      client,
      platform,
    );
    if (!environment.ok)
      return err({
        kind: "malformed",
        path,
        detail: `${detail} ${environment.error.settings.map(({ setting, constraint }) => `${setting}: ${constraint}`).join("; ")}`,
      });
    return ok(fallback.servers);
  } catch (cause: unknown) {
    return err({
      kind: "malformed",
      path,
      detail: `${detail} ${errorMessage(cause)}`,
    });
  }
};

type ConfigurationRestoreFailure =
  | { readonly kind: "conflict" }
  | {
      readonly kind: "restore";
      readonly path: string;
      readonly detail: string;
    };

const restoreConfig = async (
  publication: ClientConfigurationPublication,
  original: string | undefined,
): Promise<Result<void, ConfigurationRestoreFailure>> => {
  try {
    await publication.restore(original);
    return ok(undefined);
  } catch (cause: unknown) {
    if (isConfigurationConflict(cause) || isEnoentError(cause))
      return err({ kind: "conflict" });
    return err({
      kind: "restore",
      path: publication.path,
      detail: errorMessage(cause),
    });
  }
};

const rollbackOrReadbackFailure = async (
  publication: ClientConfigurationPublication,
  original: string | undefined,
  backupPath: string | undefined,
): Promise<ClientConfigurationResult> => {
  const rollback = await restoreConfig(publication, original);
  return rollback.ok
    ? {
        status: "failed",
        reason: "readback",
        ...(backupPath === undefined ? {} : { backupPath }),
      }
    : rollbackFailure(rollback.error, backupPath);
};

const rollbackFailure = (
  failure: ConfigurationRestoreFailure,
  backupPath?: string,
): Extract<ClientConfigurationResult, { readonly status: "failed" }> =>
  failure.kind === "conflict"
    ? conflictFailure(backupPath)
    : {
        status: "failed",
        reason: "rollback",
        failure,
        ...(backupPath === undefined ? {} : { backupPath }),
      };

const isConfigurationConflict = (cause: unknown): boolean =>
  cause instanceof RegularFileChangedError ||
  cause instanceof InvalidUtf8FileError;

const conflictFailure = (
  backupPath?: string,
): Extract<ClientConfigurationResult, { readonly status: "failed" }> => ({
  status: "failed",
  reason: "conflict",
  ...(backupPath === undefined ? {} : { backupPath }),
});

/** Whether REA's entry matches, no legacy entry remains, and no client disable list suppresses it. */
const registrationCurrent = (
  parsed: ClientConfigurationDocument,
  desired: unknown,
): boolean =>
  parsed.requiresRewrite !== true &&
  (parsed.dialect !== "dsh" || dshDocument(parsed.document).ready) &&
  clientConfigurationValuesEqual(
    parsed.servers[PRODUCT_IDENTITY.mcpServerKey],
    desired,
  ) &&
  !Object.hasOwn(parsed.legacyServers, PRODUCT_IDENTITY.mcpServerKey) &&
  !clientServerListedDisabled(parsed, PRODUCT_IDENTITY.mcpServerKey);

/**
 * A private profile with the wrong modes needs publication even when its row
 * is current. Modes belong to the host holding the file, not to the platform
 * the registration is written for.
 */
const privateProfileCurrent = async (
  client: SetupClient,
  original: string | undefined,
): Promise<boolean> =>
  client.privateProfile === undefined ||
  (original !== undefined &&
    (await privateProfileModesCurrent(
      client.configPath,
      HOST_PLATFORM.platform,
    )));

const clientConfigurationDesired = async (
  client: SetupClient,
  providerEnvironment: SetupProviderEnvironment,
  command: readonly string[],
  parsed: ClientConfigurationDocument | undefined,
  sources: readonly ClientConfigurationSource[],
  platform: NodeJS.Platform,
  launcherEnvironment: Readonly<NodeJS.ProcessEnv>,
  resolveProviderRequestBudget?: ProviderRequestBudgetResolver,
): Promise<Result<unknown, ConfigurationError>> => {
  const effective = effectiveClientConfiguration(
    sources,
    { client, document: parsed },
    platform,
  );
  const format = clientWriteDialect(
    parsed?.dialect ?? client.format ?? "json",
    sources,
  );
  const launcher =
    command.length === 0 ? [PRODUCT_IDENTITY.cliBinary, "mcp"] : command;
  if (format === "dsh") {
    // The budget resolver's declared read set keeps the gate fail-closed only
    // for settings the derivation may actually read, so unrelated Cordis
    // expressions stay preserved while the budget still resolves.
    const validated = await clientRegistrationEnvironmentDetailsWithBudget(
      effective,
      client,
      providerEnvironment,
      "effective",
      resolveProviderRequestBudget,
      platform,
    );
    if (!validated.ok) return validated;
    const desired = (
      parsed === undefined
        ? new DshCordisDocument("")
        : dshDocument(parsed.document)
    ).desired(
      launcher,
      providerEnvironment,
      platform,
      recommendedMcpToolTimeoutMs(validated.value.timeoutInputs),
    );
    return desired;
  }
  const validated = await clientRegistrationEnvironmentDetailsWithBudget(
    effective,
    client,
    providerEnvironment,
    "effective",
    client.name === "codex" || client.name === "kimi"
      ? resolveProviderRequestBudget
      : undefined,
    platform,
  );
  if (!validated.ok) return validated;
  // Decide the fallback from the effective layers, then edit only the target.
  // A lower layer's locator still applies when the target has no value of its own.
  const writeEnvironment =
    validated.value.configHomeFallbackApplied === true
      ? providerEnvironment
      : registrationEnvironmentProposal(providerEnvironment).overrides;
  // Preserve explicitly configured server settings, never the ambient process
  // environment. The effective layered view validates precedence and supplies
  // timeout facts; the target file's fragment remains the value being written.
  const environment = clientRegistrationEnvironment(
    parsed,
    client,
    platform,
    writeEnvironment,
    "fragment",
  );
  if (!environment.ok) return environment;
  const registration = refreshClientRegistration(
    client,
    format,
    launcher,
    environment.value,
    parsed === undefined
      ? undefined
      : effectiveClientServer(parsed, PRODUCT_IDENTITY.mcpServerKey),
    validated.value.timeoutInputs,
    launcherEnvironment,
    platform,
  );
  if (!registration.ok) return registration;
  return withInheritedGooseSettings(
    registration.value,
    format,
    client,
    parsed,
    sources,
    effective,
    writeEnvironment,
    platform,
  );
};

/**
 * Goose replaces `envs` as a whole map per layer, so a user map must carry the
 * inherited one. When the user entry declares no environment and a lower layer
 * does, setup writes no map unless a setting is requested, and then writes the
 * inherited map with the requested settings applied last. Other settings only a
 * lower layer declares are left to that layer.
 */
const GOOSE_INHERITABLE_SETTINGS: readonly string[] = [
  "name",
  "description",
  "enabled",
  "timeout",
];

const withInheritedGooseSettings = (
  withoutInherited: Record<string, unknown>,
  format: ClientRegistrationDialect,
  client: SetupClient,
  parsed: ClientConfigurationDocument | undefined,
  sources: readonly ClientConfigurationSource[],
  effective: ClientConfigurationDocument | undefined,
  providerEnvironment: SetupProviderEnvironment,
  platform: NodeJS.Platform,
): Result<Record<string, unknown>, ConfigurationError> => {
  if (format !== "goose") return ok(withoutInherited);
  // The layers below the user file, which the user entry overlays field by field.
  const lower = effectiveClientConfiguration(
    sources,
    { client, document: undefined },
    platform,
  );
  const declares = (
    document: ClientConfigurationDocument | undefined,
    keys: readonly string[],
  ) => {
    const entry =
      document === undefined
        ? undefined
        : effectiveClientServer(document, PRODUCT_IDENTITY.mcpServerKey);
    return (
      typeof entry === "object" &&
      entry !== null &&
      keys.some((key) => Object.hasOwn(entry, key))
    );
  };
  // Goose merges each field separately, so a user map must use the spelling a
  // lower layer declares: `envs` beside an inherited `env` alias would leave
  // both in force, which Goose's readers reject as ambiguous.
  const spelled = (
    registration: Record<string, unknown>,
  ): Record<string, unknown> => {
    if (!declares(lower, ["env"]) || !Object.hasOwn(registration, "envs"))
      return registration;
    const { envs, ...rest } = registration;
    return { ...rest, env: envs };
  };
  const userDeclares = (keys: readonly string[]) => declares(parsed, keys);
  // A setting only a lower layer declares stays in effect: writing setup's
  // default into the user entry would override that caller's choice.
  const registration = Object.fromEntries(
    Object.entries(withoutInherited).filter(
      ([key]) =>
        !GOOSE_INHERITABLE_SETTINGS.includes(key) ||
        userDeclares([key]) ||
        !declares(lower, [key]),
    ),
  );
  const environmentKeys = ["envs", "env"];
  if (userDeclares(environmentKeys) || !declares(lower, environmentKeys))
    return ok(spelled(registration));
  const { envs: _generated, ...rest } = registration;
  if (Object.keys(providerEnvironment).length === 0) return ok(rest);
  const inherited = clientRegistrationEnvironment(
    effective,
    client,
    platform,
    providerEnvironment,
    "fragment",
  );
  return inherited.ok
    ? ok(spelled({ ...rest, envs: { ...inherited.value } }))
    : inherited;
};
