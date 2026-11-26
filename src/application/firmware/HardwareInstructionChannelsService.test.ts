import { describe, expect, it } from "vitest";
import { inspectProcedureHardwareInstructions } from "./HardwareInstructionChannelsService.js";
import { ok } from "../../domain/result.js";
import {
  createAnalysisExecution,
  type AnalysisOperationPort,
} from "../../ports/AnalysisProvider.js";

const MOCK_PROVIDER = {
  id: "mock",
  name: "Mock Provider",
  version: "1",
} as const;

describe("inspectProcedureHardwareInstructions service", () => {
  it("composes read_function_instructions and preserves provider limitations", async () => {
    const port: AnalysisOperationPort = {
      execute: async (operation, args) => {
        expect(operation).toBe("read_function_instructions");
        expect(args).toEqual({ procedure: "Reset_Handler" });
        return ok(
          createAnalysisExecution(
            {
              procedure: {
                name: "Reset_Handler",
                address: "0x08000100",
                classification: null,
                body: { available: false, reason: "fixture" },
              },
              instructions: [
                "0x08000100: cpsid i",
                "0x08000102: msr msp, r0",
                "0x08000106: isb",
              ],
              limitations: ["Ghidra terminal-call truncation possible."],
            },
            MOCK_PROVIDER,
          ),
        );
      },
    };

    const res = await inspectProcedureHardwareInstructions(port, {
      procedure: "Reset_Handler",
      hardware_architecture: "arm",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.matched_instruction_count).toBe(3);
    expect(res.value.summary.distinct_targets).toEqual(["CPS:I", "MSP"]);
    expect(res.value.limitations).toContain(
      "Ghidra terminal-call truncation possible.",
    );
  });

  it("returns AnalysisOutputError when provider output violates functionInstructionWindowSchema", async () => {
    const port: AnalysisOperationPort = {
      execute: async () =>
        ok(createAnalysisExecution({ unexpected: true }, MOCK_PROVIDER)),
    };

    const res = await inspectProcedureHardwareInstructions(port, {
      procedure: "bad_fn",
      hardware_architecture: "riscv",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error._tag).toBe("AnalysisOutputError");
  });
});
