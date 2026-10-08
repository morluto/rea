import {
  link,
  lstat,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { EvidenceFileError } from "../domain/evidenceErrors.js";
import { err, ok, type Result } from "../domain/result.js";

/** Read JSON data from a regular file at the caller-supplied path. */
export const readJsonFile = async (
  path: string,
): Promise<Result<unknown, EvidenceFileError>> => {
  try {
    const canonicalPath = await realpath(resolve(path));
    const stats = await lstat(canonicalPath);
    if (!stats.isFile()) return err(new EvidenceFileError("read", "not-file"));
    const encoded = await readFile(canonicalPath);
    let decoded: unknown;
    try {
      decoded = JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          encoded,
        ),
      );
    } catch (cause: unknown) {
      return err(new EvidenceFileError("read", "invalid-json", { cause }));
    }
    return ok(decoded);
  } catch (cause: unknown) {
    return err(new EvidenceFileError("read", "io", { cause }));
  }
};

/** Atomically write text to the caller-supplied path. */
export const writeTextFile = async (
  encoded: string,
  path: string,
  overwrite: boolean,
): Promise<
  Result<{ readonly path: string; readonly bytes: number }, EvidenceFileError>
> => writeTextParts([encoded], path, overwrite);

/** Publish complete streamed text atomically, keeping only one encoded part in memory. */
export const writeTextParts = async (
  parts: Iterable<string>,
  path: string,
  overwrite: boolean,
): Promise<
  Result<{ readonly path: string; readonly bytes: number }, EvidenceFileError>
> => {
  try {
    const requestedPath = resolve(path);
    const canonicalParent = await realpath(dirname(requestedPath));
    const destination = resolve(canonicalParent, basename(requestedPath));
    const existing = await lstat(destination).catch((cause: unknown) => {
      if (fileErrorCode(cause) === "ENOENT") return undefined;
      throw cause;
    });
    if (existing !== undefined) {
      if (!overwrite) return err(new EvidenceFileError("write", "exists"));
      if (!existing.isFile() || existing.isSymbolicLink())
        return err(new EvidenceFileError("write", "not-file"));
    }
    const bytes = await publishFile(destination, parts, overwrite);
    return ok({ path: requestedPath, bytes });
  } catch (cause: unknown) {
    if (!overwrite && fileErrorCode(cause) === "EEXIST")
      return err(new EvidenceFileError("write", "exists", { cause }));
    return err(new EvidenceFileError("write", "io", { cause }));
  }
};

const publishFile = async (
  destination: string,
  parts: Iterable<string>,
  overwrite: boolean,
): Promise<number> => {
  const stagingDirectory = await mkdtemp(
    resolve(dirname(destination), ".rea-write-"),
  );
  try {
    const staged = resolve(stagingDirectory, "content");
    const file = await open(staged, "wx", 0o600);
    let bytes = 0;
    try {
      for (const part of parts) {
        await file.writeFile(part, { encoding: "utf8" });
        bytes += Buffer.byteLength(part, "utf8");
      }
      await file.sync();
    } finally {
      await file.close();
    }
    if (overwrite) await rename(staged, destination);
    // A hard link publishes complete bytes atomically and cannot replace an existing name.
    else await link(staged, destination);
    return bytes;
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
};

const fileErrorCode = (cause: unknown): unknown =>
  typeof cause === "object" && cause !== null && "code" in cause
    ? cause.code
    : undefined;
