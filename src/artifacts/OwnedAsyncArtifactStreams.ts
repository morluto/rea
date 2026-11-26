import { Readable } from "node:stream";

import {
  ArtifactReaderFailure,
  artifactReadCancelledBy,
  type ArtifactResourceScope,
} from "../resources/index.js";

/** Bound concurrent file ranges, gzip inflaters, and UnityFS block buffers per reader. */
const MAX_MEMBER_STREAMS = 4;

/** Keeps a reader's member iterators owned through every pending read and stream close. */
export class OwnedAsyncArtifactStreams {
  readonly #streams = new Map<Readable, AbortController>();

  constructor(
    private readonly scope: ArtifactResourceScope,
    private readonly label: string,
    private readonly highWaterMark: number,
  ) {}

  open(
    signal: AbortSignal | undefined,
    readChunks: (signal: AbortSignal) => AsyncIterable<Buffer>,
  ): Readable {
    if (this.#streams.size >= MAX_MEMBER_STREAMS)
      throw new ArtifactReaderFailure(
        "limit",
        `${this.label} reader already owns four active member streams`,
        { boundary: "capacity" },
      );
    const controller = new AbortController();
    const chunks = readChunks(controller.signal);
    let pending = false;
    const cancelled = (): ArtifactReaderFailure =>
      new ArtifactReaderFailure(
        "cancelled",
        `${this.label} member read cancelled`,
        {
          cause: signal?.reason,
        },
      );
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
      highWaterMark: this.highWaterMark,
    });
    const onAbort = (): void => {
      controller.abort(signal?.reason);
      // An outstanding iterator read owns its failure; a successful read will
      // observe cancellation before yielding its next chunk.
      if (!pending) output.destroy(cancelled());
    };
    output.on("error", () => undefined);
    this.#streams.set(output, controller);
    const completion = new Promise<void>((resolve) => {
      output.once("close", () => {
        signal?.removeEventListener("abort", onAbort);
        this.#streams.delete(output);
        resolve();
      });
    });
    void this.scope
      .run(() => completion)
      .catch((cause: unknown) => {
        controller.abort(cause);
        output.destroy(
          cause instanceof Error
            ? cause
            : new Error(`${this.label} stream ownership failed`, { cause }),
        );
      });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
    return output;
  }

  close(): void {
    for (const [stream, controller] of this.#streams) {
      const cause = new ArtifactReaderFailure(
        "unavailable",
        `${this.label} reader closed`,
      );
      controller.abort(cause);
      stream.destroy(cause);
    }
  }
}
