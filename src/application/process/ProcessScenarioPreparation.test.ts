import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as filesystemSnapshot from "../../process/capture/FilesystemSnapshot.js";

import { awaitAcknowledgement } from "../../../tests/fixtures/lifecycleAcknowledgement.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { processScenarioSchema } from "../../domain/process/processScenario.js";
import { err, ok, type Result } from "../../domain/result.js";
import { ProcessCaptureError } from "../../process/capture/ProcessCaptureError.js";
import { prepareProcessScenarioPlan } from "./ProcessScenarioPreparation.js";

afterEach(() => vi.restoreAllMocks());

/**
 * Windows refuses capture before root admission runs. The cancellation cases
 * replace admission, so they plan for a platform that reaches it on any host.
 */
const capturePlatform = "linux";

// A path below a regular file is ENOTDIR on POSIX. Windows reports ENOENT,
// which admission accepts as a root the scenario may create.
it.skipIf(process.platform === "win32")(
  "rejects observation roots that capture admission rejects",
  async () => {
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
  },
);

it("reports cancellation normalized inside admission as planning cancellation", async () => {
  const scenario = processScenarioSchema.parse({
    executable: process.execPath,
    working_directory: ".",
  });
  const controller = new AbortController();
  vi.spyOn(
    filesystemSnapshot,
    "admitFilesystemObservationRoots",
  ).mockImplementationOnce(() => {
    controller.abort("caller stopped during admission");
    return Promise.resolve(
      err(
        new ProcessCaptureError("filesystem observation admission failed", {
          cause: controller.signal.reason,
        }),
      ),
    );
  });
  const prepared = await prepareProcessScenarioPlan(
    scenario,
    {},
    capturePlatform,
    controller.signal,
  );

  expect(prepared.ok).toBe(false);
  if (prepared.ok) return;
  expect(prepared.error._tag).toBe("AnalysisCancelledError");
  expect(prepared.error).toMatchObject({
    cause: "caller stopped during admission",
  });
});

it("reports cancellation after the last awaited admission step", async () => {
  const scenario = processScenarioSchema.parse({
    executable: process.execPath,
    working_directory: ".",
  });
  const controller = new AbortController();
  let admissionEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    admissionEntered = resolve;
  });
  let release!: () => void;
  const pendingAdmission = new Promise<Result<void, AnalysisError>>(
    (resolve) => {
      release = () => resolve(ok(undefined));
    },
  );
  let admissionCalls = 0;

  vi.spyOn(
    filesystemSnapshot,
    "admitFilesystemObservationRoots",
  ).mockImplementationOnce(() => {
    admissionCalls += 1;
    admissionEntered();
    return pendingAdmission;
  });
  const planning = prepareProcessScenarioPlan(
    scenario,
    {},
    capturePlatform,
    controller.signal,
  );

  // Abort only once admission is actually running. Aborting earlier would be
  // observed by the pre-admission check and would leave the post-admission
  // check untested.
  try {
    await awaitAcknowledgement(entered, planning, "root admission");
    expect(admissionCalls).toBe(1);
    expect(controller.signal.aborted).toBe(false);
    controller.abort("caller stopped after admission");

    // Admission still succeeds after the abort, so only the check that runs
    // after it can turn the planning result into a cancellation.
  } finally {
    release();
    await planning;
  }

  const prepared = await planning;
  expect(admissionCalls).toBe(1);
  expect(prepared.ok).toBe(false);
  if (prepared.ok) return;
  expect(prepared.error._tag).toBe("AnalysisCancelledError");
  expect(prepared.error).toMatchObject({
    cause: "caller stopped after admission",
  });
});
