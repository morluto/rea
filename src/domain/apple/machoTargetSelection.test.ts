import { expect, it } from "vitest";

import { machoSelectionAnswersArchitecture } from "./machoTargetSelection.js";

const CPU_ARM64 = 0x0100000c;
const CPU_X86_64 = 0x01000007;

it.each([
  ["no selection, no value", undefined, undefined, true],
  ["no selection for a value", null, "arm64", false],
  ["a selection without a value", [CPU_ARM64, 0], undefined, false],
  ["arm64 for arm64", [CPU_ARM64, 0], "arm64", true],
  ["a lone arm64e slice for arm64", [CPU_ARM64, 0x80000002], "arm64", true],
  ["arm64e for arm64e", [CPU_ARM64, 0x80000002], "arm64e", true],
  ["arm64e.x1 for arm64e", [CPU_ARM64, 12], "arm64e", true],
  ["arm64 for arm64e", [CPU_ARM64, 0], "arm64e", false],
  ["arm64v8 for arm64e", [CPU_ARM64, 1], "arm64e", false],
  ["arm64 for x86_64", [CPU_ARM64, 0], "x86_64", false],
  ["x86_64h for x86_64", [CPU_X86_64, 8], "x86_64", true],
] as const)("%s", (_, slice, architecture, answers) => {
  const selection =
    slice === null || slice === undefined
      ? slice
      : { cpu_type: slice[0], cpu_subtype: slice[1] };
  expect(machoSelectionAnswersArchitecture(selection, architecture)).toBe(
    answers,
  );
});
