import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { fetchWebSourceMaps } from "../../../src/browser/WebSourceMapFetcher.js";
import { analyzeWebBundleInputSchema } from "../../../src/domain/webBundleAnalysis.js";
import { traceSourceMap } from "../../../src/javascript/sourceMaps/TraceSourceMap.js";

const cases = [
  {
    name: "later nested line resets outer column",
    map: {
      version: 3,
      sections: [
        {
          offset: {
            line: 5,
            column: 10,
          },
          map: {
            version: 3,
            sections: [
              {
                offset: {
                  line: 1,
                  column: 0,
                },
                map: {
                  version: 3,
                  sources: ["a.ts"],
                  sourcesContent: ["export const value=1;"],
                  names: [],
                  mappings: "AAAA",
                },
              },
            ],
          },
        },
      ],
    },
    expected: [[7, 0, "a.ts"]],
    dedicatedControl: true,
  },
  {
    name: "same line retains summed columns",
    map: {
      version: 3,
      sections: [
        {
          offset: {
            line: 5,
            column: 10,
          },
          map: {
            version: 3,
            sections: [
              {
                offset: {
                  line: 0,
                  column: 3,
                },
                map: {
                  version: 3,
                  sources: ["a.ts"],
                  sourcesContent: ["export const value=1;"],
                  names: [],
                  mappings: "AAAA",
                },
              },
            ],
          },
        },
      ],
    },
    expected: [[6, 13, "a.ts"]],
    dedicatedControl: true,
  },
  {
    name: "ordinary leaf unchanged",
    map: {
      version: 3,
      sources: ["a.ts"],
      sourcesContent: ["export const value=1;"],
      names: [],
      mappings: "AAAA;AACA",
    },
    expected: [
      [1, 0, "a.ts"],
      [2, 0, "a.ts"],
    ],
    dedicatedControl: true,
  },
  {
    name: "same-line sibling clipping",
    map: {
      version: 3,
      sections: [
        {
          offset: {
            line: 0,
            column: 0,
          },
          map: {
            version: 3,
            sources: ["a.ts"],
            sourcesContent: ["export const value=1;"],
            names: [],
            mappings: "AAAA,QAAQ,IAAI",
          },
        },
        {
          offset: {
            line: 0,
            column: 10,
          },
          map: {
            version: 3,
            sources: ["b.ts"],
            sourcesContent: ["export const value=1;"],
            names: [],
            mappings: "AAAA",
          },
        },
      ],
    },
    expected: [
      [1, 0, "a.ts"],
      [1, 8, "a.ts"],
      [1, 10, "b.ts"],
    ],
    dedicatedControl: false,
  },
  {
    name: "nested gap clips previous parent leaf",
    map: {
      version: 3,
      sections: [
        {
          offset: {
            line: 0,
            column: 0,
          },
          map: {
            version: 3,
            sources: ["a.ts"],
            sourcesContent: ["export const value=1;"],
            names: [],
            mappings: "AAAA,QAAQ,IAAI",
          },
        },
        {
          offset: {
            line: 0,
            column: 5,
          },
          map: {
            version: 3,
            sections: [
              {
                offset: {
                  line: 0,
                  column: 3,
                },
                map: {
                  version: 3,
                  sources: ["b.ts"],
                  sourcesContent: ["export const value=1;"],
                  names: [],
                  mappings: "AAAA",
                },
              },
            ],
          },
        },
      ],
    },
    expected: [
      [1, 0, "a.ts"],
      [1, 8, "b.ts"],
    ],
    dedicatedControl: false,
  },
  {
    name: "empty indexed sibling clips previous leaf",
    map: {
      version: 3,
      sections: [
        {
          offset: {
            line: 0,
            column: 0,
          },
          map: {
            version: 3,
            sources: ["a.ts"],
            sourcesContent: ["export const value=1;"],
            names: [],
            mappings: "AAAA,QAAQ,IAAI",
          },
        },
        {
          offset: {
            line: 0,
            column: 5,
          },
          map: {
            version: 3,
            sections: [],
          },
        },
      ],
    },
    expected: [[1, 0, "a.ts"]],
    dedicatedControl: false,
  },
  {
    name: "depth-three same-line composition",
    map: {
      version: 3,
      sections: [
        {
          offset: {
            line: 0,
            column: 2,
          },
          map: {
            version: 3,
            sections: [
              {
                offset: {
                  line: 0,
                  column: 3,
                },
                map: {
                  version: 3,
                  sections: [
                    {
                      offset: {
                        line: 0,
                        column: 4,
                      },
                      map: {
                        version: 3,
                        sources: ["a.ts"],
                        sourcesContent: ["export const value=1;"],
                        names: [],
                        mappings: "AAAA",
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    },
    expected: [[1, 9, "a.ts"]],
    dedicatedControl: true,
  },
  {
    name: "multiline inherited sibling stop",
    map: {
      version: 3,
      sections: [
        {
          offset: {
            line: 0,
            column: 0,
          },
          map: {
            version: 3,
            sections: [
              {
                offset: {
                  line: 1,
                  column: 3,
                },
                map: {
                  version: 3,
                  sources: ["a.ts"],
                  sourcesContent: ["export const value=1;"],
                  names: [],
                  mappings: "AAAA;AACA;AACA;AACA",
                },
              },
            ],
          },
        },
        {
          offset: {
            line: 3,
            column: 1,
          },
          map: {
            version: 3,
            sources: ["b.ts"],
            sourcesContent: ["export const value=1;"],
            names: [],
            mappings: "AAAA",
          },
        },
      ],
    },
    expected: [
      [2, 3, "a.ts"],
      [3, 0, "a.ts"],
      [4, 0, "a.ts"],
      [4, 1, "b.ts"],
    ],
    dedicatedControl: false,
  },
] as const;

it.each(cases)(
  "preserves indexed coordinate contract: $name",
  async ({ map, expected, dedicatedControl }) => {
    const origin = "https://example.test";
    const url = origin + "/app.js.map";
    const text = JSON.stringify(map);
    // The dedicated decoder already normalizes absolute leaves. Its stricter
    // overlap profile is compared only for the valid non-overlapping maps.
    if (dedicatedControl) {
      for (const [line, column] of expected) {
        const point = traceSourceMap(text, url, { line, column });
        expect(point.lookup.matched_generated_position).toEqual({
          line,
          column,
        });
        expect(point.matches).toHaveLength(1);
      }
    }
    const result = await fetchWebSourceMaps(
      [{ scriptKey: "scr_" + "1".repeat(64), declaredUrl: url, fetchUrl: url }],
      analyzeWebBundleInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        allowed_origins: [origin],
        target_id: "page-1",
        fetch_source_maps: true,
      }),
      undefined,
      { fetch: () => Promise.resolve(new Response(text, { status: 200 })) },
    );
    const item = result.items[0];
    if (item?.status !== "included") throw new Error(JSON.stringify(result));
    expect(
      item.mappings.map((entry) => [
        entry.generated_line,
        entry.generated_column,
        entry.source.replace(origin + "/", ""),
      ]),
    ).toEqual(expected);
    expect(item.artifact.sha256).toBe(
      createHash("sha256").update(text).digest("hex"),
    );
    expect(item.artifact.bytes).toBe(Buffer.byteLength(text));
    // Boundary-only markers must not introduce empty original-source identities.
    expect(item.original_sources.map(({ source }) => source)).toEqual([
      ...new Set(expected.map(([, , source]) => origin + "/" + source)),
    ]);
  },
);
