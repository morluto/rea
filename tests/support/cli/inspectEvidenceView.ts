import { writeFile } from "node:fs/promises";
import { expect } from "vitest";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { analysisViewResultSchema } from "../../../src/domain/analysisView/analysisViewResult.js";
import type { TestCli } from "./cliFixture.js";

export const inspectEvidenceView =
  (cli: TestCli, evidencePath: string, queryPath: string) =>
  async (view: Record<string, unknown>) => {
    await writeFile(
      queryPath,
      JSON.stringify({
        source: { kind: "evidence-file", path: evidencePath },
        view,
      }),
    );
    const result = await cli.run({
      arguments: ["inspect-analysis-view", queryPath, "--json"],
    });
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    return analysisViewResultSchema.parse(
      parseEvidence(result.json).normalized_result,
    );
  };
