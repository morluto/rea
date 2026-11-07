import { expect, onTestFinished, vi } from "vitest";

import { SafeOutputTree } from "../../src/artifacts/SafeOutputTree.js";

/**
 * Call `cancel` once an output tree has published, inside the commit that
 * published it, and hold the commit until its signal aborts: a cancellation
 * that arrives while the commit still closes its handles.
 */
export const cancelDuringCommit = (cancel: () => void): void => {
  const commit = SafeOutputTree.prototype.commit;
  const spy = vi
    .spyOn(SafeOutputTree.prototype, "commit")
    .mockImplementation(async function (
      this: SafeOutputTree,
      signal?: AbortSignal,
    ) {
      await commit.call(this, signal);
      cancel();
      await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    });
  onTestFinished(() => {
    spy.mockRestore();
  });
};
