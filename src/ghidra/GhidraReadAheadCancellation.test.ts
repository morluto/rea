import { describe, expect, it } from "vitest";

import { GhidraReadAheadCancellation } from "./GhidraReadAheadCancellation.js";

const watcher = () => {
  const abandoned: number[] = [];
  const cancellation = new GhidraReadAheadCancellation(() => {
    abandoned.push(abandoned.length + 1);
    return Promise.resolve();
  });
  return { abandoned, cancellation };
};

describe("Ghidra read-ahead cancellation", () => {
  it("abandons once when the workflow signal aborts after the request", () => {
    const { abandoned, cancellation } = watcher();
    const controller = new AbortController();
    cancellation.watch(controller.signal);
    cancellation.watch(controller.signal);
    controller.abort();
    expect(abandoned).toEqual([1]);
  });

  it("abandons when the signal is already aborted as the request settles", () => {
    const { abandoned, cancellation } = watcher();
    const controller = new AbortController();
    controller.abort();
    cancellation.watch(controller.signal);
    cancellation.watch(controller.signal);
    expect(abandoned).toEqual([1]);
  });

  it("keeps the watch across another read-ahead request on the same signal", () => {
    const { abandoned, cancellation } = watcher();
    const controller = new AbortController();
    cancellation.watch(controller.signal);
    cancellation.takeOwnership(controller.signal);
    controller.abort();
    expect(abandoned).toEqual([1]);
  });

  it("replaces the owner only when another signal carries read-ahead", () => {
    const { abandoned, cancellation } = watcher();
    const previous = new AbortController();
    const next = new AbortController();
    cancellation.watch(previous.signal);
    cancellation.takeOwnership(next.signal);
    previous.abort();
    expect(abandoned).toEqual([]);
    cancellation.watch(next.signal);
    next.abort();
    expect(abandoned).toEqual([1]);
  });

  it("ignores an abort after the session can no longer take a request", () => {
    const { abandoned, cancellation } = watcher();
    const controller = new AbortController();
    cancellation.watch(controller.signal);
    cancellation.stop();
    controller.abort();
    expect(abandoned).toEqual([]);
  });
});
