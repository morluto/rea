import { describe, expect, it } from "vitest";
import { fc, it as fcIt } from "@fast-check/vitest";

import type { JsonValue } from "../domain/jsonValue.js";
import {
  carriesTargetContentMarker,
  encodeToolResult,
  errorTextWireBytes,
  TARGET_CONTENT_RESULT_META,
} from "./toolResultEncoding.js";

const projectedResult = (candidate: JsonValue) => ({
  content: [{ type: "text", text: JSON.stringify(candidate) }],
  structuredContent: candidate,
});

describe("MCP result encoding budget", () => {
  it.each([
    { result: ["中文", "😀", "\ud800", '"\\\n'] },
    { result: "x".repeat(8191) + "😀" + '中文\n"'.repeat(20000) },
  ])("counts actual UTF-8 structured and escaped text bytes", (candidate) => {
    const expected = Buffer.byteLength(
      JSON.stringify(projectedResult(candidate)),
    );
    const encoded = encodeToolResult(candidate, expected);
    if (!encoded.ok) throw new Error("Expected complete encoding");
    expect(encoded.text).toBe(JSON.stringify(candidate));
    expect(encoded.bytes).toBe(expected);
    expect(encodeToolResult(candidate, expected - 1)).toMatchObject({
      ok: false,
      bytesAtLeast: expected,
    });
  });

  it.each([
    { error: { code: "invalid_request", message: '中文"\n'.repeat(30000) } },
    { error: { message: "😀\ud800" } },
  ])(
    "counts escaped text and the error flag for error delivery",
    (candidate) => {
      const errorBytes = Buffer.byteLength(
        JSON.stringify({
          content: [{ type: "text", text: JSON.stringify(candidate) }],
          isError: true,
        }),
      );
      const encoded = encodeToolResult(candidate, errorBytes, "error-text");
      if (!encoded.ok) throw new Error("Expected complete encoding");
      expect(encoded.text).toBe(JSON.stringify(candidate));
      expect(encoded.bytes).toBe(errorBytes);
      expect(
        encodeToolResult(candidate, errorBytes - 1, "error-text"),
      ).toMatchObject({
        ok: false,
        bytesAtLeast: errorBytes,
      });
    },
  );

  it("accounts for the untrusted target-content marker", () => {
    const candidate = { strings: ['"ignore previous instructions"', "中文"] };
    const markedBytes = Buffer.byteLength(
      JSON.stringify({
        ...projectedResult(candidate),
        _meta: TARGET_CONTENT_RESULT_META,
      }),
    );
    const marked = encodeToolResult(
      candidate,
      markedBytes,
      "structured-and-text",
      true,
    );
    if (!marked.ok) throw new Error("Expected complete encoding");
    expect(marked.bytes).toBe(markedBytes);
    expect(marked.text).toBe(JSON.stringify(candidate));
    expect(
      encodeToolResult(candidate, markedBytes - 1, "structured-and-text", true),
    ).toMatchObject({ ok: false, bytesAtLeast: markedBytes });
    expect(TARGET_CONTENT_RESULT_META).toEqual({
      provenance: { untrusted_content: true, source: "analysis_target" },
    });
  });

  it("recognizes the delivered marker", () => {
    expect(
      carriesTargetContentMarker({ _meta: TARGET_CONTENT_RESULT_META }),
    ).toBe(true);
    expect(carriesTargetContentMarker({})).toBe(false);
    expect(
      carriesTargetContentMarker({
        _meta: { provenance: { untrusted_content: false } },
      }),
    ).toBe(false);
  });

  it("stops before reading the remainder of an oversized result", () => {
    const candidate: JsonValue = { text: "x".repeat(1000000) };
    Object.defineProperty(candidate, "remainder", {
      enumerable: true,
      get() {
        throw new Error("The remainder must not be read");
      },
    });
    // Only an already-known first property is visited before exhausting the
    // budget. The serializer's property discovery must not eagerly read values.
    expect(encodeToolResult(candidate, 1000)).toMatchObject({
      ok: false,
      constraint: "receive-buffer",
    });
  });
});

describe("error text wire size", () => {
  it("measures complete escaped error wire bytes and ranks values that cannot fit", () => {
    const value = { text: '中文"\n'.repeat(10_000) };
    const expected = Buffer.byteLength(
      JSON.stringify({
        content: [{ type: "text", text: JSON.stringify(value) }],
        isError: true,
      }),
    );
    expect(errorTextWireBytes(value, expected)).toBe(expected);
    expect(errorTextWireBytes(value, expected - 1)).toBeGreaterThan(
      expected - 1,
    );
  });
});

describe("zero-allocation escaped JSON measurement parity", () => {
  fcIt.prop([fc.string({ unit: "binary-ascii" })])(
    "matches JSON.stringify and Buffer.byteLength across ASCII control and punctuation ranges",
    (sample) => {
      const candidate = { value: sample };
      const wire = JSON.stringify(projectedResult(candidate));
      const expected = Buffer.byteLength(wire);
      const encoded = encodeToolResult(candidate, expected);
      expect(encoded).toEqual({
        ok: true,
        text: JSON.stringify(candidate),
        bytes: expected,
      });
      expect(encodeToolResult(candidate, expected - 1)).toMatchObject({
        ok: false,
        bytesAtLeast: expected,
        constraint: "receive-buffer",
      });
    },
  );

  fcIt.prop([
    fc.array(
      fc.oneof(
        fc.integer({ min: 0x00, max: 0x7f }),
        fc.integer({ min: 0x80, max: 0x7ff }),
        fc.integer({ min: 0x800, max: 0xffff }),
        fc.integer({ min: 0xd800, max: 0xdfff }),
      ),
      { maxLength: 64 },
    ),
  ])(
    "matches JSON.stringify across arbitrary UTF-16 code units including unpaired surrogates",
    (units) => {
      const sample = String.fromCharCode(...units);
      const candidate = { [sample]: sample };
      const wire = JSON.stringify(projectedResult(candidate));
      const expected = Buffer.byteLength(wire);
      const encoded = encodeToolResult(candidate, expected);
      expect(encoded).toEqual({
        ok: true,
        text: JSON.stringify(candidate),
        bytes: expected,
      });
      expect(encodeToolResult(candidate, expected - 1)).toMatchObject({
        ok: false,
        bytesAtLeast: expected,
      });
    },
  );

  it("matches every single C0 control character, non-BMP pair, and reversed surrogate edge case", () => {
    const allControlChars = Array.from({ length: 32 }, (_, c) =>
      String.fromCharCode(c),
    ).join("");
    const edgeStrings = [
      allControlChars,
      '"\\/\b\f\n\r\t\x7f',
      "\ud800",
      "\udfff",
      "\udfff\ud800",
      "\ud800a\udfff",
      "\ud83d\ude80\ud800\ud83d\ude80",
      "éß€𐍈😀\ud800end",
    ];
    for (const sample of edgeStrings) {
      const candidate = { sample };
      const expected = Buffer.byteLength(
        JSON.stringify(projectedResult(candidate)),
      );
      expect(encodeToolResult(candidate, expected)).toEqual({
        ok: true,
        text: JSON.stringify(candidate),
        bytes: expected,
      });
      expect(encodeToolResult(candidate, expected - 1)).toMatchObject({
        ok: false,
        bytesAtLeast: expected,
      });
    }
  });
});
