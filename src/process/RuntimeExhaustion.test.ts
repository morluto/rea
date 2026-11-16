import { expect, it } from "vitest";
import {
  externalJvmExhaustionRecovery,
  RUNTIME_EXHAUSTION_AREAS,
  type ExternalJvm,
} from "./RuntimeExhaustion.js";

const jvm: ExternalJvm = {
  program: "Fixture's",
  role: "engine",
  raise: (option) => `Raise the ${option}`,
  settings: "the fixture's JVM memory settings",
  threads: "Reduce concurrent fixture work",
  smaller: "select a smaller input",
};

it.each([
  ["heap", /Raise the maximum heap \(-Xmx\)/u],
  ["gc-overhead", /raise the maximum heap \(-Xmx\)/u],
  ["metaspace", /-XX:MaxMetaspaceSize; a larger heap \(-Xmx\) does not raise/u],
  ["array-size", /a larger heap \(-Xmx\) does not lift this limit/u],
  ["native-thread", /a larger heap \(-Xmx\) does not help/u],
  [undefined, /Review the reported out-of-memory line/u],
] as const)("names the JVM option that governs a %s report", (area, advice) => {
  expect(externalJvmExhaustionRecovery(area, jvm)).toMatch(advice);
});

it("advises only the heap for the areas the heap governs", () => {
  for (const area of RUNTIME_EXHAUSTION_AREAS) {
    const recovery = externalJvmExhaustionRecovery(area, jvm);
    expect(/raise the maximum heap/iu.test(recovery)).toBe(
      area === "heap" || area === "gc-overhead",
    );
  }
});
