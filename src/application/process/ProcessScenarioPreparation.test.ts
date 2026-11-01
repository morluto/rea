import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { processScenarioSchema } from "../../domain/process/processScenario.js";
import { ok, type Result } from "../../domain/result.js";
import { prepareProcessScenarioPlan } from "./ProcessScenarioPreparation.js";

it("rejects observation roots that capture admission rejects", async () => {
  const root = await createTestTempDirectory("rea-process-plan-");
  const file = join(root, "selected");
  await writeFile(file, "not a directory");
  const scenario = processScenarioSchema.parse({
    executable: process.execPath,
    working_directory: root,
    filesystem_observation_paths: [join(file, "child")],
  });

  const prepared = await prepareProcessScenarioPlan(
    scenario,
    {},
    process.platform,
  );

  expect(prepared.ok).toBe(false);
  if (prepared.ok) return;
  expect(prepared.error).toMatchObject({
    _tag: "ProcessCaptureError",
    userMessage: "filesystem observation admission failed",
  });
});

it("reports cancellation after the last awaited admission step", async () => {
  const scenario = processScenarioSchema.parse({
    executable: process.execPath,
    working_directory: ".",
  });
  const controller = new AbortController();
  let release!: () => void;
  const pendingAdmission = new Promise<Result<void, AnalysisError>>(
    (resolve) => {
      release = () => resolve(ok(undefined));
    },
  );

  const planning = prepareProcessScenarioPlan(
    scenario,
    {},
    process.platform,
    controller.signal,
    { admitRoots: () => pendingAdmission },
  );
  controller.abort("caller stopped planning");
  release();

  const prepared = await planning;
  expect(prepared.ok).toBe(false);
  if (prepared.ok) return;
  expect(prepared.error._tag).toBe("AnalysisCancelledError");
  expect(prepared.error).toMatchObject({ cause: "caller stopped planning" });
});
