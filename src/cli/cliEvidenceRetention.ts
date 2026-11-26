import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  realpath,
  rm,
  utimes,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { CLI_RETAINED_EVIDENCE_MAX_AGE_MS } from "../domain/analysisResourceLimits.js";
import type { Evidence } from "../domain/evidence.js";
import type { EvidenceBundle } from "../domain/evidenceBundle.js";
import { canonicalJsonParts, jsonParts } from "../domain/jsonSerialization.js";
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
 * The public record_sha256 receipt: SHA-256 of the complete parent's exact JSON.
 * It preserves caller-input paths and local subject metadata omitted from the
 * semantic Evidence ID. The bundle cache key separately covers source records.
 */
export const retainedEvidenceDigest = (evidence: Evidence): string =>
  retainedJsonDigest(jsonParts(evidence));

/** Hash the same canonical bytes the bundle writer publishes, including sources. */
export const retainedEvidenceBundleDigest = (bundle: EvidenceBundle): string =>
  retainedJsonDigest(canonicalJsonParts(bundle));

const retainedJsonDigest = (parts: Iterable<string>): string => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part, "utf8");
  return hash.digest("hex");
};

/** A retained bundle is named by its complete bundle digest. */
const RETAINED_NAME = /^[0-9a-f]{64}\.json$/u;

/** One retained record: its file, size, digest and whether it was already there. */
export interface RetainedEvidenceFile {
  readonly path: string;
  readonly bytes: number;
  readonly cacheKey: string;
  readonly reused: boolean;
}

/**
 * Why nothing was retained. `committed` carries the writer's failure when
 * the file was published but a later step (staging cleanup, cancellation)
 * failed; `cleanupIncomplete` carries a pre-commit failure whose staging
 * cleanup stayed incomplete. In both cases the caller reports that failure
 * and its cleanup owner.
 */
export interface RetentionStop<Committed> {
  readonly reason: string;
  readonly committed?: Committed;
  readonly cleanupIncomplete?: Committed;
  /**
   * True when the file was published and remains on disk because a post-write
   * removal (such as discarding an oversized bundle) failed; the caller must
   * retain the published file's receipt.
   */
  readonly fileRemains?: true;
  /** Surviving file receipt details when `fileRemains` is true. */
  readonly remainingFile?: RetainedEvidenceFile;
}

/** The writer's outcome: the bytes it published, that the name exists, or a stop. */
export type RetentionWrite<Committed> = Result<
  { readonly bytes: number },
  "exists" | RetentionStop<Committed>
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
const admitDirectory = async (
  directory: string,
): Promise<string | undefined> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink() || !isOwnedEntry(stats))
    return undefined;
  if (typeof process.getuid === "function" && (stats.mode & 0o077) !== 0)
    await chmod(directory, 0o700);
  // The checked directory as the filesystem resolves it, so later paths
  // keep its meaning even when the selected spelling holds `..` after a
  // symbolic link, which lexical joining would collapse.
  return realpath(directory);
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

/** Renew a retained record's age: it was used now. Its bytes never change. */
const renew = async (path: string, now: number): Promise<void> => {
  const used = new Date(now);
  await utimes(path, used, used);
};

/**
 * Remove retained records unused for longer than the maximum age, then the
 * least recently used until the directory fits `capBytes`. Only regular files
 * named like a retained record are considered, never the record just kept.
 * Each removal first checks that the record was not used since it was
 * listed, so a concurrent run's renewal keeps it; a file that cannot be
 * removed is left for a later run.
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
  const remove = async (entry: (typeof entries)[number]): Promise<boolean> => {
    const path = join(directory, entry.name);
    const current = await lstat(path).catch(() => undefined);
    if (current === undefined || current.mtimeMs !== entry.used) return false;
    return rm(path, { force: true }).then(
      () => true,
      () => false,
    );
  };
  let total = 0;
  const live: typeof entries = [];
  for (const entry of entries) {
    const expired =
      entry.name !== keep &&
      now - entry.used > CLI_RETAINED_EVIDENCE_MAX_AGE_MS;
    if (expired && (await remove(entry))) continue;
    live.push(entry);
    total += entry.bytes;
  }
  live.sort((left, right) => left.used - right.used);
  for (const entry of live) {
    if (total <= capBytes) break;
    if (entry.name === keep) continue;
    if (await remove(entry)) total -= entry.bytes;
  }
};

/**
 * Keep one over-budget record recoverable in the private cache. A record or
 * bundle larger than the cache, an unusable directory, or a failed write
 * retains nothing and says why; it never fails the analysis. `write`
 * publishes the bundle with the Evidence bundle writer, which creates the
 * file exclusively (0600) and refuses an existing name.
 */
export const retainCliEvidence = async <Committed>(input: {
  readonly cacheKey: string;
  readonly completeBytes: number;
  readonly retention: CliEvidenceRetention;
  readonly write: (path: string) => Promise<RetentionWrite<Committed>>;
  readonly rejectResolvedDirectory?: (directory: string) => string | undefined;
  readonly now?: number;
}): Promise<Result<RetainedEvidenceFile, RetentionStop<Committed>>> => {
  const { directory, capBytes } = input.retention;
  const { cacheKey } = input;
  const name = `${cacheKey}.json`;
  if (!RETAINED_NAME.test(name))
    return err({ reason: `${cacheKey} is not a SHA-256 digest.` });
  const tooLarge = (bytes: number) => ({
    reason: `The complete Evidence (${String(bytes)} bytes) is larger than the retained-Evidence cache (${String(capBytes)} bytes).`,
  });
  if (input.completeBytes > capBytes) return err(tooLarge(input.completeBytes));
  const now = input.now ?? Date.now();
  try {
    const admitted = await admitDirectory(directory);
    if (admitted === undefined)
      return err({
        reason:
          "The retained-Evidence cache directory is not a private directory this user owns.",
      });
    const rejected = input.rejectResolvedDirectory?.(admitted);
    if (rejected !== undefined) return err({ reason: rejected });
    const path = join(admitted, name);
    const reuse = async (): Promise<
      Result<RetainedEvidenceFile, RetentionStop<Committed>> | undefined
    > => {
      const bytes = await ownedFileBytes(path);
      if (bytes === undefined) return undefined;
      if (bytes === "foreign")
        return err({
          reason:
            "A file that is not a retained Evidence record holds its name.",
        });
      await renew(path, now);
      return ok({ path, bytes, cacheKey, reused: true });
    };
    let kept = await reuse();
    if (kept === undefined) {
      const written = await input.write(path);
      if (written.ok && written.value.bytes > capBytes) {
        // The bundle, with the sources it cites, outgrew the cache.
        try {
          await rm(path, { force: true });
        } catch (cause: unknown) {
          return err({
            reason: `The oversized retained-Evidence bundle (${String(written.value.bytes)} bytes) is larger than the retained-Evidence cache (${String(capBytes)} bytes) and could not be removed: ${errorMessage(cause)}`,
            fileRemains: true,
            remainingFile: {
              path,
              bytes: written.value.bytes,
              cacheKey,
              reused: false,
            },
          });
        }
        return err(tooLarge(written.value.bytes));
      }
      // Another run kept the same record between the check and the write.
      kept = written.ok
        ? ok({ path, bytes: written.value.bytes, cacheKey, reused: false })
        : written.error === "exists"
          ? ((await reuse()) ??
            err({ reason: "The retained Evidence file could not be written." }))
          : err(written.error);
    }
    if (kept.ok) await evict(admitted, name, capBytes, now).catch(() => {});
    return kept;
  } catch (cause: unknown) {
    return err({
      reason: `The retained-Evidence cache could not be used: ${errorMessage(cause)}`,
    });
  }
};

/**
 * A read through `rea inspect-analysis-view` uses a retained record, so it
 * renews the record's age as a repeat run does. Only a record file in this
 * invocation's cache directory is touched; anything else is left alone.
 */
export const renewRetainedEvidence = async (
  path: string,
  retention: CliEvidenceRetention | undefined,
  now = Date.now(),
): Promise<void> => {
  if (retention === undefined || !RETAINED_NAME.test(basename(path))) return;
  // Compare the directories as the filesystem resolves them.
  const [parent, cache] = await Promise.all([
    realpath(dirname(resolve(path))).catch(() => undefined),
    realpath(retention.directory).catch(() => undefined),
  ]);
  if (parent === undefined || parent !== cache) return;
  const absolute = join(parent, basename(path));
  const bytes = await ownedFileBytes(absolute).catch(() => undefined);
  if (typeof bytes === "number") await renew(absolute, now).catch(() => {});
};
