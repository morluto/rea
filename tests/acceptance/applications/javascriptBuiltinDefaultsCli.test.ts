import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);

it.each([
  "import fs from 'node:fs';",
  "import {default as fs} from 'node:fs';",
])(
  "retains filesystem effects in the public CLI with %s",
  async (declaration) => {
    const root = await createTestTempDirectory("rea-builtin-default-cli-");
    await writeFile(
      join(root, "app.js"),
      `${declaration} const text=fs.readFileSync('config.json','utf8'); const stream=fs.createReadStream('config.json'); stream.destroy();`,
    );
    const { stdout } = await execute(
      process.execPath,
      ["scripts/rea.mjs", "analyze-javascript-application", root, "--json"],
      { cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 },
    );
    const result = javascriptApplicationAnalysisResultSchema.parse(
      parseEvidence(JSON.parse(stdout)).normalized_result,
    );
    expect(result.semantic_graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "config-source",
          properties: expect.objectContaining({ key: "config.json" }),
        }),
        expect.objectContaining({
          kind: "resource",
          properties: expect.objectContaining({ method: "createReadStream" }),
        }),
      ]),
    );
    expect(result.semantic_graph.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relation: "releases",
          resolution: "resolved",
        }),
      ]),
    );
  },
  20_000,
);

it("keeps only direct logical defaults and actual argv elements in the public CLI graph", async () => {
  const root = await createTestTempDirectory("rea-builtin-default-cli-");
  const manyDefaults = Array.from(
    { length: 400 },
    (_, index) =>
      `const value${index} = process.env.KEY_${index} ?? "fallback-${index}";`,
  ).join("\n");
  await writeFile(
    join(root, "app.js"),
    [
      `const chained = process.env.CHAINED ?? "fallback" ?? "unreachable";
const wrapped = ((process.env.WRAPPED)) ?? "wrapped";
const argument = process.argv[2];
const argumentLength = process.argv.length;
const namedArgument = process.argv["02"];
const negativeArgument = process.argv["-1"];
const method = process.argv.map;
const lastArrayIndex = process.argv[4294967294];
const outOfRangeArgument = process.argv[4294967295];
const dynamicArgument = process.argv[process.env.ARGV_INDEX];
function shadowed(process) { return process.argv[3]; }`,
      manyDefaults,
    ].join("\n"),
  );
  const { stdout } = await execute(
    process.execPath,
    ["scripts/rea.mjs", "analyze-javascript-application", root, "--json"],
    { cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 },
  );
  const result = javascriptApplicationAnalysisResultSchema.parse(
    parseEvidence(JSON.parse(stdout)).normalized_result,
  );
  const configSources = result.semantic_graph.nodes.filter(
    ({ kind }) => kind === "config-source",
  );
  const defaults = configSources.filter(
    ({ properties }) => properties.source_kind === "default",
  );
  expect(defaults).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        properties: expect.objectContaining({
          key: "CHAINED",
          value: "fallback",
        }),
      }),
      expect.objectContaining({
        properties: expect.objectContaining({
          key: "WRAPPED",
          value: "wrapped",
        }),
      }),
    ]),
  );
  expect(
    defaults.filter(({ properties }) => properties.key === "CHAINED"),
  ).toHaveLength(1);
  expect(defaults).toHaveLength(402);
  const defaultsByKey = new Map(
    defaults.map(({ properties }) => [properties.key, properties.value]),
  );
  for (let index = 0; index < 400; index += 1)
    expect(defaultsByKey.get(`KEY_${index}`)).toBe(`fallback-${index}`);
  const argvSources = configSources.filter(
    ({ properties }) => properties.source_kind === "argv",
  );
  expect(argvSources).toHaveLength(3);
  expect(argvSources).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        properties: expect.objectContaining({ key: "2" }),
      }),
      expect.objectContaining({
        properties: expect.objectContaining({ key: "4294967294" }),
      }),
      expect.objectContaining({
        properties: expect.objectContaining({ key: null }),
      }),
    ]),
  );
  expect(
    result.semantic_graph.relations
      .filter(({ relation }) => relation === "reads-argv")
      .map(({ resolution }) => resolution),
  ).toEqual(expect.arrayContaining(["resolved", "candidate"]));
  expect(
    result.semantic_graph.relations.filter(
      ({ relation, source_node_id, target_node_id }) => {
        if (relation !== "overrides") return false;
        const source = result.semantic_graph.nodes.find(
          ({ node_id }) => node_id === source_node_id,
        );
        const target = result.semantic_graph.nodes.find(
          ({ node_id }) => node_id === target_node_id,
        );
        return (
          source?.properties.key === "CHAINED" &&
          target?.properties.key === "CHAINED"
        );
      },
    ),
  ).toHaveLength(1);
}, 20_000);
