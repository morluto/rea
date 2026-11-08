import { constants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import {
  ArtifactFileCleanupFailure,
  bindArtifactFileCleanup,
  withArtifactFileHandle,
} from "../artifacts/ArtifactFileOperation.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { homeDirectoryFromEnvironment } from "../config/homeDirectory.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import {
  buildSecretHandleSchema,
  MAX_SECRET_CHARACTERS,
  secretValueRefusal,
} from "../domain/desktop/buildSecrets.js";
import { err, ok, type Result } from "../domain/result.js";

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
  }: {
    readonly searchOnly?: boolean;
    readonly maxCharacters?: number;
    readonly minCharacters?: number;
    readonly resources?: ArtifactResourceScope;
    readonly onCloseFailureValue?: (value: string) => void;
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
      undefined,
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
        const bytes = await file.readFile();
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
    throw cause;
  }
  if (result === undefined)
    throw new Error(`Secret file read did not complete: ${path}`);
  return result;
};

/** The handles the folder holds files for; none when it is missing or unreadable. */
export const listBuildSecretHandles = async (
  directory: string,
): Promise<string[]> => {
  if ((await folderRefusal(directory)) !== undefined) return [];
  const names = await readdir(directory).catch(() => []);
  return names
    .filter((name) => buildSecretHandleSchema.safeParse(name).success)
    .sort();
};

/** Write a new secret file only its owner reads, in a folder only they enter, never through a link; false, writing nothing, when the handle already has a file. */
export const writeBuildSecretFile = async (
  directory: string,
  handle: string,
  value: string,
  resources?: ArtifactResourceScope,
): Promise<boolean> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const refusal = await folderRefusal(directory);
  if (refusal !== undefined) throw new Error(refusal);
  let file: FileHandle;
  try {
    file = await open(
      join(directory, handle),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch (cause: unknown) {
    if (errorCode(cause) === "EEXIST") return false;
    throw cause;
  }
  try {
    await withArtifactFileHandle(
      join(directory, handle),
      file,
      resources,
      undefined,
      async (file) => {
        await file.chmod(0o600);
        await file.writeFile(value);
      },
    );
  } catch (cause: unknown) {
    if (cause instanceof ArtifactFileCleanupFailure)
      throw secretFileCleanupFailure(join(directory, handle), cause);
    throw cause;
  }
  await chmod(directory, 0o700);
  return true;
};
