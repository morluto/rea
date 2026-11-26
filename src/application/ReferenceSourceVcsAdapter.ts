import { decodeStrictUtf8 } from "../domain/strictUtf8.js";
import { isAborted } from "../domain/analysisErrorCore.js";
import fs from "node:fs";
import { join, sep } from "node:path";
import {
  locateReferenceSourceGitDirectory,
  ReferenceSourceGitDirectoryCancelled,
} from "./ReferenceSourceGitDirectory.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  type ArtifactResourceScope,
  ArtifactReaderFailure,
} from "../resources/index.js";
import {
  RegularFileCleanupFailure,
  regularFileCancellation,
} from "../filesystem/OwnedRegularFile.js";
import {
  readRegularFile,
  RegularFileReadFailure,
  retryRegularFileCleanup,
} from "../process/RegularFileRead.js";
import type { ReferenceSourceReaderError } from "../reference/ReferenceSourceReaderTypes.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { referenceSourceResourceFailure } from "../reference/ReferenceSourceFailureBuilders.js";

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
  let firstReadFailure: { readonly cause: unknown } | undefined;
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
          firstReadFailure ??= { cause: physical };
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
        firstReadFailure ??= { cause: retry.outcome.cause };
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
    decodeStrictUtf8(await readMetadataBytes(path), "preserve");
  const referenceFs = {
    ...fs,
    promises: {
      ...fs.promises,
      // Ref lookup may skip a directory-shaped candidate. Retain its physical
      // read failure even if a later candidate resolves or fails cleanup.
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
          // Keep filesystem reads and cleanup resources in host spelling.
          const bytes = await readMetadataBytes(path.replaceAll("/", sep));
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
          if (
            !(cause instanceof ArtifactReaderFailure) &&
            errorCode(cause) !== "ENOENT"
          )
            firstReadFailure ??= { cause };
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
      if (!(cause instanceof ArtifactReaderFailure)) {
        if (firstReadFailure !== undefined) throw firstReadFailure.cause;
        throw cause;
      }
      const primary =
        firstReadFailure?.cause ??
        (cause.reason === "cancelled" ? cause : (cause.cause ?? cause));
      throw new ArtifactReaderFailure(
        primary instanceof ArtifactReaderFailure &&
          primary.reason === "cancelled"
          ? "cancelled"
          : "io",
        `Git metadata could not be read safely: ${errorMessage(primary)}`,
        {
          cause: new AggregateError(
            [primary, cause],
            "Git metadata reads and cleanup failed",
            {
              cause: primary,
            },
          ),
          ...(cause.cleanup === undefined ? {} : { cleanup: cause.cleanup }),
        },
      );
    }
    signal?.throwIfAborted();
    if (firstReadFailure !== undefined) throw firstReadFailure.cause;
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
