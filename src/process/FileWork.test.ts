import { describe, expect, it } from "vitest";

import { FileWork, fileWorkDeadline, MAX_HELD_FILE_STEPS } from "./FileWork.js";

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
  it("leaves two of Node's four pool threads free", () => {
    expect(MAX_HELD_FILE_STEPS).toBe(2);
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
