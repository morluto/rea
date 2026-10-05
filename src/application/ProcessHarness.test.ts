import { expect, it } from "vitest";
import { processScenarioSchema } from "../domain/processScenario.js";
import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import { captureProcessScenario } from "./ProcessHarness.js";
import { settleProcessCaptureJournal } from "./ProcessCaptureLifecycle.js";
import { processCaptureSchema } from "../domain/processCapture.js";
import { EMPTY_PROCESS_CAPTURE_EXAMPLE } from "../domain/processCapture.fixture.js";

it("rejects legacy replay output instead of silently discarding it", () => {
  expect(
    processCaptureSchema.safeParse({
      ...EMPTY_PROCESS_CAPTURE_EXAMPLE,
      protocol_events: [],
    }).success,
  ).toBe(false);
});

it("waits for terminal observations delivered after the exit callback", async () => {
  const journal: Array<{
    capture_order: number;
    collection: "frames";
    index: number;
  }> = [{ capture_order: 0, collection: "frames", index: 0 }];
  const lateFrame = new Promise<void>((resolve) => {
    setTimeout(() => {
      journal.push({ capture_order: 1, collection: "frames", index: 1 });
      resolve();
    }, 12);
  });

  let settled = false;
  const wait = settleProcessCaptureJournal(journal, 20, 200).then(() => {
    settled = true;
  });
  await lateFrame;
  expect(settled).toBe(false);
  await wait;

  expect(journal).toHaveLength(2);
  expect(journal[1]).toMatchObject({ collection: "frames", index: 1 });
});

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
