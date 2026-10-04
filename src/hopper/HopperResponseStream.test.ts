import { describe, expect, it } from "vitest";

import { HopperResponseStream } from "./HopperResponseStream.js";

describe("Hopper response stream", () => {
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
