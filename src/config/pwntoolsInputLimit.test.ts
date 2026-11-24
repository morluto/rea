import { describe, expect, it } from "vitest";

import { pwntoolsInputBytes } from "./pwntoolsInputLimit.js";
import { PWNTOOLS_LIMITS } from "../domain/native/pwntoolsResourceLimits.js";

const CONSTRAINT =
  "REA_PWNTOOLS_MAX_INPUT_BYTES must be a decimal integer from 1 to " +
  "1073741824 bytes, and REA never installs Python or packages.";

describe("pwntools input bound", () => {
  it("keeps the shipped default when the override is absent", () => {
    expect(pwntoolsInputBytes({})).toEqual({
      configured: true,
      bytes: PWNTOOLS_LIMITS.input_bytes,
      source: "default",
    });
  });

  it.each([
    ["1", 1],
    ["67108864", 64 * 1024 * 1024],
    ["172879872", 172_879_872],
    ["1073741824", 1024 * 1024 * 1024],
  ] as const)("accepts %s as %s bytes", (value, expected) => {
    expect(pwntoolsInputBytes({ REA_PWNTOOLS_MAX_INPUT_BYTES: value })).toEqual(
      { configured: true, bytes: expected, source: "setting" },
    );
  });

  it.each([
    "",
    "0",
    "-1",
    "33554432.0",
    "1e8",
    " 67108864",
    "67_108_864",
    "0x2000000",
    "1073741825",
    "99999999999999999999",
    "not-a-number",
  ])("rejects %s instead of widening the bound silently", (value) => {
    expect(pwntoolsInputBytes({ REA_PWNTOOLS_MAX_INPUT_BYTES: value })).toEqual(
      {
        configured: false,
        error: CONSTRAINT,
      },
    );
  });
});
