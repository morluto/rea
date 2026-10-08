import { describe, expect, it } from "vitest";
import { z } from "zod";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { toEvidenceToolResult } from "../../../src/server/toolResult.js";

describe("large complete Evidence MCP delivery", () => {
  it("does not claim retention without a recording acknowledgment", () => {
    const normalized = {
      payload: "x".repeat(Math.ceil(STDIO_DEFAULT_MAX_BUFFER_SIZE / 3)),
    };
    const evidence = createEvidence(
      undefined,
      { id: "fixture", name: "Fixture", version: "1" },
      {
        operation: "analyze_javascript_application",
        parameters: {},
        result: normalized,
      },
    );
    const detached = toEvidenceToolResult(
      evidence,
      toolContract("analyze_javascript_application"),
      undefined,
    );
    expect(detached.isError).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(detached))).toBeLessThan(
      STDIO_DEFAULT_MAX_BUFFER_SIZE,
    );
    expect(detached.structuredContent).toMatchObject({
      error: {
        details: { reported_limits: { evidence_id: evidence.evidence_id } },
      },
    });
    const limits = z
      .object({
        error: z.object({
          details: z.object({
            reported_limits: z.record(z.string(), z.unknown()),
          }),
        }),
      })
      .parse(detached.structuredContent).error.details.reported_limits;
    expect(limits).not.toHaveProperty("evidence_reference");
  });
});
