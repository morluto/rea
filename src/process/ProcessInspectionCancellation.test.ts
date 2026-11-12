import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { AnalysisOutputError } from "../domain/analysisErrorCore.js";
import {
  isProcessOwnershipInspectionCancellation,
  ProcessOwnershipInspectionCancelled,
} from "./ProcessInspectionCancellation.js";
import { systemProcessOwnershipHost } from "./ProcessOwnershipObservation.js";
import { spawnOwnedProviderProcess } from "./ProviderProcess.js";

it("does not turn a physical OS read failure into inspection cancellation when reused as the abort reason", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-inspection-origin-"));
  try {
    const failure = await readFile(join(root, "missing")).catch(
      (cause: unknown) => cause,
    );
    expect(failure).toMatchObject({ code: "ENOENT" });
    const controller = new AbortController();
    controller.abort(failure);
    expect(isProcessOwnershipInspectionCancellation(failure)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("wraps an opaque non-cancellation analysis error at already-aborted spawn admission without launching", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-inspection-admission-"));
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
    await rm(root, { recursive: true, force: true });
  }
});
