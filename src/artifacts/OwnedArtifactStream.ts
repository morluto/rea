import { pipeline, Transform, type Readable } from "node:stream";

import {
  ArtifactReaderFailure,
  artifactReadCancelledBy,
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
  const onAbort = (): void => {
    if (cancelRetiredSourceDecode()) return;
    // Active I/O and validation own failure precedence; cancellation also
    // retires buffered output after production completes.
    if (!producerComplete || output.destroyed) return;
    output.destroy(cancellationFailure(signal?.reason));
  };
  const retired = new Promise<void>((resolve) => {
    output.once("close", () => {
      streams?.delete(output);
      if (decode !== undefined) streams?.delete(decode);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    });
  });
  if (decode !== undefined)
    source.once("close", () => {
      sourceRetired = true;
      cancelRetiredSourceDecode();
    });
  signal?.addEventListener("abort", onAbort, { once: true });
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
