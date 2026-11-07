import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, type FileHandle } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { homeDirectoryFromEnvironment } from "../config/homeDirectory.js";
import {
  buildSecretHandleSchema,
  MAX_SECRET_CHARACTERS,
  secretValueRefusal,
} from "../domain/desktop/buildSecrets.js";
import { err, ok, type Result } from "../domain/result.js";

/** The most bytes a secret file may hold: the longest secret in UTF-8 and a line break. */
const MAX_FILE_BYTES = MAX_SECRET_CHARACTERS * 4 + 2;

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
  { searchOnly = false }: { readonly searchOnly?: boolean } = {},
): Promise<Result<string, string>> => {
  const path = join(directory, handle);
  if (!buildSecretHandleSchema.safeParse(handle).success)
    return err(`${handle} is not a secret's handle`);
  const folder = await folderRefusal(directory);
  if (folder !== undefined)
    return err(`The secret ${handle} has no file: ${folder}.`);
  let file: FileHandle;
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
    const stats = await file.stat();
    if (!stats.isFile()) return err(`${path} is not a regular file.`);
    if (process.getuid !== undefined && stats.uid !== process.getuid())
      return err(`${path} belongs to another user.`);
    if (!searchOnly && (stats.mode & 0o077) !== 0)
      return err(
        `${path} can be read by other users; make it readable only by its owner with chmod 600.`,
      );
    if (stats.size > MAX_FILE_BYTES)
      return err(`${path} is larger than one secret.`);
    const bytes = await file.readFile();
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return err(`${path} is not UTF-8 text.`);
    }
    const value = text.replace(/\r?\n$/u, "");
    const refusal = secretValueRefusal(value);
    return refusal === undefined
      ? ok(value)
      : err(`The secret in ${path} cannot be typed: ${refusal}.`);
  } finally {
    await file.close();
  }
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
