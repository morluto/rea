import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { analyzeWebBundleInputSchema } from "../../../src/domain/webBundleAnalysis.js";
import { fetchWebSourceMapsOk } from "../../fixtures/fetchWebSourceMapsOk.js";

const origin = "https://example.test";
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

const fetchMaps = (...texts: string[]) => {
  const replies = new Map(
    texts.map((text, index) => [`${origin}/map-${index}.js.map`, text]),
  );
  return fetchWebSourceMapsOk(
    [...replies.keys()].map((url, index) => ({
      scriptKey: `scr_${String(index + 1).padStart(64, "0")}`,
      declaredUrl: url,
      fetchUrl: url,
    })),
    input,
    undefined,
    { fetch: async (url) => new Response(replies.get(String(url))) },
  );
};

const identity = (text: string) => ({
  sha256: createHash("sha256").update(text).digest("hex"),
  bytes: Buffer.byteLength(text),
});

it("joins nested generated coordinates to exact declarations across section boundaries", async () => {
  const firstText = "export const first = 1;";
  const secondText = "export const second = 2;";
  const first = {
    ...leaf("same.ts", "AAAAA,QAAAA,EAAAA", ["first"]),
    sourcesContent: [firstText],
  };
  const second = {
    ...leaf("same.ts", "AAAAA", ["second"]),
    sourcesContent: [secondText],
  };
  const text = JSON.stringify(
    indexed(
      section(0, 2, indexed(section(0, 3, indexed(section(0, 4, first))))),
      section(0, 19, second),
      section(5, 10, indexed(section(1, 3, leaf("later-line.ts")))),
    ),
  );
  const shared = `${origin}/same.ts`;
  const later = `${origin}/later-line.ts`;
  const result = await fetchMaps(text);
  expect(result).toMatchObject({
    status: "included",
    items: [
      {
        artifact: identity(text),
        original_sources: [
          {
            source: shared,
            declaration_index: 0,
            artifact: identity(firstText),
          },
          {
            source: shared,
            declaration_index: 1,
            artifact: identity(secondText),
          },
          { source: later, declaration_index: 2 },
        ],
      },
    ],
  });
  // Ordered tuples of line, column, retained declaration, name and source.
  expect(
    result.items[0]?.mappings.map(
      ({
        generated_line,
        generated_column,
        declaration_index,
        name,
        source,
      }) => [generated_line, generated_column, declaration_index, name, source],
    ),
  ).toEqual([
    [1, 9, 0, "first", shared],
    [1, 17, 0, "first", shared],
    [1, 19, 0, "first", shared],
    [1, 19, 1, "second", shared],
    [7, 3, 2, null, later],
  ]);
});

it("rejects overlaps at declared section starts and inherited stops", async () => {
  const beforeNested = section(0, 0, leaf("a.ts", "AAAA,QAAQ"));
  const maps = [
    // The next declared start applies even when its own first child starts later.
    indexed(beforeNested, section(0, 5, indexed(section(0, 6, leaf("b.ts"))))),
    indexed(beforeNested, section(0, 5, indexed())),
    indexed(
      section(
        0,
        0,
        indexed(section(1, 3, leaf("a.ts", "AAAA;AACA;AACA;AACA"))),
      ),
      section(3, 1, leaf("b.ts")),
    ),
    indexed(
      section(0, 0, leaf("a.ts", "AAAA,UAAA,CAAA")),
      section(0, 10, leaf("b.ts")),
    ),
  ];
  const texts = maps.map((map) => JSON.stringify(map));
  expect(await fetchMaps(...texts)).toMatchObject({
    status: "unavailable",
    requested: texts.length,
    processed: texts.length,
    items: texts.map((text, index) => ({
      declared_url: `${origin}/map-${index}.js.map`,
      status: "invalid",
      artifact: null,
      mappings: [],
      limitation: expect.stringContaining("overlap"),
      response_identity: identity(text),
    })),
  });
});

it("rejects each malformed section offset and keeps its response identity", async () => {
  const offsets = [
    { line: 0, column: -1 },
    { line: -1, column: 0 },
    { line: "0", column: 0 },
    { line: 0, column: 0.5 },
    { line: 0 },
    { line: 0, column: Number.MAX_SAFE_INTEGER + 1 },
  ];
  const texts = offsets.map((offset) =>
    JSON.stringify({
      version: 3,
      sections: [{ offset, map: leaf("original.js") }],
    }),
  );
  expect(await fetchMaps(...texts)).toMatchObject({
    status: "unavailable",
    requested: offsets.length,
    processed: offsets.length,
    items: texts.map((text) => ({
      status: "invalid",
      artifact: null,
      mappings: [],
      response_identity: identity(text),
    })),
  });
});
