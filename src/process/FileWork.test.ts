import { describe, expect, it } from "vitest";

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
    const steps = [stalledStep(), stalledStep()];
    const started: number[] = [];
    const running = [0, 1, 2].map((index) =>
      work.scope().run(`/${String(index)}`, deadline, () => {
        started.push(index);
        return steps[index]?.step ?? Promise.resolve();
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual([0, 1]);
    steps[0]?.answer();
    await running[2];
    expect(started).toEqual([0, 1, 2]);
    steps[1]?.answer();
    await Promise.all(running);
    deadline.release();
  });

  it("refuses a waiting step once the steps ahead of it are left behind", async () => {
    const work = new FileWork(1);
    const held = stalledStep();
    const controller = new AbortController();
    const interrupted = fileWorkDeadline(controller.signal, undefined);
    const stalled = work.run("/a", interrupted, () => held.step);
    const deadline = fileWorkDeadline(undefined, undefined);
    const waiting = work.run("/b", deadline, async () => "read");
    controller.abort();
    await stalled;
    await expect(waiting).resolves.toEqual({
      status: "saturated",
      held: 1,
      budget: 1,
    });
    interrupted.release();
    deadline.release();
    held.answer();
  });

  it("refuses a new step across scopes until a held one returns", async () => {
    const work = new FileWork(2);
    const first = stalledStep();
    const second = stalledStep();
    await leave(work.scope(), "/a", first.step);
    await leave(work.scope(), "/b", second.step);
    expect(work.held).toBe(2);
    const deadline = fileWorkDeadline(undefined, undefined);
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
    deadline.release();
    second.answer();
  });

  it("makes a step on a held path wait rather than refusing it", async () => {
    const work = new FileWork(1);
    const held = stalledStep();
    await leave(work, "/a", held.step);
    const deadline = fileWorkDeadline(undefined, undefined);
    const waiting = work.run("/a", deadline, async () => "read");
    held.answer();
    await expect(waiting).resolves.toEqual({
      status: "fulfilled",
      value: "read",
    });
    deadline.release();
  });

  it("keeps owners apart", async () => {
    const held = stalledStep();
    await leave(new FileWork(1), "/a", held.step);
    const deadline = fileWorkDeadline(undefined, undefined);
    await expect(
      new FileWork(1).run("/a", deadline, async () => "read"),
    ).resolves.toMatchObject({ status: "fulfilled" });
    deadline.release();
    held.answer();
  });
});
