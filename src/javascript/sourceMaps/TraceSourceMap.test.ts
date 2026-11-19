import { describe, expect, it } from "vitest";
import { traceSourceMap } from "./TraceSourceMap.js";
import { inspectSourceMap } from "../../domain/sourceMapFormat.js";

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

it("uses the same conservative section classification for URL-plus-map and malformed URLs", () => {
  const externalUrl = "https://app.test/maps/part.map";
  const external = () =>
    inspectSourceMap(
      JSON.stringify({
        version: 3,
        sections: [
          { offset: { line: 0, column: 0 }, url: externalUrl, map: leaf },
        ],
      }),
    );
  expect(external).toThrow(
    expect.objectContaining({
      failure: expect.objectContaining({ kind: "unsupported" }),
      message: `External source-map section URL is not fetched: ${externalUrl}`,
    }),
  );

  const malformed = () =>
    inspectSourceMap(
      JSON.stringify({
        version: 3,
        sections: [{ offset: { line: 0, column: 0 }, url: 12, map: leaf }],
      }),
    );
  expect(malformed).toThrow(
    expect.objectContaining({
      failure: expect.objectContaining({ kind: "malformed" }),
      message: expect.stringMatching(/section URL.*must be a string.*\[0\]/iu),
    }),
  );
});

it("keeps ignore-list precedence and section-local indexes for duplicate sources", () => {
  const map = {
    version: 3,
    sections: [
      {
        offset: { line: 0, column: 0 },
        map: {
          ...leaf,
          sources: ["same.ts", "same.ts"],
          sourcesContent: ["first", "second"],
          mappings: "AAAA,ACAA",
          ignoreList: [1, 1],
          x_google_ignoreList: [0],
        },
      },
      {
        offset: { line: 1, column: 0 },
        map: { ...leaf, x_google_ignoreList: [0] },
      },
      {
        offset: { line: 2, column: 0 },
        map: { ...leaf, ignoreList: [], x_google_ignoreList: [0] },
      },
    ],
  };
  expect(trace(map).matches).toMatchObject([
    { source_index: 0, ignored: false, content: { text: "first" } },
    { source_index: 1, ignored: true, content: { text: "second" } },
  ]);
  expect(trace(map, { line: 2, column: 0 }).matches[0]).toMatchObject({
    section_path: [1],
    source_index: 0,
    ignored: true,
  });
  expect(trace(map, { line: 3, column: 0 }).matches[0]).toMatchObject({
    section_path: [2],
    source_index: 0,
    ignored: false,
  });
});

describe("upstream source-map point evidence", () => {
  it("preserves duplicate-column candidates, their URL spelling and their own content", () => {
    const report = trace({
      ...leaf,
      sources: ["dir/same.ts", "dir/same.ts", "dir//same.ts"],
      sourcesContent: ["first", "second", "repeated separator"],
      mappings: "AAAA,ACAA,ACAA",
    });
    expect(report.matches).toMatchObject([
      {
        flattened_source_index: 0,
        source_index: 0,
        resolved_url: "https://app.test/maps/dir/same.ts",
        content: { text: "first" },
      },
      {
        flattened_source_index: 1,
        source_index: 1,
        resolved_url: "https://app.test/maps/dir/same.ts",
        content: { text: "second" },
      },
      {
        flattened_source_index: 2,
        source_index: 2,
        resolved_url: "https://app.test/maps/dir//same.ts",
        content: { text: "repeated separator" },
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
  it("distinguishes no match from a generated-only match carried across empty lines", () => {
    const map = { ...leaf, mappings: "CAAA,I;;" };
    expect(trace(map)).toMatchObject({
      matches: [],
      lookup: { matched_generated_position: null },
    });
    expect(trace(map, { line: 3, column: 2 })).toMatchObject({
      matches: [{ state: "generated-only" }],
      lookup: { matched_generated_position: { line: 1, column: 5 } },
    });
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

describe("source-map section-boundary candidates", () => {
  it.each([
    { mappings: "AAAAA", column: 0, nested: false },
    { mappings: "AAAAA,KAAAA", column: 5, nested: false },
    { mappings: "AAAAA;AAAAA", column: 0, nested: true },
  ])(
    "retains all section-boundary candidates ($mappings, nested=$nested)",
    ({ mappings, column, nested }) => {
      const first = {
        ...leaf,
        sources: ["same.ts"],
        sourcesContent: ["first"],
        names: ["firstName"],
        mappings,
      };
      const second = {
        ...leaf,
        sources: ["same.ts"],
        sourcesContent: ["second"],
        names: ["secondName"],
        mappings: "AAAAA",
      };
      const line = nested ? 1 : 0;
      const report = trace(
        {
          version: 3,
          sections: [
            { offset: { line: 0, column: 0 }, map: first },
            {
              offset: { line, column },
              map: nested
                ? {
                    version: 3,
                    sections: [
                      {
                        offset: { line: 0, column: 0 },
                        map: second,
                      },
                    ],
                  }
                : second,
            },
          ],
        },
        { line: line + 1, column },
      );
      expect(report.lookup.matched_generated_position).toEqual({
        line: line + 1,
        column,
      });
      expect(report.matches).toMatchObject([
        {
          flattened_source_index: 0,
          section_path: [0],
          source_index: 0,
          content: { text: "first" },
          name: "firstName",
        },
        {
          flattened_source_index: 1,
          section_path: nested ? [1, 0] : [1],
          source_index: 0,
          content: { text: "second" },
          name: "secondName",
        },
      ]);
      expect(report.matches).toHaveLength(2);
    },
  );
  it.each([false, true])(
    "keeps a generated-only section-boundary candidate (first=%s)",
    (generatedOnlyFirst) => {
      const generated = { version: 3, sources: [], names: [], mappings: "A" };
      const first = generatedOnlyFirst ? generated : leaf;
      const second = generatedOnlyFirst ? leaf : generated;
      const report = trace(
        {
          version: 3,
          sections: [
            {
              offset: { line: 0, column: 0 },
              map: { ...first, mappings: `K${first.mappings.slice(1)}` },
            },
            { offset: { line: 0, column: 5 }, map: second },
          ],
        },
        { line: 1, column: 5 },
      );
      const mapped = {
        state: "mapped",
        flattened_source_index: 0,
        section_path: [generatedOnlyFirst ? 1 : 0],
        source_index: 0,
      };
      const generatedOnly = { state: "generated-only" };
      expect(report.matches).toMatchObject(
        generatedOnlyFirst ? [generatedOnly, mapped] : [mapped, generatedOnly],
      );
      expect(report.matches).toHaveLength(2);
    },
  );
});

describe("source-map layout admission", () => {
  it.each(["AAAAC", "g", "!", "AA", "D"])(
    "rejects malformed VLQ/components/indexes: %s",
    (mappings) => {
      expect(() => trace({ ...leaf, mappings })).toThrow();
    },
  );
  it.each([",", ",AAAA", "AAAA,,A", "AAAA,", "AAAA,;A"])(
    "rejects empty mapping segments around commas: %s",
    (mappings) => {
      expect(() => trace({ ...leaf, mappings })).toThrow(
        /empty mapping segment/u,
      );
    },
  );
  it("retains empty generated lines and generated-only mappings", () => {
    const report = traceSourceMap(
      JSON.stringify({ ...leaf, mappings: ";;A,CAAA;" }),
      url,
      { line: 3, column: 0 },
    );
    expect(report.lookup.matched_generated_position).toEqual({
      line: 3,
      column: 0,
    });
    expect(report.matches).toEqual([{ state: "generated-only" }]);
  });
  it("validates regular-map source indexes after reusing its decoded rows", () => {
    expect(() => trace({ ...leaf, mappings: "ACAA" })).toThrow(/index/u);
  });
  it("reports the actual malformed section offset constraint", () => {
    expect(() =>
      trace({
        version: 3,
        sections: [{ offset: { line: -1, column: 0 }, map: leaf }],
      }),
    ).toThrow(/offset/u);
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
