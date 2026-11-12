import { setImmediate as settled } from "node:timers/promises";

import { expect, it } from "vitest";

import { ok } from "../../domain/result.js";
import { DesktopBuildTurns } from "./DesktopBuildTurns.js";

/** A call that notes its start and runs until the test ends it. */
const gated = (log: string[], name: string) => {
  let end = (): void => undefined;
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  return {
    end,
    work: async () => {
      log.push(name);
      await ended;
      return ok(name);
    },
  };
};

const signal = () => new AbortController().signal;

it("runs one call at a time in the order they arrive, and frees the turn of a call that throws", async () => {
  const turns = new DesktopBuildTurns();
  const log: string[] = [];
  const first = gated(log, "first");
  const throwing = turns.run("first", signal(), async () => {
    await first.work();
    throw new Error("the driver broke");
  });
  const second = turns.run("second", signal(), async () => {
    log.push("second");
    return ok("second");
  });
  await settled();
  expect(log).toEqual(["first"]);
  first.end();
  await expect(throwing).rejects.toThrow("the driver broke");
  await expect(second).resolves.toEqual(ok("second"));
  expect(log).toEqual(["first", "second"]);
});

it("keeps the place of a call cancelled while it waits, so the one after it still waits", async () => {
  const turns = new DesktopBuildTurns();
  const log: string[] = [];
  const running = gated(log, "running");
  const first = turns.run("running", signal(), running.work);
  const caller = new AbortController();
  const cancelled = turns.run("cancelled", caller.signal, async () =>
    ok("ran"),
  );
  const last = turns.run("last", signal(), async () => {
    log.push("last");
    return ok("last");
  });
  await settled();
  const reason = { caller: "the client went away" };
  caller.abort(reason);
  const cancellation = await cancelled;
  expect(cancellation).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError", operation: "cancelled" },
  });
  expect(!cancellation.ok && cancellation.error.cause).toBe(reason);
  await settled();
  expect(log).toEqual(["running"]);
  running.end();
  await first;
  await last;
  expect(log).toEqual(["running", "last"]);
});

it("on close cancels the call running, refuses those waiting and runs once the running one has ended", async () => {
  const turns = new DesktopBuildTurns();
  const log: string[] = [];
  // It finishes after the abort, as a step whose output was already committed would.
  const running = turns.run("running", signal(), async (turn) => {
    await new Promise((resolve) => turn.addEventListener("abort", resolve));
    await settled();
    log.push("running ended");
    return ok("finished");
  });
  const waiting = turns.run("waiting", signal(), async () => ok("ran"));
  await settled();
  const closed = turns.close(async () => {
    log.push("closed");
    return "down";
  });
  expect(await waiting).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError", operation: "waiting" },
  });
  expect(await closed).toBe("down");
  expect(await running).toEqual(ok("finished"));
  expect(log).toEqual(["running ended", "closed"]);
  expect(
    await turns.run("later", signal(), async () => ok("ran")),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisCancelledError" } });
});
