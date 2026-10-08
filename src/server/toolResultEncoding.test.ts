import { describe, expect, it } from "vitest";

import type { JsonValue } from "../domain/jsonValue.js";
import { encodeToolResult } from "./toolResultEncoding.js";

const projectedResult = (candidate: JsonValue) => ({
  content: [{ type: "text", text: JSON.stringify(candidate) }],
  structuredContent: candidate,
});

describe("MCP result encoding budget", () => {
  it.each([
    { result: { value: 1 } },
    { result: ["中文", "😀", "\ud800", '"\\\n'] },
    { result: "x".repeat(8191) + "😀" + '中文\n"'.repeat(20000) },
  ])("counts actual UTF-8 structured and escaped text bytes", (candidate) => {
    const encoded = encodeToolResult(candidate);
    if (!encoded.ok) throw new Error("Expected complete encoding");
    expect(encoded.text).toBe(JSON.stringify(candidate));
    expect(encoded.bytes).toBe(
      Buffer.byteLength(JSON.stringify(projectedResult(candidate))),
    );
  });

  it("accounts for repeated Evidence representations", () => {
    const normalized = { value: '中文"'.repeat(30000) };
    const candidate = {
      result: normalized,
      evidence: { normalized_result: normalized },
    };
    const completeBytes = Buffer.byteLength(
      JSON.stringify(projectedResult(candidate)),
    );
    expect(encodeToolResult(candidate, completeBytes).ok).toBe(true);
    expect(encodeToolResult(candidate, completeBytes - 1)).toMatchObject({
      ok: false,
      bytesAtLeast: completeBytes,
    });
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
    expect(() => encodeToolResult(candidate, 1000)).not.toThrow();
    expect(encodeToolResult(candidate, 1000).ok).toBe(false);
  });
});
