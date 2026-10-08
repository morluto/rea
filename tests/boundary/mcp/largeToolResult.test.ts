import { describe, expect, it } from "vitest";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import { ok } from "../../../src/domain/result.js";
import { toCallToolResult } from "../../../src/server/toolResult.js";
import { EvidenceLedger } from "../../../src/application/investigation/EvidenceLedger.js";

describe("large complete Evidence MCP delivery", () => {
  it("preserves retained content and returns an actionable framing constraint", () => {
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
    const ledger = new EvidenceLedger();
    expect(ledger.record(evidence).ok).toBe(true);
    const result = toCallToolResult(
      ok(evidence),
      toolContract("analyze_javascript_application"),
      { retainedEvidenceId: evidence.evidence_id },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "resource_constraint",
        category: "resource_constraint",
        details: {
          resource: "transport",
          reported_limits: {
            boundary: "mcp-response",
            constraint: "receive-buffer",
            evidence_reference: {
              kind: "retained-evidence",
              evidence_id: evidence.evidence_id,
            },
          },
        },
      },
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(
      STDIO_DEFAULT_MAX_BUFFER_SIZE,
    );
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(result.structuredContent) },
    ]);
    const retained = ledger.get(evidence.evidence_id);
    expect(parseEvidence(retained)).toEqual(evidence);
    expect(retained?.normalized_result).toEqual(normalized);
    const detached = toCallToolResult(
      ok(evidence),
      toolContract("analyze_javascript_application"),
    );
    expect(detached.structuredContent).toMatchObject({
      error: {
        details: { reported_limits: { evidence_id: evidence.evidence_id } },
      },
    });
    expect(JSON.stringify(detached)).not.toContain("retained-evidence");
  });
});
