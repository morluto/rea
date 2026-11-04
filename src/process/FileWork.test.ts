import { describe, expect, it } from "vitest";

import { awaitAcknowledgement } from "../../tests/fixtures/lifecycleAcknowledgement.js";
import { FileWork, fileStepBudget, fileWorkDeadline } from "./FileWork.js";

/** A step that returns when the test answers it. */
const stalledStep = () => {
  let answer!: () => void;
  const step = new Promise<void>((resolve) => {
    answer = resolve;
  });
  return { step, answer };
};

/** Run a step until an already expired deadline leaves it behind. */
const leave = async (
  work: FileWork,
  path: string,
  step: Promise<void>,
): Promise<void> => {
  const controller = new AbortController();
  const deadline = fileWorkDeadline(controller.signal, undefined);
  const running = work.run(path, deadline, () => step);
  controller.abort();
  await expect(running).resolves.toEqual({
    status: "interrupted",
    by: "cancellation",
  });
  deadline.release();
};

describe("the stalled file step budget", () => {
  it.each([
    [undefined, 2],
    ["8", 4],
    ["3", 1],
    ["2", 1],
    ["1", 1],
    ["0", 1],
    ["many", 1],
  ])("takes half of a pool of %s threads", (size, budget) => {
    expect(
      fileStepBudget(size === undefined ? {} : { UV_THREADPOOL_SIZE: size }),
    ).toBe(budget);
  });

  it("reserves the budget for running steps, so steps that stall together stay within it", async () => {
    const work = new FileWork(2);
    const deadline = fileWorkDeadline(undefined, undefined);
    const first = stalledStep();
    const second = stalledStep();
    const started: string[] = [];
    let thirdStarted!: () => void;
    const third = new Promise<void>((resolve) => {
      thirdStarted = resolve;
    });
    const running = [
      work.scope().run("/a", deadline, () => {
        started.push("/a");
        return first.step;
      }),
      work.scope().run("/b", deadline, () => {
        started.push("/b");
        return second.step;
      }),
      work.scope().run("/c", deadline, async () => {
        started.push("/c");
        thirdStarted();
      }),
    ];
    const all = Promise.allSettled(running);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(started).toEqual(["/a", "/b"]);
      first.answer();
      await awaitAcknowledgement(third, all, "the third step's start");
      expect(started).toEqual(["/a", "/b", "/c"]);
    } finally {
      first.answer();
      second.answer();
      await all;
      deadline.release();
    }
  });

  it("refuses a waiting step once the steps ahead of it are left behind", async () => {
    const work = new FileWork(1);
    const held = stalledStep();
    const controller = new AbortController();
    const interrupted = fileWorkDeadline(controller.signal, undefined);
    const deadline = fileWorkDeadline(undefined, undefined);
    const stalled = work.run("/a", interrupted, () => held.step);
    const waiting = work.run("/b", deadline, async () => "read");
    const all = Promise.allSettled([stalled, waiting]);
    try {
      controller.abort();
      await awaitAcknowledgement(
        waiting.then(() => undefined),
        new Promise(() => {}),
        "the waiting step's refusal",
      );
      await expect(waiting).resolves.toEqual({
        status: "saturated",
        held: 1,
        budget: 1,
      });
    } finally {
      controller.abort();
      held.answer();
      await all;
      interrupted.release();
      deadline.release();
    }
  });

  it("refuses a new step across scopes until a held one returns", async () => {
    const work = new FileWork(2);
    const first = stalledStep();
    const second = stalledStep();
    const deadline = fileWorkDeadline(undefined, undefined);
    try {
      await leave(work.scope(), "/a", first.step);
      await leave(work.scope(), "/b", second.step);
      expect(work.held).toBe(2);
      let started = false;
      const start = async (): Promise<string> => {
        started = true;
        return "read";
      };
      await expect(work.scope().run("/c", deadline, start)).resolves.toEqual({
        status: "saturated",
        held: 2,
        budget: 2,
      });
      expect(started).toBe(false);
      first.answer();
      await first.step;
      await new Promise((resolve) => setImmediate(resolve));
      expect(work.held).toBe(1);
      await expect(work.scope().run("/c", deadline, start)).resolves.toEqual({
        status: "fulfilled",
        value: "read",
      });
    } finally {
      deadline.release();
      first.answer();
      second.answer();
    }
  });

  it("makes a step on a held path wait rather than refusing it", async () => {
    const work = new FileWork(1);
    const held = stalledStep();
    const deadline = fileWorkDeadline(undefined, undefined);
    try {
      await leave(work, "/a", held.step);
      const waiting = work.run("/a", deadline, async () => "read");
      held.answer();
      await expect(waiting).resolves.toEqual({
        status: "fulfilled",
        value: "read",
      });
    } finally {
      deadline.release();
      held.answer();
    }
  });

  it("keeps owners apart", async () => {
    const held = stalledStep();
    const deadline = fileWorkDeadline(undefined, undefined);
    try {
      await leave(new FileWork(1), "/a", held.step);
      await expect(
        new FileWork(1).run("/a", deadline, async () => "read"),
      ).resolves.toMatchObject({ status: "fulfilled" });
    } finally {
      deadline.release();
      held.answer();
    }
  });
});
