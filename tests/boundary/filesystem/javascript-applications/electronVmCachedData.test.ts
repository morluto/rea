import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import {
  analyzeJavaScriptApplication,
  reconstructJavaScriptArtifact,
} from "../../../support/javascriptApplicationScope.js";
import { parseEvidence } from "../../../../src/domain/evidence.js";
import { parseJavaScriptApplicationGraph } from "../../../../src/domain/javascript/javascriptApplicationGraph.js";

const WRAPPER = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const cachedData = fs.readFileSync(path.join(__dirname, "preload.bundle.cache"));
new vm.Script(sourcePlaceholder, { cachedData }).runInThisContext();
`;

const vmFixture = async (source: string): Promise<string> => {
  const root = await createTestTempDirectory("rea-electron-vm-cache-");
  await Promise.all([
    writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "rea-electron-vm-cache", main: "main.cjs" }),
    ),
    writeFile(join(root, "main.cjs"), source),
    writeFile(join(root, "preload.bundle.cache"), Buffer.from([0, 1, 2, 255])),
  ]);
  return root;
};

describe("V8 cached data compilation boundaries", () => {
  it("projects an explicit unknown for the bytecode handoff", async () => {
    const result = await reconstructJavaScriptArtifact({
      input_path: await vmFixture(WRAPPER),
    });
    const graph = parseJavaScriptApplicationGraph(result.graph);
    const unknown = graph.nodes.filter(
      ({ kind, observations }) =>
        kind === "unknown" &&
        observations.some(
          ({ properties }) =>
            properties.compilation_boundary === "v8-cached-data",
        ),
    );
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.observations[0]?.properties).toMatchObject({
      api: "vm.Script",
      cached_data_status: "declared",
      cache_path: "preload.bundle.cache",
      resolved_cache_path: null,
      candidate_cache_path: "preload.bundle.cache",
      resolution_status: "unavailable",
      source_expression: "sourcePlaceholder",
    });
    expect(unknown[0]?.observations[0]?.evidence.limitations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("does not establish valid cache bytes"),
      ]),
    );
    expect(
      graph.edges.filter(({ target_node_id: target }) =>
        unknown.some(({ node_id }) => node_id === target),
      ),
    ).toEqual([
      expect.objectContaining({
        relation: "loads",
        properties: expect.objectContaining({ api: "vm.Script" }),
      }),
    ]);
  });

  it("stays silent when compilation has no bytecode cache", async () => {
    const result = await reconstructJavaScriptArtifact({
      input_path: await vmFixture(String.raw`
        const vm = require("node:vm");
        new vm.Script("require('node:fs')").runInThisContext();
        vm.compileFunction("return 1", [], {});
      `),
    });
    const graph = parseJavaScriptApplicationGraph(result.graph);
    expect(
      graph.nodes.filter(({ observations }) =>
        observations.some(
          ({ properties }) =>
            properties.compilation_boundary === "v8-cached-data",
        ),
      ),
    ).toEqual([]);
    expect(graph.limitations.some((note) => note.includes("cachedData"))).toBe(
      false,
    );
  });
});

describe("V8 cached data summary", () => {
  it("counts cachedData declarations without claiming an empty preload", async () => {
    const result = await analyzeJavaScriptApplication({
      input_path: await vmFixture(WRAPPER),
    });
    if (!result.ok) throw result.error;
    expect(parseEvidence(result.value)).toMatchObject({
      normalized_result: {
        summary: expect.objectContaining({ v8_cached_data_compilations: 1 }),
      },
    });
  });
});

it("keeps missing, dynamic and arbitrary cachedData sources distinct", async () => {
  for (const [options, status, path] of [
    [
      '{ cachedData: fs.readFileSync("./missing.cache") }',
      "declared",
      "./missing.cache",
    ],
    ["getOptions()", "unknown", null],
    ['{ cachedData: "./preload.bundle.cache" }', "declared", null],
  ] as const) {
    const root = await vmFixture(
      `const fs = require("node:fs"); const vm = require("node:vm"); new vm.Script("void 0", ${options});`,
    );
    const result = await reconstructJavaScriptArtifact({ input_path: root });
    const graph = parseJavaScriptApplicationGraph(result.graph);
    const observation = graph.nodes
      .flatMap((node) => node.observations)
      .find(
        ({ properties }) =>
          properties.compilation_boundary === "v8-cached-data",
      );
    if (options.includes('cachedData: "'))
      expect(observation?.properties.cache_expression).toBe(
        '"./preload.bundle.cache"',
      );
    expect(observation?.properties).toMatchObject({
      cached_data_status: status,
      cache_path: path,
      resolved_cache_path: null,
    });
  }
});

it("does not resolve a cwd-relative filesystem cache to an inventoried source sibling", async () => {
  const root = await vmFixture(
    `const fs = require("node:fs"); const vm = require("node:vm"); new vm.Script(source, { cachedData: fs.readFileSync("./preload.bundle.cache") });`,
  );
  const result = await reconstructJavaScriptArtifact({ input_path: root });
  const graph = parseJavaScriptApplicationGraph(result.graph);
  const observation = graph.nodes
    .flatMap(({ observations }) => observations)
    .find(
      ({ properties }) => properties.compilation_boundary === "v8-cached-data",
    );
  expect(observation?.properties).toMatchObject({
    cache_path: "./preload.bundle.cache",
    cache_path_base: "literal-path",
    resolved_cache_path: null,
  });
});
