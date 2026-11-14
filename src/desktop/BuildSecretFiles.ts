import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import {
  ArtifactFileCleanupFailure,
  bindArtifactFileCleanup,
  withArtifactFileHandle,
} from "../artifacts/ArtifactFileOperation.js";
import type {
  ArtifactResourceScope,
  ArtifactResourceOwner,
} from "../artifacts/ArtifactResourceScope.js";
import { homeDirectoryFromEnvironment } from "../config/homeDirectory.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  buildSecretHandleSchema,
  MAX_SECRET_CHARACTERS,
  secretValueRefusal,
} from "../domain/desktop/buildSecrets.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  RegularFileCapacityError,
  readStableFileBytes,
} from "../filesystem/readStableFileBytes.js";
import { RegularFileChangedError } from "../filesystem/RegularFile.js";

/** The most bytes a secret file of at most `characters` may hold: those in UTF-8 and a line break. */
const maxFileBytes = (characters: number) => characters * 4 + 2;

/** The folder of secret files on the build host: `rea/build-secrets` under the XDG config folder, or `~/.config`. */
export const buildSecretsDirectory = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform = process.platform,
): string => {
  const xdg = environment.XDG_CONFIG_HOME;
  const root =
    xdg !== undefined && isAbsolute(xdg)
      ? xdg
      : join(homeDirectoryFromEnvironment(environment, platform), ".config");
  return join(root, "rea", "build-secrets");
};

const errorCode = (cause: unknown): unknown =>
  (cause as { code?: unknown } | null)?.code;

/** Transfer the descriptor lease without retaining secret values in the error. */
const secretFileCleanupFailure = (
  path: string,
  cause: ArtifactFileCleanupFailure,
  refusal?: string,
): ProviderAdapterError => {
  const outcome = cause.fileCleanupFailure.outcome;
  const code = outcome.kind === "failed" ? errorCode(outcome.cause) : undefined;
  const operationFailure =
    outcome.kind !== "failed"
      ? undefined
      : typeof code === "string" && /^E[A-Z0-9]{1,15}$/u.test(code)
        ? `The secret file operation failed (${code}).`
        : "The secret file operation failed.";
  const error = new ProviderAdapterError("rea-desktop", "build_secret_file", {
    userMessage:
      refusal === undefined && operationFailure === undefined
        ? `Could not close the secret file ${path}.`
        : `${refusal ?? operationFailure} The secret file could not be closed.`,
    cleanup: { reason: "Secret file close failed.", resources: [path] },
  });
  bindArtifactFileCleanup(cause, error);
  return error;
};

/** Why the folder cannot hold secrets REA reads, or undefined: it must be a real folder, not a link. */
const folderRefusal = async (
  directory: string,
): Promise<string | undefined> => {
  let entry: Stats;
  try {
    entry = await lstat(directory);
  } catch (cause: unknown) {
    return errorCode(cause) === "ENOENT"
      ? `there is no folder ${directory}`
      : `${directory} could not be read`;
  }
  if (entry.isSymbolicLink())
    return `${directory} is a symbolic link; make it a folder of its own`;
  return entry.isDirectory() ? undefined : `${directory} is not a folder`;
};

/** A handle's secret from its own regular file, readable by no one else unless only searched for; a refusal never quotes it. */
export const readBuildSecretFile = async (
  directory: string,
  handle: string,
  {
    searchOnly = false,
    maxCharacters = MAX_SECRET_CHARACTERS,
    minCharacters,
    resources,
    onCloseFailureValue,
    signal,
  }: {
    readonly searchOnly?: boolean;
    readonly maxCharacters?: number;
    readonly minCharacters?: number;
    readonly resources?: ArtifactResourceScope;
    readonly onCloseFailureValue?: (value: string) => void;
    readonly signal?: AbortSignal;
  } = {},
): Promise<Result<string, string>> => {
  const path = join(directory, handle);
  if (!buildSecretHandleSchema.safeParse(handle).success)
    return err(`${handle} is not a secret's handle`);
  const folder = await folderRefusal(directory);
  if (folder !== undefined)
    return err(`The secret ${handle} has no file: ${folder}.`);
  let file: FileHandle;
  let result: Result<string, string> | undefined;
  try {
    // No link is followed, and a FIFO in its place cannot hold the open.
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (cause: unknown) {
    return err(
      errorCode(cause) === "ELOOP"
        ? `${path} is a symbolic link; write the secret in the file itself.`
        : errorCode(cause) === "ENOENT"
          ? `The secret ${handle} has no file at ${path}.`
          : `${path} could not be opened.`,
    );
  }
  try {
    await withArtifactFileHandle(
      path,
      file,
      resources,
      signal,
      async (file) => {
        const stats = await file.stat();
        if (!stats.isFile()) {
          result = err(`${path} is not a regular file.`);
          return;
        }
        if (process.getuid !== undefined && stats.uid !== process.getuid()) {
          result = err(`${path} belongs to another user.`);
          return;
        }
        if (!searchOnly && (stats.mode & 0o077) !== 0) {
          result = err(
            `${path} can be read by other users; make it readable only by its owner with chmod 600.`,
          );
          return;
        }
        if (stats.size > maxFileBytes(maxCharacters)) {
          result = err(`${path} is larger than one secret.`);
          return;
        }
        const bytes = await readStableFileBytes(
          file,
          path,
          maxFileBytes(maxCharacters),
          {
            symlinks: "reject",
            ...(signal === undefined ? {} : { signal }),
          },
        );
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          result = err(`${path} is not UTF-8 text.`);
          return;
        }
        const value = text.replace(/\r?\n$/u, "");
        const refusal = secretValueRefusal(value, maxCharacters, minCharacters);
        result =
          refusal === undefined
            ? ok(value)
            : err(`The secret in ${path} cannot be typed: ${refusal}.`);
      },
    );
  } catch (cause: unknown) {
    if (cause instanceof ArtifactFileCleanupFailure) {
      if (result?.ok) onCloseFailureValue?.(result.value);
      throw secretFileCleanupFailure(
        path,
        cause,
        result?.ok === false ? result.error : undefined,
      );
    }
    if (cause instanceof RegularFileCapacityError)
      return err(`${path} is larger than one secret.`);
    if (cause instanceof RegularFileChangedError)
      return err(`${path} changed while REA read it.`);
    throw cause;
  }
  if (result === undefined)
    throw new Error(`Secret file read did not complete: ${path}`);
  return result;
};

/** The handles the folder holds files for; only a missing folder is empty. */
export const listBuildSecretHandles = async (
  directory: string,
): Promise<string[]> => {
  try {
    const entry = await lstat(directory);
    if (entry.isSymbolicLink() || !entry.isDirectory())
      throw new Error(
        `The secrets folder ${directory} is not a directory of its own.`,
      );
  } catch (cause: unknown) {
    if (errorCode(cause) === "ENOENT") return [];
    throw new Error(`The secrets folder ${directory} could not be inspected.`, {
      cause,
    });
  }
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (cause: unknown) {
    throw new Error(`The secrets folder ${directory} could not be listed.`, {
      cause,
    });
  }
  return names
    .filter((name) => buildSecretHandleSchema.safeParse(name).success)
    .sort();
};

/** Write a new secret file only its owner reads, in a folder only they enter, never through a link, its name given only once it is whole; false, giving it none, when the handle already has a file. */
export const writeBuildSecretFile = async (
  directory: string,
  handle: string,
  value: string,
  resources: ArtifactResourceScope,
): Promise<boolean> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const refusal = await folderRefusal(directory);
  if (refusal !== undefined) throw new Error(refusal);
  // Written under a name no handle takes, then linked to the handle's, which fails if it has a file: no reader sees one half written.
  const pending = join(directory, `.${handle}.${randomUUID()}`);
  const file = await open(
    pending,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  const temporary: ArtifactResourceOwner = {
    kind: "lease",
    resource: pending,
    lease: { release: () => unlink(pending) },
  };
  let linked = false;
  let failure: unknown;
  let failed = false;
  try {
    await withArtifactFileHandle(
      pending,
      file,
      resources,
      undefined,
      async (file) => {
        await file.chmod(0o600);
        await file.writeFile(value);
      },
    );
    linked = await link(pending, join(directory, handle)).then(
      () => true,
      (cause: unknown) => {
        if (errorCode(cause) === "EEXIST") return false;
        throw cause;
      },
    );
  } catch (cause: unknown) {
    failed = true;
    failure = cause;
  }
  const removed = await resources.release(temporary);
  if (removed.kind === "failed") {
    const cleanup = resources.cleanupFailure(
      failed ? { kind: "failed", cause: failure } : { kind: "completed" },
      [removed],
    );
    const code = errorCode(failure);
    const error = new ProviderAdapterError("rea-desktop", "build_secret_file", {
      userMessage:
        failure instanceof ArtifactFileCleanupFailure
          ? (secretFileCleanupFailure(pending, failure).userMessage ??
            "The secret file operation failed.")
          : failure instanceof AnalysisError
            ? (failure.userMessage ?? "The secret file operation failed.")
            : typeof code === "string" && /^E[A-Z0-9]{1,15}$/u.test(code)
              ? `The secret file operation failed (${code}).`
              : linked
                ? `The secret was published as ${handle}, but its temporary file could not be removed.`
                : "The temporary secret file could not be removed.",
      ...(linked ? { diagnostics: { published_handle: handle } } : {}),
      cleanup: {
        reason: "Temporary secret file removal failed.",
        resources: cleanup.cleanup?.resources ?? [pending],
      },
    });
    bindArtifactFileCleanup(cleanup, error);
    throw error;
  }
  if (failed)
    throw failure instanceof ArtifactFileCleanupFailure
      ? secretFileCleanupFailure(pending, failure)
      : failure;
  if (linked) {
    try {
      await chmod(directory, 0o700);
    } catch (cause: unknown) {
      const code = errorCode(cause);
      throw new ProviderAdapterError("rea-desktop", "build_secret_file", {
        userMessage: `The secret was published as ${handle}, but its directory permissions could not be updated${typeof code === "string" && /^E[A-Z0-9]{1,15}$/u.test(code) ? ` (${code})` : ""}.`,
        remediationAction: `Check the permissions of ${directory} before using the secret.`,
        diagnostics: { published_handle: handle },
      });
    }
  }
  return linked;
};
