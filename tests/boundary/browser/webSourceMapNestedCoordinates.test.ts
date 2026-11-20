import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { analyzeWebBundleInputSchema } from "../../../src/domain/webBundleAnalysis.js";
import { fetchWebSourceMapsOk } from "../../fixtures/fetchWebSourceMapsOk.js";

const origin = "https://example.test";
const url = `${origin}/app.js.map`;
const request = {
  scriptKey: `scr_${"1".repeat(64)}`,
  declaredUrl: url,
  fetchUrl: url,
};
const input = analyzeWebBundleInputSchema.parse({
  cdp_endpoint: "http://127.0.0.1:9222",
  allowed_origins: [origin],
  target_id: "page-1",
  fetch_source_maps: true,
});

const leaf = (source: string, mappings = "AAAA", names: string[] = []) => ({
  version: 3,
  sources: [source],
  sourcesContent: ["export const value = 1;"],
  names,
  mappings,
});

interface Section {
  offset: { line: number; column: number };
  map: ReturnType<typeof leaf> | { version: number; sections: Section[] };
}

const section = (
  line: number,
  column: number,
  map: Section["map"],
): Section => ({
  offset: { line, column },
  map,
});

const indexed = (...sections: Section[]) => ({ version: 3, sections });

const fetchMap = (text: string) =>
  fetchWebSourceMapsOk([request], input, undefined, {
    fetch: async () => new Response(text),
  });

it.each([
  {
    name: "a later nested line discards the outer column",
    map: indexed(section(5, 10, indexed(section(1, 3, leaf("a.ts"))))),
    line: 7,
    column: 3,
  },
  {
    name: "three offsets on the same line add their columns",
    map: indexed(
      section(
        0,
        2,
        indexed(section(0, 3, indexed(section(0, 4, leaf("a.ts"))))),
      ),
    ),
    line: 1,
    column: 9,
  },
])("publishes nested coordinates when $name", async ({ map, line, column }) => {
  const text = JSON.stringify(map);
  const result = await fetchMap(text);
  expect(result).toMatchObject({
    status: "included",
    items: [
      {
        artifact: {
          sha256: createHash("sha256").update(text).digest("hex"),
          bytes: Buffer.byteLength(text),
        },
        original_sources: [{ source: `${origin}/a.ts` }],
        mappings: [
          {
            generated_line: line,
            generated_column: column,
            source: `${origin}/a.ts`,
          },
        ],
      },
    ],
  });
});

it.each([
  {
    name: "a following indexed section starts before its first child",
    map: indexed(
      section(0, 0, leaf("a.ts", "AAAA,QAAQ")),
      section(0, 5, indexed(section(0, 6, leaf("b.ts")))),
    ),
  },
  {
    name: "a following indexed section is empty",
    map: indexed(
      section(0, 0, leaf("a.ts", "AAAA,QAAQ")),
      section(0, 5, indexed()),
    ),
  },
  {
    name: "a descendant mapping passes its parent's multiline stop",
    map: indexed(
      section(
        0,
        0,
        indexed(section(1, 3, leaf("a.ts", "AAAA;AACA;AACA;AACA"))),
      ),
      section(3, 1, leaf("b.ts")),
    ),
  },
])("rejects an overlap when $name", async ({ map }) => {
  const text = JSON.stringify(map);
  expect(await fetchMap(text)).toMatchObject({
    status: "unavailable",
    items: [
      {
        status: "invalid",
        artifact: null,
        mappings: [],
        limitation: expect.stringContaining("overlap"),
        response_identity: {
          sha256: createHash("sha256").update(text).digest("hex"),
          bytes: Buffer.byteLength(text),
        },
      },
    ],
  });
});

it("accepts mappings at the next section start and rejects mappings beyond it", async () => {
  const fetchSiblings = (firstMappings: string) =>
    fetchMap(
      JSON.stringify(
        indexed(
          section(0, 0, leaf("a.ts", firstMappings)),
          section(0, 10, leaf("b.ts")),
        ),
      ),
    );

  expect(await fetchSiblings("AAAA,QAAQ")).toMatchObject({
    status: "included",
    items: [
      {
        mappings: [
          { generated_line: 1, generated_column: 0, source: `${origin}/a.ts` },
          { generated_line: 1, generated_column: 8, source: `${origin}/a.ts` },
          { generated_line: 1, generated_column: 10, source: `${origin}/b.ts` },
        ],
      },
    ],
  });
  const text = JSON.stringify(
    indexed(
      section(0, 0, {
        ...leaf("same.ts", "AAAAA,UAAAA", ["first"]),
        sourcesContent: ["export const first = 1;"],
      }),
      section(0, 10, {
        ...leaf("same.ts", "AAAAA", ["second"]),
        sourcesContent: ["export const second = 2;"],
      }),
    ),
  );
  expect(await fetchMap(text)).toMatchObject({
    status: "included",
    items: [
      {
        artifact: {
          sha256: createHash("sha256").update(text).digest("hex"),
          bytes: Buffer.byteLength(text),
        },
        original_sources: [
          { source: `${origin}/same.ts`, declaration_index: 0 },
          { source: `${origin}/same.ts`, declaration_index: 1 },
        ],
        mappings: [
          {
            generated_line: 1,
            generated_column: 0,
            declaration_index: 0,
            name: "first",
          },
          {
            generated_line: 1,
            generated_column: 10,
            declaration_index: 0,
            name: "first",
          },
          {
            generated_line: 1,
            generated_column: 10,
            declaration_index: 1,
            name: "second",
          },
        ],
      },
    ],
  });
  expect(await fetchSiblings("AAAA,UAAA,CAAA")).toMatchObject({
    status: "unavailable",
    items: [
      {
        status: "invalid",
        artifact: null,
        mappings: [],
        limitation: expect.stringContaining("overlap"),
      },
    ],
  });
});
