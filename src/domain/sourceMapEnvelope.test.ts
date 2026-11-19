import { describe, expect, it } from "vitest";

import { inspectLocalSourceMapDeclarations } from "./sourceMapFormat.js";
import { selectedSourceMapLimits } from "./sourceMapLimits.js";

const inspect = (root: unknown) =>
  inspectLocalSourceMapDeclarations(JSON.stringify(root));

const leaf = {
  version: 3,
  mappings: "AAAA",
  sources: ["app.ts"],
  names: [],
};

describe("source-map envelope walk", () => {
  it("retains ordered declarations under nested section offsets", () => {
    const root = {
      version: 3,
      sections: [
        {
          offset: { line: 0, column: 0 },
          map: {
            version: 3,
            sections: [
              {
                offset: { line: 0, column: 0 },
                map: { ...leaf, sources: ["b.ts"] },
              },
              {
                offset: { line: 1, column: 0 },
                map: { ...leaf, sources: ["c.ts"] },
              },
            ],
          },
        },
        {
          offset: { line: 10, column: 0 },
          map: { ...leaf, sources: ["d.ts"] },
        },
      ],
    };
    const result = inspect(root);
    expect(result.limitations).toEqual([]);
    expect(result.invalid_sections).toEqual([]);
    expect(result.declarations.map(({ source }) => source)).toEqual([
      "b.ts",
      "c.ts",
      "d.ts",
    ]);
  });

  it("retains external sections in canonical path order and embedded leaves", () => {
    const url = "https://app.test/maps/part.map";
    const result = inspect({
      version: 3,
      sections: [
        {
          offset: { line: 0, column: 0 },
          map: {
            version: 3,
            sections: [
              { offset: { line: 0, column: 0 }, url: `${url}/nested` },
              { offset: { line: 1, column: 0 }, map: leaf },
            ],
          },
        },
        { offset: { line: 1, column: 0 }, url },
        {
          offset: { line: 2, column: 0 },
          map: { ...leaf, sources: ["after.ts"] },
        },
      ],
    });
    expect(result).toMatchObject({
      limitations: [],
      declarations: [
        { sectionPath: [0, 1], source: "app.ts" },
        { sectionPath: [2], source: "after.ts" },
      ],
      external_sections: [
        { section_path: [0, 0], url: `${url}/nested` },
        { section_path: [1], url },
      ],
      invalid_sections: [],
    });
  });

  it("retains valid leaves and URLs when a sibling section is malformed", () => {
    const url = "https://app.test/maps/part.map";
    const result = inspect({
      version: 3,
      sections: [
        {
          offset: { line: 0, column: 0 },
          map: { ...leaf, sources: ["before.ts"] },
        },
        { offset: { line: 1, column: 0 }, url },
        { offset: { line: 2, column: 0 }, url: 12, map: leaf },
        {
          offset: { line: 3, column: 0 },
          map: { ...leaf, sources: ["after.ts"] },
        },
      ],
    });
    expect(result).toMatchObject({
      limitations: [],
      declarations: [
        { sectionPath: [0], source: "before.ts" },
        { sectionPath: [3], source: "after.ts" },
      ],
      external_sections: [{ section_path: [1], url }],
      invalid_sections: [
        {
          section_path: [2],
          reason: expect.stringMatching(/section URL.*must be a string/iu),
        },
      ],
    });
  });

  it("rejects sections without embedded maps or an external URL", () => {
    const missing = {
      version: 3,
      sections: [{ offset: { line: 0, column: 0 } }],
    };
    expect(inspect(missing)).toMatchObject({
      invalid_sections: [
        {
          section_path: [0],
          reason: expect.stringMatching(
            /source-map section requires.*embedded map or external URL/i,
          ),
        },
      ],
    });
  });
});

describe("malformed source-map envelope facts", () => {
  it("marks a present non-array sections member malformed at the map path", () => {
    expect(
      inspect({
        version: 3,
        sections: null,
        sources: ["must-not-be-read.ts"],
        mappings: "AAAA",
      }),
    ).toEqual({
      declarations: [],
      limitations: [],
      external_sections: [],
      invalid_sections: [
        {
          section_path: [],
          reason: expect.stringMatching(/sections.*must be an array/iu),
        },
      ],
    });
  });

  it("rejects non-version-3 roots and nested maps", () => {
    expect(inspect({ version: 3 })).toMatchObject({
      declarations: [],
      limitations: ["Source map has no sources array."],
    });
    expect(inspect(null)).toMatchObject({
      declarations: [],
      limitations: ["Source map is not a version 3 map."],
    });
    expect(inspect([{ version: 3 }])).toMatchObject({
      declarations: [],
      limitations: ["Source map is not a version 3 map."],
    });
    expect(inspect({ version: 2, mappings: "AAAA" })).toMatchObject({
      declarations: [],
      limitations: ["Source map is not a version 3 map."],
    });
    expect(inspect({ mappings: "AAAA" })).toMatchObject({
      declarations: [],
      limitations: ["Source map is not a version 3 map."],
    });
    expect(
      inspect({
        version: 3,
        sections: [
          {
            offset: { line: 0, column: 0 },
            map: { version: "3", sections: [] },
          },
        ],
      }),
    ).toMatchObject({
      invalid_sections: [
        {
          section_path: [0],
          reason: "Indexed source-map section map is not a version 3 map.",
        },
      ],
    });
  });
});

it("does not traverse more local sections than the format reader admits", () => {
  const observed = inspectLocalSourceMapDeclarations(
    JSON.stringify({
      version: 3,
      sections: [
        { offset: { line: 0, column: 0 }, map: leaf },
        { offset: { line: 1, column: 0 }, map: leaf },
      ],
    }),
    { limits: selectedSourceMapLimits({ decoded_records: 1 }) },
  );
  expect(observed.declarations).toEqual([]);
  expect(observed.invalid_sections).toEqual([
    {
      section_path: [],
      reason: "Local source-map inspection exceeded decoded_records (1).",
    },
  ]);
});
