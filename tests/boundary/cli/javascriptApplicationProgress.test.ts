import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";
import { z } from "zod";

import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { analyzeJavaScriptApplication } from "../../../src/application/javascript/JavaScriptApplicationService.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const progressLine = z.object({
  rea_progress: z.object({
    phase: z.string(),
    completed: z.number(),
    total: z.number().nullable(),
    message: z.string(),
    sequence: z.number(),
    terminal: z.boolean().optional(),
  }),
});

for (const command of ["analyze-javascript-application", "analyze"]) {
  cliTest(
    `${command} reports real analysis phases on stderr and preserves stdout Evidence`,
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-js-cli-progress-");
      await writeFile(join(root, "main.js"), "fetch('');\n");
      const direct = await analyzeJavaScriptApplication({ input_path: root });
      if (!direct.ok) throw direct.error;

      const output = await cli.run({ arguments: [command, root, "--json"] });
      expect(output.exitCode).toBe(0);
      expect(parseEvidence(output.json).evidence_id).toBe(
        direct.value.evidence_id,
      );
      const updates = output.stderr
        .trim()
        .split("\n")
        .map((line) => progressLine.parse(JSON.parse(line)).rea_progress);
      expect(updates[0]?.completed).toBe(0);
      expect(
        updates.some(({ phase }) => phase === "parse_javascript_sources"),
      ).toBe(true);
      expect(updates.at(-1)).toMatchObject({ completed: 1, terminal: true });
      expect(
        updates.slice(0, -1).every(({ terminal }) => terminal !== true),
      ).toBe(true);
    },
  );
}

cliTest(
  "keeps a failed analysis distinct from a completed result",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-js-cli-progress-failure-");
    const output = await cli.run({
      arguments: [
        "analyze-javascript-application",
        join(root, "absent"),
        "--json",
      ],
    });
    expect(output.json).toMatchObject({ code: "artifact_operation_failed" });
    const updates = output.stderr
      .trim()
      .split("\n")
      .map((line) => progressLine.parse(JSON.parse(line)).rea_progress);
    expect(updates[0]?.completed).toBe(0);
    expect(updates.every(({ terminal }) => terminal !== true)).toBe(true);
  },
);

for (const extension of ["mts", "cts"]) {
  for (const command of ["analyze-javascript-application", "analyze"]) {
    cliTest(
      `${command} returns facts for a selected ${extension} source`,
      async ({ cli }) => {
        const root = await createTestTempDirectory("rea-nodenext-cli-");
        const path = `selected.${extension}`;
        await writeFile(
          join(root, path),
          "export function selected_feature(value: string) { return { value }; }",
        );
        const output = await cli.run({ arguments: [command, root, "--json"] });
        expect(output.exitCode).toBe(0);
        const evidence = parseEvidence(output.json);
        const result = javascriptApplicationAnalysisResultSchema.parse(
          evidence.normalized_result,
        );
        expect(result.statistics).toMatchObject({
          relevant_files: 1,
          parsed_javascript_files: 1,
          parse_failures: 0,
        });
        expect(
          result.graph.nodes.some(
            ({ kind, observations }) =>
              kind === "javascript-asset" &&
              observations.some(({ properties }) => properties.path === path),
          ),
        ).toBe(true);
      },
    );
  }
}
