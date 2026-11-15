import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it } from "vitest";
import { phaseGate } from "../support/lifecycleHarness.js";

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
