import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { analysisViewCaptureEvidence } from "../../tests/fixtures/analysisView.js";
import { createApplicationMcpHarness } from "../../tests/fixtures/applicationMcpHarness.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { parseMcpToolError } from "../../tests/fixtures/mcpToolError.js";

/**
 * Issue #8453 is about the delivered MCP error, not only the reader's result. On
 * unmodified `main`, a malformed Evidence file with 125,000 invalid `limitations`
 * values returned `resource_constraint` at the MCP response boundary with an
 * original-error reference and no file path, because the reader projected every
 * validator issue before the response budget applied.
 */
it("delivers a bounded file validation error through inspect_analysis_view", async () => {
  const root = await createTestTempDirectory("rea-mcp-bounded-issues-");
  const source = analysisViewCaptureEvidence();
  const { client } = await createApplicationMcpHarness();
  const inspectFile = async (name: string, document: unknown) => {
    const path = join(root, name);
    await writeFile(path, JSON.stringify(document));
    const result = await client.callTool({
      name: "inspect_analysis_view",
      arguments: {
        source: { kind: "evidence-file", path },
        view: { kind: "summary" },
      },
    });
    const { error } = parseMcpToolError(result);
    expect(error).toMatchObject({ code: "invalid_request", details: { path } });
    return error;
  };

  const many = await inspectFile("many.json", {
    ...source,
    limitations: Array.from({ length: 125_000 }, (_value, index) => index),
  });
  const issues = many.details?.content_issues;
  expect(issues).toEqual(
    expect.arrayContaining([
      { path: ["limitations", 0], reason: "invalid_type", expected: "string" },
      expect.objectContaining({
        path: [],
        message: expect.stringContaining("validator issues were omitted"),
      }),
    ]),
  );
  expect(Buffer.byteLength(JSON.stringify(many), "utf8")).toBeLessThan(1 << 20);

  // Projection may run out of work budget while the exact location still fits.
  const fittingKey = "argument".repeat(1500);
  const fitting = await inspectFile("fitting-key.json", {
    ...source,
    caller_input_paths: { [fittingKey]: false },
  });
  expect(fitting.details?.content_issues).toContainEqual(
    expect.objectContaining({ path: ["caller_input_paths", fittingKey] }),
  );

  const longKey = await inspectFile("oversized-key.json", {
    ...source,
    caller_input_paths: { ["argument".repeat(10_000)]: false },
  });
  expect(longKey.details?.content_issues).toEqual([
    {
      path: ["caller_input_paths"],
      reason: "invalid_value",
      message: expect.stringContaining("nearest parent"),
    },
    expect.objectContaining({
      path: [],
      message: expect.stringContaining("1 of 1 validator issues were omitted"),
    }),
  ]);
});
