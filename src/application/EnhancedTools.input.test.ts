import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { AnalysisOperationPort } from "./AnalysisProvider.js";
import { EnhancedTools } from "./EnhancedTools.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { MAX_ENHANCED_RECORDS } from "../contracts/enhancedInputs.js";

describe("EnhancedTools input validation", () => {
  it("rejects an oversized batch_decompile before provider admission", async () => {
    let calls = 0;
    const analysis: AnalysisOperationPort = {
      execute: async () => {
        calls += 1;
        throw new Error("provider must not be called for invalid input");
      },
    };

    const result = await new EnhancedTools(analysis).execute(
      "batch_decompile",
      {
        addresses: Array.from(
          { length: MAX_ENHANCED_RECORDS + 1 },
          () => "0x0",
        ),
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(AnalysisInputError);
    expect(result.error.cause).toBeInstanceOf(z.ZodError);
    expect(calls).toBe(0);
  });
});
