import { describe, expect, it, vi } from "vitest";

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
  it("resumes buffered lines on empty or nonempty input and discards them on reset", () => {
    const lines = new Utf8NdjsonLineBuffer(() => 128);
    const consumeFirst = (chunk: string, wanted: string) => {
      const iterator = lines.push(Buffer.from(chunk));
      expect(iterator.next()).toEqual({ value: ok(wanted), done: false });
      iterator.return(undefined);
    };

    consumeFirst("first\nsecond\nthird\npartial", "first");
    expect(texts(lines.push(Buffer.alloc(0)))).toEqual(["second", "third"]);
    consumeFirst(" line\nkeep\n", "partial line");
    expect(texts(lines.push(Buffer.from("new\n")))).toEqual(["keep", "new"]);

    consumeFirst("discard me\nqueued\nand partial", "discard me");
    lines.reset();
    expect(texts(lines.push(Buffer.from("after reset\n")))).toEqual([
      "after reset",
    ]);
  });

  it.each([
    { projection: "bridge", expected: ["é", "second"] },
    { projection: "raw", expected: ["\uFEFF é ", " \t", " second "] },
  ] as const)(
    "preserves the $projection whitespace policy across fragments",
    ({ projection, expected }) => {
      const lines = new Utf8NdjsonLineBuffer(() => 64);
      const encoded = Buffer.from("\uFEFF é \n \t\n second \n unfinished");
      const cut = encoded.indexOf(0xc3) + 1;
      const push = (chunk: Buffer) =>
        projection === "bridge" ? lines.push(chunk) : lines.pushRaw(chunk);
      expect(texts(push(encoded.subarray(0, cut)))).toEqual([]);
      expect(texts(push(encoded.subarray(cut)))).toEqual(expected);
      expect(texts(push(Buffer.from(" line\n")))).toEqual(
        projection === "bridge" ? ["unfinished line"] : [" unfinished line"],
      );
    },
  );

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

  it("keeps completed lines when malformed UTF-8 stops a frame or EOF validation", () => {
    const lines = new Utf8NdjsonLineBuffer(() => 64);
    const malformed = { kind: "malformed", format: "ndjson" };
    const yielded = [
      ...lines.push(Buffer.from([0x61, 0x0a, 0xff, 0x0a, 0x62, 0x0a, 0xff])),
    ];
    expect(yielded).toMatchObject([
      ok("a"),
      { ok: false, error: { failure: malformed } },
    ]);
    expect(texts(lines.push(Buffer.alloc(0)))).toEqual(["b"]);
    expect(lines.finish()).toMatchObject({
      ok: false,
      error: { failure: malformed },
    });

    lines.reset();
    expect(lines.finish()).toEqual(ok(null));
  });

  it.each(["", "partial"])(
    "releases a drained full frame with tail %j",
    (tail) => {
      const bytes = 64 * 1024;
      const lines = new Utf8NdjsonLineBuffer(() => bytes);
      expect(texts(lines.push(Buffer.alloc(bytes, 0x78)))).toEqual([]);
      const iterator = lines.push(Buffer.from(`\n${tail}`));
      expect(iterator.next()).toEqual({
        done: false,
        value: ok("x".repeat(bytes)),
      });
      if (tail === "") iterator.return(undefined);
      else expect(iterator.next().done).toBe(true);

      const retained = lines.retainedTail();
      expect(retained.pendingBytes).toBe(tail.length);
      expect(retained.backingBytes).toBeLessThanOrEqual(
        tail.length === 0 ? 0 : Buffer.poolSize,
      );
      if (tail !== "") {
        expect(texts(lines.push(Buffer.from(" line\n")))).toEqual([
          "partial line",
        ]);
      }
    },
  );

  it.each([
    { boundary: "tail", ending: "y" },
    { boundary: "line", ending: "y\n" },
  ] as const)(
    "discards a $boundary above the newly reduced byte ceiling",
    ({ boundary, ending }) => {
      let maximumBytes = 17;
      const lines = new Utf8NdjsonLineBuffer(() => maximumBytes);
      const prefix = Buffer.alloc(16, 0x78);
      expect([...lines.push(prefix)]).toEqual([]);

      maximumBytes = 16;
      const refused = [...lines.push(Buffer.from(ending))];
      expect(refused).toHaveLength(1);
      const refusal = refused[0]?.ok ? undefined : refused[0]?.error;
      expect(refusal).toBeInstanceOf(Utf8NdjsonOversizeError);
      expect(refusal).toMatchObject({
        maximumBytes: 16,
        observedBytes: 17,
        boundary,
        failure: {
          kind: "limit",
          format: "ndjson",
          limit: { name: "ndjson-line-bytes", maximum: 16 },
        },
      });
      expect(lines.retainedTail()).toEqual({
        pendingBytes: 0,
        backingBytes: 0,
      });

      maximumBytes = 17;
      expect(
        texts(lines.push(Buffer.concat([prefix, Buffer.from("y\n")]))),
      ).toEqual(["x".repeat(16) + "y"]);
    },
  );
});
