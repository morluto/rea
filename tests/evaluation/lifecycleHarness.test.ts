import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it } from "vitest";
import { phaseArrival, phaseGate } from "../support/lifecycleHarness.js";

it("hands an early rejection to the later hold without an unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const record = (cause: unknown) => unhandled.push(cause);
  process.on("unhandledRejection", record);
  try {
    const gate = phaseGate<void, number>();
    const failure = new Error("decided before the boundary");
    gate.reject(failure);
    gate.release(1);
    await nextTurn();
    await nextTurn();
    expect(unhandled).toEqual([]);
    await expect(gate.hold()).rejects.toBe(failure);
  } finally {
    process.off("unhandledRejection", record);
  }
});

it("gives each hold its own promise, so an unhandled held rejection is still reported", async () => {
  const gate = phaseGate<void, number>();
  const first = gate.hold();
  const second = gate.hold();
  // The gate's internal guard against an early rejection must not mark the
  // promise the code under test receives as handled.
  expect(first).not.toBe(second);
  gate.release(1);
  expect(await Promise.all([first, second])).toEqual([1, 1]);
});

it("releases every hold with the first value", async () => {
  const gate = phaseGate<string, number>();
  const operation = gate.hold("arrived");
  expect(await gate.reached(operation, "held boundary")).toBe("arrived");
  gate.release(7);
  gate.release(8);
  gate.reject(new Error("ignored after release"));
  expect(await operation).toBe(7);
  expect(await gate.hold("again")).toBe(7);
});

it("reports an arrival only when it happens before the operation settles", async () => {
  const arrival = phaseArrival<string>();
  const settled = Promise.resolve("done");
  await expect(arrival.reached(settled, "late boundary")).rejects.toThrow(
    "late boundary was not acknowledged before the triggering operation settled",
  );
  const running = new Promise<void>(() => {});
  arrival.arrive("first");
  arrival.arrive("second");
  expect(await arrival.reached(running, "announced boundary")).toBe("first");
});

it("counts an arrival announced in the same turn the operation settles", async () => {
  const arrival = phaseArrival();
  const operation = Promise.resolve().then(() => arrival.arrive());
  await arrival.reached(operation, "immediate boundary");
  const gate = phaseGate();
  const held = Promise.resolve().then(() => {
    void gate.hold();
  });
  await gate.reached(held, "immediate hold");
});
