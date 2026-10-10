import { expect, it } from "vitest";
import type { IPty } from "@lydell/node-pty";

import { parseProcessScenario } from "../../domain/process/processScenario.js";
import type { ProcessCaptureFinalization } from "../../domain/process/processCapture.js";
import { awaitTerminalExit } from "./ProcessCaptureLifecycle.js";
import type { ProcessTimer } from "./ProcessTimer.js";

type Delivery = ProcessCaptureFinalization["signals"][number]["delivery"];

interface FakeExit {
  readonly exitCode: number;
  readonly signal?: number;
}

/**
 * Terminal whose exit notification the test delivers when it chooses, plus
 * the identity-checked signaller that finalization uses instead of a bare
 * terminal kill. Both record into `signals`.
 */
const fakeTerminal = (
  deliveries: Partial<Record<"SIGTERM" | "SIGKILL", Delivery>> = {},
  hold?: Promise<void>,
) => {
  let listener: ((exit: FakeExit) => void) | undefined;
  const signals: string[] = [];
  const terminal: Pick<IPty, "onExit" | "kill"> = {
    onExit: (next) => {
      listener = next;
      return { dispose: () => undefined };
    },
    kill: (signal) => {
      signals.push(`terminal:${signal ?? "SIGHUP"}`);
    },
  };
  const signalTarget = async (
    signal: "SIGTERM" | "SIGKILL",
  ): Promise<Delivery> => {
    signals.push(signal);
    await hold;
    return deliveries[signal] ?? "signaled";
  };
  return {
    signals,
    terminal,
    signalTarget,
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

const snapshots: ProcessCaptureFinalization[] = [];

const observed = <Result extends { readonly unobserved?: boolean }>(
  result: Result,
): Exclude<Result, { readonly unobserved: true }> => {
  if (result.unobserved === true) throw new Error("exit was not observed");
  return result as Exclude<Result, { readonly unobserved: true }>;
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
    signalTarget: fake.signalTarget,
    recordFinalization: (snapshot) => {
      snapshots.push(snapshot);
    },
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

  const exit = observed(await pending);

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

  const exit = observed(await pending);

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

  const exit = observed(await pending);

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

  const exit = observed(await pending);

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

it("records every delivery result and publishes attempts incrementally", async () => {
  snapshots.length = 0;
  const fake = fakeTerminal({ SIGTERM: "gone", SIGKILL: "gone" });
  const pending = start(fake, { timeout_ms: 100, finalization_ms: 100 });
  await waitFor(() => fake.signals.includes("SIGKILL"));
  fake.deliverExit({ exitCode: 0, signal: 9 });

  const exit = observed(await pending);

  expect(
    exit.finalization?.signals.map(({ delivery }) => delivery),
    "both delivery results are kept as reported",
  ).toEqual(["gone", "gone"]);
  expect(
    snapshots.map(({ signals }) => signals.length),
    "the first attempt was published before the escalation existed",
  ).toContain(1);
  expect(
    snapshots.at(-1)?.signals.length,
    "the last published record holds both attempts",
  ).toBe(2);
});

it.each(["identity-changed", "unverified"] as const)(
  "stops waiting for an exit when the escalation reports %s",
  async (delivery) => {
    snapshots.length = 0;
    const fake = fakeTerminal({ SIGTERM: "signaled", SIGKILL: delivery });
    const pending = start(fake, { timeout_ms: 100, finalization_ms: 100 });

    const result = await pending;

    expect(result.unobserved, "no exit is invented").toBe(true);
    expect(result.reason, "the initiating deadline is retained").toBe(
      "timeout",
    );
    expect(
      result.finalization,
      "attempts and the undelivered result are kept",
    ).toMatchObject({
      elapsed_ms: null,
      signals: [
        { signal: "SIGTERM", delivery: "signaled" },
        { signal: "SIGKILL", delivery },
      ],
    });
    expect(
      fake.signals.filter((signal) => signal.startsWith("terminal:")),
      "a failed identity check never falls back to a bare terminal kill",
    ).toEqual([]);
  },
);

it("returns at once when a cancellation kill cannot be delivered", async () => {
  const fake = fakeTerminal({ SIGKILL: "unverified" });
  const controller = new AbortController();
  const pending = start(
    fake,
    { timeout_ms: 100, finalization_ms: 60_000 },
    controller.signal,
  );
  await waitFor(() => fake.signals.includes("SIGTERM"));
  controller.abort();

  const result = await pending;

  expect(result.reason, "cancellation replaces the deadline").toBe("cancelled");
  expect(result.unobserved, "the capture does not wait for an exit").toBe(true);
});

it("waits for a pending delivery before reporting an observed exit", async () => {
  let release: () => void = () => undefined;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fake = fakeTerminal({ SIGTERM: "signaled" }, hold);
  const pending = start(fake, { timeout_ms: 100, finalization_ms: 5_000 });
  await waitFor(() => fake.signals.includes("SIGTERM"));
  fake.deliverExit({ exitCode: 0, signal: 0 });
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(settled, "the result waits for the outstanding delivery").toBe(false);

  release();
  const exit = observed(await pending);

  expect(
    exit.finalization?.signals,
    "the delivery result is complete in the published record",
  ).toMatchObject([{ signal: "SIGTERM", delivery: "signaled" }]);
});

it("keeps the zero-interval deadline as a bare SIGKILL", async () => {
  const fake = fakeTerminal();
  const pending = start(fake, { timeout_ms: 60, finalization_ms: 0 });
  await waitFor(() => fake.signals.includes("terminal:SIGKILL"));
  fake.deliverExit({ exitCode: 0, signal: 9 });

  const exit = observed(await pending);

  expect(
    fake.signals.filter((signal) => !signal.startsWith("terminal:")),
    "the identity-checked signaller is never used without an interval",
  ).toEqual([]);
  expect(exit.finalization, "no finalization record exists").toBeUndefined();
});

it("stops waiting for a hung delivery once the exit is observed", async () => {
  const fake = fakeTerminal({}, new Promise<void>(() => undefined));
  const pending = start(fake, { timeout_ms: 100, finalization_ms: 5_000 });
  await waitFor(() => fake.signals.includes("SIGTERM"));
  fake.deliverExit({ exitCode: 0, signal: 0 });

  const exit = observed(await pending);

  expect(
    exit.finalization?.signals,
    "an undelivered attempt stays recorded as unverified",
  ).toMatchObject([{ signal: "SIGTERM", delivery: "unverified" }]);
  expect(exit.signal, "the observed exit is kept").toBe(0);
}, 10_000);

it("keeps an observed exit when a late kill delivery reports unverified", async () => {
  let release: () => void = () => undefined;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fake = fakeTerminal({ SIGKILL: "unverified" }, hold);
  const pending = start(fake, { timeout_ms: 100, finalization_ms: 100 });
  await waitFor(() => fake.signals.includes("SIGKILL"));
  fake.deliverExit({ exitCode: 0, signal: 9 });
  release();

  const result = await pending;

  expect(
    result.unobserved,
    "an exit that was already observed is never turned into an unobserved one",
  ).not.toBe(true);
  expect(observed(result).signal, "the observed exit signal is retained").toBe(
    9,
  );
});

it("stops waiting when the escalation delivery never settles and no exit arrives", async () => {
  const fake = fakeTerminal({}, new Promise<void>(() => undefined));
  const pending = start(fake, { timeout_ms: 100, finalization_ms: 100 });

  const result = await pending;

  expect(result.unobserved, "no exit is invented").toBe(true);
  expect(
    result.finalization?.signals.at(-1),
    "the undelivered escalation stays recorded as unverified",
  ).toMatchObject({ signal: "SIGKILL", delivery: "unverified" });
  expect(result.finalization?.elapsed_ms, "no exit was observed").toBeNull();
}, 10_000);
