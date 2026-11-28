import { describe, expect, it } from "vitest";
import { edgeSpan, trimEdges, trimTrailing } from "./trimEdges.js";

const isSpace = (character: string): boolean =>
  character === " " || character === "\t";
const isZero = (character: string): boolean => character === "0";

describe("trimEdges kernel helpers", () => {
  it("computes leading and trailing bounds across empty, all-matching, and mixed strings", () => {
    expect(edgeSpan("", isSpace)).toEqual({ start: 0, end: 0 });
    expect(edgeSpan("   \t ", isSpace)).toEqual({ start: 5, end: 5 });
    expect(edgeSpan("plain", isSpace)).toEqual({ start: 0, end: 5 });
    expect(edgeSpan(" \tabc\t ", isSpace)).toEqual({ start: 2, end: 5 });
    expect(edgeSpan("  a   b  ", isSpace)).toEqual({ start: 2, end: 7 });
  });

  it("trims trailing runs without disturbing leading or interior characters", () => {
    expect(trimTrailing("", isZero)).toBe("");
    expect(trimTrailing("0000", isZero)).toBe("");
    expect(trimTrailing("0010", isZero)).toBe("001");
    expect(trimTrailing("10001", isZero)).toBe("10001");
    expect(trimTrailing(`1${"0".repeat(200_000)}1`, isZero)).toBe(
      `1${"0".repeat(200_000)}1`,
    );
  });

  it("trims leading and trailing runs while preserving interior characters", () => {
    expect(trimEdges("", isSpace)).toBe("");
    expect(trimEdges(" \t ", isSpace)).toBe("");
    expect(trimEdges("plain", isSpace)).toBe("plain");
    expect(trimEdges("\t hello   world  ", isSpace)).toBe("hello   world");
    expect(trimEdges(`${" ".repeat(200_000)}x`, isSpace)).toBe("x");
  });
});
