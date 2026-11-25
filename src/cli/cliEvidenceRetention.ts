import { chmod, lstat, mkdir, readdir, rm, utimes } from "node:fs/promises";
import { join } from "node:path";

import { CLI_RETAINED_EVIDENCE_MAX_AGE_MS } from "../domain/analysisResourceLimits.js";
import { err, ok, type Result } from "../domain/result.js";
import { reaCacheDirectory } from "../filesystem/cacheDirectory.js";
import { errorMessage } from "../kernel/errorMessage.js";

/** Where one invocation may retain over-budget Evidence, and how much. */
export interface CliEvidenceRetention {
  /** The private per-user directory, `rea/evidence` under the cache root. */
  readonly directory: string;
  /** Total bytes the directory may hold; above 0. */
  readonly capBytes: number;
}

/** The per-run opt-out switch. */
export const NO_RETAIN_FLAG = "--no-retain";

/** The retained-Evidence directory under the platform's per-user cache root. */
export const cliRetainedEvidenceDirectory = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): string => reaCacheDirectory(environment, platform, "evidence");

/**
 * A retained bundle is named by its complete record's Evidence ID, a SHA-256
 * content digest, so one record has one file: a repeat run reuses it and a
 * written file is never overwritten. The cache key is the record itself,
 * which covers every input that affected the result.
 */
const RETAINED_NAME = /^ev_[0-9a-f]{64}\.json$/u;

/** One retained record: its file, size, and whether it was already there. */
export interface RetainedEvidenceFile {
  readonly path: string;
  readonly bytes: number;
  readonly reused: boolean;
}

/** The writer's outcome: the bundle it published, or that the name exists. */
export type RetentionWrite = Result<
  { readonly bytes: number },
  "exists" | string
>;

const isMissing = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  (cause as { readonly code?: unknown }).code === "ENOENT";

const isOwnedEntry = (stats: { readonly uid: number }): boolean =>
  // Only POSIX hosts expose user IDs; elsewhere the cache root's ACLs apply.
  typeof process.getuid !== "function" || stats.uid === process.getuid();

/**
 * Create the directory privately (0700), and admit it only when it is a real
 * directory this user owns, never a symbolic link. Our own directory is
 * tightened to 0700 if something loosened it.
 */
const admitDirectory = async (directory: string): Promise<boolean> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink() || !isOwnedEntry(stats))
    return false;
  if (typeof process.getuid === "function" && (stats.mode & 0o077) !== 0)
    await chmod(directory, 0o700);
  return true;
};

/** A regular file this user owns at `path`, its size; undefined when absent. */
const ownedFileBytes = async (
  path: string,
): Promise<number | "foreign" | undefined> => {
  const stats = await lstat(path).catch((cause: unknown) => {
    if (isMissing(cause)) return undefined;
    throw cause;
  });
  if (stats === undefined) return undefined;
  return stats.isFile() && !stats.isSymbolicLink() && isOwnedEntry(stats)
    ? stats.size
    : "foreign";
};

/**
 * Remove retained records unused for longer than the maximum age, then the
 * least recently used until the directory fits `capBytes`. Only regular files
 * named like a retained record are considered, never the record just kept,
 * and a file that cannot be removed is left for a later run.
 */
const evict = async (
  directory: string,
  keep: string,
  capBytes: number,
  now: number,
): Promise<void> => {
  const entries: { name: string; bytes: number; used: number }[] = [];
  for (const name of await readdir(directory)) {
    if (!RETAINED_NAME.test(name)) continue;
    const stats = await lstat(join(directory, name)).catch(() => undefined);
    if (stats === undefined || !stats.isFile() || !isOwnedEntry(stats))
      continue;
    entries.push({ name, bytes: stats.size, used: stats.mtimeMs });
  }
  const remove = (name: string) =>
    rm(join(directory, name), { force: true }).then(
      () => true,
      () => false,
    );
  let total = 0;
  const live: typeof entries = [];
  for (const entry of entries)
    if (
      entry.name !== keep &&
      now - entry.used > CLI_RETAINED_EVIDENCE_MAX_AGE_MS
    )
      await remove(entry.name);
    else {
      live.push(entry);
      total += entry.bytes;
    }
  live.sort((left, right) => left.used - right.used);
  for (const entry of live) {
    if (total <= capBytes) break;
    if (entry.name === keep) continue;
    if (await remove(entry.name)) total -= entry.bytes;
  }
};

/**
 * Keep one over-budget record recoverable in the private cache. A record
 * larger than the cache, an unusable directory, or a failed write retains
 * nothing and says why; it never fails the analysis. `write` publishes the
 * bundle with the Evidence bundle writer, which creates the file exclusively
 * (0600) and refuses an existing name.
 */
export const retainCliEvidence = async (input: {
  readonly evidenceId: string;
  readonly completeBytes: number;
  readonly retention: CliEvidenceRetention;
  readonly write: (path: string) => Promise<RetentionWrite>;
  readonly now?: number;
}): Promise<Result<RetainedEvidenceFile, string>> => {
  const { directory, capBytes } = input.retention;
  const name = `${input.evidenceId}.json`;
  if (!RETAINED_NAME.test(name))
    return err(`Evidence ID ${input.evidenceId} is not a content digest.`);
  if (input.completeBytes > capBytes)
    return err(
      `The complete Evidence (${String(input.completeBytes)} bytes) is larger than the retained-Evidence cache (${String(capBytes)} bytes).`,
    );
  const now = input.now ?? Date.now();
  try {
    if (!(await admitDirectory(directory)))
      return err(
        `${directory} is not a private directory this user owns, so nothing was retained.`,
      );
    const path = join(directory, name);
    const reuse = async (): Promise<
      Result<RetainedEvidenceFile, string> | undefined
    > => {
      const bytes = await ownedFileBytes(path);
      if (bytes === undefined) return undefined;
      if (bytes === "foreign")
        return err(`${path} exists and is not a retained Evidence file.`);
      // A use refreshes the record's age; its bytes are never rewritten.
      const used = new Date(now);
      await utimes(path, used, used);
      return ok({ path, bytes, reused: true });
    };
    let kept = await reuse();
    if (kept === undefined) {
      const written = await input.write(path);
      // Another run kept the same record between the check and the write.
      kept = written.ok
        ? ok({ path, bytes: written.value.bytes, reused: false })
        : written.error === "exists"
          ? ((await reuse()) ?? err(`${path} could not be written.`))
          : err(written.error);
    }
    if (kept.ok) await evict(directory, name, capBytes, now).catch(() => {});
    return kept;
  } catch (cause: unknown) {
    return err(
      `The retained-Evidence cache could not be used: ${errorMessage(cause)}`,
    );
  }
};
