import { pipeline, Transform, type Readable } from "node:stream";

import {
  ArtifactReaderFailure,
  artifactReadCancelledBy,
  type ArtifactEntry,
  type ArtifactResourceScope,
} from "../resources/index.js";

const READER_CLOSED = Symbol("Artifact stream reader closed");

export interface ArtifactMemberLifecycle {
  readonly signal: AbortSignal;
  readonly cancellationFailure: (reason: unknown) => ArtifactReaderFailure;
  verify(check: (signal: AbortSignal) => Promise<unknown>): Promise<void>;
}

/** Close and caller cancellation share one ordering for a reader's member streams. */
export class ArtifactStreamLifecycle {
  readonly #shutdown = new AbortController();

  constructor(private readonly label: string) {}

  get closed(): boolean {
    return this.#shutdown.signal.aborted;
  }

  close(): void {
    this.#shutdown.abort(READER_CLOSED);
  }

  member(caller: AbortSignal | undefined): ArtifactMemberLifecycle {
    const signal =
      caller === undefined
        ? this.#shutdown.signal
        : AbortSignal.any([caller, this.#shutdown.signal]);
    const cancellationFailure = (reason: unknown): ArtifactReaderFailure =>
      reason === READER_CLOSED
        ? new ArtifactReaderFailure(
            "unavailable",
            `${this.label} reader closed`,
          )
        : new ArtifactReaderFailure(
            "cancelled",
            `${this.label} read cancelled`,
            { cause: reason },
          );
    return {
      signal,
      cancellationFailure,
      async verify(check) {
        try {
          await check(signal);
        } catch (cause) {
          if (
            signal.reason === READER_CLOSED &&
            artifactReadCancelledBy(cause, signal)
          )
            throw cancellationFailure(READER_CLOSED);
          throw cause;
        }
        if (signal.aborted) throw cancellationFailure(signal.reason);
      },
    };
  }
}

/** Verify the member's byte count and source before stream completion. */
export const checkedArtifactMemberStream = (
  entry: ArtifactEntry,
  label: string,
  incomplete: (detail: string) => Error,
  verify: () => Promise<void>,
): Transform => {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(null, chunk);
    },
    flush(callback) {
      if (bytes !== entry.declaredSize) {
        callback(incomplete(`member ended early: ${entry.path}`));
        return;
      }
      void verify().then(
        () => callback(),
        (cause: unknown) =>
          callback(
            cause instanceof Error
              ? cause
              : new Error(`${label} read failed`, { cause }),
          ),
      );
    },
  });
};

/** Keep the carrier and buffered output owned through production and retirement. */
export const ownArtifactStream = (
  source: Readable,
  output: Transform,
  {
    scope,
    streams,
    signal,
    cancellationFailure,
    label,
    decode,
  }: {
    readonly scope: ArtifactResourceScope;
    readonly streams?: Set<Readable>;
    readonly decode?: Transform;
    readonly signal: AbortSignal | undefined;
    readonly cancellationFailure: (reason: unknown) => Error;
    readonly label: string;
  },
): void => {
  output.on("error", () => undefined);
  streams?.add(output);
  if (decode !== undefined) {
    decode.on("error", () => undefined);
    streams?.add(decode);
  }
  let producerComplete = false;
  let sourceRetired = false;
  const upstream: Readable = decode ?? source;
  const cancelRetiredSourceDecode = (): boolean => {
    // Once the source retires its abort listener is gone, while a decoder
    // paused by a slow consumer can still hold undelivered output. It has
    // not ended, so the output's final validation has not started.
    if (
      decode === undefined ||
      !sourceRetired ||
      signal?.aborted !== true ||
      decode.destroyed ||
      decode.readableEnded
    )
      return false;
    decode.destroy(cancellationFailure(signal.reason));
    return true;
  };
  const canRetireOnAbort = (): boolean =>
    producerComplete ||
    (upstream.readableEnded && !upstream.errored && output.writableLength > 0);
  const onAbort = (): void => {
    if (cancelRetiredSourceDecode()) return;
    // Active I/O and validation own failure precedence; cancellation also
    // retires buffered output after production completes or when upstream
    // has ended and output is stalled on readable backpressure before flush.
    if (!canRetireOnAbort() || output.destroyed) return;
    output.destroy(cancellationFailure(signal?.reason));
  };
  const onUpstreamEnd = (): void => {
    if (signal?.aborted) onAbort();
  };
  const retired = new Promise<void>((resolve) => {
    output.once("close", () => {
      streams?.delete(output);
      if (decode !== undefined) streams?.delete(decode);
      signal?.removeEventListener("abort", onAbort);
      upstream.removeListener("end", onUpstreamEnd);
      resolve();
    });
  });
  if (decode !== undefined)
    source.once("close", () => {
      sourceRetired = true;
      cancelRetiredSourceDecode();
    });
  signal?.addEventListener("abort", onAbort, { once: true });
  upstream.once("end", onUpstreamEnd);
  if (signal?.aborted) onAbort();
  output.once("finish", () => {
    // A successful writable finish follows the transform's final validation.
    // Pipeline retirement may follow later while readable bytes remain buffered.
    producerComplete = true;
    if (signal?.aborted) onAbort();
  });
  void scope
    .run(async () => {
      await Promise.all([
        new Promise<void>((resolve) => {
          const onPipeline = (): void => {
            producerComplete = true;
            if (signal?.aborted) onAbort();
            resolve();
          };
          if (decode === undefined) pipeline(source, output, onPipeline);
          else pipeline(source, decode, output, onPipeline);
        }),
        retired,
      ]);
    })
    .catch((cause: unknown) =>
      output.destroy(
        cause instanceof Error
          ? cause
          : new Error(`${label} stream ownership failed`, { cause }),
      ),
    );
};
