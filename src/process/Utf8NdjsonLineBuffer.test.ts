import { describe, expect, it, vi } from "vitest";

import { Utf8NdjsonLineBuffer } from "./Utf8NdjsonLineBuffer.js";

describe("UTF-8 NDJSON line buffer", () => {
  it("drains complete buffered lines on an empty push after iteration stops", () => {
    const lines = new Utf8NdjsonLineBuffer();
    const iterator = lines.push(Buffer.from("first\nsecond\nthird\npartial"));
    expect(iterator.next()).toEqual({ value: "first", done: false });
    iterator.return(undefined);

    expect([...lines.push(Buffer.from(""))]).toEqual(["second", "third"]);
    expect([...lines.push(Buffer.from(" line\n"))]).toEqual(["partial line"]);
  });

  it("joins fragments and yields trimmed nonblank complete lines", () => {
    const lines = new Utf8NdjsonLineBuffer();

    expect([...lines.push(Buffer.from("  first "))]).toEqual([]);
    expect([
      ...lines.push(Buffer.from("\n \t\n second \n unfinished")),
    ]).toEqual(["first", "second"]);
    expect([...lines.push(Buffer.from(" line\n"))]).toEqual([
      "unfinished line",
    ]);
  });

  it("preserves an unexpected decoder failure without classifying it as malformed UTF-8", () => {
    const failure = new RangeError("controlled decoder failure");
    const decode = vi
      .spyOn(TextDecoder.prototype, "decode")
      .mockImplementationOnce(() => {
        throw failure;
      });
    try {
      const lines = new Utf8NdjsonLineBuffer();
      let observed;
      try {
        Array.from(lines.push(Buffer.from("valid\n")));
      } catch (cause: unknown) {
        observed = cause;
      }
      expect(observed).toBe(failure);
    } finally {
      decode.mockRestore();
    }
  });

  it("retains unconsumed complete lines and reset discards them", () => {
    const lines = new Utf8NdjsonLineBuffer();
    const iterator = lines.push(Buffer.from('invalid\n{"id":2}\n'));

    expect(iterator.next()).toEqual({ value: "invalid", done: false });
    iterator.return(undefined);
    expect([...lines.push(Buffer.from('{"id":3}\n'))]).toEqual([
      '{"id":2}',
      '{"id":3}',
    ]);

    const nextIterator = lines.push(
      Buffer.from("discard me\nwill also be discarded\nkeep partial"),
    );
    expect(nextIterator.next()).toEqual({ value: "discard me", done: false });
    nextIterator.return(undefined);
    lines.reset();
    expect([...lines.push(Buffer.from("after reset\n"))]).toEqual([
      "after reset",
    ]);
  });

  it("releases the backing allocation when a frame ends at the newline", () => {
    const lines = new Utf8NdjsonLineBuffer();
    const frame = Buffer.alloc(64 * 1024, 0x78);
    frame[frame.length - 1] = 0x0a;
    expect([...lines.push(frame)]).toEqual([
      frame.subarray(0, frame.length - 1).toString("utf8"),
    ]);
    expect(lines.retainedTail()).toEqual({ pendingBytes: 0, backingBytes: 0 });

    const tail = Buffer.from("next");
    expect([...lines.push(tail)]).toEqual([]);
    expect(lines.retainedTail()).toEqual({
      pendingBytes: tail.length,
      backingBytes: tail.buffer.byteLength,
    });
  });
});
