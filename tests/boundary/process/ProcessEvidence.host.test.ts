import { expect, it } from "vitest";

import { emptyUnverifiedProcessCapture } from "../../../src/domain/process/processCapture.fixture.js";
import { parseProcessCapture } from "../../../src/domain/process/processCapture.js";
import { parseProcessScenario } from "../../../src/domain/process/processScenario.js";
import { createProcessCaptureEvidence } from "../../../src/application/process/ProcessEvidence.js";
import { observeSettlement } from "../../../src/process/capture/ProcessCaptureLifecycle.js";

it.each([
  ["win32", "program.exe"],
  ["linux", "directory\\program.exe"],
  ["darwin", "directory\\program.exe"],
] as const)(
  "interprets the executable name using the captured %s host",
  (platform, expectedName) => {
    const scenario = parseProcessScenario({
      executable: "/fixtures/directory\\program.exe",
      working_directory: process.cwd(),
      events: [],
    });
    const base = emptyUnverifiedProcessCapture();
    const capture = parseProcessCapture({
      ...base,
      manifest: { ...base.manifest, platform },
    });
    expect(
      createProcessCaptureEvidence(scenario, capture).parameters
        .executable_name,
    ).toBe(expectedName);
  },
);

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
