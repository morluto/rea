import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { analyzeJavaScriptApplication } from "../../../support/javascriptApplicationScope.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../../src/domain/javascript/javascriptApplicationAnalysis.js";

const analyzeMaps = async (maps: Readonly<Record<string, string>>) => {
  const root = await createTestTempDirectory("rea-app-source-map-mappings-");
  await Promise.all(
    Object.entries(maps).map(([path, text]) =>
      writeFile(join(root, path), text),
    ),
  );
  const result = await analyzeJavaScriptApplication({
    input_path: root,
    format: "directory",
  });
  if (!result.ok) throw result.error;
  const analysis = javascriptApplicationAnalysisResultSchema.parse(
    result.value.normalized_result,
  );
  return analysis.graph;
};

it("keeps nested declarations and exact section diagnostics across external and malformed siblings", async () => {
  const url = "https://app.test/maps/part.map";
  const original = (source: string, content: string) => ({
    version: 3,
    sources: [source] as const,
    sourcesContent: [content] as const,
    names: [],
    mappings: "AAAA",
  });
  const before = original("before.ts", "export const before = 1;");
  const middle = original("middle.ts", "export const middle = 2;");
  const after = original("after.ts", "export const after = 3;");
  const retained = [
    [before, [0, 0]],
    [middle, [0, 3]],
    [after, [3]],
  ] as const;
  const indexed = [
    {
      offset: { line: 0, column: 0 },
      map: {
        version: 3,
        sections: [
          {
            offset: { line: 0, column: 0 },
            map: before,
          },
          {
            offset: { line: 1, column: 0 },
            url: `${url}/nested`,
            map: original("ignored.ts", "0"),
          },
          { offset: { line: 2, column: 0 } },
          {
            offset: { line: 3, column: 0 },
            map: middle,
          },
        ],
      },
    },
    { offset: { line: 4, column: 0 }, url },
    {
      offset: { line: 5, column: 0 },
      url: 42,
      map: original("ignored.ts", "0"),
    },
    {
      offset: { line: 6, column: 0 },
      map: after,
    },
  ];
  const mapText = JSON.stringify({ version: 3, sections: indexed });
  const graph = await analyzeMaps({ "indexed.js.map": mapText });
  const digest = createHash("sha256").update(mapText).digest("hex");
  const invalid_sections = [
    {
      section_path: [0, 2],
      reason:
        "Indexed source-map section requires an embedded map or external URL.",
    },
    {
      section_path: [2],
      reason: "External source-map section URL must be a string.",
    },
  ];
  const external_sections = [
    { section_path: [0, 1], url: `${url}/nested` },
    { section_path: [1], url },
  ];
  const limitation = [
    ...invalid_sections.map(
      ({ section_path, reason }) =>
        `Indexed source-map section at [${section_path.join(",")}]: ${reason}`,
    ),
    ...external_sections.map(
      ({ url }) => `External source-map section URL is not fetched: ${url}`,
    ),
  ].join("; ");
  expect(graph.coverage.status).toBe("partial");
  expect(graph.nodes).toContainEqual(
    expect.objectContaining({
      kind: "unknown",
      observations: expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            path: "indexed.js.map",
            operation: "parse-local-source-map",
            external_sections,
            invalid_sections,
          }),
          evidence: expect.objectContaining({
            artifact: expect.objectContaining({ sha256: digest }),
            limitations: [limitation],
          }),
        }),
      ]),
    }),
  );
  const originals = graph.nodes.filter(
    ({ identity }) => identity.strategy === "source-map-original",
  );
  expect(originals).toHaveLength(retained.length);
  for (const [declaration_index, [map, section_path]] of retained.entries())
    expect(originals).toContainEqual(
      expect.objectContaining({
        kind: "source-module",
        identity: expect.objectContaining({
          source_map_sha256: digest,
          original_source: map.sources[0],
          source_sha256: createHash("sha256")
            .update(map.sourcesContent[0])
            .digest("hex"),
        }),
        observations: expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              declaration_index,
              section_path,
              source_index: 0,
            }),
          }),
        ]),
      }),
    );
});

it("marks non-array sections malformed even when the object has regular-map fields", async () => {
  const mapText = JSON.stringify({
    version: 3,
    sections: null,
    sources: ["must-not-be-read.ts"],
    sourcesContent: ["export const value = 1;"],
    names: [],
    mappings: "AAAA",
  });
  const graph = await analyzeMaps({ "malformed.js.map": mapText });
  const digest = createHash("sha256").update(mapText).digest("hex");

  expect(graph.coverage.status).toBe("partial");
  expect(graph.nodes).toContainEqual(
    expect.objectContaining({
      kind: "unknown",
      observations: expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            path: "malformed.js.map",
            operation: "parse-local-source-map",
            invalid_sections: [
              {
                section_path: [],
                reason: expect.stringMatching(/sections.*must be an array/iu),
              },
            ],
          }),
          evidence: expect.objectContaining({
            artifact: expect.objectContaining({ sha256: digest }),
            limitations: [
              expect.stringMatching(
                /section at \[\].*sections.*must be an array/iu,
              ),
            ],
          }),
        }),
      ]),
    }),
  );
  expect(
    graph.nodes.some(
      (node) =>
        node.identity.strategy === "source-map-original" &&
        node.identity.source_map_sha256 === digest,
    ),
  ).toBe(false);
});

it("retains safe declarations and section diagnostics across malformed leaves", async () => {
  const mapText = JSON.stringify({
    version: 3,
    sections: [
      {
        offset: { line: 0, column: 0 },
        map: {
          version: 3,
          sources: ["before.ts"],
          sourcesContent: ["export const before = 1;"],
          names: [],
          mappings: "",
        },
      },
      {
        offset: { line: 1, column: 0 },
        map: {
          version: 3,
          sourceRoot: 42,
          sources: ["unknown-root.ts"],
          sourcesContent: ["export const unknownRoot = 2;"],
          names: [],
          mappings: "AAAA",
        },
      },
      {
        offset: { line: 2, column: 0 },
        map: {
          version: 3,
          sources: ["content.ts"],
          sourcesContent: [42],
          names: [],
          mappings: "AAAA",
        },
      },
      {
        offset: { line: 3, column: 0 },
        map: {
          version: 3,
          sources: [42, "valid-entry.ts"],
          sourcesContent: [null, "export const validEntry = 3;"],
          names: [],
          mappings: "AAAA",
        },
      },
      {
        offset: { line: 4, column: 0 },
        map: { version: 3, sourcesContent: [], names: [], mappings: "AAAA" },
      },
      {
        offset: { line: 5, column: 0 },
        map: {
          version: 3,
          sources: ["no-mappings.ts"],
          sourcesContent: ["export const noMappings = 4;"],
          names: [],
        },
      },
      {
        offset: { line: 6, column: 0 },
        map: {
          version: 3,
          sources: ["after.ts"],
          sourcesContent: ["export const after = 4;"],
          names: [],
          mappings: "AAAA",
        },
      },
    ],
  });
  const graph = await analyzeMaps({
    "indexed-malformed-values.js.map": mapText,
  });
  const digest = createHash("sha256").update(mapText).digest("hex");
  const limitation = [
    "Source map sourceRoot must be a string or null in section [1].",
    "Source map sourcesContent must be an array of strings or null entries in section [2].",
    "Source map contains a non-string source name at index 0 in section [3].",
    "Source map has no sources array in section [4].",
    "Source map has no mappings string in section [5].",
  ].join("; ");

  expect(graph.coverage.status).toBe("partial");
  expect(graph.nodes).toContainEqual(
    expect.objectContaining({
      kind: "unknown",
      observations: expect.arrayContaining([
        expect.objectContaining({
          evidence: expect.objectContaining({
            artifact: expect.objectContaining({ sha256: digest }),
            limitations: [limitation],
          }),
        }),
      ]),
    }),
  );
  const originals = graph.nodes.filter(
    ({ identity }) => identity.strategy === "source-map-original",
  );
  expect(originals).toHaveLength(5);
  const retained = [
    ["before.ts", [0], "export const before = 1;", 0],
    ["content.ts", [2], null, 0],
    ["valid-entry.ts", [3], "export const validEntry = 3;", 1],
    ["no-mappings.ts", [5], "export const noMappings = 4;", 0],
    ["after.ts", [6], "export const after = 4;", 0],
  ] as const;
  for (const [
    declaration_index,
    [source, section_path, content, source_index],
  ] of retained.entries())
    expect(originals).toContainEqual(
      expect.objectContaining({
        kind: "source-module",
        identity: expect.objectContaining({
          source_map_sha256: digest,
          original_source: source,
          source_sha256:
            content === null
              ? null
              : createHash("sha256").update(content).digest("hex"),
        }),
        observations: expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              section_path,
              source_index,
              declaration_index,
            }),
            evidence: expect.objectContaining({ limitations: [limitation] }),
          }),
        ]),
      }),
    );
});
