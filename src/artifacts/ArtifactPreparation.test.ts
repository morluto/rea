import { expect, it, vi } from "vitest";
import { ArtifactPreparation } from "./ArtifactPreparation.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";

it.each(["physical", "cleanup", "waiter-cancelled"] as const)(
  "does not retry another caller's %s failure",
  async (kind) => {
    const owner = new ArtifactPreparation();
    const first = new AbortController();
    const waiter = new AbortController();
    const reason = new Error("first caller cancelled");
    let reject!: (cause: unknown) => void;
    const pending = new Promise<void>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    const prepare = vi.fn(() => pending);
    const assertOpen = vi.fn();
    const initial = owner.run(first.signal, prepare, assertOpen);
    const peer = owner.run(waiter.signal, prepare, assertOpen);
    first.abort(reason);
    if (kind === "waiter-cancelled") waiter.abort("waiter stopped");
    const failure =
      kind === "physical"
        ? new Error("read failed")
        : new ArtifactReaderFailure("cancelled", "cancelled", {
            cause: reason,
            ...(kind === "cleanup"
              ? { cleanup: { reason: "close failed", resources: ["file"] } }
              : {}),
          });
    reject(failure);
    await expect(initial).rejects.toBe(failure);
    await expect(peer).rejects.toBe(failure);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(assertOpen).not.toHaveBeenCalled();

    // A later call can try again after the failed shared preparation settles.
    await expect(
      owner.run(
        undefined,
        async () => {},
        () => {},
      ),
    ).resolves.toBeUndefined();
  },
);

it("shares one replacement when multiple callers survive a peer cancellation", async () => {
  const owner = new ArtifactPreparation();
  const first = new AbortController();
  const reason = new Error("first caller cancelled");
  let reject!: (cause: unknown) => void;
  const initialWork = new Promise<void>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  let complete!: () => void;
  const replacement = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const retry = vi.fn(() => replacement);
  const initial = owner.run(
    first.signal,
    () => initialWork,
    () => {},
  );
  const left = owner.run(undefined, retry, () => {});
  const right = owner.run(undefined, retry, () => {});
  first.abort(reason);
  const failure = new ArtifactReaderFailure("cancelled", "cancelled", {
    cause: reason,
  });
  reject(failure);
  await expect(initial).rejects.toBe(failure);
  expect(retry).toHaveBeenCalledTimes(1);
  complete();
  await expect(Promise.all([left, right])).resolves.toEqual([
    undefined,
    undefined,
  ]);
  expect(retry).toHaveBeenCalledTimes(1);
});
