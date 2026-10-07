import { describe, expect, it } from "vitest";
import { traceSourceMap } from "./TraceSourceMap.js";

const url = "https://app.test/maps/app.js.map?v=2#map";
const point = { line: 1, column: 0 };
const leaf = {
  version: 3,
  names: [],
  mappings: "AAAA",
  sources: ["app.ts"],
  sourcesContent: ["original"],
};
const trace = (map: unknown, position = point) =>
  traceSourceMap(JSON.stringify(map), url, position);

describe("upstream source-map point evidence", () => {
  it("preserves every duplicate-column/source-URL candidate and its own embedded bytes", () => {
    const report = trace({
      ...leaf,
      sources: ["same.ts", "same.ts"],
      sourcesContent: ["first", "second"],
      mappings: "AAAA,ACAA",
    });
    expect(report.matches).toHaveLength(2);
    expect(report.matches).toMatchObject([
      {
        flattened_source_index: 0,
        source_index: 0,
        resolved_url: "https://app.test/maps/same.ts",
        content: { text: "first" },
      },
      {
        flattened_source_index: 1,
        source_index: 1,
        resolved_url: "https://app.test/maps/same.ts",
        content: { text: "second" },
      },
    ]);
  });
  it("keeps sourceRoot, query/fragment identity and decoded-text UTF-8 digest", () => {
    const report = trace({
      ...leaf,
      sourceRoot: "../src",
      sources: ["a.ts?v=2#source"],
      sourcesContent: ["🎋a\r\nb"],
      names: ["answer"],
      mappings: "AAAEA",
    });
    expect(report.matches[0]).toMatchObject({
      reported_source: "a.ts?v=2#source",
      reported_source_root: "../src",
      resolved_url: "https://app.test/src/a.ts?v=2#source",
      name: "answer",
      original_position: {
        line: 1,
        column: 2,
        offset: 2,
        content_position: "verified-in-embedded-text",
      },
      content: { utf8_bytes: 8 },
    });
  });
  it("retains generated-only mappings and no-match positions explicitly", () => {
    expect(
      trace({ ...leaf, mappings: "AAAA,K" }, { line: 1, column: 5 }).matches,
    ).toEqual([{ state: "generated-only" }]);
    expect(trace({ ...leaf, mappings: "KAAA" }).matches).toEqual([]);
    expect(
      trace({ ...leaf, mappings: "" }).lookup.matched_generated_position,
    ).toBeNull();
  });
  it("uses cross-line greatest-position lookup without inventing a mapping", () => {
    expect(
      trace({ ...leaf, mappings: "AAAA;;" }, { line: 3, column: 2 }).lookup
        .matched_generated_position,
    ).toEqual({ line: 1, column: 0 });
  });
  it("preserves unknown source identity while retaining embedded content", () => {
    expect(trace({ ...leaf, sources: [null] }).matches[0]).toMatchObject({
      reported_source: null,
      resolved_url: null,
      content: { text: "original" },
    });
  });
  it("keeps indexed original content aligned when a preceding section has partial contents", () => {
    const report = trace(
      {
        version: 3,
        sections: [
          {
            offset: { line: 0, column: 0 },
            map: { ...leaf, sources: ["a", "b"], sourcesContent: ["A"] },
          },
          {
            offset: { line: 1, column: 0 },
            map: { ...leaf, sources: ["c"], sourcesContent: ["C"] },
          },
        ],
      },
      { line: 2, column: 0 },
    );
    expect(report.matches[0]).toMatchObject({
      section_path: [1],
      source_index: 0,
      flattened_source_index: 2,
      reported_source: "c",
      content: { text: "C" },
    });
  });
  it("supports nested indexed line offsets with first-line-only column shifts", () => {
    const report = trace(
      {
        version: 3,
        sections: [
          {
            offset: { line: 1, column: 2 },
            map: {
              version: 3,
              sections: [{ offset: { line: 1, column: 3 }, map: leaf }],
            },
          },
        ],
      },
      { line: 3, column: 3 },
    );
    expect(report.lookup.matched_generated_position).toEqual({
      line: 3,
      column: 3,
    });
    expect(report.matches[0]).toMatchObject({
      section_path: [0, 0],
      original_position: { line: 1, column: 0 },
    });
  });
  it("reports original positions outside embedded contents without fabricating an offset", () => {
    expect(trace({ ...leaf, mappings: "AAUA" }).matches[0]).toMatchObject({
      original_position: {
        line: 11,
        column: 0,
        offset: null,
        content_position: "outside-embedded-text",
      },
    });
  });
});

describe("source-map layout admission", () => {
  it.each(["ACAA", "AAAAC", "g", "!", "AA", "D"])(
    "rejects malformed VLQ/components/indexes: %s",
    (mappings) => {
      expect(() => trace({ ...leaf, mappings })).toThrow();
    },
  );
  it("validates regular-map source indexes after reusing its decoded rows", () => {
    expect(() => trace({ ...leaf, mappings: "ACAA" })).toThrow(/index/u);
  });
  it("rejects huge indexed offsets before upstream row allocation", () => {
    expect(() =>
      trace({
        version: 3,
        sections: [{ offset: { line: 1000000000, column: 0 }, map: leaf }],
      }),
    ).toThrow(/decoder budget/u);
  });
  it("reports the actual malformed section offset constraint", () => {
    expect(() =>
      trace({
        version: 3,
        sections: [{ offset: { line: -1, column: 0 }, map: leaf }],
      }),
    ).toThrow(/offset/u);
  });
  it("rejects overlapping section mappings rather than silently clipping evidence", () => {
    expect(() =>
      trace({
        version: 3,
        sections: [
          {
            offset: { line: 0, column: 0 },
            map: { ...leaf, mappings: "AAAA,UAAA" },
          },
          { offset: { line: 0, column: 5 }, map: leaf },
        ],
      }),
    ).toThrow(/overlap/u);
  });
  it("accepts absent optional names and null contents without changing reported identity", () => {
    expect(
      trace({
        version: 3,
        sources: ["app.ts"],
        sourcesContent: null,
        mappings: "AAAA",
      }).matches[0],
    ).toMatchObject({
      reported_source: "app.ts",
      content: { state: "unavailable" },
    });
  });
});

it.each(["ACAA", "AAAAC"])(
  "rejects invalid section-local source/name indexes before flattening: %s",
  (mappings) => {
    expect(() =>
      traceSourceMap(
        JSON.stringify({
          version: 3,
          sections: [
            { offset: { line: 0, column: 0 }, map: { ...leaf, mappings } },
            {
              offset: { line: 1, column: 0 },
              map: { ...leaf, names: ["other"] },
            },
          ],
        }),
        url,
        point,
      ),
    ).toThrow(/index/u);
  },
);
it.each(["ggggggEAAA", "gggggggBAAA"])(
  "rejects overflowing VLQ quantities before upstream bitwise decoding: %s",
  (mappings) => {
    expect(() =>
      traceSourceMap(JSON.stringify({ ...leaf, mappings }), url, point),
    ).toThrow(/32-bit/u);
  },
);
