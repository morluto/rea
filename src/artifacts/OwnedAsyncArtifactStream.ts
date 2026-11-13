import { Readable } from "node:stream";

import { ArtifactReaderFailure } from "./ArtifactReader.js";
import { artifactReadCancelledBy } from "./ArtifactFileOperation.js";
import type { ArtifactResourceScope } from "./ArtifactResourceScope.js";

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
  let pending = false;
  const cancelled = (): ArtifactReaderFailure =>
    new ArtifactReaderFailure("cancelled", `${label} member read cancelled`, {
      cause: signal?.reason,
    });
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
  const output = Readable.from(tracked(), { objectMode: false, highWaterMark });
  const onAbort = (): void => {
    controller.abort(signal?.reason);
    // An outstanding iterator read owns its failure; a successful read will
    // observe cancellation before yielding its next chunk.
    if (!pending) output.destroy(cancelled());
  };
  output.on("error", () => undefined);
  streams.set(output, controller);
  const completion = new Promise<void>((resolve) => {
    output.once("close", () => {
      signal?.removeEventListener("abort", onAbort);
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
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted === true) onAbort();
  return output;
};
