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

it("keeps external indexed sections unsupported while retaining local siblings", async () => {
  const url = "https://app.test/maps/part.map";
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
          mappings: "AAAA",
        },
      },
      { offset: { line: 1, column: 0 }, url },
      {
        offset: { line: 2, column: 0 },
        url: 42,
        map: {
          version: 3,
          sources: ["ignored.ts"],
          sourcesContent: ["export const ignored = 0;"],
          names: [],
          mappings: "AAAA",
        },
      },
      {
        offset: { line: 3, column: 0 },
        map: {
          version: 3,
          sources: ["after.ts"],
          sourcesContent: ["export const after = 2;"],
          names: [],
          mappings: "AAAA",
        },
      },
    ],
  });
  const graph = await analyzeMaps({ "indexed.js.map": mapText });
  const digest = createHash("sha256").update(mapText).digest("hex");
  const limitation =
    `Indexed source-map section at [2]: External source-map section URL must be a string.; ` +
    `External source-map section URL is not fetched: ${url}`;
  expect(graph.coverage.status).toBe("partial");
  expect(graph.nodes).toContainEqual(
    expect.objectContaining({
      kind: "unknown",
      observations: expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            path: "indexed.js.map",
            operation: "parse-local-source-map",
            external_sections: [{ section_path: [1], url }],
            invalid_sections: [
              {
                section_path: [2],
                reason: expect.stringMatching(
                  /section URL.*must be a string/iu,
                ),
              },
            ],
          }),
          evidence: expect.objectContaining({
            artifact: expect.objectContaining({ sha256: digest }),
            limitations: [limitation],
          }),
        }),
      ]),
    }),
  );
  for (const [source, content] of [
    ["before.ts", "export const before = 1;"],
    ["after.ts", "export const after = 2;"],
  ] as const) {
    expect(graph.nodes).toContainEqual(
      expect.objectContaining({
        kind: "source-module",
        identity: expect.objectContaining({
          source_map_sha256: digest,
          original_source: source,
          source_sha256: createHash("sha256").update(content).digest("hex"),
        }),
      }),
    );
  }
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
