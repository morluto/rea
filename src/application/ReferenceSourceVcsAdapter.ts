import fs from "node:fs";
import { join } from "node:path";
import {
  locateReferenceSourceGitDirectory,
  ReferenceSourceGitDirectoryCancelled,
} from "./ReferenceSourceGitDirectory.js";
import { err, ok, type Result } from "../domain/result.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  RegularFileCleanupFailure,
  regularFileCancellation,
} from "../filesystem/OwnedRegularFile.js";
import {
  readRegularFile,
  RegularFileReadFailure,
  retryRegularFileCleanup,
} from "./RegularFileRead.js";
import { referenceSourceResourceFailure } from "../reference/ReferenceSourceReaderErrors.js";
import type { ReferenceSourceReaderError } from "../reference/ReferenceSourceReaderTypes.js";

export type ReferenceSourceVcsInfo =
  | {
      readonly kind: "git";
      readonly head: string;
      readonly dirty: boolean | null;
    }
  | { readonly kind: "none"; readonly head: null; readonly dirty: null }
  | { readonly kind: "unknown"; readonly head: null; readonly dirty: null };

/**
 * Read Git metadata for a directory using isomorphic-git.
 *
 * No git subprocess or network is used; only the local `.git` object store is read.
 */
export const readReferenceSourceVcs = async (
  root: string,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<Result<ReferenceSourceVcsInfo, ReferenceSourceReaderError>> => {
  try {
    return await resources.run(async () => {
      try {
        return ok(await resolveSourceVcs(root, resources, signal));
      } catch (cause: unknown) {
        if (cause instanceof ArtifactReaderFailure) throw cause;
        return ok(unknownVcs());
      }
    });
  } catch (cause: unknown) {
    if (!(cause instanceof ArtifactReaderFailure)) throw cause;
    return err({
      ...referenceSourceResourceFailure(cause),
      ...(cause.reason !== "cancelled" && signal?.aborted === true
        ? { secondaryCancellation: { cause: signal.reason } }
        : {}),
    });
  }
};

const unknownVcs = (): ReferenceSourceVcsInfo => ({
  kind: "unknown",
  head: null,
  dirty: null,
});

const resolveSourceVcs = async (
  root: string,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<ReferenceSourceVcsInfo> => {
  // isomorphic-git is loaded on first use so CLI and MCP startup skip it.
  const { resolveRef } = await import("isomorphic-git");
  let failedRead: { readonly cause: unknown } | undefined;
  const cleanupFailures: ArtifactReaderFailure[] = [];
  const readMetadataBytes = async (path: string): Promise<Buffer> => {
    try {
      return await readRegularFile(path, {
        signal,
        cancellationFailure: (reason) =>
          new ArtifactReaderFailure(
            "cancelled",
            "Git metadata read cancelled",
            {
              cause: reason,
            },
          ),
      });
    } catch (cause: unknown) {
      if (cause instanceof ArtifactReaderFailure) throw cause;
      if (!(cause instanceof RegularFileCleanupFailure)) {
        if (
          signal?.aborted === true &&
          regularFileCancellation(cause) === undefined
        ) {
          const physical =
            cause instanceof RegularFileReadFailure
              ? cause.operationCause
              : cause;
          // The Git directory owner interprets absence of optional metadata.
          if (errorCode(physical) === "ENOENT") throw physical;
          throw new ArtifactReaderFailure(
            "io",
            `Git metadata could not be read safely: ${errorMessage(physical)}`,
            { cause: physical },
          );
        }
        throw cause instanceof RegularFileReadFailure
          ? cause.operationCause
          : cause;
      }
      const cancellation = regularFileCancellation(cause);
      const retry = await retryRegularFileCleanup(cause, resources, signal);
      if (
        retry.outcome.kind === "failed" &&
        cancellation === undefined &&
        errorCode(retry.outcome.cause) !== "ENOENT"
      )
        failedRead ??= { cause: retry.outcome.cause };
      if (
        retry.cleanup === undefined &&
        retry.outcome.kind === "failed" &&
        !isAborted(signal)
      )
        throw retry.outcome.cause;
      const primary =
        retry.outcome.kind === "failed"
          ? retry.outcome.cause
          : cause.cleanupCause;
      throw new ArtifactReaderFailure(
        cancellation === undefined ? "io" : "cancelled",
        `Git metadata could not be read safely: ${errorMessage(primary)}`,
        {
          cause: cancellation === undefined ? primary : cancellation.reason,
          ...(retry.cleanup === undefined ? {} : { cleanup: retry.cleanup }),
        },
      );
    }
  };
  const readMetadataText = async (path: string): Promise<string> =>
    (await readMetadataBytes(path)).toString("utf8");
  const throwCleanupFailures = (primary: unknown): never => {
    const observations = cleanupFailures.flatMap((failure) =>
      failure.cleanup === undefined ? [] : [failure.cleanup],
    );
    throw new ArtifactReaderFailure(
      primary instanceof ArtifactReaderFailure && primary.reason === "cancelled"
        ? "cancelled"
        : "io",
      `Git metadata could not be read safely: ${errorMessage(primary)}`,
      {
        cause: new AggregateError(
          [primary, ...cleanupFailures],
          "Git metadata reads and cleanup failed",
          { cause: primary },
        ),
        ...(observations.length === 0
          ? {}
          : {
              cleanup: {
                reason: observations.map(({ reason }) => reason).join("; "),
                resources: [
                  ...new Set(
                    observations.flatMap(({ resources }) => resources),
                  ),
                ],
              },
            }),
      },
    );
  };
  const referenceFs = {
    ...fs,
    promises: {
      ...fs.promises,
      // Let isomorphic-git finish probing refs, then report original failures.
      // A later resolved ref must not discard an earlier physical read or
      // retained cleanup failure.
      readFile: async (
        path: string | undefined,
        options:
          | BufferEncoding
          | { readonly encoding?: BufferEncoding | null }
          | null = null,
      ) => {
        // The library probes readFile() without a path to detect promise APIs.
        // Reject that invocation without attributing it to a source read.
        if (path === undefined)
          throw new TypeError("Git metadata path is required");
        try {
          const bytes = await readMetadataBytes(path);
          const encoding =
            typeof options === "string"
              ? options
              : typeof options === "object" &&
                  options !== null &&
                  "encoding" in options
                ? options.encoding
                : undefined;
          if (encoding === undefined || encoding === null) return bytes;
          if (typeof encoding !== "string" || !Buffer.isEncoding(encoding))
            throw new TypeError("Unsupported Git metadata text encoding");
          return bytes.toString(encoding);
        } catch (cause: unknown) {
          if (cause instanceof ArtifactReaderFailure) {
            cleanupFailures.push(cause);
            if (cause.reason !== "cancelled")
              failedRead ??= { cause: cause.cause ?? cause };
          } else if (errorCode(cause) !== "ENOENT") failedRead ??= { cause };
          throw cause;
        }
      },
    },
  };
  const readRef = async (options: {
    readonly gitdir?: string;
    readonly ref: string;
  }) => {
    let head: string;
    try {
      head = await resolveRef({ fs: referenceFs, dir: root, ...options });
    } catch (cause: unknown) {
      if (cleanupFailures.length > 0)
        throwCleanupFailures(failedRead?.cause ?? cleanupFailures[0] ?? cause);
      if (failedRead !== undefined) throw failedRead.cause;
      throw cause;
    }
    if (cleanupFailures.length > 0)
      throwCleanupFailures(failedRead?.cause ?? cleanupFailures[0]);
    signal?.throwIfAborted();
    if (failedRead !== undefined) throw failedRead.cause;
    return head;
  };
  let locations;
  try {
    locations = await locateReferenceSourceGitDirectory(
      root,
      readMetadataText,
      signal,
    );
  } catch (cause: unknown) {
    if (
      signal?.aborted === true &&
      !(cause instanceof ReferenceSourceGitDirectoryCancelled) &&
      !(cause instanceof ArtifactReaderFailure)
    )
      throw new ArtifactReaderFailure(
        "io",
        `Git directory could not be resolved: ${errorMessage(cause)}`,
        { cause },
      );
    throw cause;
  }
  if (locations === undefined) return { kind: "none", head: null, dirty: null };
  if (isAborted(signal)) return unknownVcs();
  const { gitDirectory, commonDirectory } = locations;
  if (gitDirectory === commonDirectory) {
    const head = await readRef({ gitdir: gitDirectory, ref: "HEAD" });
    return isAborted(signal)
      ? unknownVcs()
      : { kind: "git", head, dirty: null };
  }
  const headText = (await readMetadataText(join(gitDirectory, "HEAD"))).trim();
  const ref = headText.startsWith("ref: ") ? headText.slice(5) : "HEAD";
  const privateRef =
    ref === "HEAD" ||
    ["refs/bisect/", "refs/rewritten/", "refs/worktree/"].some((prefix) =>
      ref.startsWith(prefix),
    );
  const head = await readRef({
    gitdir: privateRef ? gitDirectory : commonDirectory,
    ref,
  });
  if (isAborted(signal)) return unknownVcs();
  return { kind: "git", head, dirty: null };
};

const errorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause
    ? String(cause.code)
    : undefined;

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const isAborted = (signal?: AbortSignal): boolean => signal?.aborted === true;
