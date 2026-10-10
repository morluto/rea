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
  signal?: AbortSignal,
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
    signal,
    timers: new Set<ProcessTimer>(),
    interactions: [],
    dispatchedEventIndexes: new Set<number>(),
    recordEvent: () => undefined,
  });

it("records attempts when a self-exit notification arrives after escalation", async () => {
  const fake = fakeTerminal();
  const pending = start(fake, { timeout_ms: 100, finalization_ms: 100 });
  await waitFor(() => fake.signals.includes("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 150));
  fake.deliverExit({ exitCode: 0, signal: 0 });

  const exit = await pending;

  expect(
    exit.finalization?.signals.map(({ signal }) => signal),
    "both attempts are observed in order",
  ).toEqual(["SIGTERM", "SIGKILL"]);
  expect(exit.signal, "the observed exit remains independent of attempts").toBe(
    0,
  );
  expect(
    fake.signals.filter((signal) => signal === "SIGKILL"),
    "the escalation is sent once, not on every poll",
  ).toHaveLength(1);
  expect(
    fake.signals.filter((signal) => signal === "SIGTERM"),
    "the finalization signal is sent once, not on every poll",
  ).toHaveLength(1);
});

it("kills at once when cancelled during the finalization interval", async () => {
  const fake = fakeTerminal();
  const controller = new AbortController();
  const pending = start(
    fake,
    { timeout_ms: 100, finalization_ms: 60_000 },
    controller.signal,
  );
  await waitFor(() => fake.signals.includes("SIGTERM"));
  controller.abort();
  await waitFor(() => fake.signals.includes("SIGKILL"));
  fake.deliverExit({ exitCode: 0, signal: 9 });

  const exit = await pending;

  expect(exit.reason, "cancellation replaces the initiating deadline").toBe(
    "cancelled",
  );
  expect(
    fake.signals.filter((signal) => signal === "SIGKILL"),
    "the abort branch itself sent one SIGKILL, long before the interval ended",
  ).toHaveLength(1);
  expect(
    exit.finalization?.signals.map(({ signal }) => signal),
    "cancellation records both attempts",
  ).toEqual(["SIGTERM", "SIGKILL"]);
});

it("records escalation attempts alongside an observed SIGKILL exit", async () => {
  const fake = fakeTerminal();
  const pending = start(fake, { timeout_ms: 100, finalization_ms: 100 });
  await waitFor(() => fake.signals.includes("SIGKILL"));
  fake.deliverExit({ exitCode: 0, signal: 9 });

  const exit = await pending;

  expect(
    exit.finalization?.signals,
    "both finalization attempts are recorded",
  ).toMatchObject([
    { signal: "SIGTERM", delivery: "signaled" },
    { signal: "SIGKILL", delivery: "signaled" },
  ]);
  expect(exit.signal, "the observed exit signal is retained separately").toBe(
    9,
  );
  expect(
    exit.finalization?.elapsed_ms,
    "the escalation waited for the whole interval",
  ).toBeGreaterThanOrEqual(100);
});

it("records a scripted SIGKILL exit without inferring its cause", async () => {
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
    exit.finalization?.signals,
    "only the SIGTERM attempt was made",
  ).toMatchObject([{ signal: "SIGTERM", delivery: "signaled" }]);
  expect(exit.signal, "the observed SIGKILL remains an exit fact").toBe(9);
});
