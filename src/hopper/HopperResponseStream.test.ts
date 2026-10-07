import { describe, expect, it } from "vitest";

import { HopperResponseStream } from "./HopperResponseStream.js";

describe("Hopper response stream", () => {
  it("preserves fragmented messages and drops partial bytes on reset", () => {
    const messages: unknown[] = [];
    const stream = new HopperResponseStream({
      accept: (message) => {
        messages.push(message);
        return true;
      },
      hasQueued: () => false,
      nextRequestId: () => 4,
      abort: (message) => {
        throw new Error(message);
      },
    });
    stream.push("discarded");
    stream.reset();
    stream.push(' {"id":1,"result":"雪');
    stream.push('🦊"}\r');
    stream.push('\n\n{"id":2,"result":null}\n{"id":');
    stream.push('3,"result":true}');
    expect(messages).toEqual([
      { id: 1, result: "雪🦊" },
      { id: 2, result: null },
    ]);
    stream.push("\n");
    expect(messages).toEqual([
      { id: 1, result: "雪🦊" },
      { id: 2, result: null },
      { id: 3, result: true },
    ]);
  });

  it("stops delivering queued lines when validation aborts and resets the stream", () => {
    const messages: unknown[] = [];
    const failures: string[] = [];
    const stream = new HopperResponseStream({
      accept: (message) => {
        messages.push(message);
        return true;
      },
      hasQueued: () => false,
      nextRequestId: () => 2,
      abort: (message) => {
        failures.push(message);
        stream.reset();
      },
    });
    stream.push('malformed\n{"id":1,"result":true}\n');
    expect(messages).toEqual([]);
    expect(failures).toHaveLength(1);
    stream.push('{"id":1,"result":false}\n');
    expect(messages).toEqual([{ id: 1, result: false }]);
  });

  it("accepts a large response arriving in many small socket fragments", () => {
    const messages: unknown[] = [];
    const stream = new HopperResponseStream({
      accept: (message) => {
        messages.push(message);
        return true;
      },
      hasQueued: () => false,
      nextRequestId: () => 2,
      abort: (message) => {
        throw new Error(message);
      },
    });
    const response = `{"id":1,"result":"${"x".repeat(8 * 1024 * 1024)}"}`;
    for (let offset = 0; offset < response.length; offset += 4096)
      stream.push(response.slice(offset, offset + 4096));
    expect(messages).toEqual([]);
    stream.push("\n");
    expect(messages).toEqual([JSON.parse(response)]);
  });

  it("accepts complete responses larger than the former 10 MiB ceiling", () => {
    const messages: unknown[] = [];
    const failures: string[] = [];
    const stream = new HopperResponseStream({
      accept: (message) => {
        messages.push(message);
        return true;
      },
      hasQueued: () => false,
      nextRequestId: () => 2,
      abort: (message) => failures.push(message),
    });
    const line = `{"id":1,"result":"${"x".repeat(10 * 1024 * 1024 + 1)}"}`;

    stream.push(`${line}\n`);

    expect(failures).toEqual([]);
    expect(messages).toEqual([JSON.parse(line)]);
  });
});
