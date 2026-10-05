import { expect, it } from "vitest";
import { processScenarioSchema } from "../domain/processScenario.js";
import { AnalysisCapabilityUnavailableError } from "../domain/errors.js";
import { captureProcessScenario } from "./ProcessHarness.js";

it("fails closed on Windows before resolving or launching scenario paths", async () => {
  const scenario = processScenarioSchema.parse({
    executable: "Z:/missing/should-never-be-resolved.exe",
    working_directory: "Z:/missing/working-directory",
  });
  const result = await captureProcessScenario(scenario, undefined, "win32");
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected Windows ownership refusal");
  expect(result.error).toBeInstanceOf(AnalysisCapabilityUnavailableError);
  expect(result.error).toMatchObject({
    operation: "capture_process_scenario",
    reason: expect.stringContaining("Windows process-tree ownership"),
  });
});
