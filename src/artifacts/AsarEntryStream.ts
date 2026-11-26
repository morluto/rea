import type { FileHandle } from "node:fs/promises";
import type { FileHandleChunkStream } from "../filesystem/readFileHandleChunks.js";
import { Readable } from "node:stream";

import { ArtifactReaderFailure } from "../resources/index.js";
import { invariantViolation } from "../domain/internalInvariant.js";
import { asarCancellationFailure, asarFailure } from "./AsarFailure.js";

const ASAR_READ_CHUNK_BYTES = 256 * 1024;

/** Stream one bounded packed ASAR member range via positional preads on an open handle. */
export const readValidatedAsarRange = (
  handle: Pick<FileHandle, "read">,
  start: number,
  expectedBytes: number,
  entryPath: string,
  archivePath: string,
  signal?: AbortSignal,
): Readable => {
  let position = start;
  let remaining = expectedBytes;
  let readState: "idle" | "pending" | "failed" = "idle";
  let reading = false;
  let ended = false;
  const output = new Readable({
    read() {
      if (reading || ended || output.destroyed) return;
      reading = true;
      void pump().finally(() => {
        reading = false;
      });
    },
  });
  const fail = (cause: unknown): void => {
    ended = true;
    output.destroy(asarFailure(archivePath, `read ${entryPath}`, cause));
  };
  const pump = async (): Promise<void> => {
    while (remaining > 0 && !ended && !output.destroyed) {
      if (signal?.aborted) {
        fail(asarCancellationFailure(signal.reason));
        return;
      }
      const length = Math.min(ASAR_READ_CHUNK_BYTES, remaining);
      const buffer = Buffer.allocUnsafe(length);
      readState = "pending";
      let bytesRead: number;
      try {
        ({ bytesRead } = await handle.read(buffer, 0, length, position));
        readState = "idle";
      } catch (cause: unknown) {
        // Keep physical read errors primary even if cancellation arrives in flight.
        readState = "failed";
        if (output.destroyed) return;
        fail(cause);
        return;
      }
      if (output.destroyed) return;
      if (bytesRead <= 0 || bytesRead > length) {
        fail(
          new ArtifactReaderFailure(
            "integrity",
            `ASAR entry size disagrees with its header: ${entryPath}`,
            { integrityCheck: "declared-size" },
          ),
        );
        return;
      }
      position += bytesRead;
      remaining -= bytesRead;
      const chunk =
        bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
      if (signal?.aborted) {
        fail(asarCancellationFailure(signal.reason));
        return;
      }
      const wantMore = output.push(chunk);
      if (output.destroyed) return;
      if (remaining === 0) {
        if (signal?.aborted) {
          fail(asarCancellationFailure(signal.reason));
          return;
        }
        ended = true;
        output.push(null);
        return;
      }
      if (signal?.aborted) {
        fail(asarCancellationFailure(signal.reason));
        return;
      }
      if (!wantMore) break;
    }
  };
  // Cancellation can precede the caller's first read while it prepares output.
  output.on("error", () => undefined);
  const onAbort = (): void => {
    if (readState === "idle" && !output.destroyed && !output.readableEnded) {
      ended = true;
      output.destroy(asarCancellationFailure(signal!.reason));
    }
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  output.once("close", () => {
    ended = true;
    signal?.removeEventListener("abort", onAbort);
  });
  if (signal?.aborted) onAbort();
  return output;
};

/** Validate and contextualize bytes read from one ASAR member source. */
export const readValidatedAsarEntry = (
  source: FileHandleChunkStream,
  expectedBytes: number | undefined,
  entryPath: string,
  archivePath: string,
  signal?: AbortSignal,
): Readable => {
  const expectedExtent =
    expectedBytes === undefined ? undefined : BigInt(expectedBytes);
  const completionFailure = (): ArtifactReaderFailure | undefined => {
    const coverage = source.readCoverage();
    if (coverage.kind !== "complete")
      return new ArtifactReaderFailure(
        "integrity",
        `ASAR entry read coverage is incomplete: ${entryPath}`,
        { integrityCheck: "read-coverage" },
      );
    if (expectedExtent !== undefined && coverage.bytes !== expectedExtent)
      return new ArtifactReaderFailure(
        "integrity",
        `ASAR entry size disagrees with its header: ${entryPath}`,
        { integrityCheck: "declared-size" },
      );
    if (signal?.aborted) return asarCancellationFailure(signal.reason);
    return undefined;
  };
  const output = Readable.from(
    (async function* () {
      const iterator = source[Symbol.asyncIterator]();
      try {
        while (true) {
          const next = await iterator.next();
          if (next.done) break;
          const chunk: unknown = next.value;
          if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array))
            throw invariantViolation(
              `ASAR entry did not return bytes: ${entryPath}`,
            );
          const coverage = source.readCoverage();
          if (expectedExtent !== undefined && coverage.bytes > expectedExtent)
            throw new ArtifactReaderFailure(
              "integrity",
              `ASAR entry exceeded its declared size: ${entryPath}`,
              { integrityCheck: "declared-size" },
            );
          if (coverage.kind === "complete" && signal?.aborted) {
            const failure = completionFailure();
            if (failure !== undefined) throw failure;
          }
          yield chunk;
        }
        const failure = completionFailure();
        if (failure !== undefined) throw failure;
      } catch (cause: unknown) {
        throw asarFailure(archivePath, `read ${entryPath}`, cause);
      } finally {
        try {
          await iterator.return?.();
        } catch {
          // Preserve the read failure; source destruction below owns cleanup.
        }
        if (!source.destroyed) source.destroy();
      }
    })(),
  );
  // Cancellation can precede the caller's first read while it prepares output.
  // Retain the stream error for that consumer without an unhandled error event.
  output.on("error", () => undefined);
  const onSourceError = (cause: unknown): void => {
    const completedCancellation =
      cause instanceof ArtifactReaderFailure &&
      cause.reason === "cancelled" &&
      source.readCoverage().kind === "complete"
        ? completionFailure()
        : undefined;
    output.destroy(
      completedCancellation ??
        asarFailure(archivePath, `read ${entryPath}`, cause),
    );
  };
  source.on("error", onSourceError);
  source.once("close", () => source.removeListener("error", onSourceError));
  const onAbort = (): void => {
    if (
      source.readCoverage().kind === "complete" &&
      !output.destroyed &&
      (source.errored === null ||
        (source.errored instanceof ArtifactReaderFailure &&
          source.errored.reason === "cancelled"))
    ) {
      const failure = completionFailure();
      if (failure !== undefined) output.destroy(failure);
    }
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  output.once("close", () => {
    signal?.removeEventListener("abort", onAbort);
    if (!source.destroyed) source.destroy();
  });
  if (signal?.aborted) onAbort();
  return output;
};
