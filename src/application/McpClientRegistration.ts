import { mkdir } from "node:fs/promises";
import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import { dirname } from "node:path";

import { AnalysisCleanupLeaseGroup } from "../artifacts/AnalysisCleanupLease.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import {
  AnalysisCancelledError,
  cancelledBy,
} from "../domain/analysisErrorCore.js";
import { analysisErrorWithCancellation } from "../domain/analysisErrorCancellation.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import type { ClientRegistrationCommand } from "../domain/clientRegistrationCommand.js";
import {
  sameRegularFileState,
  RegularFileChangedError,
} from "../filesystem/RegularFile.js";
import { writeClientRegistrationBackup } from "./ClientRegistrationBackup.js";
import { resolveClientConfigTransactionPath } from "./ClientConfigPath.js";
import {
  privateProfilePermissions,
  PRIVATE_PROFILE_MODES,
  type PrivateProfilePermissions,
  securePrivateDirectory,
} from "./ClientPrivateProfile.js";
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
  readonly permissions?: PrivateProfilePermissions;
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

/**
 * Whether a registration's settings were published, including a failure that
 * arrived after publication (for example cancellation during verification).
 */
export const mcpClientRegistrationWritten = (
  result: Result<McpClientRegistrationReceipt, McpClientRegistrationFailure>,
): boolean =>
  result.ok
    ? result.value.status === "configured"
    : result.error.diagnostics?.["configured"] === true;

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
      throw cancelledBy("MCP registration", signal, {
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
        ...(client.privateProfile !== undefined
          ? { mode: PRIVATE_PROFILE_MODES.directory }
          : {}),
      });
      checkCancellation();
      if (
        client.privateProfile !== undefined &&
        HOST_PLATFORM.platform !== "win32"
      )
        await securePrivateDirectory(
          dirname(path),
          client.privateProfile.home,
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
          ...(client.privateProfile !== undefined
            ? { requiredMode: PRIVATE_PROFILE_MODES.file }
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
        ...(client.privateProfile !== undefined
          ? { permissions: privateProfilePermissions(HOST_PLATFORM.platform) }
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
        cancelledBy("MCP registration", signal),
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
    (client.privateProfile !== undefined &&
      HOST_PLATFORM.platform !== "win32" &&
      ((snapshot?.state.mode ?? 0) & 0o777) !== PRIVATE_PROFILE_MODES.file)
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
    client.privateProfile !== undefined && HOST_PLATFORM.platform !== "win32"
      ? await securePrivateDirectory(
          dirname(path),
          client.privateProfile.home,
          checkCancellation,
          resources,
        )
      : false;
  return {
    status: permissionsChanged ? "configured" : "unchanged",
    ...(client.privateProfile !== undefined
      ? { permissions: privateProfilePermissions(HOST_PLATFORM.platform) }
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
