import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import { unsupportedTarget } from "../../../src/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { BinaryTargetError } from "../../../src/domain/configurationErrors.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";

const CLI_ISSUE_REPORT_URL = "https://github.com/morluto/rea/issues";

const delivery = createToolResultDelivery(STDIO_DEFAULT_MAX_BUFFER_SIZE);

describe("MCP error delivery excludes CLI-only issue hints", () => {
  it.each([
    {
      name: "unsupported_target",
      error: unsupportedTarget(
        "inspect-target",
        "/tmp/sample.bin",
        "fixture",
        "Container format is unsupported.",
      ),
      expectedCode: "unsupported_target",
    },
    {
      name: "target_unavailable",
      error: new BinaryTargetError("/tmp/missing.bin", "missing", {
        remediationAction: "Check that the file exists.",
      }),
      expectedCode: "target_unavailable",
    },
    {
      name: "file_format_rejected",
      error: new BinaryTargetError("/tmp/unknown.bin", "refused", {
        constraint: "file_format_rejected",
        remediationAction: "Provide a supported binary format.",
      }),
      expectedCode: "target_unavailable",
    },
  ])(
    "emits no GitHub issue URL in MCP toErrorToolResult or AnalysisErrorProjection for $name",
    ({ error, expectedCode }) => {
      const projection = projectAnalysisError(error);
      expect(projection.code).toBe(expectedCode);
      expect(JSON.stringify(projection)).not.toContain(CLI_ISSUE_REPORT_URL);

      const toolResult = delivery.toErrorToolResult(error, false);
      expect(toolResult.isError).toBe(true);
      const serialized = JSON.stringify(toolResult);
      expect(serialized).toContain(expectedCode);
      expect(serialized).not.toContain(CLI_ISSUE_REPORT_URL);
      expect(serialized).not.toContain("github.com/morluto/rea/issues");
    },
  );
});
