import { describe, expect, it } from "vitest";
import { FifoQueue } from "./FifoQueue.js";

describe("FifoQueue", () => {
  it("preserves FIFO order across compaction and clear", () => {
    const queue = new FifoQueue<number>();
    expect(queue.size).toBe(0);
    expect(queue.peek()).toBeUndefined();
    expect(queue.shift()).toBeUndefined();

    for (let i = 0; i < 10; i++) queue.push(i);
    expect(queue.size).toBe(10);
    expect(queue.peek()).toBe(0);

    const drained: number[] = [];
    for (let i = 0; i < 6; i++) drained.push(queue.shift()!);
    expect(drained).toEqual([0, 1, 2, 3, 4, 5]);
    expect(queue.size).toBe(4);
    expect(queue.toArray()).toEqual([6, 7, 8, 9]);

    queue.clear();
    expect(queue.size).toBe(0);
    expect(queue.shift()).toBeUndefined();
    expect(queue.toArray()).toEqual([]);
  });
});
