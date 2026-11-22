import { access } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

import { AnalysisOutputError } from "../domain/analysisErrorCore.js";
import { ProcessOwnershipInspectionCancelled } from "./ProcessInspectionCancellation.js";
import { systemProcessOwnershipHost } from "./ProcessOwnershipObservation.js";
import { spawnOwnedProviderProcess } from "./ProviderProcess.js";

it("wraps an opaque non-cancellation analysis error at already-aborted spawn admission without launching", async () => {
  const root = await createTestTempDirectory("rea-inspection-admission-");
  const marker = join(root, "launched");
  const prepare = vi
    .spyOn(systemProcessOwnershipHost, "prepare")
    .mockRejectedValue(new Error("Native inspection must not start"));
  try {
    const reason = new AnalysisOutputError(
      "authored-admission",
      "opaque reason",
    );
    const controller = new AbortController();
    controller.abort(reason);
    const failure = await spawnOwnedProviderProcess({
      command: process.execPath,
      arguments: [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], 'launched')",
        marker,
      ],
      runId: "authored-aborted-admission",
      signal: controller.signal,
    }).catch((cause: unknown) => cause);
    expect(failure).not.toBe(reason);
    expect(failure).toBeInstanceOf(ProcessOwnershipInspectionCancelled);
    if (!(failure instanceof ProcessOwnershipInspectionCancelled))
      throw failure;
    expect(failure.reason).toBe(reason);
    expect(failure.cause).toBe(reason);
    expect(prepare).not.toHaveBeenCalled();
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    prepare.mockRestore();
  }
});
