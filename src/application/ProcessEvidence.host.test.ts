import { expect, it } from "vitest";

import { emptyUnverifiedProcessCapture } from "../domain/processCapture.fixture.js";
import { parseProcessCapture } from "../domain/processCapture.js";
import { parseProcessScenario } from "../domain/processScenario.js";
import { createProcessCaptureEvidence } from "./ProcessEvidence.js";
import { observeSettlement } from "./ProcessCaptureLifecycle.js";

it("stamps process Evidence from the capture manifest host", () => {
  const scenario = parseProcessScenario({
    executable: process.execPath,
    working_directory: process.cwd(),
    events: [],
  });
  const base = emptyUnverifiedProcessCapture();
  const capture = parseProcessCapture({
    ...base,
    manifest: {
      ...base.manifest,
      platform: "linux",
      architecture: "arm64",
    },
  });

  expect(
    createProcessCaptureEvidence(scenario, capture).environment,
  ).toMatchObject({
    id: "linux-arm64",
    platform: "linux",
    architecture: "arm64",
  });
});

it("uses the selected host platform for process settlement behavior", async () => {
  const events: string[] = [];
  const result = await observeSettlement(
    "run",
    [],
    0,
    (event) => events.push(event),
    "win32",
  );

  expect(result).toEqual({ state: "unverifiable", elapsed_ms: 0 });
  expect(events).toEqual(["lifecycle"]);
});
