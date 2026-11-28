import { expect, it } from "vitest";
import { assertBinaryLaneProviderIds } from "./BinaryProviderIds.js";

/** The published lane must match the providers wired in `createBinarySession`. */
it("accepts the wired binary providers", () => {
  expect(() =>
    assertBinaryLaneProviderIds(["ida", "hopper", "kuna", "ghidra"]),
  ).not.toThrow();
});

it("fails loudly on lane drift instead of emitting stale guidance", () => {
  expect(() =>
    assertBinaryLaneProviderIds(["hopper", "ghidra", "kuna"]),
  ).toThrow(/missing ida/);
  expect(() =>
    assertBinaryLaneProviderIds(["hopper", "ghidra", "ida", "kuna", "jeb"]),
  ).toThrow(/unexpected jeb/);
});
