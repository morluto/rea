import { describe, expect, it } from "vitest";

import { flattenSourceMapLeaves, isVersion3Map } from "./sourceMapEnvelope.js";

const leaf = {
  version: 3,
  mappings: "AAAA",
  sources: ["app.ts"],
  names: [],
};

describe("source-map envelope walk", () => {
  it("accepts version-3 maps and rejects other shapes", () => {
    expect(isVersion3Map(leaf)).toBe(true);
    expect(isVersion3Map({ version: 2, mappings: "AAAA" })).toBe(false);
    expect(isVersion3Map(null)).toBe(false);
    expect(isVersion3Map([{ version: 3 }])).toBe(false);
  });

  it("collects indexed section leaves without validating offsets by default", () => {
    const root = {
      version: 3,
      sections: [
        { offset: { line: 0, column: 0 }, map: leaf },
        { offset: { line: 10, column: 0 }, map: { ...leaf, sources: [] } },
      ],
    };
    expect(flattenSourceMapLeaves(root)).toHaveLength(2);
  });

  it("rejects non-map sections and enforces offsets when requested", () => {
    const missing = {
      version: 3,
      sections: [{ offset: { line: 0, column: 0 } }],
    };
    expect(flattenSourceMapLeaves(missing)).toBeUndefined();
    const badOffset = {
      version: 3,
      sections: [{ offset: { line: -1, column: 0 }, map: leaf }],
    };
    expect(
      flattenSourceMapLeaves(badOffset, { validateOffsets: true }),
    ).toBeUndefined();
    expect(flattenSourceMapLeaves(badOffset)).toHaveLength(1);
  });

  it("rejects non-version-3 roots and nested maps", () => {
    expect(flattenSourceMapLeaves({ version: 3 })).toHaveLength(1);
    expect(flattenSourceMapLeaves({ mappings: "AAAA" })).toBeUndefined();
    expect(
      flattenSourceMapLeaves({
        version: 3,
        sections: [{ offset: { line: 0, column: 0 }, map: { version: 2 } }],
      }),
    ).toBeUndefined();
  });
});
