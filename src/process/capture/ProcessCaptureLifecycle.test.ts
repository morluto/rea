import { afterEach, expect, it, vi } from "vitest";
import type { IPty } from "@lydell/node-pty";

import { processScenarioSchema } from "../../domain/process/processScenario.js";
import type { ProcessCaptureFinalization } from "../../domain/process/processCapture.js";
import { awaitTerminalExit } from "./ProcessCaptureLifecycle.js";
import type { ProcessTimer } from "./ProcessTimer.js";
import { monotonicProcessCaptureClock } from "./ProcessCaptureClock.js";

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
  signalFailure?: Error,
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
  ): Promise<{ readonly delivery: Delivery }> => {
    signals.push(signal);
    await hold;
    if (signalFailure !== undefined) throw signalFailure;
    return { delivery: deliveries[signal] ?? "signaled" };
  };
  return {
    signals,
    terminal,
    signalTarget,
    deliverExit: (exit: FakeExit) => listener?.(exit),
  };
};

const snapshots: ProcessCaptureFinalization[] = [];

const fakePollingClock = () => {
  vi.useFakeTimers({
    toFake: ["Date", "performance", "setInterval", "clearInterval"],
  });
};

afterEach(() => {
  vi.useRealTimers();
});

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
    scenario: processScenarioSchema.parse({
      executable: "unused",
      idle_timeout_ms: 10_000,
      ...scenario,
    }),
    started: monotonicProcessCaptureClock(),
    lastOutput: monotonicProcessCaptureClock,
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

it("uses the monotonic running deadline and releases zero-interval polling after exit", async () => {
  fakePollingClock();
  const fake = fakeTerminal();
  const pending = start(fake, { timeout_ms: 100, finalization_ms: 0 });
  vi.setSystemTime(Date.now() - 60_000);

  await vi.advanceTimersByTimeAsync(80);
  expect(fake.signals).toEqual([]);
  await vi.advanceTimersByTimeAsync(20);
  expect(fake.signals).toEqual(["terminal:SIGKILL"]);
  fake.deliverExit({ exitCode: 0, signal: 9 });

  const exit = observed(await pending);
  expect(exit.reason).toBe("timeout");
  expect(exit.finalization).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});

it("records attempts when a self-exit notification arrives after escalation", async () => {
  fakePollingClock();
  const fake = fakeTerminal();
  const pending = start(fake, { timeout_ms: 100, finalization_ms: 100 });
  // Let several more polls run after escalation before the PTY emits exit.
  await vi.advanceTimersByTimeAsync(350);
  expect(fake.signals).toEqual(["SIGTERM", "SIGKILL"]);
  fake.deliverExit({ exitCode: 0, signal: 0 });

  const exit = observed(await pending);

  expect(
    exit.finalization?.signals.map(({ signal }) => signal),
    "both attempts are observed in order",
  ).toEqual(["SIGTERM", "SIGKILL"]);
  expect(exit.signal, "the observed exit remains independent of attempts").toBe(
    0,
  );
});

it("kills at once when cancelled during the finalization interval", async () => {
  const fake = fakeTerminal();
  const controller = new AbortController();
  const pending = start(
    fake,
    { timeout_ms: 100, finalization_ms: 60_000 },
    controller.signal,
  );
  await expect.poll(() => fake.signals).toContain("SIGTERM");
  controller.abort();
  await expect.poll(() => fake.signals).toContain("SIGKILL");
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
  expect(
    fake.signals.filter((signal) => signal.startsWith("terminal:")),
    "cancellation during finalization never uses a bare terminal kill",
  ).toEqual([]);
});

it("records escalation attempts alongside an observed SIGKILL exit", async () => {
  const fake = fakeTerminal();
  const pending = start(fake, { timeout_ms: 100, finalization_ms: 100 });
  await expect.poll(() => fake.signals).toContain("SIGKILL");
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
    exit.finalization?.signals[1]?.sent_at_ms,
    "the escalation waited for the whole interval",
  ).toBeGreaterThanOrEqual(100);
  expect(exit.finalization?.exit_code).toBeNull();
});

it("records a scripted SIGKILL exit without inferring its cause", async () => {
  const fake = fakeTerminal();
  const pending = start(fake, { timeout_ms: 100, finalization_ms: 5_000 });
  await expect.poll(() => fake.signals).toContain("SIGTERM");
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

it.each([0, 3])(
  "records exit code %i of a finalizer that exits on its own",
  async (exitCode) => {
    const fake = fakeTerminal();
    const pending = start(fake, { timeout_ms: 100, finalization_ms: 5_000 });
    await expect.poll(() => fake.signals).toContain("SIGTERM");
    fake.deliverExit({ exitCode, signal: 0 });

    const exit = observed(await pending);
    expect(exit.finalization?.exit_code).toBe(exitCode);
    expect(exit.reason).toBe("timeout");
  },
);

it("records no exit code when the PTY reports a negative code without a signal", async () => {
  const fake = fakeTerminal();
  const pending = start(fake, { timeout_ms: 100, finalization_ms: 5_000 });
  await expect.poll(() => fake.signals).toContain("SIGTERM");
  fake.deliverExit({ exitCode: -1, signal: 0 });

  const exit = observed(await pending);

  expect(
    exit.finalization?.exit_code,
    "a negative PTY code is not a process exit code and is never recorded",
  ).toBeNull();
  expect(exit.reason, "the initiating deadline stays the exit reason").toBe(
    "timeout",
  );
});

it("records every delivery result and publishes attempts incrementally", async () => {
  snapshots.length = 0;
  const fake = fakeTerminal({ SIGTERM: "gone", SIGKILL: "gone" });
  const pending = start(fake, { timeout_ms: 100, finalization_ms: 100 });
  await expect.poll(() => fake.signals).toContain("SIGKILL");
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
  await expect.poll(() => fake.signals).toContain("SIGTERM");
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
  await expect.poll(() => fake.signals).toContain("SIGTERM");
  fake.deliverExit({ exitCode: 0, signal: 0 });
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled, "the result waits for the outstanding delivery").toBe(
      false,
    );
  } finally {
    release();
  }
  const exit = observed(await pending);

  expect(
    exit.finalization?.signals,
    "the delivery result is complete in the published record",
  ).toMatchObject([{ signal: "SIGTERM", delivery: "signaled" }]);
});

it("stops waiting for a hung delivery once the exit is observed", async () => {
  const fake = fakeTerminal({}, new Promise<void>(() => undefined));
  const pending = start(fake, { timeout_ms: 100, finalization_ms: 5_000 });
  await expect.poll(() => fake.signals).toContain("SIGTERM");
  fake.deliverExit({ exitCode: 0, signal: 0 });

  const exit = observed(await pending);

  expect(
    exit.finalization?.signals,
    "an undelivered attempt stays recorded as unverified",
  ).toMatchObject([
    {
      signal: "SIGTERM",
      delivery: "unverified",
      reason: "delivery did not settle within 1000 ms",
    },
  ]);
  expect(exit.signal, "the observed exit is kept").toBe(0);
});

it("retains a thrown signal error as an unverified delivery reason", async () => {
  const fake = fakeTerminal(
    {},
    undefined,
    new Error("signal transport failed"),
  );
  const pending = start(fake, { timeout_ms: 100, finalization_ms: 5_000 });
  await expect.poll(() => fake.signals).toContain("SIGTERM");
  fake.deliverExit({ exitCode: 0, signal: 0 });

  const exit = observed(await pending);

  expect(
    exit.finalization?.signals,
    "a rejected signal retains its error message",
  ).toMatchObject([
    {
      signal: "SIGTERM",
      delivery: "unverified",
      reason: "signal transport failed",
    },
  ]);
});

it("keeps an observed exit when a late kill delivery reports unverified", async () => {
  let release: () => void = () => undefined;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fake = fakeTerminal({ SIGKILL: "unverified" }, hold);
  const pending = start(fake, { timeout_ms: 100, finalization_ms: 100 });
  await expect.poll(() => fake.signals).toContain("SIGKILL");
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
  const result = await start(fake, { timeout_ms: 100, finalization_ms: 100 });
  expect(result.unobserved, "no exit is invented").toBe(true);
  expect(
    result.finalization?.signals.at(-1),
    "the undelivered escalation stays recorded as unverified",
  ).toMatchObject({
    signal: "SIGKILL",
    delivery: "unverified",
    reason: "delivery did not settle within 1000 ms",
  });
  expect(result.finalization).toMatchObject({
    elapsed_ms: null,
    exit_code: null,
  });
});

const activeTimers = (): number =>
  process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;

it("cancels the bounded-wait timer once deliveries settle after an exit", async () => {
  const fake = fakeTerminal();
  const before = activeTimers();
  const pending = start(fake, { timeout_ms: 100, finalization_ms: 5_000 });
  await expect.poll(() => fake.signals).toContain("SIGTERM");
  fake.deliverExit({ exitCode: 0, signal: 0 });

  await pending;
  await new Promise((resolve) => setImmediate(resolve));

  expect(
    activeTimers(),
    "no one-second grace timer outlives the finalized exit",
  ).toBeLessThanOrEqual(before);
});

it("keeps a non-empty reason when a signal delivery throws without a message", async () => {
  const fake = fakeTerminal();
  let signalStarted = false;
  const throwing = {
    ...fake,
    signalTarget: async (): Promise<never> => {
      signalStarted = true;
      throw new Error();
    },
  };
  const pending = start(throwing, { timeout_ms: 100, finalization_ms: 5_000 });
  await expect.poll(() => signalStarted).toBe(true);
  throwing.deliverExit({ exitCode: 0, signal: 0 });

  const exit = observed(await pending);

  expect(
    exit.finalization?.signals[0]?.reason?.length,
    "a thrown error without a message still leaves a named reason",
  ).toBeGreaterThan(0);
});

it("never publishes an unverified attempt without a reason, also while it is in flight", async () => {
  const fake = fakeTerminal();
  let calls = 0;
  const custom = {
    ...fake,
    signalTarget: (signal: "SIGTERM" | "SIGKILL") => {
      calls += 1;
      fake.signals.push(signal);
      return calls === 1
        ? new Promise<never>(() => undefined)
        : Promise.resolve({ delivery: "identity-changed" as const });
    },
  };
  const pending = start(custom, { timeout_ms: 50, finalization_ms: 20 });

  const result = await pending;

  expect(result.unobserved, "the undeliverable escalation ends the wait").toBe(
    true,
  );
  expect(
    result.finalization?.signals[0],
    "the still-undelivered SIGTERM carries a reason, as the capture schema requires",
  ).toMatchObject({ signal: "SIGTERM", delivery: "unverified" });
  expect(
    result.finalization?.signals[0]?.reason?.length,
    "the in-flight attempt is never published without a reason",
  ).toBeGreaterThan(0);
});
