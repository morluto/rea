import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascriptApplicationAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);

it("resolves public CLI default-parameter calls outside the body environment", async () => {
  const root = await createTestTempDirectory("rea-parameter-environment-cli-");
  await writeFile(
    join(root, "app.js"),
    `function helper(){return 'OUTER'}
function run(value=helper()) {
  function helper(){return 'INNER'}
  const body=helper();
  return value;
}
export const actual=run();`,
  );
  const { stdout } = await execute(
    process.execPath,
    ["scripts/rea.mjs", "analyze-javascript-application", root, "--json"],
    { cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 },
  );
  const result = javascriptApplicationAnalysisResultSchema.parse(
    parseEvidence(JSON.parse(stdout)).normalized_result,
  );
  const graph = result.semantic_graph;
  const targetLines = graph.relations
    .filter(({ relation }) => relation === "calls")
    .map((relation) => ({
      call: graph.nodes.find(
        ({ node_id }) => node_id === relation.source_node_id,
      )?.identity.source_range?.start.line,
      target: graph.nodes.find(
        ({ node_id }) => node_id === relation.target_node_id,
      )?.identity.source_range?.start.line,
    }));
  expect(targetLines).toEqual(
    expect.arrayContaining([
      { call: 2, target: 1 },
      { call: 4, target: 3 },
    ]),
  );
}, 20_000);
