import { expect, it } from "vitest";

import { parseProcessScenario } from "../../../src/domain/processScenario.js";
import {
  createRunManifest,
  observeSettlement,
} from "../../../src/application/ProcessCaptureLifecycle.js";

it("uses one selected host identity for manifest and settlement", async () => {
  const scenario = parseProcessScenario({
    executable: process.execPath,
    working_directory: process.cwd(),
    events: [],
  });
  const selectedHost = {
    platform: "win32" as const,
    architecture: "arm64" as const,
  };
  const manifest = await createRunManifest(
    scenario,
    new Date(0),
    new Date(1),
    selectedHost,
  );
  const settlement = await observeSettlement(
    "run",
    [],
    0,
    () => undefined,
    selectedHost.platform,
  );

  expect(manifest).toMatchObject(selectedHost);
  expect(settlement).toEqual({ state: "unverifiable", elapsed_ms: 0 });
});
