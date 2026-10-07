import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascriptApplicationAnalysis.js";
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
