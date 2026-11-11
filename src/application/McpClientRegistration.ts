import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

import {
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
} from "../artifacts/AnalysisCleanupLease.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { analysisErrorWithCancellation } from "../domain/analysisErrorCancellation.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import type { ClientRegistrationCommand } from "../domain/clientRegistrationCommand.js";
import {
  sameRegularFileState,
  RegularFileChangedError,
} from "../filesystem/RegularFile.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { writeClientRegistrationBackup } from "./ClientRegistrationBackup.js";
import { resolveClientConfigTransactionPath } from "./ClientConfigPath.js";
import {
  ClientConfigurationPublicationFailure,
  isClientConfigurationCleanupFailure,
  retryClientConfigurationCleanup,
} from "./ClientConfigurationCleanup.js";
import { clientConfigurationValuesEqual } from "./ClientConfigurationDocument.js";
import { ClientConfigurationPublication } from "./ClientConfigurationPublication.js";
import { withClientConfigurationTransaction } from "./ClientConfigurationTransaction.js";
import {
  prepareRegistration,
  verifyEffectiveRegistration,
} from "./McpRegistrationConfiguration.js";
import type { McpRegistrationClient } from "./McpRegistrationCatalog.js";
import {
  readRegularFileText,
  readRegularFileTextSnapshot,
} from "./RegularFileRead.js";

export interface McpClientRegistrationReceipt {
  readonly status: "configured" | "unchanged";
  readonly backupPath?: string;
  readonly permissions?:
    | {
        readonly kind: "verified_posix_modes";
        readonly directoryMode: 0o700;
        readonly fileMode: 0o600;
      }
    | {
        readonly kind: "requested_windows_modes";
        readonly requestedDirectoryMode: 0o700;
        readonly requestedFileMode: 0o600;
        readonly aclVerification: "unavailable";
      };
}
export type McpClientRegistrationFailure =
  | ConfigurationError
  | AnalysisCancelledError;
interface OutcomeLabels {
  readonly client: McpRegistrationClient["id"];
  readonly configPath: string;
  readonly scope: McpRegistrationClient["scope"];
}
export type McpClientRegistrationOutcome = OutcomeLabels &
  (
    | {
        readonly status: "completed";
        readonly result: Result<
          McpClientRegistrationReceipt,
          McpClientRegistrationFailure
        >;
      }
    | { readonly status: "not_started" }
  );

/** Preserve every selected client's outcome, including work never started after cancellation. */
export const registerMcpClients = async (
  clients: readonly McpRegistrationClient[],
  launcher: ClientRegistrationCommand,
  signal: AbortSignal | undefined,
  resources: ArtifactResourceScope,
): Promise<readonly McpClientRegistrationOutcome[]> => {
  const outcomes: McpClientRegistrationOutcome[] = [];
  let cancelled = false;
  for (const client of clients) {
    const labels = {
      client: client.id,
      configPath: client.configPath,
      scope: client.scope,
    };
    if (cancelled) {
      outcomes.push({ ...labels, status: "not_started" });
      continue;
    }
    const result = await registerMcpClient(client, launcher, signal, resources);
    outcomes.push({ ...labels, status: "completed", result });
    cancelled =
      signal?.aborted === true ||
      (!result.ok && result.error instanceof AnalysisCancelledError);
  }
  return outcomes;
};

const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

/** One selected document owner admits, merges and verifies exact launcher facts. */
export const registerMcpClient = async (
  client: McpRegistrationClient,
  launcher: ClientRegistrationCommand,
  signal: AbortSignal | undefined,
  resources: ArtifactResourceScope,
): Promise<
  Result<McpClientRegistrationReceipt, McpClientRegistrationFailure>
> => {
  const settingsPath = client.configPath;
  let backupPath: string | undefined;
  let configured = false;
  const checkCancellation = (): void => {
    if (signal?.aborted === true)
      throw new AnalysisCancelledError("MCP registration", {
        cause: signal.reason,
        diagnostics: {
          client: client.id,
          settings_path: settingsPath,
          configured,
          ...(backupPath === undefined ? {} : { backup_path: backupPath }),
        },
      });
  };
  try {
    checkCancellation();
    // The caller supplies canonical argv, not a native client-shaped entry.
    if (launcher.command.length === 0)
      throw new ConfigurationError(
        "The registration needs a nonempty executable.",
      );
    const path = await resolveClientConfigTransactionPath(settingsPath);
    if (path === undefined)
      throw new ConfigurationError(
        `Client settings path could not be verified: ${settingsPath}`,
      );
    return await withClientConfigurationTransaction(path, async () => {
      checkCancellation();
      const prepared = await prepareRegistration(path, client, launcher);
      const { snapshot, original, contents } = prepared;
      checkCancellation();
      const unchanged = await unchangedRegistration(
        prepared,
        checkCancellation,
        resources,
      );
      checkCancellation();
      if (unchanged !== undefined) return ok(unchanged);
      if (original !== undefined) {
        const backup = await writeClientRegistrationBackup(path, original);
        if (!backup.ok)
          throw new ConfigurationError(backup.error.detail, {
            diagnostics: {
              settings_path: settingsPath,
              backup_path: backup.error.path,
            },
          });
        backupPath = backup.value;
      }
      checkCancellation();
      await mkdir(dirname(path), {
        recursive: true,
        ...(client.privateProfile === true ? { mode: 0o700 } : {}),
      });
      checkCancellation();
      if (client.privateProfile === true && process.platform !== "win32")
        await securePrivateDirectory(
          dirname(path),
          checkCancellation,
          resources,
        );
      checkCancellation();
      const publication = await ClientConfigurationPublication.write(
        path,
        contents,
        original,
        {
          requestedPath: settingsPath,
          state: snapshot?.state,
          ...(client.privateProfile === true
            ? { requiredMode: 0o600 as const }
            : {}),
        },
      );
      // Cancellation cannot abandon published bytes, verification or retained cleanup.
      await verifyRegistration(publication, prepared, backupPath, resources);
      configured = true;
      checkCancellation();
      return ok({
        status: "configured",
        ...(backupPath === undefined ? {} : { backupPath }),
        ...(client.privateProfile === true
          ? { permissions: privateProfilePermissions() }
          : {}),
      });
    });
  } catch (cause: unknown) {
    if (cause instanceof AnalysisCancelledError) return err(cause);
    configured ||=
      cause instanceof ClientConfigurationPublicationFailure &&
      cause.outcome.kind === "completed";
    const failure = await registrationFailure(cause, settingsPath, resources, {
      backupPath,
      configured,
    });
    if (signal?.aborted === true)
      analysisErrorWithCancellation(
        failure,
        new AnalysisCancelledError("MCP registration", {
          cause: signal.reason,
        }),
      );
    return err(failure);
  }
};

const registrationFailure = async (
  cause: unknown,
  path: string,
  resources: ArtifactResourceScope,
  progress: {
    readonly backupPath: string | undefined;
    readonly configured: boolean;
  },
): Promise<ConfigurationError> => {
  const { backupPath, configured } = progress;
  if (cause instanceof ConfigurationError) return cause;
  const cleanup = isClientConfigurationCleanupFailure(cause)
    ? await retryClientConfigurationCleanup(cause, resources)
    : undefined;
  const primary = cleanup?.primary ?? cause;
  const detail = primary instanceof Error ? primary.message : String(primary);
  const error = new ConfigurationError(
    `Could not register MCP settings at ${path}: ${detail}`,
    {
      cause,
      ...(cleanup?.cleanup === undefined ? {} : { cleanup: cleanup.cleanup }),
      diagnostics: {
        settings_path: path,
        configured,
        ...(backupPath === undefined ? {} : { backup_path: backupPath }),
      },
    },
  );
  if (cleanup !== undefined)
    new AnalysisCleanupLeaseGroup(error, cleanup.cleanupLeases);
  return error;
};

/** A semantic no-op is usable only while the admitted physical snapshot remains current. */
const unchangedRegistration = async (
  prepared: Awaited<ReturnType<typeof prepareRegistration>>,
  checkCancellation: () => void,
  resources: ArtifactResourceScope,
): Promise<McpClientRegistrationReceipt | undefined> => {
  const { client, path, snapshot, parsed, updated } = prepared;
  if (
    parsed.requiresRewrite === true ||
    !clientConfigurationValuesEqual(parsed.document, updated) ||
    (client.privateProfile === true &&
      process.platform !== "win32" &&
      ((snapshot?.state.mode ?? 0) & 0o777) !== 0o600)
  )
    return undefined;
  const current = await readRegularFileTextSnapshot(path, {
    symlinks: "reject",
  });
  if (
    snapshot === undefined ||
    current.text !== snapshot.text ||
    !sameRegularFileState(snapshot.state, current.state)
  )
    throw new RegularFileChangedError(path);
  checkCancellation();
  await verifyEffectiveRegistration(prepared, current.text);
  const permissionsChanged =
    client.privateProfile === true && process.platform !== "win32"
      ? await securePrivateDirectory(
          dirname(path),
          checkCancellation,
          resources,
        )
      : false;
  return {
    status: permissionsChanged ? "configured" : "unchanged",
    ...(client.privateProfile === true
      ? { permissions: privateProfilePermissions() }
      : {}),
  };
};

const verifyRegistration = async (
  publication: ClientConfigurationPublication,
  prepared: Awaited<ReturnType<typeof prepareRegistration>>,
  backupPath: string | undefined,
  resources: ArtifactResourceScope,
): Promise<void> => {
  const { original, client } = prepared;
  const settingsPath = client.configPath;
  await publication.verify(async () => {
    try {
      const readback = await readRegularFileText(publication.path, {
        symlinks: "reject",
      });
      await publication.assertCurrent(readback);
      await verifyEffectiveRegistration(prepared, readback);
    } catch (cause: unknown) {
      if (cause instanceof RegularFileChangedError || isMissing(cause))
        throw cause;
      const failure = await registrationFailure(
        cause,
        settingsPath,
        resources,
        { backupPath, configured: false },
      );
      try {
        await publication.restore(original);
      } catch (rollbackCause: unknown) {
        throw new ConfigurationError(
          "Client settings verification failed and restoration could not be verified",
          {
            cause: rollbackCause,
            cleanupPrimary: failure,
            diagnostics: {
              settings_path: settingsPath,
              ...(backupPath === undefined ? {} : { backup_path: backupPath }),
            },
          },
        );
      }
      throw failure;
    }
  });
};

/** fx's profile permissions are applied through the selected directory descriptor. */
const securePrivateDirectory = async (
  path: string,
  checkCancellation: () => void,
  resources: ArtifactResourceScope,
): Promise<boolean> => {
  const owner = new OwnedFileHandle(
    await open(
      path,
      constants.O_RDONLY |
        (constants.O_DIRECTORY ?? 0) |
        (constants.O_NOFOLLOW ?? 0),
    ),
  );
  const lease = AnalysisCleanupLease.forCloseOwner(owner, path);
  let primary: unknown;
  let changed = false;
  try {
    const before = await owner.handle.stat();
    const named = await lstat(path);
    if (
      !before.isDirectory() ||
      named.isSymbolicLink() ||
      before.ino === 0 ||
      before.dev !== named.dev ||
      before.ino !== named.ino ||
      !named.isDirectory()
    )
      throw new RegularFileChangedError(path);
    changed = (before.mode & 0o777) !== 0o700;
    checkCancellation();
    if (changed) await owner.handle.chmod(0o700);
    const after = await owner.handle.stat();
    const current = await lstat(path);
    if (
      (after.mode & 0o777) !== 0o700 ||
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== after.dev ||
      current.ino !== after.ino
    )
      throw new RegularFileChangedError(path);
  } catch (cause: unknown) {
    primary = cause;
  }
  try {
    await lease.release();
  } catch (cause: unknown) {
    const error = new ConfigurationError(
      `Private client directory cleanup failed at ${path}`,
      {
        cause:
          primary === undefined
            ? cause
            : new AggregateError(
                [primary, cause],
                "Private profile permission operation and directory cleanup failed",
              ),
        cleanup: {
          reason: "Private profile directory handle could not be closed",
          resources: [path],
        },
      },
    );
    new AnalysisCleanupLeaseGroup(error, [lease]);
    resources.retain({ kind: "lease", resource: path, lease });
    throw error;
  }
  if (primary !== undefined) throw primary;
  return changed;
};

/** Mode requests cannot establish Windows ACL privacy. */
const privateProfilePermissions = (): NonNullable<
  McpClientRegistrationReceipt["permissions"]
> =>
  process.platform === "win32"
    ? {
        kind: "requested_windows_modes",
        requestedDirectoryMode: 0o700,
        requestedFileMode: 0o600,
        aclVerification: "unavailable",
      }
    : { kind: "verified_posix_modes", directoryMode: 0o700, fileMode: 0o600 };
