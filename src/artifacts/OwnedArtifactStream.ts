import { pipeline, type Readable, type Transform } from "node:stream";

import type { ArtifactResourceScope } from "./ArtifactResourceScope.js";

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
  }: {
    readonly scope: ArtifactResourceScope;
    readonly streams: Set<Readable>;
    readonly signal: AbortSignal | undefined;
    readonly cancellationFailure: (reason: unknown) => Error;
    readonly label: string;
  },
): void => {
  output.on("error", () => undefined);
  streams.add(output);
  let producerComplete = false;
  const onAbort = (): void => {
    // Active I/O and validation own failure precedence; cancellation also
    // retires buffered output after production completes.
    if (!producerComplete || output.destroyed) return;
    output.destroy(cancellationFailure(signal?.reason));
  };
  const retired = new Promise<void>((resolve) => {
    output.once("close", () => {
      streams.delete(output);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    });
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
          pipeline(source, output, () => {
            producerComplete = true;
            if (signal?.aborted) onAbort();
            resolve();
          });
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
