import { describe, expect, it, vi } from "vitest";

import { ParseFailureError } from "../domain/parseFailure.js";
import { ok } from "../domain/result.js";
import {
  Utf8NdjsonLineBuffer,
  Utf8NdjsonOversizeError,
} from "./Utf8NdjsonLineBuffer.js";

const texts = (lines: Iterable<{ ok: boolean; value?: string }>): string[] =>
  Array.from(lines, (line) => {
    if (!line.ok || line.value === undefined)
      throw new Error("expected a decoded line");
    return line.value;
  });

describe("UTF-8 NDJSON line buffer", () => {
  it("drains complete buffered lines on an empty push after iteration stops", () => {
    const lines = new Utf8NdjsonLineBuffer(() => 1024 * 1024);
    const iterator = lines.push(Buffer.from("first\nsecond\nthird\npartial"));
    expect(iterator.next()).toEqual({ value: ok("first"), done: false });
    iterator.return(undefined);

    expect(texts(lines.push(Buffer.from("")))).toEqual(["second", "third"]);
    expect(texts(lines.push(Buffer.from(" line\n")))).toEqual(["partial line"]);
  });

  it("joins fragments and yields trimmed nonblank complete lines", () => {
    const lines = new Utf8NdjsonLineBuffer(() => 1024 * 1024);

    expect(texts(lines.push(Buffer.from("  first ")))).toEqual([]);
    expect(
      texts(lines.push(Buffer.from("\n \t\n second \n unfinished"))),
    ).toEqual(["first", "second"]);
    expect(texts(lines.push(Buffer.from(" line\n")))).toEqual([
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
      const lines = new Utf8NdjsonLineBuffer(() => 1024 * 1024);
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

  it("yields a line that is not UTF-8 as a malformed parse failure and stops", () => {
    const lines = new Utf8NdjsonLineBuffer(() => 1024 * 1024);
    const yielded = Array.from(
      lines.push(Buffer.from([0x61, 0x0a, 0xff, 0x0a, 0x62, 0x0a])),
    );
    expect(yielded).toHaveLength(2);
    expect(yielded[0]).toEqual(ok("a"));
    const failure = yielded[1];
    expect(failure?.ok).toBe(false);
    if (failure === undefined || failure.ok) return;
    if (!(failure.error instanceof ParseFailureError))
      throw new Error("expected a malformed parse failure");
    expect(failure.error.failure).toMatchObject({
      kind: "malformed",
      format: "ndjson",
    });
    expect(texts(lines.push(Buffer.alloc(0)))).toEqual(["b"]);
  });

  it("reports an unfinished tail that is not UTF-8 at EOF", () => {
    const lines = new Utf8NdjsonLineBuffer(() => 1024 * 1024);
    expect(texts(lines.push(Buffer.from([0x61, 0x0a, 0xff])))).toEqual(["a"]);
    const tail = lines.finish();
    expect(tail.ok).toBe(false);
    if (tail.ok) return;
    expect(tail.error.kind).toBe("malformed");
    lines.reset();
    expect(lines.finish()).toEqual(ok(null));
  });

  it("retains unconsumed complete lines and reset discards them", () => {
    const lines = new Utf8NdjsonLineBuffer(() => 1024 * 1024);
    const iterator = lines.push(Buffer.from('invalid\n{"id":2}\n'));

    expect(iterator.next()).toEqual({ value: ok("invalid"), done: false });
    iterator.return(undefined);
    expect(texts(lines.push(Buffer.from('{"id":3}\n')))).toEqual([
      '{"id":2}',
      '{"id":3}',
    ]);

    const nextIterator = lines.push(
      Buffer.from("discard me\nwill also be discarded\nkeep partial"),
    );
    expect(nextIterator.next()).toEqual({
      value: ok("discard me"),
      done: false,
    });
    nextIterator.return(undefined);
    lines.reset();
    expect(texts(lines.push(Buffer.from("after reset\n")))).toEqual([
      "after reset",
    ]);
  });

  it("releases the backing allocation when a frame ends at the newline", () => {
    const lines = new Utf8NdjsonLineBuffer(() => 1024 * 1024);
    const frame = Buffer.alloc(64 * 1024, 0x78);
    frame[frame.length - 1] = 0x0a;
    expect(texts(lines.push(frame))).toEqual([
      frame.subarray(0, frame.length - 1).toString("utf8"),
    ]);
    expect(lines.retainedTail()).toEqual({ pendingBytes: 0, backingBytes: 0 });

    const tail = Buffer.from("next");
    expect(texts(lines.push(tail))).toEqual([]);
    expect(lines.retainedTail()).toEqual({
      pendingBytes: tail.length,
      backingBytes: tail.buffer.byteLength,
    });
  });

  it("discards an unterminated tail once it passes the ceiling", () => {
    const lines = new Utf8NdjsonLineBuffer(() => 16);
    expect([...lines.push(Buffer.alloc(16, 0x78))]).toEqual([]);

    const refused = [...lines.push(Buffer.from("y"))];
    expect(refused).toHaveLength(1);
    const refusal = refused[0]?.ok ? undefined : refused[0]?.error;
    expect(refusal).toEqual(new Utf8NdjsonOversizeError(16, 17));
    // The refusal is the shared limit parse failure, with the observed bytes.
    expect(refusal).toBeInstanceOf(ParseFailureError);
    expect(refusal?.failure).toMatchObject({
      kind: "limit",
      format: "ndjson",
      limit: { name: "ndjson-line-bytes", maximum: 16 },
    });
    expect(lines.retainedTail()).toEqual({ pendingBytes: 0, backingBytes: 0 });
  });

  it("reads the ceiling on each push so a runtime change applies to the next chunk", () => {
    let maximumBytes = 4;
    const lines = new Utf8NdjsonLineBuffer(() => maximumBytes);
    const refused = [...lines.push(Buffer.from("12345\n"))];
    expect(refused[0]?.ok ? undefined : refused[0]?.error).toBeInstanceOf(
      Utf8NdjsonOversizeError,
    );
    maximumBytes = 8;
    expect(texts(lines.push(Buffer.from("12345\n")))).toEqual(["12345"]);
  });
});
