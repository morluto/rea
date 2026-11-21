import { lstat, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import {
  applyUserConfigurationDefaults,
  parseUserConfig,
  parseUserConfigText,
  type PersistedSetting,
  type UserConfiguration,
  type UserSettings,
} from "../config/userConfig.js";
import {
  analysisErrorWithCleanupDependencies,
  withInheritedCleanupOwnership,
} from "../domain/analysisErrorCleanup.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import { OwnedStagedOutput } from "../filesystem/OwnedStagedOutput.js";
import { RegularFileCleanupFailure } from "../filesystem/OwnedRegularFile.js";
import {
  NonRegularFileReadError,
  RejectedRegularFileSymlink,
  RegularFileChangedError,
} from "../filesystem/RegularFile.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import {
  bindRegularFileCleanup,
  InvalidUtf8FileError,
  readRegularFileTextSnapshot,
} from "../process/RegularFileRead.js";
import {
  AnalysisCleanupLeaseGroup,
  ArtifactReaderFailure,
  ArtifactResourceScope,
  writeTextFile,
} from "../resources/index.js";
import { resolveClientConfigTransactionPath } from "./ClientConfigPath.js";
import {
  isClientConfigurationCleanupFailure,
  retryClientConfigurationCleanup,
} from "./ClientConfigurationCleanup.js";
import { ClientConfigurationPublication } from "./ClientConfigurationPublication.js";
import { userConfigFilePath } from "./UserConfigurationLocation.js";

// Keep exact failed-close owners available for subsequent reads or edits.
const resources = new ArtifactResourceScope();
type ConfigSnapshot = Awaited<ReturnType<typeof readRegularFileTextSnapshot>>;
type FileErrorOptions = ConstructorParameters<typeof ConfigurationError>[1];
const errorCode = (cause: unknown): unknown =>
  cause instanceof Error && "code" in cause ? cause.code : undefined;

const configFileError = (
  path: string,
  detail: string,
  options?: FileErrorOptions,
): ConfigurationError =>
  new ConfigurationError(
    `Cannot use the REA user configuration at ${path}. ${detail}`,
    {
      settings: [{ setting: path, constraint: detail }],
      remediationAction:
        "Check the named file and its parent directory before retrying.",
      ...options,
    },
  );

const configReadFailure = (
  path: string,
  cause: unknown,
): ConfigurationError => {
  const primary =
    cause instanceof RegularFileCleanupFailure &&
    cause.outcome.kind === "failed"
      ? cause.outcome.cause
      : cause;
  const detail =
    primary instanceof NonRegularFileReadError ||
    primary instanceof RejectedRegularFileSymlink
      ? "could not be read as a regular JSON file"
      : primary instanceof InvalidUtf8FileError
        ? "must be valid UTF-8"
        : primary instanceof RegularFileChangedError
          ? "changed while being read; retry after the edit finishes"
          : "could not be read";
  const cleanup =
    cause instanceof RegularFileCleanupFailure
      ? { reason: errorMessage(cause.cleanupCause), resources: [cause.path] }
      : cause instanceof ArtifactReaderFailure
        ? cause.cleanup
        : undefined;
  const failure = configFileError(path, detail, { cause, cleanup });
  bindRegularFileCleanup(cause, failure);
  return failure;
};

/** Read one stable snapshot, including the mode and identity used by an edit. */
const readConfigSnapshot = async (
  path: string,
  symlinks: "follow" | "reject",
): Promise<Result<ConfigSnapshot | undefined, ConfigurationError>> => {
  try {
    return ok(await readRegularFileTextSnapshot(path, { symlinks, resources }));
  } catch (cause: unknown) {
    return errorCode(cause) === "ENOENT"
      ? ok(undefined)
      : err(configReadFailure(path, cause));
  }
};

const parseConfigSnapshot = (
  path: string,
  snapshot: ConfigSnapshot | undefined,
): Result<UserSettings, ConfigurationError> => {
  if (snapshot === undefined) return ok({});
  const result = parseUserConfigText(snapshot.text);
  if (result.ok) return result;
  const detail = result.error.settings
    .map(({ setting, constraint }) => `${setting}: ${constraint}`)
    .join(", ");
  return err(configFileError(path, detail, { cause: result.error }));
};

/** Read validated saved values independently of the environment that can override them. */
export const loadUserConfigurationDefaults = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform = HOST_PLATFORM.platform,
): Promise<Result<UserSettings, ConfigurationError>> => {
  const path = userConfigFilePath(environment, platform);
  const input = await readConfigSnapshot(path, "follow");
  return input.ok ? parseConfigSnapshot(path, input.value) : input;
};

/** Resolve saved settings once for a production invocation. */
export const loadUserConfiguration = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform = HOST_PLATFORM.platform,
): Promise<Result<UserConfiguration, ConfigurationError>> => {
  const defaults = await loadUserConfigurationDefaults(environment, platform);
  return defaults.ok
    ? ok(applyUserConfigurationDefaults(environment, defaults.value))
    : defaults;
};

const configWriteFailure = async (
  path: string,
  cause: unknown,
): Promise<ConfigurationError> => {
  if (isClientConfigurationCleanupFailure(cause)) {
    const retry = await retryClientConfigurationCleanup(cause, resources);
    const failure = configFileError(
      path,
      "could not complete the configuration write",
      {
        cause: retry.primary,
        cleanup: retry.cleanup,
      },
    );
    if (retry.cleanupLeases.length > 0)
      new AnalysisCleanupLeaseGroup(failure, retry.cleanupLeases);
    return failure;
  }
  if (cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined) {
    const failure = configFileError(
      path,
      "could not release resources from an earlier edit",
      {
        cause,
        cleanup: cause.cleanup,
      },
    );
    bindRegularFileCleanup(cause, failure);
    return failure;
  }
  return configFileError(
    path,
    cause instanceof RegularFileChangedError
      ? "changed during the edit; retry with the current file"
      : "could not write the configuration",
    { cause },
  );
};

const serializeConfig = (settings: UserSettings): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(settings).sort(([a], [b]) => a.localeCompare(b)),
    ),
    null,
    2,
  ) + "\n";

const preserveOriginal = async (
  path: string,
  text: string,
): Promise<Result<void, ConfigurationError>> => {
  const backup = `${path}.rea.backup`;
  try {
    await lstat(backup);
    return ok(undefined);
  } catch (cause: unknown) {
    if (errorCode(cause) !== "ENOENT") throw cause;
  }
  const write = await writeTextFile(text, backup, false, resources);
  if (write.ok || write.error.reason === "exists") return ok(undefined);
  return err(
    withInheritedCleanupOwnership(
      configFileError(backup, "could not preserve the original configuration", {
        cause: write.error,
        cleanup: write.error.cleanup,
      }),
      write.error,
    ),
  );
};

const publishEdit = async (
  path: string,
  text: string,
  input: ConfigSnapshot | undefined,
): Promise<Result<void, ConfigurationError>> => {
  const transactionPath = await resolveClientConfigTransactionPath(path);
  if (transactionPath === undefined)
    return err(configFileError(path, "could not resolve the edit destination"));
  if (input !== undefined) {
    const backup = await preserveOriginal(transactionPath, input.text);
    if (!backup.ok) return backup;
  }
  const publication = await ClientConfigurationPublication.write(
    transactionPath,
    text,
    input?.text,
    { requestedPath: path, state: input?.state },
  );
  await publication.verify(async () => {
    const current = await readRegularFileTextSnapshot(publication.path, {
      resources,
      symlinks: "reject",
    });
    await publication.assertCurrent(current.text);
  });
  return ok(undefined);
};

interface UserConfigEdit {
  readonly settings: UserSettings;
  readonly removed: readonly PersistedSetting[];
}

const reviseConfig = async (
  path: string,
  settings: UserSettings,
  remove: readonly PersistedSetting[],
): Promise<Result<UserConfigEdit, ConfigurationError>> => {
  const input = await readConfigSnapshot(path, "reject");
  if (!input.ok) return input;
  const before = parseConfigSnapshot(path, input.value);
  if (!before.ok) return before;
  const next = { ...before.value, ...settings };
  const removed = [...new Set(remove)].filter((key) =>
    Object.hasOwn(next, key),
  );
  for (const key of removed) delete next[key];
  const text = serializeConfig(next);
  if (serializeConfig(before.value) !== text) {
    const publication = await publishEdit(path, text, input.value);
    if (!publication.ok) return publication;
  }
  return ok({ settings: next, removed });
};

/** Apply a complete edit under one cross-process lock. */
export const updateUserConfig = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  settings: UserSettings,
  remove: readonly PersistedSetting[],
  platform: NodeJS.Platform = HOST_PLATFORM.platform,
): Promise<UserConfigEdit> => {
  const path = userConfigFilePath(environment, platform);
  const checked = parseUserConfig(settings);
  if (!checked.ok) throw checked.error;
  if (remove.some((name) => Object.hasOwn(settings, name)))
    throw configFileError(
      path,
      "a setting cannot be set and unset in the same edit",
    );

  if (resources.hasPending) {
    try {
      await resources.retryCleanup();
    } catch (cause: unknown) {
      throw await configWriteFailure(path, cause);
    }
  }
  const hasNewSettings = Object.keys(checked.value).length > 0;
  if (hasNewSettings)
    await mkdir(dirname(path), { recursive: true }).catch((cause: unknown) => {
      throw configFileError(
        path,
        "could not create the configuration directory",
        { cause },
      );
    });
  const lock = `${path}.lock`;
  try {
    await mkdir(lock);
  } catch (cause: unknown) {
    if (errorCode(cause) === "ENOENT" && !hasNewSettings)
      return { settings: {}, removed: [] };
    if (errorCode(cause) === "EEXIST")
      throw configFileError(
        path,
        `another edit holds ${lock}. Retry after it finishes. If a previous process was interrupted, remove the empty lock directory after confirming no edit is active`,
        { cause },
      );
    throw configFileError(path, "could not acquire the configuration lock", {
      cause,
    });
  }

  const lockOwner = await OwnedStagedOutput.create(lock);
  const edit = await reviseConfig(path, checked.value, remove).catch(
    async (cause: unknown) => err(await configWriteFailure(path, cause)),
  );
  const release = await resources.release({
    kind: "staged-output",
    resource: lock,
    output: lockOwner,
  });
  if (release.kind === "failed") {
    const failure = configFileError(
      lock,
      "could not release the configuration lock",
      {
        cause: release.cause,
        cleanup: { reason: errorMessage(release.cause), resources: [lock] },
      },
    );
    release.lease.bindCleanupError(failure);
    throw edit.ok
      ? failure
      : analysisErrorWithCleanupDependencies(edit.error, failure, "config");
  }
  if (!edit.ok) throw edit.error;
  return edit.value;
};
