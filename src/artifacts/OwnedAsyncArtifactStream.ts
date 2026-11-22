import { Readable } from "node:stream";

import {
  ArtifactReaderFailure,
  artifactReadCancelledBy,
  type ArtifactResourceScope,
} from "../resources/index.js";

/**
 * Stream an iterator's chunks and retire the stream on cancellation, including
 * while backpressure leaves the iterator unread. An outstanding iterator read
 * owns its failure; a successful read observes cancellation before yielding.
 */
export const cancellableArtifactChunks = (
  chunks: AsyncIterable<Buffer>,
  {
    signal,
    cancellationFailure,
    highWaterMark,
  }: {
    readonly signal: AbortSignal | undefined;
    readonly cancellationFailure: (reason: unknown) => Error;
    readonly highWaterMark?: number;
  },
): Readable => {
  let pending = false;
  const cancelled = (): Error => cancellationFailure(signal?.reason);
  const tracked = async function* (): AsyncGenerator<Buffer> {
    const iterator = chunks[Symbol.asyncIterator]();
    try {
      while (true) {
        pending = true;
        let next: IteratorResult<Buffer>;
        try {
          next = await iterator.next();
        } catch (cause) {
          if (artifactReadCancelledBy(cause, signal)) throw cancelled();
          throw cause;
        } finally {
          pending = false;
        }
        if (signal?.aborted) throw cancelled();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      await iterator.return?.();
    }
  };
  const output = Readable.from(tracked(), {
    objectMode: false,
    ...(highWaterMark === undefined ? {} : { highWaterMark }),
  });
  const onAbort = (): void => {
    if (!pending && !output.destroyed) output.destroy(cancelled());
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  output.once("close", () => signal?.removeEventListener("abort", onAbort));
  if (signal?.aborted === true) onAbort();
  return output;
};

/** Retain a member iterator, including pending reads, until its stream closes. */
export const ownAsyncArtifactStream = (
  chunks: AsyncIterable<Buffer>,
  controller: AbortController,
  {
    scope,
    streams,
    signal,
    label,
    highWaterMark,
  }: {
    readonly scope: ArtifactResourceScope;
    readonly streams: Map<Readable, AbortController>;
    readonly signal: AbortSignal | undefined;
    readonly label: string;
    readonly highWaterMark: number;
  },
): Readable => {
  // Abort the member's reads before the stream retires its iterator.
  const abortChunks = (): void => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abortChunks, { once: true });
  if (signal?.aborted === true) abortChunks();
  const output = cancellableArtifactChunks(chunks, {
    signal,
    cancellationFailure: (reason) =>
      new ArtifactReaderFailure("cancelled", `${label} member read cancelled`, {
        cause: reason,
      }),
    highWaterMark,
  });
  output.on("error", () => undefined);
  streams.set(output, controller);
  const completion = new Promise<void>((resolve) => {
    output.once("close", () => {
      signal?.removeEventListener("abort", abortChunks);
      streams.delete(output);
      resolve();
    });
  });
  void scope
    .run(() => completion)
    .catch((cause: unknown) => {
      controller.abort(cause);
      output.destroy(
        cause instanceof Error
          ? cause
          : new Error(`${label} stream ownership failed`, { cause }),
      );
    });
  return output;
};
