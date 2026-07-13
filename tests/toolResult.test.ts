import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { ToolContract } from "../src/contracts/toolContracts.js";
import { ok } from "../src/domain/result.js";
import { err } from "../src/domain/result.js";
import { HopperProcessError } from "../src/domain/errors.js";
import { toCallToolResult } from "../src/server/toolResult.js";

const contract: ToolContract = {
  name: "provider_neutral_fixture",
  description: "Fixture contract for provider-neutral output validation.",
  kind: "enhanced",
  inputSchema: z.object({}),
  outputSchema: z.object({ value: z.string() }),
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
        code: "unsupported_demo_dialog",
        category: "execution_failure",
      },
    });
    expect(JSON.stringify(result)).not.toContain("expected Hopper");
  });
  it("classifies output contract failures without naming a provider", () => {
    expect(toCallToolResult(ok({ value: 42 }), contract)).toEqual({
      content: [
        {
          type: "text",
          text: "Analysis returned an unreadable result. Retry once; if it continues, run `rea doctor`.",
        },
      ],
      structuredContent: {
        error: {
          category: "execution_failure",
          message:
            "Analysis returned an unreadable result. Retry once; if it continues, run `rea doctor`.",
        },
      },
      isError: true,
    });
  });
});
