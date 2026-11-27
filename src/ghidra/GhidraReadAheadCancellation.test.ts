import { describe, expect, it } from "vitest";

import { GhidraReadAheadCancellation } from "./GhidraReadAheadCancellation.js";

const watcher = () => {
  const generations: number[] = [];
  const cancellation = new GhidraReadAheadCancellation((generation) => {
    generations.push(generation);
    return Promise.resolve();
  });
  return { generations, cancellation };
};

describe("Ghidra read-ahead cancellation", () => {
  it("abandons once when the admitted workflow signal aborts after the request", () => {
    const { generations, cancellation } = watcher();
    const controller = new AbortController();
    cancellation.takeOwnership(controller.signal);
    cancellation.watch(controller.signal);
    cancellation.watch(controller.signal);
    controller.abort();
    expect(generations).toEqual([1]);
    expect(cancellation.owns(1)).toBe(true);
  });

  it("abandons when the signal is already aborted as the admitted request settles", () => {
    const { generations, cancellation } = watcher();
    const controller = new AbortController();
    cancellation.takeOwnership(controller.signal);
    controller.abort();
    cancellation.watch(controller.signal);
    cancellation.watch(controller.signal);
    expect(generations).toEqual([1]);
  });

  it("re-arms the same signal when its next read-ahead request settles", () => {
    const { generations, cancellation } = watcher();
    const controller = new AbortController();
    cancellation.takeOwnership(controller.signal);
    cancellation.watch(controller.signal);
    cancellation.takeOwnership(controller.signal);
    controller.abort();
    expect(generations).toEqual([]);
    cancellation.watch(controller.signal);
    expect(generations).toEqual([2]);
  });

  it("does not let an older request restore its watch", () => {
    const { generations, cancellation } = watcher();
    const carrying = new AbortController();
    const queued = new AbortController();
    cancellation.takeOwnership(carrying.signal);
    cancellation.takeOwnership(queued.signal);
    cancellation.watch(carrying.signal);
    carrying.abort();
    expect(generations).toEqual([]);
    cancellation.watch(queued.signal);
    queued.abort();
    expect(generations).toEqual([2]);
  });

  it("drops the previous owner when a window has no signal", () => {
    const { generations, cancellation } = watcher();
    const previous = new AbortController();
    cancellation.takeOwnership(previous.signal);
    cancellation.watch(previous.signal);
    cancellation.takeOwnership(undefined);
    previous.abort();
    expect(generations).toEqual([]);
    cancellation.watch(previous.signal);
    expect(generations).toEqual([]);
  });

  it("ignores an abandon queued for a generation that no longer owns the workers", () => {
    const { generations, cancellation } = watcher();
    const previous = new AbortController();
    const next = new AbortController();
    cancellation.takeOwnership(previous.signal);
    cancellation.watch(previous.signal);
    previous.abort();
    expect(generations).toEqual([1]);
    cancellation.takeOwnership(next.signal);
    expect(cancellation.owns(1)).toBe(false);
    expect(cancellation.owns(2)).toBe(true);
  });

  it("ignores an abort after the session can no longer take a request", () => {
    const { generations, cancellation } = watcher();
    const controller = new AbortController();
    cancellation.takeOwnership(controller.signal);
    cancellation.watch(controller.signal);
    cancellation.stop();
    controller.abort();
    expect(generations).toEqual([]);
  });
});
