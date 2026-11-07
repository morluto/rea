import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, onTestFinished } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { inspectEvtxArchiveEvidence } from "./EvtxArchiveService.js";

it("reports the selected path and cause when it cannot resolve the event log", async () => {
  const root = await createTestTempDirectory("rea-evtx-missing-");
  const blocker = join(root, "file");
  await writeFile(blocker, "x");
  const resources = new ArtifactResourceScope();
  onTestFinished(() => resources.close());
  for (const [path, code] of [
    [join(root, "missing.evtx"), "ENOENT"],
    [join(blocker, "child.evtx"), "ENOTDIR"],
  ] as const) {
    const result = await inspectEvtxArchiveEvidence({ path }, resources);
    expect(result.ok).toBe(false);
    if (result.ok || !(result.error instanceof AnalysisInputError))
      throw new Error("Expected input refusal");
    expect(result.error.issues).toEqual([
      {
        path: ["path"],
        reason: "invalid_format",
        message: `Selected event log could not be read (${code}): ${path}`,
      },
    ]);
  }
});
