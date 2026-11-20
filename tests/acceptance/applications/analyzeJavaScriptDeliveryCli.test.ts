import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { parseEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { writeJavaScriptSourceSelectionFixture } from "../../fixtures/javascriptSourceSelection.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "delivers analyze's JavaScript summary beside its complete bundle",
  async ({ cli }) => {
    const directory = await createTestTempDirectory("rea-analyze-js-summary-");
    await writeJavaScriptSourceSelectionFixture(directory);
    const destination = join(
      await createTestTempDirectory("rea-analyze-js-bundle-"),
      "analysis.json",
    );
    const response = await cli.run({
      arguments: [
        "analyze",
        directory,
        "--source-path",
        "main.mjs",
        "--max-semantic-nodes",
        "5000",
        "--detail",
        "summary",
        "--evidence_output",
        destination,
        "--format",
        "json",
      ],
    });
    expect(response.exitCode, response.stdout).toBe(0);
    const bytes = await readFile(destination);
    const [parent] = parseEvidenceBundle(JSON.parse(bytes.toString())).records;
    expect(parent).toMatchObject({
      operation: "analyze_javascript_application",
      parameters: { source_paths: ["main.mjs"], max_semantic_nodes: 5000 },
    });
    const { summary, evidence_bundle: receipt } = response.json as {
      summary: unknown;
      evidence_bundle: unknown;
    };
    expect(receipt).toEqual({ path: destination, bytes: bytes.length });
    expect(parseEvidence(summary).evidence_links).toEqual([
      parent?.evidence_id,
    ]);
  },
);

cliTest(
  "refuses a JavaScript budget for a native analyze target by its CLI key",
  async ({ cli }) => {
    const directory = await createTestTempDirectory("rea-analyze-js-native-");
    await writeJavaScriptSourceSelectionFixture(directory);
    const response = await cli.run({
      arguments: [
        "analyze",
        directory,
        "--provider",
        "ghidra",
        "--max-semantic-nodes",
        "5000",
        "--format",
        "json",
      ],
    });
    expect(response.exitCode).toBe(1);
    expect(response.json).toMatchObject({
      code: "invalid_request",
      details: {
        issues: [{ path: ["maxSemanticNodes"], reason: "invalid_value" }],
      },
    });
  },
);
