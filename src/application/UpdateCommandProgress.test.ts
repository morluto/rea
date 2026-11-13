import { setImmediate as nextTurn } from "node:timers/promises";
import { PassThrough, Writable } from "node:stream";
import { expect, it } from "vitest";
import { UpdateCommandProgress } from "./UpdateCommandProgress.js";

it.each(["success", "failure"] as const)(
  "joins the final progress acknowledgement: %s",
  async (outcome) => {
    let acknowledge!: (error?: Error | null) => void;
    let started!: () => void;
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const destination = new Writable({
      write(_chunk, _encoding, callback) {
        acknowledge = callback;
        started();
      },
    });
    const progress = new UpdateCommandProgress(destination);
    const source = new PassThrough();
    progress.pipe(source);
    source.end("final progress");
    await writing;
    let closed = false;
    const pending = progress.close().then((result) => {
      closed = true;
      return result;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    acknowledge(
      outcome === "failure" ? new Error("final progress refused") : undefined,
    );
    const failure = await pending;
    if (outcome === "success") expect(failure).toBeUndefined();
    else expect(failure?.message).toBe("final progress refused");
    expect(destination.writableEnded).toBe(false);
    await nextTurn();
    expect(destination.listenerCount("error")).toBe(0);
    expect(progress.close()).toBe(progress.close());
  },
);

it("applies backpressure and resumes draining after a destination failure", async () => {
  let acknowledge!: (error?: Error | null) => void;
  const destination = new Writable({
    highWaterMark: 1024,
    write(_chunk, _encoding, callback) {
      acknowledge = callback;
    },
  });
  const progress = new UpdateCommandProgress(destination);
  const source = new PassThrough({ highWaterMark: 1024 });
  const ended = new Promise<void>((resolve) => {
    source.once("end", resolve);
  });
  progress.pipe(source);
  const chunk = Buffer.alloc(64 * 1024);
  source.write(chunk);
  expect(source.isPaused()).toBe(true);
  source.end(chunk);
  expect(destination.writableLength).toBe(chunk.length);
  acknowledge(new Error("progress destination refused"));
  await ended;
  expect((await progress.close())?.message).toBe(
    "progress destination refused",
  );
  expect(destination.writableEnded).toBe(false);
});

it("observes late write rejection after an independent destination failure", async () => {
  let acknowledge!: (error?: Error | null) => void;
  const destination = new Writable({
    write(_chunk, _encoding, callback) {
      acknowledge = callback;
    },
  });
  const progress = new UpdateCommandProgress(destination);
  const source = new PassThrough();
  progress.pipe(source);
  source.end("pending progress");
  destination.emit("error", new Error("independent destination failure"));
  expect((await progress.close())?.message).toBe(
    "independent destination failure",
  );
  expect(destination.listenerCount("error")).toBe(1);
  acknowledge(new Error("late write rejection"));
  await nextTurn();
  expect(destination.listenerCount("error")).toBe(0);
});

it.each(["success", "failure"] as const)(
  "drains after a silent destination close while retaining a late %s acknowledgement",
  async (outcome) => {
    let acknowledge!: (error?: Error | null) => void;
    let enter!: () => void;
    const writing = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const destination = new Writable({
      highWaterMark: 1024,
      write(_chunk, _encoding, callback) {
        acknowledge = callback;
        enter();
      },
    });
    const progress = new UpdateCommandProgress(destination);
    const source = new PassThrough({ highWaterMark: 1024 });
    progress.pipe(source);
    source.write(Buffer.alloc(64 * 1024));
    source.end("remaining output");
    await writing;
    const closed = new Promise<void>((resolve) =>
      destination.once("close", resolve),
    );
    destination.destroy();
    await closed;
    let acknowledged = false;
    try {
      await expect
        .poll(() => source.readableEnded, { timeout: 300 })
        .toBe(true);
      const failure = await progress.close();
      expect(failure?.message).toContain("destination closed");
      expect(destination.listenerCount("error")).toBe(1);
      acknowledge(
        outcome === "failure" ? new Error("late write rejection") : undefined,
      );
      acknowledged = true;
      await nextTurn();
      expect(await progress.close()).toBe(failure);
      expect(destination.listenerCount("error")).toBe(0);
      expect(destination.listenerCount("close")).toBe(0);
    } finally {
      if (!acknowledged) acknowledge();
      await progress.close();
      source.destroy();
    }
  },
);

it("drains when attached to a destination whose close event already passed", async () => {
  const destination = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const closed = new Promise<void>((resolve) =>
    destination.once("close", resolve),
  );
  destination.destroy();
  await closed;
  const progress = new UpdateCommandProgress(destination);
  const source = new PassThrough();
  progress.pipe(source);
  source.end("remaining output");
  await expect.poll(() => source.readableEnded, { timeout: 300 }).toBe(true);
  expect((await progress.close())?.message).toContain("destination closed");
  await nextTurn();
  expect(destination.listenerCount("error")).toBe(0);
  expect(destination.listenerCount("close")).toBe(0);
});

it("keeps completed progress successful when the borrowed destination closes afterwards", async () => {
  const destination = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const progress = new UpdateCommandProgress(destination);
  const source = new PassThrough();
  progress.pipe(source);
  source.end("completed output");
  expect(await progress.close()).toBeUndefined();
  destination.destroy();
  await nextTurn();
  expect(await progress.close()).toBeUndefined();
  expect(destination.listenerCount("error")).toBe(0);
  expect(destination.listenerCount("close")).toBe(0);
});
