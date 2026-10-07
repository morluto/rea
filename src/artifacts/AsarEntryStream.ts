import { Readable } from "node:stream";

import { ArtifactReaderFailure } from "./ArtifactReader.js";

/** Close an ASAR file handle before honoring cancellation of an empty member. */
export const closeAsarHandle = async (
  close: () => Promise<void>,
  signal?: AbortSignal,
): Promise<void> => {
  await close();
  abortIfNeeded(signal);
};

/** Validate and contextualize bytes read from one ASAR member source. */
export const readValidatedAsarEntry = (
  source: Readable,
  expectedBytes: number | undefined,
  entryPath: string,
  archivePath: string,
  signal?: AbortSignal,
): Readable => {
  const output = Readable.from(
    (async function* () {
      let observedBytes = 0;
      const iterator = source[Symbol.asyncIterator]();
      try {
        while (true) {
          abortIfNeeded(signal);
          const next = await iterator.next();
          if (next.done) break;
          const chunk: unknown = next.value;
          if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array))
            throw new ArtifactReaderFailure(
              "format",
              `ASAR entry did not return bytes: ${entryPath}`,
            );
          observedBytes += Buffer.isBuffer(chunk)
            ? chunk.length
            : chunk.byteLength;
          if (expectedBytes !== undefined && observedBytes > expectedBytes)
            throw new ArtifactReaderFailure(
              "integrity",
              `ASAR entry exceeded its declared size: ${entryPath}`,
            );
          yield chunk;
        }
        if (expectedBytes !== undefined && observedBytes !== expectedBytes)
          throw new ArtifactReaderFailure(
            "integrity",
            `ASAR entry size disagrees with its header: ${entryPath}`,
          );
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
  const closeSource = (): void => {
    signal?.removeEventListener("abort", onAbort);
    if (!source.destroyed) source.destroy();
  };
  const onAbort = (): void => {
    closeSource();
    output.destroy(
      new ArtifactReaderFailure("cancelled", "ASAR operation cancelled"),
    );
  };
  output.once("close", closeSource);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted === true) onAbort();
  return output;
};

const abortIfNeeded = (signal?: AbortSignal): void => {
  if (signal?.aborted === true)
    throw new ArtifactReaderFailure("cancelled", "ASAR operation cancelled");
};

const asarFailure = (
  path: string,
  operation: string,
  cause: unknown,
): ArtifactReaderFailure => {
  if (cause instanceof ArtifactReaderFailure) return cause;
  if (isFilesystemFailure(cause))
    return new ArtifactReaderFailure(
      "io",
      `Could not ${operation} ASAR at ${path}: ${cause.message}`,
      { cause },
    );
  return new ArtifactReaderFailure(
    "format",
    `Malformed ASAR during ${operation}: ${path}`,
    { cause },
  );
};

const isFilesystemFailure = (
  cause: unknown,
): cause is NodeJS.ErrnoException & Error =>
  cause instanceof Error &&
  "errno" in cause &&
  typeof cause.errno === "number" &&
  "syscall" in cause &&
  typeof cause.syscall === "string";
