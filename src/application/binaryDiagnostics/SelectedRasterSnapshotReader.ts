import { setImmediate } from "node:timers/promises";
import { absoluteCallerPath } from "../../filesystem/callerPath.js";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { REA_WORKFLOW_PROVIDER } from "../../domain/investigationProviders.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  classifyProviderFailure,
  type ProviderFailureDialect,
} from "../../providers/classifyProviderFailure.js";
import {
  AnalysisOutputError,
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  cancelledBy,
  carriedReason,
  AnalysisInputError,
  fixedCeilingConstraint,
} from "../../domain/analysisErrorCore.js";
import type { FileSnapshotPartialObservation } from "../../domain/fileSnapshotObservation.js";
import type { Evidence } from "../../domain/evidence.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  ArtifactResourceScope,
  ArtifactReaderFailure,
  withArtifactFileHandle,
  bindArtifactFileCleanup,
  ArtifactFileCleanupFailure,
  artifactFileCompletion,
  assertArtifactReadActive,
  artifactFileCancellationCause,
  artifactSelectedPathErrno,
} from "../../resources/index.js";
import { analysisErrorWithCleanupDependencies } from "../../domain/analysisErrorCleanup.js";
import { sameRegularFileState } from "../../filesystem/RegularFile.js";
import { HOST_PLATFORM } from "../../platform/HostPlatform.js";

export interface SelectedRasterSnapshot {
  bytes: Uint8Array;
  artifact: { path: string; bytes: number; sha256: string };
  window: { offset: number; length: number };
}
export interface SelectedRasterWindow {
  path: string;
  offset: number;
  length?: number | undefined;
}
interface SnapshotReadOptions {
  signal?: AbortSignal | undefined;
  completedObservation?: ((value: unknown) => Evidence | undefined) | undefined;
}
const MAX_FILE_BYTES = 128 * 1024 * 1024;
/** One bounded selected-file admission owner shared by inspection and export. */
export class SelectedRasterSnapshotReader {
  constructor(
    private readonly files: Pick<
      typeof import("node:fs/promises"),
      "open" | "stat"
    > = { open, stat },
    private readonly resources = new ArtifactResourceScope(),
    private readonly platform: NodeJS.Platform = HOST_PLATFORM.platform,
  ) {}
  async read<T>(
    input: SelectedRasterWindow,
    operation: string,
    consume: (snapshot: SelectedRasterSnapshot) => T | Promise<T>,
    options: SnapshotReadOptions = {},
  ): Promise<Result<T, AnalysisError>> {
    try {
      return await this.resources.run(() =>
        this.#readOwned(input, operation, consume, options),
      );
    } catch (cause: unknown) {
      const failure = new AnalysisOutputError(
        operation,
        "A retained raster-analysis file descriptor could not be released before inspection.",
        {
          cause,
          ...(cause instanceof ArtifactReaderFailure &&
          cause.cleanup !== undefined
            ? { cleanup: cause.cleanup }
            : {}),
        },
      );
      bindArtifactFileCleanup(cause, failure);
      return err(failure);
    }
  }

  close(): Promise<void> {
    return this.resources.close();
  }
  async #readOwned<T>(
    selection: SelectedRasterWindow,
    operation: string,
    consume: (snapshot: SelectedRasterSnapshot) => T | Promise<T>,
    options: SnapshotReadOptions,
  ): Promise<Result<T, AnalysisError>> {
    let input = { ...selection, path: absoluteCallerPath(selection.path) };
    const invalid = (field: string, message: string) =>
      new AnalysisInputError(operation, undefined, [
        { path: [field], reason: "invalid_value", message },
      ]);
    let admitted = false;
    let acquiredIdentity: FileSnapshotPartialObservation | undefined;
    const failureDialect: ProviderFailureDialect = {
      providerId: REA_WORKFLOW_PROVIDER.id,
      operation: operation,
      // Admission owns the distinction between an unavailable selected path
      // and a path that disappeared after its identity was admitted.
      recognise: (cause, details) => {
        if (!(cause instanceof Error) || !("code" in cause)) return undefined;
        if (cause.code === "EACCES" || cause.code === "EPERM")
          return new AnalysisAccessDeniedError(
            operation,
            input.path,
            cause.code,
            { ...details, cause },
          );
        const pathErrno = artifactSelectedPathErrno(cause);
        if (pathErrno === undefined) return undefined;
        return admitted
          ? new AnalysisArtifactChangedError(
              operation,
              input.path,
              "Selected file path changed during raster candidate inspection.",
              { ...details, cause },
            )
          : new AnalysisInputError(operation, { ...details, cause }, [
              {
                path: ["path"],
                reason: "invalid_value",
                message:
                  pathErrno === "ENOENT" || pathErrno === "ENOTDIR"
                    ? "Selected file could not be found."
                    : pathErrno === "ELOOP"
                      ? `Selected file path could not be resolved because symbolic-link traversal looped or exceeded the host limit (ELOOP): ${input.path}`
                      : `Selected file path exceeds the host path or component length limit (ENAMETOOLONG): ${input.path}`,
              },
            ]);
      },
      unclassified: (cause, details) =>
        new AnalysisOutputError(
          operation,
          cause instanceof ArtifactReaderFailure
            ? cause.message
            : "Could not read complete raster analysis evidence.",
          { ...details, cause },
        ),
    };
    try {
      const before = await this.files.stat(input.path, { bigint: true });
      if (!before.isFile()) throw invalid("path", "Expected a regular file.");
      admitted = true;
      // Only an admitted selected file may consult filesystem spelling. Do not
      // replace symlink/junction/8.3 aliases or touch source-derived paths.
      if (this.platform === "win32") {
        const canonical = await realpath(input.path).catch(() => undefined);
        assertArtifactReadActive(options.signal);
        if (canonical?.toLowerCase() === input.path.toLowerCase())
          input = { ...input, path: canonical };
      }
      const file = await this.files.open(
        input.path,
        constants.O_RDONLY | constants.O_NONBLOCK,
      );
      const report = await withArtifactFileHandle(
        input.path,
        file,
        this.resources,
        options.signal,
        async (file) => {
          const initial = await file.stat({ bigint: true });
          const changed = () =>
            new AnalysisArtifactChangedError(
              operation,
              input.path,
              "File identity, size or timestamps changed during raster candidate inspection.",
            );
          if (!initial.isFile() || !sameRegularFileState(initial, before))
            throw changed();
          const size = Number(initial.size);
          if (!Number.isSafeInteger(size))
            throw invalid(
              "path",
              "File size exceeds exact numeric offset representation.",
            );
          if (input.offset > size)
            throw invalid(
              "offset",
              "Selected byte window starts beyond the end of the file.",
            );
          const length = input.length ?? size - input.offset;
          if (length > size - input.offset)
            throw invalid(
              "length",
              "Selected byte window extends beyond the end of the file.",
            );
          if (size > MAX_FILE_BYTES)
            throw fixedCeilingConstraint(
              operation,
              "capacity",
              "Discovery accepts at most a 128 MiB file.",
              {
                name: "Raster discovery whole-file input",
                kind: "input",
                limit: MAX_FILE_BYTES,
                unit: "bytes",
              },
            );
          if (length > 16 * 1024 * 1024)
            throw fixedCeilingConstraint(
              operation,
              "capacity",
              "Discovery accepts at most a 16 MiB selected range.",
              {
                name: "Raster discovery selected range",
                kind: "bytes",
                limit: 16 * 1024 * 1024,
                unit: "bytes",
                narrowing: "Select a smaller complete byte range.",
              },
            );
          if (length === 0)
            throw invalid("length", "Select at least one byte.");
          const selectedBytes = Buffer.alloc(length);
          const end = input.offset + length;
          const buffer = Buffer.alloc(65_536);
          const hash = createHash("sha256");
          let position = 0;
          while (position < size) {
            assertArtifactReadActive(options.signal);
            const selected = position >= input.offset && position < end;
            const boundary =
              position < input.offset ? input.offset : selected ? end : size;
            const wanted = Math.min(buffer.length, boundary - position);
            let filled = 0;
            while (filled < wanted) {
              assertArtifactReadActive(options.signal);
              const { bytesRead } = await file.read(
                buffer,
                filled,
                wanted - filled,
                position + filled,
              );
              if (bytesRead === 0) throw changed();
              filled += bytesRead;
            }
            const bytes = buffer.subarray(0, filled);
            hash.update(bytes);
            if (selected) selectedBytes.set(bytes, position - input.offset);
            position += filled;
          }
          if (
            !sameRegularFileState(initial, await file.stat({ bigint: true })) ||
            !sameRegularFileState(
              initial,
              await this.files.stat(input.path, { bigint: true }),
            )
          )
            throw changed();
          const artifact = {
            path: input.path,
            bytes: size,
            sha256: hash.digest("hex"),
          };
          // The entire file and final descriptor/path metadata are checked now.
          // Retain these facts before cancellation, decoding or cleanup can fail.
          acquiredIdentity = { kind: "file-snapshot-hash", ...artifact };
          assertArtifactReadActive(options.signal);
          // Yield before bounded synchronous scoring so queued cancellation is observed.
          await setImmediate();
          assertArtifactReadActive(options.signal);
          return consume({
            bytes: selectedBytes,
            artifact,
            window: { offset: input.offset, length },
          });
        },
      );
      return ok(report);
    } catch (cause) {
      const completion = artifactFileCompletion(cause);
      const observation =
        (completion === undefined
          ? undefined
          : options.completedObservation?.(completion.value)) ??
        acquiredIdentity;
      const retainObservation = (error: AnalysisError): AnalysisError => {
        if (observation !== undefined)
          error.retainPartialObservation(observation);
        return error;
      };
      const failure = (error: AnalysisError): Result<T, AnalysisError> =>
        err(retainObservation(error));
      if (cause instanceof ArtifactFileCleanupFailure) {
        const outcome = cause.fileCleanupFailure.outcome;
        const cleanup = new AnalysisOutputError(
          operation,
          "Could not confirm closing the selected file.",
          {
            cause,
            cleanup: cause.cleanup,
            partialObservation: observation,
          },
        );
        bindArtifactFileCleanup(cause, cleanup);
        if (
          outcome.kind === "failed" &&
          outcome.cause instanceof ArtifactReaderFailure &&
          outcome.cause.reason === "cancelled"
        ) {
          const cancelled = cancelledBy(
            operation,
            carriedReason(artifactFileCancellationCause(outcome.cause)),
            { cleanup: cause.cleanup },
          ).retainSecondaryFailure(cleanup);
          bindArtifactFileCleanup(cause, cancelled);
          return failure(cancelled);
        }
        const cancellation = completion?.cancellation;
        if (cancellation !== undefined) {
          const cancelled = cancelledBy(
            operation,
            carriedReason(cancellation.reason),
            {
              partialObservation: cleanup.partialObservation,
              cleanup: cause.cleanup,
            },
          ).retainSecondaryFailure(cleanup);
          bindArtifactFileCleanup(cause, cancelled);
          return failure(cancelled);
        }
        if (outcome.kind === "failed") {
          const primary = classifyProviderFailure(
            outcome.cause,
            failureDialect,
          );
          return failure(
            analysisErrorWithCleanupDependencies(
              retainObservation(primary),
              cleanup,
              operation,
            ),
          );
        }
        return failure(cleanup);
      }
      if (cause instanceof ArtifactReaderFailure) {
        if (cause.reason === "cancelled") {
          const cancelled = cancelledBy(
            operation,
            carriedReason(artifactFileCancellationCause(cause)),
            { partialObservation: observation },
          );
          bindArtifactFileCleanup(cause, cancelled);
          return failure(cancelled);
        }
        const retry = new AnalysisOutputError(
          operation,
          "A previous raster-analysis file descriptor is still owned; cleanup must succeed before another file can be inspected.",
          {
            cause,
            ...(cause.cleanup === undefined ? {} : { cleanup: cause.cleanup }),
          },
        );
        bindArtifactFileCleanup(cause, retry);
        return failure(retry);
      }
      return failure(classifyProviderFailure(cause, failureDialect));
    }
  }
}
