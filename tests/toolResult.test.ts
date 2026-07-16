import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { ToolContract } from "../src/contracts/toolContracts.js";
import { ok } from "../src/domain/result.js";
import { err } from "../src/domain/result.js";
import { HopperProcessError } from "../src/domain/errors.js";
import { toCallToolResult } from "../src/server/toolResult.js";
import { createEvidence } from "../src/domain/evidence.js";
import { evidenceResultOf } from "../src/contracts/toolOutputSchemas.js";

const contract: ToolContract = {
  name: "provider_neutral_fixture",
  title: "Provider Neutral Fixture",
  description: "Fixture contract for provider-neutral output validation.",
  kind: "enhanced",
  inputSchema: z.object({}),
  outputSchema: z.object({ value: z.string() }),
  effects: {
    mutatesTarget: false,
    mutatesSession: false,
    writesFilesystem: false,
    launchesProcess: false,
    accessesNetwork: false,
    changesUiState: false,
    mayDiscardData: false,
    idempotent: true,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  examples: [{ title: "Example fixture request", input: {} }],
};

describe("tool result projection", () => {
  it("exposes an actionable adapter code to MCP callers", () => {
    const result = toCallToolResult(err(new HopperProcessError(76)), contract);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "provider_unavailable",
        details: { failure_code: "unsupported_demo_dialog" },
        category: "execution_failure",
      },
    });
    expect(JSON.stringify(result)).not.toContain("expected Hopper");
  });
  it("classifies output contract failures without naming a provider", () => {
    const result = toCallToolResult(ok({ value: 42 }), contract);
    expect(result).toMatchObject({
      structuredContent: {
        error: {
          code: "unreadable_output",
          category: "execution_failure",
          message:
            "Analysis returned an unreadable result. Retry once; if it continues, run `rea doctor`.",
          retryable: false,
          remediation: {
            action:
              "Analysis returned an unreadable result. Retry once; if it continues, run `rea doctor`.",
            restart_required: false,
          },
        },
      },
      isError: true,
    });
    expect(result.content[0]).toEqual({
      type: "text",
      text: JSON.stringify(result.structuredContent),
    });
  });

  it("links successful evidence only when its session resource exists", () => {
    const evidence = createEvidence(
      undefined,
      { id: "fixture", name: "Fixture", version: "1" },
      {
        operation: "fixture",
        parameters: {},
        result: { value: "observed" },
        limitations: [],
      },
    );
    const evidenceContract: ToolContract = {
      ...contract,
      outputSchema: evidenceResultOf(z.object({ value: z.string() })),
    };

    expect(
      toCallToolResult(ok(evidence), evidenceContract).content,
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "resource_link" }),
      ]),
    );
    expect(
      toCallToolResult(ok(evidence), evidenceContract, {
        evidenceResourcesAvailable: true,
      }).content,
    ).toContainEqual(
      expect.objectContaining({
        type: "resource_link",
        uri: `rea://evidence/${evidence.evidence_id}`,
      }),
    );
  });
});
