import { expect, it } from "vitest";
import { externalJvmExhaustionRecovery } from "./RuntimeExhaustion.js";

it("recommends increasing the heap for a JVM GC overhead report", () => {
  const recovery = externalJvmExhaustionRecovery("gc-overhead", {
    program: "Fixture's",
    role: "engine",
    raise: (option) => `Raise the ${option}`,
    settings: "the fixture's JVM memory settings",
    threads: "Reduce concurrent fixture work",
    smaller: "select a smaller input",
  });
  expect(recovery).toMatch(/raise[^.]*-Xmx/iu);
});
