import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { parseEvidence } from "../../src/domain/evidence.js";
import { javascriptApplicationAnalysisResultSchema } from "../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { JAVASCRIPT_STATIC_FACT_BYTES } from "../../src/domain/javascript/javascriptAnalysisResourceControls.js";
import { javascriptAsyncChunkCapacity } from "../fixtures/javascriptAsyncChunkCapacity.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "reports the complete-fact ceiling for wide async chunk metadata",
  async ({ cli }) => {
    // This bounded public control exceeds the complete-fact allowance. The
    // forked boundary regression separately owns call-argument capacity.
    const { source } = javascriptAsyncChunkCapacity(50_000);
    const root = await createTestTempDirectory("rea-async-chunk-budget-");
    await writeFile(join(root, "entry.cjs"), source);
    const response = await cli.run({
      arguments: [
        "analyze-javascript-application",
        root,
        "--max-semantic-nodes",
        "1",
        "--max-semantic-nodes-per-file",
        "1",
        "--max-heap-mb",
        "2048",
        "--analysis-timeout-ms",
        "30000",
        "--json",
      ],
    });
    // Analysis retains the interrupted file rather than failing the command.
    expect(response.exitCode, `${response.stdout}\n${response.stderr}`).toBe(0);
    const result = javascriptApplicationAnalysisResultSchema.parse(
      parseEvidence(response.json).normalized_result,
    );
    const failures = result.graph.nodes.flatMap(({ observations }) =>
      observations.flatMap(({ properties }) =>
        properties.analysis_failure === undefined
          ? []
          : [properties.analysis_failure],
      ),
    );
    expect(failures).toEqual([
      expect.objectContaining({
        code: "resource_constraint",
        retryable: false,
        message: expect.stringContaining("static checkpoint"),
        remediation: {
          action: expect.stringContaining("no runtime override"),
        },
        details: expect.objectContaining({
          resource: "transport",
          reported_limits: expect.objectContaining({
            checkpoint_bytes: expect.any(Number),
            checkpoint_limit_bytes: JAVASCRIPT_STATIC_FACT_BYTES,
          }),
        }),
      }),
    ]);
    expect(JSON.stringify(failures)).not.toContain("call stack");
    expect(JSON.stringify(failures)).toContain(
      "Raising max_heap_mb does not raise it",
    );
  },
);
