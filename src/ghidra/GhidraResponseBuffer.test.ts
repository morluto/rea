import { describe, expect, it } from "vitest";

import { GhidraResponseBuffer } from "./GhidraResponseBuffer.js";

describe("Ghidra response buffer", () => {
  it("preserves fragmented lines, whitespace and a trailing partial response", () => {
    const lines: string[] = [];
    const buffer = new GhidraResponseBuffer({
      onLine: (line) => lines.push(line),
    });
    buffer.push('  {"result":"雪');
    buffer.push('🦊"}\r');
    buffer.push('\n\n {"result":2}\n{"res');
    expect(lines).toEqual(['{"result":"雪🦊"}', '{"result":2}']);
    buffer.push('ult":3}');
    expect(lines).toHaveLength(2);
    buffer.push("\n");
    expect(lines).toEqual([
      '{"result":"雪🦊"}',
      '{"result":2}',
      '{"result":3}',
    ]);
  });

  it("drops both pending fragments and remaining lines when reset during delivery", () => {
    const lines: string[] = [];
    const buffer = new GhidraResponseBuffer({
      onLine: (line) => {
        lines.push(line);
        buffer.reset();
      },
    });
    buffer.push("discarded partial");
    buffer.reset();
    buffer.push("first\nsecond\npartial");
    buffer.push("discarded");
    buffer.reset();
    buffer.push("next\n");
    expect(lines).toEqual(["first", "next"]);
  });

  it("accepts a large response arriving in many small socket fragments", () => {
    const lines: string[] = [];
    const buffer = new GhidraResponseBuffer({
      onLine: (line) => lines.push(line),
    });
    const response = `{"result":"${"x".repeat(8 * 1024 * 1024)}"}`;
    for (let offset = 0; offset < response.length; offset += 4096)
      buffer.push(response.slice(offset, offset + 4096));
    expect(lines).toEqual([]);
    buffer.push("\n");
    expect(lines).toEqual([response]);
  });

  it("accepts complete responses larger than the former 64 MiB ceiling", () => {
    const lines: string[] = [];
    const buffer = new GhidraResponseBuffer({
      onLine: (line) => lines.push(line),
    });
    const response = `{"result":"${"x".repeat(64 * 1024 * 1024 + 1)}"}`;

    buffer.push(`${response}\n`);

    expect(lines).toEqual([response]);
  });
});
