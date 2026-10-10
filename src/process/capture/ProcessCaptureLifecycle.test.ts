import { expect, it } from "vitest";
import type { IPty } from "@lydell/node-pty";

import { parseProcessScenario } from "../../domain/process/processScenario.js";
import { awaitTerminalExit } from "./ProcessCaptureLifecycle.js";
import type { ProcessTimer } from "./ProcessTimer.js";

interface FakeExit {
  readonly exitCode: number;
  readonly signal?: number;
}

/** Terminal whose exit notification the test delivers when it chooses. */
const fakeTerminal = () => {
  let listener: ((exit: FakeExit) => void) | undefined;
  const signals: string[] = [];
  const terminal: Pick<IPty, "onExit" | "kill"> = {
    onExit: (next) => {
      listener = next;
      return { dispose: () => undefined };
    },
    kill: (signal) => {
      signals.push(signal ?? "SIGHUP");
    },
  };
  return {
    signals,
    terminal,
    deliverExit: (exit: FakeExit) => listener?.(exit),
  };
};

const waitFor = async (condition: () => boolean): Promise<void> => {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const start = (
  fake: ReturnType<typeof fakeTerminal>,
  scenario: Readonly<Record<string, unknown>>,
) =>
  awaitTerminalExit({
    terminal: fake.terminal,
    scenario: parseProcessScenario({
      executable: "unused",
      idle_timeout_ms: 10_000,
      ...scenario,
    }),
    started: Date.now(),
    lastOutput: () => Date.now(),
    signal: undefined,
    timers: new Set<ProcessTimer>(),
    interactions: [],
    dispatchedEventIndexes: new Set<number>(),
    recordEvent: () => undefined,
  });

it("reports a self-exit as target_exited when its notification arrives after the escalation", async () => {
  const fake = fakeTerminal();
  const pending = start(fake, { timeout_ms: 100, finalization_ms: 100 });
  await waitFor(() => fake.signals.includes("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 150));
  fake.deliverExit({ exitCode: 0, signal: 0 });

  const exit = await pending;

  expect(exit.finalization?.outcome, "the observed exit was not a kill").toBe(
    "target_exited",
  );
  expect(
    fake.signals.filter((signal) => signal === "SIGKILL"),
    "the escalation is sent once, not on every poll",
  ).toHaveLength(1);
});

it("reports forced_kill when the observed exit is the escalation's SIGKILL", async () => {
  const fake = fakeTerminal();
  const pending = start(fake, { timeout_ms: 100, finalization_ms: 100 });
  await waitFor(() => fake.signals.includes("SIGKILL"));
  fake.deliverExit({ exitCode: 0, signal: 9 });

  const exit = await pending;

  expect(exit.finalization, "forced kill is recorded").toMatchObject({
    requested_ms: 100,
    outcome: "forced_kill",
  });
  expect(
    exit.finalization?.elapsed_ms,
    "the escalation waited for the whole interval",
  ).toBeGreaterThanOrEqual(100);
});

it("does not call a scripted SIGKILL during the interval a forced kill", async () => {
  const fake = fakeTerminal();
  const pending = start(fake, { timeout_ms: 100, finalization_ms: 5_000 });
  await waitFor(() => fake.signals.includes("SIGTERM"));
  fake.deliverExit({ exitCode: 0, signal: 9 });

  const exit = await pending;

  expect(
    fake.signals,
    "the harness itself never escalated inside the interval",
  ).not.toContain("SIGKILL");
  expect(
    exit.finalization?.outcome,
    "an exit the harness did not cause is not a forced kill",
  ).toBe("target_exited");
});
