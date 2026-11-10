import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { historicalSourceGraphSchema } from "../../src/domain/referenceSourceGraph.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "retains suffix-only source dotfiles through reference import",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-reference-dotfile-cli-");
    const source = 'import {join} from "node:path"; require("./dep.cjs");';
    await Promise.all([
      writeFile(join(root, ".MJS"), source),
      writeFile(join(root, ".TS"), source),
      writeFile(join(root, "dep.cjs"), "module.exports = {};"),
    ]);
    const result = await cli.run({
      arguments: ["import-reference-source", root, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const graph = historicalSourceGraphSchema.parse(result.json);
    for (const [path, language] of [
      [".MJS", "JavaScript"],
      [".TS", "TypeScript"],
    ] as const) {
      expect(graph.entries).toContainEqual(
        expect.objectContaining({
          path,
          language,
          classifications: ["source"],
        }),
      );
      expect(graph.relationships).toContainEqual({
        from_path: path,
        to: "./dep.cjs",
        kind: "requires",
        resolution: "unknown",
        parse_state: "partial",
      });
    }
  },
);
