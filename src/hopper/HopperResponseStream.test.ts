import { describe, expect, it, vi } from "vitest";

import { HopperResponseStream } from "./HopperResponseStream.js";

describe("Hopper response stream", () => {
  it("stops on malformed input and resumes with buffered response lines", () => {
    const accepted: number[] = [];
    const abort = vi.fn();
    const stream = new HopperResponseStream({
      accept: (message) => {
        accepted.push(message.id);
        return true;
      },
      hasQueued: () => false,
      nextRequestId: () => 4,
      abort,
    });

    stream.push(Buffer.from('not json\n{"id":2,"result":null}\n'));
    expect(accepted).toEqual([]);
    expect(abort).toHaveBeenCalledOnce();

    stream.push(Buffer.from('{"id":3'));
    expect(accepted).toEqual([2]);
    stream.push(Buffer.from(',"result":null}\n'));
    expect(accepted).toEqual([2, 3]);
    expect(abort).toHaveBeenCalledOnce();
  });

  it("stops on a future response id and retains later complete lines", () => {
    const accepted: number[] = [];
    const abort = vi.fn();
    const stream = new HopperResponseStream({
      accept: (message) => {
        if (message.id >= 3) return false;
        accepted.push(message.id);
        return true;
      },
      hasQueued: () => false,
      nextRequestId: () => 3,
      abort,
    });

    stream.push(
      Buffer.from('{"id":3,"result":null}\n{"id":1,"result":null}\n'),
    );
    expect(accepted).toEqual([]);
    expect(abort).toHaveBeenCalledWith(
      "Hopper returned an unknown response id",
    );

    stream.push(Buffer.from('{"id":2'));
    expect(accepted).toEqual([1]);
    stream.push(Buffer.from(',"result":null}\n'));
    expect(accepted).toEqual([1, 2]);
    expect(abort).toHaveBeenCalledOnce();
  });

  it("discards incomplete lines on reset", () => {
    const accepted: number[] = [];
    const stream = new HopperResponseStream({
      accept: (message) => {
        accepted.push(message.id);
        return true;
      },
      hasQueued: () => false,
      nextRequestId: () => 2,
      abort: vi.fn(),
    });

    stream.push(Buffer.from('{"id":1,"result":null}'));
    stream.reset();
    stream.push(Buffer.from('{"id":1,"result":null}\n'));
    expect(accepted).toEqual([1]);
  });
});
