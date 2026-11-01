import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { analysisViewCaptureEvidence } from "../../../tests/fixtures/analysisView.js";
import { createApplicationMcpHarness } from "../../../tests/fixtures/applicationMcpHarness.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import type { Evidence } from "../../domain/evidence.js";

/**
 * Issue #8453 is about the delivered MCP error, not only the reader's result. On
 * unmodified `main`, a malformed Evidence file with 125,000 invalid `limitations`
 * values returned `resource_constraint` at the MCP response boundary with an
 * original-error reference and no file path, because the reader projected every
 * validator issue before the response budget applied.
 */
it("delivers a bounded file validation error through inspect_analysis_view", async () => {
  const root = await createTestTempDirectory("rea-mcp-bounded-issues-");
  const evidencePath = join(root, "many.json");
  const source = structuredClone(analysisViewCaptureEvidence());
  const document = {
    ...source,
    limitations: Array.from({ length: 125_000 }, (_value, index) => index),
  } as unknown as Evidence;
  await writeFile(evidencePath, JSON.stringify(document));

  const { client } = await createApplicationMcpHarness();
  const result = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: { kind: "evidence-file", path: evidencePath },
      view: { kind: "summary" },
    },
  });

  expect(result.isError).toBe(true);
  const text = (result.content as readonly { type: string; text?: string }[])
    .flatMap(({ type, text: value }) =>
      type === "text" && value !== undefined ? [value] : [],
    )
    .join("");
  // The typed file error and the selected path survive the response boundary.
  const delivered = JSON.parse(text) as {
    error?: {
      code?: string;
      details?: {
        path?: string;
        content_issues?: readonly {
          path?: readonly (string | number)[];
          reason?: string;
          message?: string;
        }[];
      };
    };
  };
  expect(delivered.error?.code).toBe("invalid_request");
  expect(delivered.error?.details?.path).toBe(evidencePath);
  const issues = delivered.error?.details?.content_issues ?? [];
  // Bounded rather than all 125,000, and explicitly incomplete.
  expect(issues.length).toBeGreaterThan(0);
  expect(issues.length).toBeLessThan(1_000);
  expect(issues).toContainEqual(
    expect.objectContaining({
      path: [],
      message: expect.stringContaining("validator issues were omitted"),
    }),
  );
  // The whole delivered response stays well inside the default MCP budget.
  expect(Buffer.byteLength(text, "utf8")).toBeLessThan(1 << 20);
});
