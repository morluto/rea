import { describe, expect, it } from "vitest";
import canonicalize from "canonicalize";

import {
  bufferedJsonParts,
  canonicalJsonParts,
  jsonParts,
} from "./jsonSerialization.js";

describe("streamed JSON representation", () => {
  it.each([
    null,
    true,
    -0,
    [1, false, null, 'quotes: " / slash: \\ / newline: \n'],
    { nested: { value: "中文 😀 \ud800" }, items: [1, 2] },
    JSON.parse('{"__proto__":{"value":1},"constructor":2,"10":3,"2":4}'),
  ])("matches native JSON for ordinary values: %j", (value: unknown) => {
    expect([...bufferedJsonParts(jsonParts(value))].join("")).toBe(
      JSON.stringify(value),
    );
    expect([...jsonParts(value, true)].join("")).toBe(
      JSON.stringify(value, null, 2),
    );
  });

  it("preserves surrogate pairs across string and buffer boundaries", () => {
    const value = { text: `${"x".repeat(8190)}😀${'中文\n"'.repeat(20000)}` };
    const parts = [...bufferedJsonParts(jsonParts(value))];
    expect(
      Buffer.concat(parts.map((part) => Buffer.from(part))).toString(),
    ).toBe(JSON.stringify(value));
    expect(JSON.parse(parts.join(""))).toEqual(value);
  });

  it("rejects a cycle while allowing repeated references", () => {
    const shared = { value: 1 };
    expect([...jsonParts({ left: shared, right: shared })].join("")).toBe(
      JSON.stringify({ left: shared, right: shared }),
    );
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(() => [...jsonParts(cycle)]).toThrow("circular reference");
  });

  it("matches existing canonical bytes for numeric keys, Unicode, and shared values", () => {
    const shared = { z: -0, a: [1e-7, 1e30, "雪😀\ud800"] };
    const ownKeys: unknown = JSON.parse(
      '{"__proto__":1,"constructor":2,"10":3,"2":4}',
    );
    const value = {
      z: shared,
      a: shared,
      keys: ownKeys,
      long: '雪😀"'.repeat(20000),
    };
    expect([...bufferedJsonParts(canonicalJsonParts(value))].join("")).toBe(
      canonicalize(value),
    );
  });
});
