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

describe("V8 cached data execution boundaries", () => {
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
            properties.execution_boundary === "v8-cached-data",
        ),
    );
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.observations[0]?.properties).toMatchObject({
      api: "vm.Script",
      execution: "cached-data",
      cache_path: "preload.bundle.cache",
      resolved_cache_path: "preload.bundle.cache",
      source_expression: "sourcePlaceholder",
    });
    expect(unknown[0]?.observations[0]?.evidence.limitations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("opaque cachedData bytecode"),
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
            properties.execution_boundary === "v8-cached-data",
        ),
      ),
    ).toEqual([]);
  });
});

describe("V8 cached data summary", () => {
  it("counts cachedData executions without claiming an empty preload", async () => {
    const result = await analyzeJavaScriptApplication({
      input_path: await vmFixture(WRAPPER),
    });
    if (!result.ok) throw result.error;
    expect(parseEvidence(result.value)).toMatchObject({
      normalized_result: {
        summary: expect.objectContaining({ v8_cached_data_executions: 1 }),
      },
    });
  });
});
