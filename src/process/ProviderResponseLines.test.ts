import { describe, expect, it, vi } from "vitest";

import { ProviderResponseLines } from "./ProviderResponseLines.js";

// The real limit is V8's string length, which a test cannot reach cheaply.
vi.mock("node:buffer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:buffer")>();
  return {
    ...actual,
    constants: { ...actual.constants, MAX_STRING_LENGTH: 8 },
  };
});

const reader = (
  accept: (line: string) => boolean = () => true,
  continueAfterOverflow = true,
) => {
  const lines: string[] = [];
  let overflows = 0;
  const responses = new ProviderResponseLines({
    onLine: (line) => {
      lines.push(line);
      return accept(line);
    },
    onOverflow: () => {
      overflows += 1;
      return continueAfterOverflow;
    },
  });
  return { responses, lines, overflows: () => overflows };
};

describe("ProviderResponseLines", () => {
  it("assembles a line split across chunks when it reaches the limit exactly", () => {
    const { responses, lines, overflows } = reader();
    responses.push("abcd");
    responses.push("efgh\n\n  ijk\r\n");

    expect(lines).toEqual(["abcdefgh", "ijk"]);
    expect(overflows()).toBe(0);
  });

  it("skips only the oversized line and keeps reading the same chunk", () => {
    const { responses, lines, overflows } = reader();
    responses.push("abcd");
    responses.push('efghi\n{"id":2}\n');

    expect(overflows()).toBe(1);
    expect(lines).toEqual(['{"id":2}']);
  });

  it("skips an oversized line across later chunks until its newline", () => {
    const { responses, lines, overflows } = reader();
    responses.push("abcdefghi");
    responses.push("still the same line");
    responses.push(' tail\n{"id":3}\n');

    expect(overflows()).toBe(1);
    expect(lines).toEqual(['{"id":3}']);
  });

  it("drops the rest of the chunk when the overflow ends the session", () => {
    const { responses, lines } = reader(() => true, false);
    responses.push('abcdefghi\n{"id":2}\n');
    expect(lines).toEqual([]);

    responses.reset();
    responses.push('{"id":4}\n');
    expect(lines).toEqual(['{"id":4}']);
  });

  it("drops the rest of a chunk once a line is refused", () => {
    const { responses, lines } = reader((line) => line !== "stop");
    responses.push("first\nstop\nlater\n");

    expect(lines).toEqual(["first", "stop"]);
  });
});
