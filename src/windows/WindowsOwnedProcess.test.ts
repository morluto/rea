import { describe, expect, it } from "vitest";

import { quoteWindowsProcessArgument } from "./WindowsOwnedProcess.js";

describe("Windows process argument representation", () => {
  it.each([
    ["", '""'],
    ["plain", '"plain"'],
    ["two words", '"two words"'],
    ['embedded"quote', '"embedded\\"quote"'],
    ["D:\\folder\\", '"D:\\folder\\\\"'],
    ['slash\\"quote', '"slash\\\\\\"quote"'],
  ])("quotes %j without changing its CRT argument", (input, expected) => {
    expect(quoteWindowsProcessArgument(input)).toBe(expected);
  });

  it("rejects NUL before crossing the native boundary", () => {
    expect(() => quoteWindowsProcessArgument("a\0b")).toThrow("NUL");
  });
});
